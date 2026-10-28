"""Obact 编排层：act / read / download / extract / save / wait_for_human。

act、read、download 共用同一套流程：缓存命中走 S1，未命中或 S1 失败走 S2（先 fast 后 smart）。
"""

import asyncio
import os
from pathlib import Path
from typing import Any, Self

from playwright.async_api import Download, Locator, Page, async_playwright
from playwright.async_api import Error as PlaywrightError
from pydantic import TypeAdapter

from . import output, snapshot
from .cache import Cache, cache_key, render, render_selector, templatize, untemplated
from .llm import LLM, SLOTS, ModelError

S1_WAIT_MS = 3000  # S1 等缓存元素出现的时间
ACTION_TIMEOUT_MS = 5000
EXPECT_TIMEOUT_MS = 10000
DOWNLOAD_WAIT_MS = 15000  # 点击后等下载开始的时间

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
    """一步失败。attempts 是各级尝试记录，screenshot 是失败时的截图路径。"""

    def __init__(self, instruction: str, attempts: list[str], screenshot: Path | None):
        self.instruction = instruction
        self.attempts = attempts
        self.screenshot = screenshot
        detail = "；".join(attempts)
        super().__init__(f"{instruction}：{detail}" + (f"（截图 {screenshot}）" if screenshot else ""))


class _Miss(Exception):
    """模型没有给出可用的目标。"""


class _Mismatch(Exception):
    """S1 核对不符。"""


class Obact:
    def __init__(self, task: str, env: str | Path = ".env"):
        """task 决定缓存文件名。配置全部来自环境变量，启动时先加载 env 指定的文件，已存在的环境变量优先。"""
        _load_env(Path(env))
        width, height = _env("OBACT_VIEWPORT", "1280x800").lower().split("x")
        self.task = task
        self.viewport = {"width": int(width), "height": int(height)}
        self.headless = _env("OBACT_HEADLESS", "false").lower() in ("1", "true", "yes")
        # 为空时 Playwright 使用临时目录；指定目录可以跨运行保留登录状态和 cookie
        self.user_data_dir = _env("OBACT_USER_DATA_DIR")
        self.executable_path = _env("OBACT_EXECUTABLE_PATH") or None
        self.cache = Cache(Path(_env("OBACT_CACHE_DIR", ".obact")) / f"{task}.jsonl")
        self.llm = LLM(_model_config())

    async def __aenter__(self) -> Self:
        await self.llm.check_vision()
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
        except BaseException:
            await self._pw.stop()
            raise
        return self

    async def __aexit__(self, *exc) -> None:
        await self._context.close()
        await self._pw.stop()

    @staticmethod
    def _on_page(page: Page) -> None:
        snapshot.watch(page)
        # alert、confirm、prompt 一律接受：点击“删除”后弹出的确认框按指令的意图继续
        page.on("dialog", lambda dialog: dialog.accept())

    @property
    def page(self) -> Page:
        """当前页面；点击打开新标签页后，后续步骤作用在最新打开的页面上。"""
        return self._context.pages[-1]

    async def act(self, instruction: str, params: dict | None = None, step: str | None = None, expect: str | None = None) -> None:
        """执行一步操作。

        instruction 中用 {名称} 占位，值由 params 提供；step 用于区分同一页面上相同的指令；
        expect 为执行后校验：以 http://、https:// 或 ** 开头时按 URL 模式等待，否则按选择器等待元素可见。
        """

        async def verify(attempts: list[str]) -> None:
            await self._expect(expect, instruction, attempts)

        await self._step(instruction, params, step, self._replay, self._infer, verify)

    async def read(self, instruction: str, params: dict | None = None, step: str | None = None) -> str:
        """读取页面上某块区域（正文、表格、列表等）的全部文字。

        第一次由模型从文本块清单中定位区域并缓存位置，之后按缓存直接读取，不调用模型。
        适合读较长的内容；零散的字段用 extract 按 schema 提取。
        """

        async def verify(attempts: list[str]) -> None:
            return None

        return await self._step(instruction, params, step, self._reread, self._locate, verify)

    async def download(
        self, instruction: str, save_to: str | Path = ".", params: dict | None = None, step: str | None = None
    ) -> Path:
        """点击触发下载，把文件按网站给的文件名存到 save_to 目录，返回文件路径；点击位置和 act 一样缓存。

        点击后 DOWNLOAD_WAIT_MS 内没有触发下载视为这一步失败：抛出 StepFailed，不写缓存。
        """
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
            raise await self._failed(instruction, attempts + ["点击后没有触发下载"])

        # 下载可能由点击后新打开的标签页触发，新页面也要监听
        for p in self._context.pages:
            watch(p)
        self._context.on("page", watch)
        try:
            await self._step(instruction, params, step, self._replay, self._infer, verify)
        finally:
            self._context.remove_listener("page", watch)
            for p in self._context.pages:
                p.remove_listener("download", on_download)
        path = Path(save_to) / downloads[-1].suggested_filename
        path.parent.mkdir(parents=True, exist_ok=True)
        await downloads[-1].save_as(path)
        print(f"[obact] 已下载 {path}", flush=True)
        return path

    def save(self, data: Any, path: str | Path) -> Path:
        """把结果按扩展名保存为 .json / .csv / .md / .txt 文件，返回文件路径。"""
        return output.save(data, path)

    async def _step(self, instruction: str, params: dict | None, step: str | None, replay, infer, verify) -> Any:
        """S1 → fast → smart 的公共流程。

        replay(entry, params) 按缓存执行并返回结果，核对不符时抛 _Mismatch；
        infer(slot, key, 指令, params) 走模型执行，返回 (结果, 缓存条目)，条目为 None 表示不缓存；
        verify(attempts) 在执行后校验结果，不通过时抛 StepFailed，此时不写缓存、不升级；S1 回放后不通过还会删掉这条缓存，
        下次运行这一步重新走模型。
        """
        params = {k: str(v) for k, v in (params or {}).items()}
        key = cache_key(step or instruction, self.page.url)
        entry = self.cache.get(key)
        attempts: list[str] = []
        label = f"{step}：{instruction}" if step else instruction

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
                return result

        text = render(instruction, params)
        for slot in SLOTS:
            try:
                result, new_entry = await infer(slot, key, text, params)
            except (ModelError, PlaywrightError, _Miss) as e:
                attempts.append(f"{slot}：{_short(e)}")
                continue
            await verify(attempts + [f"{slot}：已执行"])
            if new_entry:
                self.cache.put(new_entry)
            status = "视觉模型执行（缓存失效，已自愈）" if entry else "视觉模型执行（无缓存）"
            self._log(slot, status, label, cached=new_entry is not None)
            return result
        raise await self._failed(label, attempts)

    async def extract(self, instruction: str, schema: Any) -> Any:
        """按 schema 提取数据，每次走模型、不缓存；schema 可以是 BaseModel 或 list[Model] 这类类型。"""
        adapter = TypeAdapter(schema)
        attempts: list[str] = []
        for slot in SLOTS:
            try:
                await snapshot.settle(self.page)
                text = await snapshot.page_text(self.page)
                image = await self.page.screenshot()
                data = await self.llm.extract(slot, instruction, text, image, adapter)
            except (ModelError, PlaywrightError) as e:
                attempts.append(f"{slot}：{_short(e)}")
                continue
            self._log(slot, "视觉模型提取", instruction)
            return data
        raise await self._failed(instruction, attempts)

    async def wait_for_human(self, message: str) -> None:
        """暂停，等人工在浏览器里完成验证后按回车继续。"""
        print(f"[obact] 等待人工：{message}", flush=True)
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

    async def _locate(self, slot: str, key: str, instruction: str, params: dict[str, str]) -> tuple[str, dict | None]:
        """read 的 S2：文本块快照 → 模型选块 → 读文字。"""
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
        return text, templatize(entry, params)

    async def _infer(self, slot: str, key: str, instruction: str, params: dict[str, str]) -> tuple[None, dict | None]:
        """act 的 S2：快照 → 模型 → 执行。返回要写入的缓存条目，参数无法模板化时条目为 None。"""
        snap = await snapshot.take(self.page)
        d = await self.llm.decide(slot, instruction, snap.text, snap.image, snap.size)
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
        return None, templatize(entry, params)

    async def _run(self, target: Locator | tuple[float, float], method: str, args: list[str]) -> None:
        """执行动作；target 是元素定位器或视口像素坐标。"""
        page = self.page
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
            raise await self._failed(instruction, attempts + [f"expect 不通过：{expect}"]) from None

    async def _failed(self, instruction: str, attempts: list[str]) -> StepFailed:
        path: Path | None = self.cache.path.with_name(f"{self.task}_failed.png")
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            await self.page.screenshot(path=str(path))
        except PlaywrightError:
            path = None
        return StepFailed(instruction, attempts, path)

    def _to_pixels(self, point) -> tuple[float, float]:
        return point[0] * self.viewport["width"], point[1] * self.viewport["height"]

    @staticmethod
    def _log(how: str, status: str, instruction: str, cached: bool = True) -> None:
        suffix = "" if cached else "（参数无法模板化，不缓存）"
        print(f"[obact] {how} {status}{suffix} | {instruction}", flush=True)


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, "").strip() or default


def _model_config() -> dict:
    """fast 槽位读 OBACT_FAST_*，没写的项用 OPENAI_URL、OPENAI_MODEL、OPENAI_KEY；smart 槽位读 OBACT_SMART_*，没写的项沿用 fast。"""
    fast = {
        "base_url": _env("OBACT_FAST_URL", _env("OPENAI_URL")),
        "model": _env("OBACT_FAST_MODEL", _env("OPENAI_MODEL")),
        "api_key": _env("OBACT_FAST_KEY", _env("OPENAI_KEY")),
        "coords": _env("OBACT_FAST_COORDS", "pixel"),
    }
    names = {"base_url": "URL", "model": "MODEL", "api_key": "KEY", "coords": "COORDS"}
    smart = {k: _env(f"OBACT_SMART_{n}", fast[k]) for k, n in names.items()}
    for slot, cfg in (("fast", fast), ("smart", smart)):
        if not cfg["base_url"] or not cfg["model"]:
            raise ValueError(
                f"{slot} 槽位缺少模型地址或模型名：在 .env 中设置 OPENAI_URL、OPENAI_MODEL，"
                f"或 OBACT_{slot.upper()}_URL、OBACT_{slot.upper()}_MODEL"
            )
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
