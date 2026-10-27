"""页面快照：注入 snapshot.js，取元素清单、编号截图和“编号 → 选择器”对照表。"""

import json
from dataclasses import dataclass
from pathlib import Path

from playwright.async_api import Error as PlaywrightError
from playwright.async_api import Locator, Page

JS = Path(__file__).with_name("snapshot.js").read_text(encoding="utf-8")
SETTLE_QUIET_MS = 300
SETTLE_MAX_MS = 3000
MAX_TEXT = 20000  # extract 发给模型的页面文本上限（字符）


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


async def settle(page: Page) -> None:
    """等页面加载完、DOM 停止变化。"""
    try:
        await page.wait_for_load_state("domcontentloaded")
        await ensure(page)
        await page.evaluate("([q, m]) => window.__obact.settle(q, m)", [SETTLE_QUIET_MS, SETTLE_MAX_MS])
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


async def name_of(page: Page, locator: Locator) -> str:
    await ensure(page)
    return await locator.evaluate("el => window.__obact.nameOf(el)")


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
