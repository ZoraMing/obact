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

from playwright.async_api import Download, FileChooser, Locator, Page, async_playwright
from playwright.async_api import Error as PlaywrightError
from playwright.async_api import TimeoutError as PlaywrightTimeout
from pydantic import TypeAdapter

from . import output, snapshot
from .cache import Cache, cache_key, render, render_selector, templatize, untemplated
from .llm import LLM, SLOTS, Decision, ModelError

S1_WAIT_MS = 3000  # S1 等缓存元素出现的时间
ACTION_TIMEOUT_MS = 5000
EXPECT_TIMEOUT_MS = 10000
DOWNLOAD_WAIT_MS = 15000  # 点击后等下载开始的时间
UPLOAD_WAIT_MS = 5000  # 点击后等文件选择框出现的时间
NEW_TAB_WAIT_MS = 10000  # 点击或回车会打开新标签页时，等它出现的时间
EFFECT_METHODS = ("click", "press", "fill", "select_option")  # act 没写 expect 时检查有没有效果的动作
VISION_CHECKED = "vision_checked.json"  # 缓存目录根下，记录通过视觉检查的“模型地址|模型名”
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
    """一步失败。attempts 是各级尝试记录，screenshot 是失败时的截图路径；executed 为 True 表示动作已执行、执行后校验未通过。

    act 没写 expect 时，执行后页面没有任何变化也算执行后校验未通过。
    """

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


class _NoEffect(Exception):
    """act 没写 expect 时，动作执行后页面没有任何变化。"""


class Obact:
    def __init__(self, task: str, env: str | Path = ".env", headless: bool | None = None):
        """task 决定缓存文件夹：缓存目录/任务名/ 下放步骤缓存 steps.jsonl 和失败截图 failed.png；
        任务名不能用作文件夹名时抛 ValueError。配置全部来自环境变量，启动时先加载 env 指定的文件，已存在的环境变量优先。

        headless 为 None 时读取 OBACT_HEADLESS，为 True 或 False 时直接使用，不受环境变量影响。
        """
        _check_task(task)
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
        self.cache = Cache(Path(_env("OBACT_CACHE_DIR", ".obact")) / task / "steps.jsonl")
        self._models = _model_config(env)
        self.llm = LLM(self._models)
        # 最近一步的执行信息：how（S1、编号、fast、smart）、method、name 或 point、cached
        self.last_step: dict | None = None
        # 最近一次 page_state 的（页面、地址、快照），供 element_id 使用；act、download、read、goto、scroll 时作废
        self._snap: tuple[Page, str, snapshot.Snapshot] | None = None
        # 正在执行的是没写 expect 的 act：_run 要检查动作有没有效果
        self._check_effect = False
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

        记录在缓存目录根下的 VISION_CHECKED 文件里，各任务共用，不含密钥；删掉这个文件可以强制重新检查。
        """
        path = self.cache.path.parent.parent / VISION_CHECKED
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
        没写 expect 时，click、press、fill、select_option 执行后页面没有任何变化，视为这一级没有生效，见 _step。
        element_id 是最近一次 page_state 快照中的编号，由调用方直接指定目标和 method、args，缓存未命中时先按它执行，
        不调用模型；编号失效或核对不符时转模型。
        """
        picked = self._picked(element_id, method, args)

        async def verify(attempts: list[str]) -> None:
            await self._expect(expect, instruction, attempts)

        self._check_effect = not expect
        try:
            await self._step(instruction, params, step, self._replay, self._infer, verify, picked)
        finally:
            self._check_effect = False

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

    async def upload(
        self,
        instruction: str,
        files: str | Path | list[str | Path],
        params: dict | None = None,
        step: str | None = None,
        element_id: int | None = None,
    ) -> None:
        """点击上传按钮（或文件输入框），在弹出的文件选择框里选中 files；点击位置和 act 一样缓存。

        页面上常见的是隐藏的 input[type=file] 加一个样式按钮，所以不直接填输入框，而是点击后接住文件选择框。
        点击后 UPLOAD_WAIT_MS 内没有出现文件选择框视为这一步失败：抛出 StepFailed，不写缓存。element_id 同 act。
        """
        paths = [Path(f) for f in (files if isinstance(files, list) else [files])]
        missing = [str(p) for p in paths if not p.is_file()]
        if missing:
            raise FileNotFoundError(f"要上传的文件不存在：{'、'.join(missing)}")
        picked = self._picked(element_id, "click", None)
        choosers: list[FileChooser] = []

        def on_chooser(c: FileChooser) -> None:
            choosers.append(c)

        async def verify(attempts: list[str]) -> None:
            for _ in range(UPLOAD_WAIT_MS // 100):
                if choosers:
                    if len(paths) > 1 and not choosers[-1].is_multiple():
                        raise await self._failed(instruction, attempts + ["文件选择框只能选一个文件"], executed=True)
                    await choosers[-1].set_files(paths)
                    await snapshot.settle(self.page)
                    return
                await asyncio.sleep(0.1)
            raise await self._failed(instruction, attempts + ["点击后没有打开文件选择框"], executed=True)

        # 监听 filechooser 后，Playwright 会接住选择框，不弹出系统对话框
        page = self.page
        page.on("filechooser", on_chooser)
        try:
            await self._step(instruction, params, step, self._replay, self._infer, verify, picked)
        finally:
            page.remove_listener("filechooser", on_chooser)
        print(f"[obact] 已上传 {'、'.join(p.name for p in paths)}", file=sys.stderr, flush=True)

    async def goto(self, url: str) -> None:
        """打开地址并等页面稳定。不等 load 事件：卡住的第三方资源会让 load 迟迟不触发。"""
        self._snap = None
        await self.page.goto(url, wait_until="domcontentloaded")
        await snapshot.settle(self.page)

    async def scroll(self) -> tuple[int, int]:
        """在鼠标当前位置向下滚动一屏（视口高度），等页面稳定后返回滚动前后页面的纵向位置；两者相同说明已经到底。

        不移动鼠标，之前的悬停状态得以保留；鼠标停在可滚动的局部区域上时，滚动的是那个区域。不调用模型，不写缓存。
        """
        self._snap = None
        before = await self.page.evaluate("() => Math.round(window.scrollY)")
        await self.page.mouse.wheel(0, self.viewport["height"])
        await snapshot.settle(self.page)
        after = await self.page.evaluate("() => Math.round(window.scrollY)")
        return before, after

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
        下次运行这一步重新走模型。
        没写 expect 的 act 执行后页面没有任何变化时，replay、infer、picked 抛 _NoEffect：这一级不写缓存，记入 attempts 后
        升级到下一级，S1 还会删掉这条缓存；各级都失败、且有一级执行了动作但没有效果时，StepFailed 的 executed 为 True。
        执行信息记在 last_step。
        """
        params = {k: str(v) for k, v in (params or {}).items()}
        key = cache_key(step or instruction, self.page.url)
        entry = self.cache.get(key)
        attempts: list[str] = []
        label = f"{step}：{instruction}" if step else instruction
        self.last_step = None
        executed = False  # 有一级执行了动作，但页面没有任何变化

        if entry:
            try:
                result = await replay(entry, params)
            except (_Mismatch, PlaywrightError) as e:
                attempts.append(f"S1：{_short(e)}")
            except _NoEffect as e:
                self.cache.delete(key)
                attempts.append(f"S1：{e}")
                executed = True
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
            except _NoEffect as e:
                attempts.append(f"{how}：{e}")
                executed = True
                continue
            await verify(attempts + [f"{how}：已执行"])
            new_entry = templatize(raw, params)
            if new_entry:
                self.cache.put(new_entry)
            status = ("按编号执行" if how == "编号" else "视觉模型执行") + ("（缓存失效，已自愈）" if entry else "（无缓存）")
            self._log(how, status, label, cached=new_entry is not None)
            self.last_step = _summary(how, raw, {}, cached=new_entry is not None)
            return result
        raise await self._failed(label, attempts, executed)

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

    async def wait_for_human(self, message: str, until: str | None = None, timeout: float = 300) -> None:
        """暂停，等人工在浏览器里完成验证、登录等操作。

        不给 until 时在终端按回车继续。给了 until 时不读终端，在当前页面上等条件满足后自动继续，写法与 expect 相同：
        以 http://、https:// 或 ** 开头时等地址匹配，否则等选择器对应的元素可见；timeout 秒内没有满足时抛出 TimeoutError。
        """
        print(f"[obact] 等待人工：{message}", file=sys.stderr, flush=True)
        if not until:
            await asyncio.to_thread(input, "完成后按回车继续...")
            return
        print(f"[obact] 满足 {until} 后自动继续，最多等 {timeout} 秒", file=sys.stderr, flush=True)
        try:
            await self.wait_for(until, timeout)
        except TimeoutError:
            raise TimeoutError(f"等待人工超时：{timeout} 秒内没有满足 {until}（{message}）") from None

    async def wait_for(self, until: str | None = None, timeout: float = 30) -> None:
        """在当前页面上等条件满足，再等页面稳定，用于加载慢的页面和组件。

        until 的写法与 expect 相同：以 http://、https:// 或 ** 开头时等地址匹配，否则等选择器对应的元素可见
        （如 text=加载完成）；timeout 秒内没有满足时抛出 TimeoutError。
        不给 until 时固定等 timeout 秒，用于没有明确条件可等的情况（如倒计时按钮、网络或设备慢）。
        """
        if not until:
            await asyncio.sleep(timeout)
            await snapshot.settle(self.page)
            return
        try:
            if until.startswith(("http://", "https://", "**")):
                await self.page.wait_for_url(until, wait_until="commit", timeout=timeout * 1000)
            else:
                await self.page.locator(until).first.wait_for(state="visible", timeout=timeout * 1000)
        except PlaywrightTimeout:
            raise TimeoutError(f"{timeout} 秒内没有满足 {until}") from None
        await snapshot.settle(self.page)

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
        """act 的 S2：快照 → 模型 → 执行。返回未模板化的缓存条目。

        模型报告目标被弹层挡住时，按一次 Escape，重新拍快照（take 会先等页面稳定），由同一模型再判断一次；
        仍被挡住或找不到时抛 ModelError，由 _step 升级到下一级模型。
        """
        snap = await snapshot.take(self.page)
        d = await self.llm.decide(slot, instruction, snap.text, snap.image, snap.size)
        if d.blocked:
            print(f"[obact] 目标（{slot}）：被弹层挡住，按 Escape 后重新判断{_reason(d)}", file=sys.stderr, flush=True)
            await self.page.keyboard.press("Escape")
            snap = await snapshot.take(self.page)
            d = await self.llm.decide(slot, instruction, snap.text, snap.image, snap.size)
            if d.blocked or not d.found:
                state = "仍被挡住" if d.blocked else "找不到目标"
                raise ModelError(f"目标被弹层挡住，按 Escape 后{state}{_reason(d)}")
        return None, await self._apply(slot, snap, d, key, params)

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
            return None, await self._apply("编号", snap[2], d, key, params)

        return run

    async def _apply(self, how: str, snap: snapshot.Snapshot, d: Decision, key: str, params: dict[str, str]) -> dict:
        """按快照上的决策执行，返回未模板化的缓存条目。

        执行前在日志里写明选中的目标（编号、名称、选择器或坐标）、method 和模型给的理由，不写 args（可能是密码）；
        执行出错时，报错里带上选中的编号和名称。
        """
        if not d.found:
            raise _Miss("找不到目标" + _reason(d))
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
            where = self.page.locator(selector)
            chosen = f"[{d.id}] {json.dumps(target.name, ensure_ascii=False)}"
            located = f"{chosen}，{selector}"
        else:
            entry = {"key": key, "point": [round(c, 4) for c in d.point], "method": d.method, "args": d.args}
            where = self._to_pixels(d.point)
            chosen = located = f"坐标 ({where[0]:.0f}, {where[1]:.0f})"
        print(f"[obact] 目标（{how}）：{located}，{d.method}{_reason(d)}", file=sys.stderr, flush=True)
        try:
            await self._run(where, d.method, d.args)
        except PlaywrightError as e:
            raise PlaywrightError(f"选了 {chosen}，执行失败：{_short(e)}") from e
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
        # 动作效果从这里观察到下面的 settle 结束，不包括模型思考期间页面自身的变化
        watch = self._check_effect and method in EFFECT_METHODS
        if watch:
            url = page.url
            await snapshot.watch_effect(page, method)
        if isinstance(target, tuple):
            if method == "hover":
                await page.mouse.move(*target)
            else:
                await page.mouse.click(*target)
            if method == "fill":
                await page.keyboard.type(args[0])
            elif method == "press":
                await page.keyboard.press(args[0])
        elif method == "click":
            await target.click(timeout=ACTION_TIMEOUT_MS)
        elif method == "hover":
            await target.hover(timeout=ACTION_TIMEOUT_MS)
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
        # 地址或标签页数变了就算有效果，不再看页面内部
        changed = not watch or page.url != url or len(self._context.pages) != tabs
        if not changed and not await snapshot.had_effect(page, target, method, args[0] if args else ""):
            raise _NoEffect("动作执行后页面没有任何变化")

    async def _expect(self, expect: str | None, instruction: str, attempts: list[str]) -> None:
        if not expect:
            return
        # 先截图留作失败截图：“密码错误”这类临时提示撑不到等满超时
        try:
            image = await self.page.screenshot()
        except PlaywrightError:
            image = None
        try:
            if expect.startswith(("http://", "https://", "**")):
                # 地址匹配即通过，不等 load 事件：卡住的第三方资源会让 load 迟迟不触发
                await self.page.wait_for_url(expect, wait_until="commit", timeout=EXPECT_TIMEOUT_MS)
            else:
                await self.page.locator(expect).first.wait_for(state="visible", timeout=EXPECT_TIMEOUT_MS)
        except PlaywrightError:
            raise await self._failed(instruction, attempts + [f"expect 不通过：{expect}"], True, image) from None

    async def _failed(
        self, instruction: str, attempts: list[str], executed: bool = False, image: bytes | None = None
    ) -> StepFailed:
        """生成 StepFailed 并保存失败截图；image 是事先拍好的截图，没有时现在拍。"""
        path: Path | None = self.cache.path.with_name("failed.png")
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            if image:
                path.write_bytes(image)
            else:
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


def _reason(d: Decision) -> str:
    """模型给的理由，写在日志和失败记录的末尾；没给时为空。模型常在理由里复述 fill 的内容（可能是密码），替换成 ***。"""
    reason = d.reason
    if d.method == "fill":
        for a in filter(None, d.args):
            reason = reason.replace(a, "***")
    return f"，理由：{reason}" if reason else ""


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, "").strip() or default


def _check_task(task: str) -> None:
    """任务名用作缓存目录下的文件夹名，不能为空，不能含 Windows 文件名的非法字符和控制字符，不能以空格或点结尾。"""
    if not task or task[-1] in " ." or any(c in '<>:"/\\|?*' or ord(c) < 32 for c in task):
        raise ValueError(
            f'任务名 {task!r} 不能用作缓存文件夹名（不能为空，不能含 <>:"/\\|?* 和控制字符，不能以空格或点结尾），请换一个名字'
        )


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
