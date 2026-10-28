"""Obact 编排层：act / read / download / extract / save / wait_for_human。

act、read、download 共用同一套流程：缓存命中走 S1，未命中或 S1 失败走 S2（先 fast 后 smart）；
act、download 给了 element_id 时，S2 先按调用方指定的编号执行。
"""

import asyncio
import functools
import json
import os
import sys
from pathlib import Path
from typing import Any, Self

from playwright.async_api import Download, Locator, Page, async_playwright
from playwright.async_api import Error as PlaywrightError
from pydantic import TypeAdapter

from . import output, snapshot
from .cache import Cache, cache_key, render, render_selector, templatize, untemplated
from .llm import LLM, SLOTS, Decision, ModelError

S1_WAIT_MS = 3000  # S1 等缓存元素出现的时间
ACTION_TIMEOUT_MS = 5000
EXPECT_TIMEOUT_MS = 10000
DOWNLOAD_WAIT_MS = 15000  # 点击后等下载开始的时间
NEW_TAB_WAIT_MS = 10000  # 点击或回车会打开新标签页时，等它出现的时间
VISION_CHECKED = "vision_checked.json"  # 缓存目录下，记录通过视觉检查的“模型地址|模型名”
# 缺少模型配置时，报错里给出的 .env 模板；完整的可选项见仓库的 .env.example
ENV_TEMPLATE = """\
# 必填：模型接口（OpenAI 格式，模型必须支持图像输入）
MODEL_BASE_URL = https://你的接口地址/v1
MODEL_NAME = 视觉模型名
MODEL_KEY = 你的密钥

# 可选：更聪明的 smart 模型，上面的模型失败时升级使用；没写的项沿用上面的设置
# SMART_MODEL_NAME = 更强的视觉模型名

# 可选：无头运行（默认显示浏览器窗口）
# OBACT_HEADLESS = true"""

# 降低被识别为自动化浏览器的概率，参考 Stagehand v1 lib/index.ts 的本地启动参数与 applyStealthScripts
LAUNCH_ARGS = ["--disable-blink-features=AutomationControlled"]
STEALTH_JS = """
if (navigator.webdriver) {
  Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false });
}
delete window.__playwright;
delete window.__pw_manual;
delete window.__PW_inspect;
if (navigator.permissions && window.Notification) {
  const query = navigator.permissions.query.bind(navigator.permissions);
  navigator.permissions.query = (p) =>
    p && p.name === 'notifications' ? Promise.resolve({ state: Notification.permission }) : query(p);
}
"""


class StepFailed(Exception):
    """一步失败。attempts 是各级尝试记录，screenshot 是失败时的截图路径；executed 为 True 表示动作已执行、执行后校验未通过。"""

    def __init__(self, instruction: str, attempts: list[str], screenshot: Path | None, executed: bool = False):
        self.instruction = instruction
        self.attempts = attempts
        self.screenshot = screenshot
        self.executed = executed
        detail = "；".join(attempts)
        super().__init__(f"{instruction}：{detail}" + (f"（截图 {screenshot}）" if screenshot else ""))


class _Miss(Exception):
    """模型没有给出可用的目标。"""


class _Mismatch(Exception):
    """S1 核对不符。"""


class Obact:
    def __init__(self, task: str, env: str | Path = ".env", headless: bool | None = None):
        """task 决定缓存文件名。配置全部来自环境变量，启动时先加载 env 指定的文件，已存在的环境变量优先。

        headless 为 None 时读取 OBACT_HEADLESS，为 True 或 False 时直接使用，不受环境变量影响。
        """
        env = Path(env)
        _load_env(env)
        width, height = _env("OBACT_VIEWPORT", "1280x800").lower().split("x")
        self.task = task
        self.viewport = {"width": int(width), "height": int(height)}
        if headless is None:
            headless = _env("OBACT_HEADLESS", "false").lower() in ("1", "true", "yes")
        self.headless = headless
        # 为空时 Playwright 使用临时目录；指定目录可以跨运行保留登录状态和 cookie
        self.user_data_dir = _env("OBACT_USER_DATA_DIR")
        self.executable_path = _env("OBACT_EXECUTABLE_PATH") or None
        self.cache = Cache(Path(_env("OBACT_CACHE_DIR", ".obact")) / f"{task}.jsonl")
        self._models = _model_config(env)
        self.llm = LLM(self._models)
        # 最近一步的执行信息：how（S1、编号、fast、smart）、method、name 或 point、cached
        self.last_step: dict | None = None
        # 最近一次 page_state 的（页面、地址、快照），供 element_id 使用；act、download、read、goto 时作废
        self._snap: tuple[Page, str, snapshot.Snapshot] | None = None
        self._closed = False

    async def __aenter__(self) -> Self:
        await self._check_vision()
        self._pw = await async_playwright().start()
        try:
            self._context = await self._pw.chromium.launch_persistent_context(
                self.user_data_dir,
                headless=self.headless,
                viewport=self.viewport,
                executable_path=self.executable_path,
                args=LAUNCH_ARGS,
            )
            await self._context.add_init_script(STEALTH_JS)
            for p in self._context.pages:
                self._on_page(p)
            self._context.on("page", self._on_page)
            self._context.on("close", self._on_close)
        except BaseException:
            await self._pw.stop()
            raise
        return self

    async def __aexit__(self, *exc) -> None:
        await self._context.close()
        await self._pw.stop()

    async def _check_vision(self) -> None:
        """视觉检查。两个槽位的“模型地址|模型名”都通过过检查时跳过；换了地址或模型才重新检查。

        记录在缓存目录的 VISION_CHECKED 文件里，不含密钥；删掉这个文件可以强制重新检查。
        """
        path = self.cache.path.with_name(VISION_CHECKED)
        current = {f"{m['base_url']}|{m['model']}" for m in self._models.values()}
        try:
            passed = set(json.loads(path.read_text(encoding="utf-8")))
        except (OSError, ValueError):
            passed = set()
        if current <= passed:
            return
        await self.llm.check_vision()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(sorted(passed | current), ensure_ascii=False, indent=1), encoding="utf-8")

    @staticmethod
    def _on_page(page: Page) -> None:
        snapshot.watch(page)
        # alert、confirm、prompt 一律接受：点击“删除”后弹出的确认框按指令的意图继续
        page.on("dialog", lambda dialog: dialog.accept())

    def _on_close(self, _context) -> None:
        self._closed = True

    @property
    def page(self) -> Page:
        """当前页面；点击打开新标签页后，后续步骤作用在最新打开的页面上。"""
        return self._context.pages[-1]

    @property
    def closed(self) -> bool:
        """浏览器已关闭（窗口被关掉或进程退出）。"""
        return self._closed or not self._context.pages

    async def act(
        self,
        instruction: str,
        params: dict | None = None,
        step: str | None = None,
        expect: str | None = None,
        element_id: int | None = None,
        method: str = "click",
        args: list[str] | None = None,
    ) -> None:
        """执行一步操作。

        instruction 中用 {名称} 占位，值由 params 提供；step 用于区分同一页面上相同的指令；
        expect 为执行后校验：以 http://、https:// 或 ** 开头时按 URL 模式等待，否则按选择器等待元素可见。
        element_id 是最近一次 page_state 快照中的编号，由调用方直接指定目标和 method、args，缓存未命中时先按它执行，
        不调用模型；编号失效或核对不符时转模型。
        """
        picked = self._picked(element_id, method, args)

        async def verify(attempts: list[str]) -> None:
            await self._expect(expect, instruction, attempts)

        await self._step(instruction, params, step, self._replay, self._infer, verify, picked)

    async def read(self, instruction: str, params: dict | None = None, step: str | None = None) -> str:
        """读取页面上某块区域（正文、表格、列表等）的全部文字。

        第一次由模型从文本块清单中定位区域并缓存位置，之后按缓存直接读取，不调用模型。
        适合读较长的内容；零散的字段用 extract 按 schema 提取。
        """
        # 文本块快照会替换页面里记录的元素编号
        self._snap = None

        async def verify(attempts: list[str]) -> None:
            return None

        return await self._step(instruction, params, step, self._reread, self._locate, verify)

    async def download(
        self,
        instruction: str,
        save_to: str | Path = ".",
        params: dict | None = None,
        step: str | None = None,
        element_id: int | None = None,
    ) -> Path:
        """点击触发下载，把文件按网站给的文件名存到 save_to 目录，返回文件路径；点击位置和 act 一样缓存。

        点击后 DOWNLOAD_WAIT_MS 内没有触发下载视为这一步失败：抛出 StepFailed，不写缓存。element_id 同 act。
        """
        picked = self._picked(element_id, "click", None)
        downloads: list[Download] = []

        def on_download(d: Download) -> None:
            downloads.append(d)

        def watch(page: Page) -> None:
            page.on("download", on_download)

        async def verify(attempts: list[str]) -> None:
            for _ in range(DOWNLOAD_WAIT_MS // 100):
                if downloads:
                    return
                await asyncio.sleep(0.1)
            raise await self._failed(instruction, attempts + ["点击后没有触发下载"], executed=True)

        # 下载可能由点击后新打开的标签页触发，新页面也要监听
        for p in self._context.pages:
            watch(p)
        self._context.on("page", watch)
        try:
            await self._step(instruction, params, step, self._replay, self._infer, verify, picked)
        finally:
            self._context.remove_listener("page", watch)
            for p in self._context.pages:
                p.remove_listener("download", on_download)
        path = Path(save_to) / downloads[-1].suggested_filename
        path.parent.mkdir(parents=True, exist_ok=True)
        await downloads[-1].save_as(path)
        print(f"[obact] 已下载 {path}", file=sys.stderr, flush=True)
        return path

    async def goto(self, url: str) -> None:
        """打开地址并等页面稳定。不等 load 事件：卡住的第三方资源会让 load 迟迟不触发。"""
        self._snap = None
        await self.page.goto(url, wait_until="domcontentloaded")
        await snapshot.settle(self.page)

    async def page_state(self) -> snapshot.Snapshot:
        """返回当前页面的元素清单文字和带编号框的视口截图，不调用模型；快照留给下一次 act、download 的 element_id。"""
        snap = await snapshot.take(self.page)
        self._snap = (self.page, self.page.url, snap)
        return snap

    async def page_info(self) -> dict:
        """当前页面的地址、标题和已打开的标签页数。"""
        return {"url": self.page.url, "title": await self.page.title(), "tabs": len(self._context.pages)}

    def cached_steps(self) -> list[tuple[str, dict]]:
        """当前页面（域名 + 路径）下已缓存的步骤：step 或指令模板，以及缓存条目。"""
        return self.cache.on_page(self.page.url)

    @staticmethod
    def save(data: Any, path: str | Path) -> Path:
        """把结果按扩展名保存为 .json / .csv / .md / .txt 文件，返回文件路径。"""
        return output.save(data, path)

    async def _step(
        self, instruction: str, params: dict | None, step: str | None, replay, infer, verify, picked=None
    ) -> Any:
        """S1 →（给了 element_id 时）编号 → fast → smart 的公共流程。

        replay(entry, params) 按缓存执行并返回结果，核对不符时抛 _Mismatch；
        infer(slot, key, 指令, params) 走模型执行，picked(key, 指令, params) 按调用方给出的编号执行，都返回 (结果, 条目)；
        条目模板化后写入缓存，参数无法模板化时不缓存；
        verify(attempts) 在执行后校验结果，不通过时抛 StepFailed，此时不写缓存、不升级；S1 回放后不通过还会删掉这条缓存，
        下次运行这一步重新走模型。执行信息记在 last_step。
        """
        params = {k: str(v) for k, v in (params or {}).items()}
        key = cache_key(step or instruction, self.page.url)
        entry = self.cache.get(key)
        attempts: list[str] = []
        label = f"{step}：{instruction}" if step else instruction
        self.last_step = None

        if entry:
            try:
                result = await replay(entry, params)
            except (_Mismatch, PlaywrightError) as e:
                attempts.append(f"S1：{_short(e)}")
            else:
                try:
                    await verify(attempts + ["S1：已执行"])
                except StepFailed:
                    self.cache.delete(key)
                    raise
                self._log("S1", "命中缓存，直接回放", label)
                self.last_step = _summary("S1", entry, params, cached=True)
                return result

        text = render(instruction, params)
        tiers = [(slot, functools.partial(infer, slot)) for slot in SLOTS]
        if picked:
            tiers.insert(0, ("编号", picked))
        for how, run in tiers:
            try:
                result, raw = await run(key, text, params)
            except (ModelError, PlaywrightError, _Miss, _Mismatch) as e:
                attempts.append(f"{how}：{_short(e)}")
                continue
            await verify(attempts + [f"{how}：已执行"])
            new_entry = templatize(raw, params)
            if new_entry:
                self.cache.put(new_entry)
            status = ("按编号执行" if how == "编号" else "视觉模型执行") + ("（缓存失效，已自愈）" if entry else "（无缓存）")
            self._log(how, status, label, cached=new_entry is not None)
            self.last_step = _summary(how, raw, {}, cached=new_entry is not None)
            return result
        raise await self._failed(label, attempts)

    async def extract(self, instruction: str, schema: Any, slot: str | None = None) -> Any:
        """按 schema 提取数据，每次走模型、不缓存；schema 可以是 BaseModel 或 list[Model] 这类类型。

        slot 可选 "fast" 或 "smart"，不填时默认按 fast → smart 顺序降级尝试。
        """
        adapter = TypeAdapter(schema)
        attempts: list[str] = []
        slots = [slot] if slot else SLOTS
        for s in slots:
            try:
                await snapshot.settle(self.page)
                text = await snapshot.page_text(self.page)
                image = await self.page.screenshot()
                data = await self.llm.extract(s, instruction, text, image, adapter)
            except (ModelError, PlaywrightError) as e:
                attempts.append(f"{s}：{_short(e)}")
                continue
            self._log(s, "视觉模型提取", instruction)
            return data
        raise await self._failed(instruction, attempts)

    async def wait_for_human(self, message: str) -> None:
        """暂停，等人工在浏览器里完成验证后按回车继续。"""
        print(f"[obact] 等待人工：{message}", file=sys.stderr, flush=True)
        await asyncio.to_thread(input, "完成后按回车继续...")

    async def _unique(self, selector: str) -> Locator:
        """等缓存的选择器出现，并核对它只匹配到一个元素。"""
        loc = self.page.locator(selector)
        try:
            await loc.first.wait_for(state="visible", timeout=S1_WAIT_MS)
        except PlaywrightError:
            raise _Mismatch("选择器没有匹配到可见元素") from None
        count = await loc.count()
        if count != 1:
            raise _Mismatch(f"选择器匹配到 {count} 个元素")
        return loc

    async def _replay(self, entry: dict, params: dict[str, str]) -> None:
        """act 的 S1：核对通过就执行。"""
        method = entry["method"]
        args = [render(a, params) for a in entry.get("args", [])]
        if "point" in entry:
            await snapshot.settle(self.page)
            await self._run(self._to_pixels(entry["point"]), method, args)
            return
        loc = await self._unique(render_selector(entry["selector"], params))
        name = await snapshot.name_of(self.page, loc)
        expected = render(entry.get("name", ""), params)
        if name != expected:
            raise _Mismatch(f"名称不一致（缓存 {expected!r}，页面 {name!r}）")
        await self._run(loc, method, args)

    async def _reread(self, entry: dict, params: dict[str, str]) -> str:
        """read 的 S1：按缓存的位置读文字。区域内容本身会变，不核对名称。"""
        await snapshot.settle(self.page)
        loc = await self._unique(render_selector(entry["selector"], params))
        text = await loc.inner_text(timeout=ACTION_TIMEOUT_MS)
        if not text.strip():
            raise _Mismatch("区域里没有文字")
        return text

    async def _locate(self, slot: str, key: str, instruction: str, params: dict[str, str]) -> tuple[str, dict]:
        """read 的 S2：文本块快照 → 模型选块 → 读文字。返回文字和未模板化的缓存条目。"""
        snap = await snapshot.take_blocks(self.page)
        block_id = await self.llm.locate(slot, instruction, snap.text, snap.image)
        if block_id is None:
            raise _Miss("找不到目标")
        target = snap.targets.get(block_id)
        if target is None:
            raise _Miss(f"编号 {block_id} 不在文本块清单中")
        selector = target.selector
        missing = untemplated(selector, [], params)
        if missing:
            selector = await snapshot.anchor(self.page, block_id, missing) or selector
        text = await self.page.locator(selector).inner_text(timeout=ACTION_TIMEOUT_MS)
        entry = {"key": key, "selector": selector, "method": "read", "args": []}
        return text, entry

    async def _infer(self, slot: str, key: str, instruction: str, params: dict[str, str]) -> tuple[None, dict]:
        """act 的 S2：快照 → 模型 → 执行。返回未模板化的缓存条目。"""
        snap = await snapshot.take(self.page)
        d = await self.llm.decide(slot, instruction, snap.text, snap.image, snap.size)
        return None, await self._apply(snap, d, key, params)

    def _picked(self, element_id: int | None, method: str, args: list[str] | None):
        """调用方按最近一次 page_state 的编号给出的决策，没给编号时返回 None。快照在这里作废，只能用一次。

        执行前核对：页面和地址没有变，编号对应的选择器唯一匹配且名称与快照一致，否则抛 _Mismatch 转模型。
        """
        snap, self._snap = self._snap, None
        if element_id is None:
            return None
        d = Decision(found=True, id=element_id, method=method, args=args or [])

        async def run(key: str, instruction: str, params: dict[str, str]) -> tuple[None, dict]:
            if snap is None or snap[0] is not self.page or snap[1] != self.page.url:
                raise _Mismatch("编号已失效，需要重新调用 page_state")
            target = snap[2].targets.get(element_id)
            if target is None:
                raise _Miss(f"编号 {element_id} 不在元素清单中")
            loc = await self._unique(target.selector)
            name = await snapshot.name_of(self.page, loc)
            if name != target.name:
                raise _Mismatch(f"名称不一致（快照 {target.name!r}，页面 {name!r}）")
            return None, await self._apply(snap[2], d, key, params)

        return run

    async def _apply(self, snap: snapshot.Snapshot, d: Decision, key: str, params: dict[str, str]) -> dict:
        """按快照上的决策执行，返回未模板化的缓存条目。"""
        if not d.found:
            raise _Miss("找不到目标")
        if d.id is not None:
            target = snap.targets.get(d.id)
            if target is None:
                raise _Miss(f"编号 {d.id} 不在元素清单中")
            selector = target.selector
            # 定位用的参数值不在选择器里时，尝试生成包含参数值的选择器
            missing = untemplated(selector, d.args, params)
            if missing:
                selector = await snapshot.anchor(self.page, d.id, missing) or selector
            # 元素可能在执行后消失（如点击后跳转），条目在执行前生成
            entry = {"key": key, "selector": selector, "name": target.name, "method": d.method, "args": d.args}
            await self._run(self.page.locator(selector), d.method, d.args)
        else:
            entry = {"key": key, "point": [round(c, 4) for c in d.point], "method": d.method, "args": d.args}
            await self._run(self._to_pixels(d.point), d.method, d.args)
        return entry

    async def _run(self, target: Locator | tuple[float, float], method: str, args: list[str]) -> None:
        """执行动作；target 是元素定位器或视口像素坐标。"""
        page = self.page
        tabs = len(self._context.pages)
        new_tab = (
            isinstance(target, Locator)
            and method in ("click", "press")
            and await snapshot.opens_tab(page, target, method, args[0] if args else "")
        )
        if isinstance(target, tuple):
            await page.mouse.click(*target)
            if method == "fill":
                await page.keyboard.type(args[0])
            elif method == "press":
                await page.keyboard.press(args[0])
        elif method == "click":
            await target.click(timeout=ACTION_TIMEOUT_MS)
        elif method == "fill":
            await target.fill(args[0], timeout=ACTION_TIMEOUT_MS)
        elif method == "press":
            await target.press(args[0], timeout=ACTION_TIMEOUT_MS)
        else:
            await target.select_option(args[0], timeout=ACTION_TIMEOUT_MS)
        if new_tab:
            # 新标签页要等它的地址开始加载后才出现在 pages 里，可能比下面的 settle 还晚；
            # 不等的话，settle、expect 和后续步骤都会作用在旧页面上
            for _ in range(NEW_TAB_WAIT_MS // 100):
                if len(self._context.pages) > tabs:
                    break
                await asyncio.sleep(0.1)
        # 等页面对这次动作的反应结束（参考 Stagehand 每次动作后的 _waitForSettledDom），
        # 否则回放过快时，页面延迟触发的焦点切换、弹层等会打乱下一步
        try:
            await snapshot.settle(self.page)
        except PlaywrightError:
            # 动作已执行，页面被关闭等情况不算动作失败
            pass

    async def _expect(self, expect: str | None, instruction: str, attempts: list[str]) -> None:
        if not expect:
            return
        try:
            if expect.startswith(("http://", "https://", "**")):
                # 地址匹配即通过，不等 load 事件：卡住的第三方资源会让 load 迟迟不触发
                await self.page.wait_for_url(expect, wait_until="commit", timeout=EXPECT_TIMEOUT_MS)
            else:
                await self.page.locator(expect).first.wait_for(state="visible", timeout=EXPECT_TIMEOUT_MS)
        except PlaywrightError:
            raise await self._failed(instruction, attempts + [f"expect 不通过：{expect}"], executed=True) from None

    async def _failed(self, instruction: str, attempts: list[str], executed: bool = False) -> StepFailed:
        path: Path | None = self.cache.path.with_name(f"{self.task}_failed.png")
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            await self.page.screenshot(path=str(path))
        except PlaywrightError:
            path = None
        return StepFailed(instruction, attempts, path, executed)

    def _to_pixels(self, point) -> tuple[float, float]:
        return point[0] * self.viewport["width"], point[1] * self.viewport["height"]

    @staticmethod
    def _log(how: str, status: str, instruction: str, cached: bool = True) -> None:
        suffix = "" if cached else "（参数无法模板化，不缓存）"
        print(f"[obact] {how} {status}{suffix} | {instruction}", file=sys.stderr, flush=True)


def _summary(how: str, entry: dict, params: dict[str, str], cached: bool) -> dict:
    """last_step 的内容：执行路径、动作、元素名称或坐标、是否缓存。"""
    out = {"how": how, "method": entry["method"], "cached": cached}
    if "point" in entry:
        out["point"] = entry["point"]
    else:
        out["name"] = render(entry.get("name", ""), params)
    return out


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, "").strip() or default


def _model_config(env: Path) -> dict:
    """fast 槽位读 MODEL_BASE_URL、MODEL_NAME、MODEL_KEY、MODEL_COORDS；smart 槽位读 SMART_ 开头的同名变量，没写的项沿用 fast。

    缺少模型地址或模型名时报错，说明到哪里找的 .env，并附上配置模板。
    """
    names = {"base_url": "BASE_URL", "model": "NAME", "api_key": "KEY", "coords": "COORDS"}
    fast = {k: _env(f"MODEL_{n}") for k, n in names.items()}
    fast["coords"] = fast["coords"] or "pixel"
    smart = {k: _env(f"SMART_MODEL_{n}", fast[k]) for k, n in names.items()}
    if not fast["base_url"] or not fast["model"]:
        where = f"{env.resolve()} 不存在" if not env.is_file() else f"{env.resolve()} 中没有设置 MODEL_BASE_URL 或 MODEL_NAME"
        raise ValueError(f"没有配置模型（{where}）。请创建或补全这个 .env 文件后重试，格式如下：\n\n{ENV_TEMPLATE}")
    return {"fast": fast, "smart": smart}


def _load_env(path: Path) -> None:
    """把 .env 中的 KEY=VALUE 写入环境变量；已经存在的环境变量不覆盖。"""
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8-sig").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.removeprefix("export ").split("=", 1)
        value = value.strip()
        if value[:1] in ("'", '"') and value[0] in value[1:]:
            value = value[1 : value.index(value[0], 1)]
        else:
            # 不带引号的值，" #" 之后是行尾注释
            value = value.split(" #", 1)[0].strip()
        os.environ.setdefault(key.strip(), value)


def _short(e: Exception) -> str:
    """Playwright 的报错带多行调用日志，只取第一行。"""
    lines = str(e).strip().splitlines()
    return lines[0] if lines else type(e).__name__
