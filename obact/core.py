"""Obact 编排层：act / extract / wait_for_human。缓存命中走 S1，未命中或 S1 失败走 S2（先 fast 后 smart）。"""

import asyncio
from pathlib import Path
from typing import Any, Self

import yaml
from playwright.async_api import Error as PlaywrightError
from playwright.async_api import Locator, Page, async_playwright
from pydantic import TypeAdapter

from . import snapshot
from .cache import Cache, cache_key, render, templatize, untemplated
from .llm import LLM, SLOTS, ModelError

S1_WAIT_MS = 3000  # S1 等缓存元素出现的时间
ACTION_TIMEOUT_MS = 5000
EXPECT_TIMEOUT_MS = 10000

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


class Obact:
    def __init__(self, task: str, config: str = "obact.yaml"):
        cfg = yaml.safe_load(Path(config).read_text(encoding="utf-8"))
        self.task = task
        self.viewport = cfg["viewport"]
        self.headless = cfg.get("headless", False)
        # 为空时 Playwright 使用临时目录；指定目录可以跨运行保留登录状态和 cookie
        self.user_data_dir = cfg.get("user_data_dir", "")
        self.executable_path = cfg.get("executable_path")
        self.cache = Cache(Path(cfg.get("cache_dir", ".obact")) / f"{task}.jsonl")
        self.llm = LLM(cfg["models"])

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
        except BaseException:
            await self._pw.stop()
            raise
        return self

    async def __aexit__(self, *exc) -> None:
        await self._context.close()
        await self._pw.stop()

    @property
    def page(self) -> Page:
        """当前页面；点击打开新标签页后，后续步骤作用在最新打开的页面上。"""
        return self._context.pages[-1]

    async def act(self, instruction: str, params: dict | None = None, step: str | None = None, expect: str | None = None) -> None:
        """执行一步操作。

        instruction 中用 {名称} 占位，值由 params 提供；step 用于区分同一页面上相同的指令；
        expect 为执行后校验：以 http://、https:// 或 ** 开头时按 URL 模式等待，否则按选择器等待元素可见。
        """
        params = {k: str(v) for k, v in (params or {}).items()}
        key = cache_key(step or instruction, self.page.url)
        entry = self.cache.get(key)
        attempts: list[str] = []

        if entry:
            error = await self._replay(entry, params)
            if error is None:
                await self._expect(expect, instruction, attempts + ["S1：已执行"])
                self._log("S1", "命中", instruction)
                return
            attempts.append(f"S1：{error}")

        text = render(instruction, params)
        for slot in SLOTS:
            try:
                new_entry = await self._infer(slot, key, text, params)
            except (ModelError, PlaywrightError, _Miss) as e:
                attempts.append(f"{slot}：{_short(e)}")
                continue
            await self._expect(expect, instruction, attempts + [f"{slot}：已执行"])
            if new_entry:
                self.cache.put(new_entry)
            self._log(slot, "自愈" if entry else "未命中", instruction, cached=new_entry is not None)
            return
        raise await self._failed(instruction, attempts)

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
            self._log(slot, "提取", instruction)
            return data
        raise await self._failed(instruction, attempts)

    async def wait_for_human(self, message: str) -> None:
        """暂停，等人工在浏览器里完成验证后按回车继续。"""
        print(f"[obact] 等待人工：{message}", flush=True)
        await asyncio.to_thread(input, "完成后按回车继续...")

    async def _replay(self, entry: dict, params: dict[str, str]) -> str | None:
        """S1：核对通过就执行。成功返回 None，否则返回失败原因。"""
        method = entry["method"]
        args = [render(a, params) for a in entry.get("args", [])]
        try:
            if "point" in entry:
                await snapshot.settle(self.page)
                await self._run(self._to_pixels(entry["point"]), method, args)
                return None
            loc = self.page.locator(render(entry["selector"], params))
            try:
                await loc.first.wait_for(state="visible", timeout=S1_WAIT_MS)
            except PlaywrightError:
                return "选择器没有匹配到可见元素"
            count = await loc.count()
            if count != 1:
                return f"选择器匹配到 {count} 个元素"
            name = await snapshot.name_of(self.page, loc)
            expected = render(entry.get("name", ""), params)
            if name != expected:
                return f"名称不一致（缓存 {expected!r}，页面 {name!r}）"
            await self._run(loc, method, args)
            return None
        except PlaywrightError as e:
            return f"执行出错：{_short(e)}"

    async def _infer(self, slot: str, key: str, instruction: str, params: dict[str, str]) -> dict | None:
        """S2：快照 → 模型 → 执行。返回要写入的缓存条目，参数无法模板化时返回 None。"""
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
        return templatize(entry, params)

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
                await self.page.wait_for_url(expect, timeout=EXPECT_TIMEOUT_MS)
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


def _short(e: Exception) -> str:
    """Playwright 的报错带多行调用日志，只取第一行。"""
    lines = str(e).strip().splitlines()
    return lines[0] if lines else type(e).__name__
