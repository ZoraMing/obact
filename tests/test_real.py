"""用 .env 里真实模型的测试（本地测试页），加 --real 运行：pytest tests/test_real.py --real

检查模型能不能按提示词用好各项功能；能缓存的场景跑两遍，第二遍按缓存回放、模型调用为 0。
"""

import pytest
from pages import CALENDAR, FULL_TITLE
from pydantic import BaseModel
from support import run

from obact import StepFailed

pytestmark = pytest.mark.real


def _twice(real, go):
    """跑两遍：第一遍应调用模型，第二遍应全部按缓存回放。"""
    run(go())
    assert real.calls["n"] > 0
    real.calls["n"] = 0
    run(go())
    assert real.calls["n"] == 0, "第二遍应全部按缓存回放"


def test_hover(site, real):
    async def go():
        async with real() as ob:
            await ob.goto(site + "/hover")
            await ob.act("悬停在顶部导航的产品菜单上")
            assert ob.last_step["method"] == "hover"
            await ob.act("点击产品子菜单里的手机", expect="text=已选择手机")

    _twice(real, go)


def test_blocked(site, real):
    async def go():
        async with real() as ob:
            await ob.goto(site + "/blocked")
            await ob.act("点击立即购买按钮", expect="text=购买成功")

    run(go())


def test_scroll(site, real):
    async def go():
        async with real() as ob:
            await ob.goto(site + "/scroll")
            for _ in range(10):
                if "商品 35" in await ob.page.inner_text("#list"):
                    break
                await ob.scroll()
            await ob.act("点击 {name} 那一行的加入购物车按钮", params={"name": "商品 35"}, expect="text=已加入商品 35")

    _twice(real, go)


def test_wait_for(site, real):
    async def go():
        async with real() as ob:
            await ob.goto(site + "/slow")
            await ob.wait_for("text=查看结果", 10)
            await ob.act("点击查看结果按钮", expect="text=结果详情")

    _twice(real, go)


def test_upload(site, real, tmp_path):
    files = [tmp_path / "a.txt", tmp_path / "b.txt"]
    for f in files:
        f.write_text(f.name, encoding="utf-8")

    async def go():
        async with real() as ob:
            await ob.goto(site + "/upload")
            await ob.upload("点击上传附件按钮", files)
            assert await ob.page.inner_text("#r") == "已选择：a.txt,b.txt"

    _twice(real, go)


def test_pseudo_element_button(site, real):
    async def go(name):
        async with real() as ob:
            await ob.goto(site + "/pseudo")
            await ob.act("点击 {name} 那一行的删除按钮", params={"name": name}, expect=f"text=已删除{name}")
            assert ob.last_step["name"] == "删除"

    run(go("订单 B"))
    real.calls["n"] = 0
    run(go("订单 A"))
    assert real.calls["n"] == 0


def test_event_delegation_cell(site, real):
    async def go(day):
        async with real() as ob:
            await ob.goto(site + "/calendar")
            await ob.act("点击日历里的 {day} 号", params={"day": day}, expect=f"text=已选择 {day} 号")

    run(go("12"))
    real.calls["n"] = 0
    run(go("5"))
    assert real.calls["n"] == 0


class Day(BaseModel):
    day: int
    price: float | None


class Book(BaseModel):
    title: str


def test_extract_calendar_alignment(site, real):
    async def go():
        async with real() as ob:
            await ob.goto(site + "/calendar")
            return await ob.extract("日历里每一天的日期和价格（数字，不含 ¥），没有价格的那天 price 填 null", list[Day])

    got = {d.day: d.price for d in run(go())}
    assert got == CALENDAR


def test_extract_single_field_object(site, real):
    async def go():
        async with real() as ob:
            await ob.goto(site + "/calendar")
            return [await ob.extract("页面上那本书的完整书名", Book) for _ in range(3)]

    assert all(book.title == FULL_TITLE for book in run(go()))


def test_no_effect(site, real):
    async def go():
        async with real() as ob:
            await ob.goto(site + "/effect")
            with pytest.raises(StepFailed) as info:
                await ob.act("点击无效按钮")
            return info.value

    err = run(go())
    assert err.executed and all("没有任何变化" in a for a in err.attempts)


def test_failure_screenshot(site, real):
    async def go():
        async with real() as ob:
            await ob.goto(site + "/login")
            with pytest.raises(StepFailed) as info:
                await ob.act("点击登录按钮", expect="#welcome")
            return info.value, await ob.page.screenshot()

    err, now = run(go())
    assert err.screenshot and err.screenshot.read_bytes() != now
