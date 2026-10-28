"""页面快照：注入 snapshot.js，取元素清单、编号截图和“编号 → 选择器”对照表。"""

import asyncio
import json
import time
from dataclasses import dataclass
from pathlib import Path

from playwright.async_api import Error as PlaywrightError
from playwright.async_api import Locator, Page

JS = Path(__file__).with_name("snapshot.js").read_text(encoding="utf-8")
SETTLE_QUIET_MS = 300
SETTLE_MAX_MS = 5000
MAX_TEXT = 20000  # extract 发给模型的页面文本上限（字符）
NETWORK_TYPES = {"document", "script", "xhr", "fetch"}  # settle 要等结束的请求类型；script 覆盖单页应用加载代码的阶段
STALLED_S = 2.0  # 进行超过这么久的请求视为卡住，不再等（如连不上的第三方统计脚本、长轮询）

# 每个页面进行中的请求及其开始时间，由 watch 注册的事件维护
_pending: dict[Page, dict] = {}


@dataclass
class Target:
    selector: str
    name: str


@dataclass
class Snapshot:
    text: str  # 发给模型的元素清单
    image: bytes  # 视口截图，带编号框
    size: tuple[int, int]  # 截图宽高，等于视口
    targets: dict[int, Target]  # 编号 → 选择器，不发给模型


async def ensure(page: Page) -> None:
    """注入页面脚本；已注入时脚本自己会直接返回。"""
    await page.evaluate(JS)


def watch(page: Page) -> None:
    """记录页面上进行中的文档、脚本、xhr、fetch 请求，供 settle 等待。用 Playwright 事件实现，页面感知不到。"""
    pending = _pending.setdefault(page, {})

    def start(request) -> None:
        if request.resource_type in NETWORK_TYPES:
            pending[request] = time.monotonic()

    def end(request) -> None:
        pending.pop(request, None)

    page.on("request", start)
    page.on("requestfinished", end)
    page.on("requestfailed", end)
    page.on("close", lambda _: _pending.pop(page, None))


async def settle(page: Page) -> None:
    """等页面安静：进行中的请求结束，并且 DOM 连续 SETTLE_QUIET_MS 没有变化，总共最多等 SETTLE_MAX_MS。

    请求结束后渲染又可能发出新请求，所以两个条件交替检查，直到同时满足或超时。
    参考 Stagehand 的 _waitForSettledDom：新版本同样跟踪进行中的网络请求，并忽略卡住的请求。
    """
    deadline = time.monotonic() + SETTLE_MAX_MS / 1000
    pending = _pending.get(page, {})

    def busy() -> bool:
        now = time.monotonic()
        return any(now - started < STALLED_S for started in list(pending.values()))

    try:
        await page.wait_for_load_state("domcontentloaded")
        while True:
            while busy() and time.monotonic() < deadline:
                await asyncio.sleep(0.05)
            left_ms = int((deadline - time.monotonic()) * 1000)
            if left_ms <= 0:
                return
            await ensure(page)
            await page.evaluate("([q, m]) => window.__obact.settle(q, m)", [SETTLE_QUIET_MS, left_ms])
            if not busy() or time.monotonic() >= deadline:
                return
    except PlaywrightError:
        # 等待期间发生导航，执行上下文被销毁；等新页面加载完即可
        await page.wait_for_load_state("domcontentloaded")


async def take(page: Page) -> Snapshot:
    await settle(page)
    await ensure(page)
    items = await page.evaluate("() => window.__obact.snapshot()")
    try:
        image = await page.screenshot()
    finally:
        try:
            await page.evaluate("() => window.__obact && window.__obact.clearMarks()")
        except PlaywrightError:
            pass
    size = page.viewport_size
    return Snapshot(
        text="\n".join(_line(it) for it in items),
        image=image,
        size=(size["width"], size["height"]),
        targets={it["id"]: Target("xpath=" + it["selector"], it["name"]) for it in items},
    )


async def take_blocks(page: Page) -> Snapshot:
    """read 用的快照：文本块清单 + 不带编号框的视口截图。"""
    await settle(page)
    await ensure(page)
    items = await page.evaluate("() => window.__obact.blocks()")
    image = await page.screenshot()
    size = page.viewport_size
    return Snapshot(
        text="\n".join(_block_line(it) for it in items),
        image=image,
        size=(size["width"], size["height"]),
        targets={it["id"]: Target("xpath=" + it["selector"], "") for it in items},
    )


async def name_of(page: Page, locator: Locator) -> str:
    await ensure(page)
    return await locator.evaluate("el => window.__obact.nameOf(el)")


async def opens_tab(page: Page, locator: Locator, method: str, key: str) -> bool:
    """对这个元素执行 method（press 时按 key）是否会在新标签页打开页面，规则见 snapshot.js 的 opensTab。"""
    await ensure(page)
    return await locator.evaluate("(el, [m, k]) => window.__obact.opensTab(el, m, k)", [method, key])


async def anchor(page: Page, element_id: int, values: list[str]) -> str | None:
    """为最近一次快照中的元素生成包含参数值的选择器，找不到返回 None。"""
    xpath = await page.evaluate(
        "([id, values]) => window.__obact ? window.__obact.anchor(id, values) : null", [element_id, values]
    )
    return "xpath=" + xpath if xpath else None


async def page_text(page: Page) -> str:
    return await page.evaluate("(n) => (document.body ? document.body.innerText : '').slice(0, n)", MAX_TEXT)


def _line(it: dict) -> str:
    parts = [f"[{it['id']}]", it["tag"]]
    if it["type"]:
        parts.append(f"type={it['type']}")
    if it["role"]:
        parts.append(f"role={it['role']}")
    if it["name"]:
        parts.append(json.dumps(it["name"], ensure_ascii=False))
    if it["value"]:
        parts.append("value=" + json.dumps(it["value"], ensure_ascii=False))
    if it.get("options"):
        parts.append("options=" + json.dumps(it["options"], ensure_ascii=False))
    x, y, w, h = it["rect"]
    parts.append(f"@({x},{y},{w}x{h})")
    if not it["inView"]:
        parts.append("屏幕外")
    return " ".join(parts)


def _block_line(it: dict) -> str:
    preview = it["preview"] + ("…" if it["length"] > len(it["preview"]) else "")
    x, y, w, h = it["rect"]
    line = f"[{it['id']}] {it['tag']} {json.dumps(preview, ensure_ascii=False)}（{it['length']} 字）@({x},{y},{w}x{h})"
    return line if it["inView"] else line + " 屏幕外"
