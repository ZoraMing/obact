"""浏览器 + 本地测试页 + 假模型的功能测试：不访问外网、不调用真实模型。

需要缓存的功能都跑两遍：第一遍由假模型决策并写缓存，第二遍按缓存回放，模型调用为 0。
"""

import json
import re
import time

import pytest
from pages import FULL_TITLE
from support import center, click, element, run

from obact import StepFailed, snapshot


def _entries(cache_dir, task="t") -> list[dict]:
    path = cache_dir / task / "steps.jsonl"
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


# ---------- hover ----------


def test_hover_menu_two_passes(site, fake, make_ob, cache_dir):
    def decide(ins, lst):
        if "悬停" in ins:
            return click(lst, "产品", method="hover")
        return click(lst, "手机")

    fake.on_act = decide

    async def go():
        async with make_ob() as ob:
            await ob.goto(site + "/hover")
            await ob.act("悬停在产品菜单上")
            assert ob.last_step["method"] == "hover"
            await ob.act("点击子菜单里的手机", expect="text=已选择手机")

    run(go())
    assert fake.calls["act"] == 2
    assert [e["method"] for e in _entries(cache_dir)] == ["hover", "click"]
    fake.calls.clear()
    run(go())
    assert fake.model_calls == 0


def test_hover_by_point(site, fake, make_ob):
    fake.on_act = lambda ins, lst: {"found": True, "id": None, "point": list(center(lst, "产品")), "method": "hover",
                                    "args": []}

    async def go():
        async with make_ob() as ob:
            await ob.goto(site + "/hover")
            await ob.act("悬停在产品菜单上")
            assert ob.last_step["method"] == "hover" and "point" in ob.last_step
            assert await ob.page.is_visible("text=手机")

    run(go())


def test_page_state_keeps_hover(site, fake, make_ob):
    """编号框不抢鼠标：悬停后拍快照，子菜单仍然展开，清单里能看到子菜单项。"""
    fake.on_act = lambda ins, lst: click(lst, "产品", method="hover")

    async def go():
        async with make_ob() as ob:
            await ob.goto(site + "/hover")
            await ob.act("悬停在产品菜单上")
            snap = await ob.page_state()
            assert '"手机"' in snap.text
            await ob.act("点击子菜单里的手机", element_id=element(snap.text, "手机"), expect="text=已选择手机")
            assert ob.last_step["how"] == "编号"

    run(go())


# ---------- blocked ----------


def test_blocked_presses_escape_and_retries(site, fake, make_ob):
    def decide(ins, lst):
        if '"立即购买"' in lst:
            return click(lst, "立即购买")
        return {"found": False, "blocked": True, "reason": "订阅弹窗挡住了按钮"}

    fake.on_act = decide

    async def go():
        async with make_ob() as ob:
            await ob.goto(site + "/blocked")
            await ob.act("点击立即购买按钮", expect="text=购买成功")

    run(go())
    assert fake.slots == ["fast", "fast"]  # 同一槽位：先报告被挡住，按 Escape 后再判断


def test_blocked_that_escape_cannot_close(site, fake, make_ob):
    fake.on_act = lambda ins, lst: {"found": False, "blocked": True, "reason": "遮罩挡住了按钮"}

    async def go():
        async with make_ob() as ob:
            await ob.goto(site + "/stuck")
            with pytest.raises(StepFailed) as info:
                await ob.act("点击立即购买按钮")
            return info.value

    err = run(go())
    assert fake.slots == ["fast", "fast", "smart", "smart"]
    assert not err.executed
    assert len(err.attempts) == 2 and all("遮罩挡住了按钮" in a for a in err.attempts)


# ---------- scroll ----------


def test_scroll_loads_more_until_bottom(site, fake, make_ob, cache_dir):
    # 滚到底后清单里有 50 个“加入购物车”，第 35 个属于商品 35；验证 act 能操作滚动后才加载的元素
    fake.on_act = lambda ins, lst: click(lst, "加入购物车", nth=34)

    async def go():
        async with make_ob() as ob:
            await ob.goto(site + "/scroll")
            positions = []
            for _ in range(20):
                before, after = await ob.scroll()
                positions.append((before, after))
                if before == after:
                    break
            assert positions[0][1] > positions[0][0]
            assert positions[-1][0] == positions[-1][1], "最后一次滚动应报告已到底"
            assert "商品 50" in await ob.page.inner_text("#list")
            await ob.act("点击 {name} 那一行的加入购物车按钮", params={"name": "商品 35"}, expect="text=已加入商品 35")

    run(go())
    fake.calls.clear()
    run(go())
    assert fake.model_calls == 0


def test_scroll_invalidates_element_ids(site, fake, make_ob):
    fake.on_act = lambda ins, lst: click(lst, "加入购物车")

    async def go():
        async with make_ob() as ob:
            await ob.goto(site + "/scroll")
            snap = await ob.page_state()
            await ob.scroll()
            await ob.act("点击第一个加入购物车按钮", element_id=element(snap.text, "加入购物车"))
            assert ob.last_step["how"] == "fast", "scroll 后编号失效，应转模型"

    run(go())


def test_scroll_keeps_hover(site, fake, make_ob):
    fake.on_act = lambda ins, lst: click(lst, "产品", method="hover")

    async def go():
        async with make_ob() as ob:
            await ob.goto(site + "/hover")
            await ob.act("悬停在产品菜单上")
            await ob.scroll()
            assert await ob.page.is_visible("text=手机"), "scroll 不应移动鼠标"

    run(go())


# ---------- wait_for ----------


def test_wait_for_condition(site, fake, make_ob):
    async def go():
        async with make_ob() as ob:
            await ob.goto(site + "/slow")
            assert "加载中" in await ob.page.inner_text("#box"), "接口 3 秒才返回，settle 等不到"
            await ob.wait_for("text=查看结果", 10)
            assert await ob.page.is_visible("text=查看结果")
            await ob.wait_for("**/slow", 2)

    run(go())


def test_wait_for_timeout(site, fake, make_ob):
    async def go():
        async with make_ob() as ob:
            await ob.goto(site + "/hover")
            start = time.monotonic()
            with pytest.raises(TimeoutError):
                await ob.wait_for("text=不存在的内容", 1)
            assert time.monotonic() - start < 4

    run(go())


def test_wait_for_fixed_duration(site, fake, make_ob):
    async def go():
        async with make_ob() as ob:
            await ob.goto(site + "/slow")
            start = time.monotonic()
            await ob.wait_for(timeout=4)
            assert time.monotonic() - start >= 4
            assert await ob.page.is_visible("text=查看结果")

    run(go())


def test_wait_for_human_until(site, fake, make_ob):
    async def go():
        async with make_ob() as ob:
            await ob.goto(site + "/slow")
            await ob.wait_for_human("等页面加载", until="text=查看结果", timeout=10)
            with pytest.raises(TimeoutError, match="等待人工超时"):
                await ob.wait_for_human("等不到", until="text=没有", timeout=1)

    run(go())


# ---------- upload ----------


def test_upload_two_passes(site, fake, make_ob, tmp_path):
    files = [tmp_path / "a.txt", tmp_path / "b.txt"]
    for f in files:
        f.write_text(f.name, encoding="utf-8")
    fake.on_act = lambda ins, lst: click(lst, "上传附件")

    async def go():
        async with make_ob() as ob:
            await ob.goto(site + "/upload")
            await ob.upload("点击上传附件按钮", files)
            assert await ob.page.inner_text("#r") == "已选择：a.txt,b.txt"

    run(go())
    fake.calls.clear()
    run(go())
    assert fake.model_calls == 0


def test_upload_errors(site, fake, make_ob, tmp_path, cache_dir):
    files = [tmp_path / "a.txt", tmp_path / "b.txt"]
    for f in files:
        f.write_text(f.name, encoding="utf-8")

    def decide(ins, lst):
        return click(lst, "上传头像" if "头像" in ins else "没有选择框的按钮")

    fake.on_act = decide

    async def go():
        async with make_ob() as ob:
            await ob.goto(site + "/upload")
            with pytest.raises(FileNotFoundError):
                await ob.upload("点击上传附件按钮", tmp_path / "不存在.txt")
            with pytest.raises(StepFailed) as single:
                await ob.upload("点击上传头像按钮", files)
            with pytest.raises(StepFailed) as none:
                await ob.upload("点击没有选择框的按钮", files[0])
            return single.value, none.value

    single, none = run(go())
    assert single.executed and "文件选择框只能选一个文件" in single.attempts
    assert none.executed and "点击后没有打开文件选择框" in none.attempts
    assert _entries(cache_dir) == [], "失败的上传不写缓存"


# ---------- 伪元素名称、事件委托元素 ----------


def test_pseudo_element_names(site, fake, make_ob):
    fake.on_act = lambda ins, lst: click(lst, "删除", nth=1 if "订单 B" in ins else 0)

    async def go(name):
        async with make_ob() as ob:
            await ob.goto(site + "/pseudo")
            snap = await ob.page_state()
            assert snap.text.count('"删除"') == 2 and snap.text.count('"编辑"') == 2
            await ob.act("点击 {name} 那一行的删除按钮", params={"name": name}, expect=f"text=已删除{name}")
            assert ob.last_step["name"] == "删除"

    run(go("订单 B"))
    fake.calls.clear()
    run(go("订单 A"))  # 换参数回放：参数锚定到“订单 A”那一行
    assert fake.model_calls == 0


def test_event_delegation_cells_in_list(site, fake, make_ob):
    def decide(ins, lst):
        day = re.search(r"(\d+) 号", ins).group(1)
        return click(lst, day)

    fake.on_act = decide

    async def go(day):
        async with make_ob() as ob:
            await ob.goto(site + "/calendar")
            await ob.act("点击日历里的 {day} 号", params={"day": day}, expect=f"text=已选择 {day} 号")

    run(go("12"))
    fake.calls.clear()
    run(go("5"))
    assert fake.model_calls == 0


# ---------- extract 的结构化文本 ----------


def test_page_text_lines_have_coordinates(site, fake, make_ob):
    async def go():
        async with make_ob() as ob:
            await ob.goto(site + "/calendar")
            text = await snapshot.page_text(ob.page)
            await ob.goto(site + "/hover")
            hidden = await snapshot.page_text(ob.page)
            return text, hidden

    text, hidden = run(go())
    lines = text.splitlines()
    assert all(re.search(r"@\(-?\d+,-?\d+,\d+x\d+\)( 屏幕外)?$", line) for line in lines), text
    assert f"[title: {FULL_TITLE}]" in text
    assert any(line.startswith("¥380 ") for line in lines), "价格单独成行，带坐标"
    assert "手机" not in hidden, "display:none 的子菜单不在文字里"


def test_extract_sends_schema(site, fake, make_ob):
    fake.on_extract = lambda ins, page: {"title": FULL_TITLE}

    async def go():
        from pydantic import BaseModel

        class Book(BaseModel):
            title: str

        async with make_ob() as ob:
            await ob.goto(site + "/calendar")
            return await ob.extract("书名", Book)

    assert run(go()).title == FULL_TITLE
    schema = fake.schemas[-1]
    assert schema["properties"]["data"]["properties"]["title"]["type"] == "string"


# ---------- 动作没有效果 ----------


def test_no_effect_escalates_and_does_not_cache(site, fake, make_ob, cache_dir):
    fake.on_act = lambda ins, lst: click(lst, "无效按钮")

    async def go():
        async with make_ob() as ob:
            await ob.goto(site + "/effect")
            with pytest.raises(StepFailed) as info:
                await ob.act("点击无效按钮")
            return info.value

    err = run(go())
    assert fake.slots == ["fast", "smart"]
    assert err.executed and all("没有任何变化" in a for a in err.attempts)
    assert _entries(cache_dir) == []


# 姓名输入框没有名称，element 按清单行里的 value="张三" 找到它
@pytest.mark.parametrize("instruction, decide", [
    ("点击保存按钮", lambda lst: click(lst, "保存")),  # 改 DOM
    ("勾选同意条款", lambda lst: click(lst, "同意条款")),  # 只改 checked 属性
    ("点击姓名输入框", lambda lst: click(lst, "张三")),  # 只改焦点
    ("在姓名输入框输入 张三", lambda lst: click(lst, "张三", method="fill", args=["张三"])),  # 填入与原值相同的内容
])
def test_actions_with_effect_are_cached(site, fake, make_ob, cache_dir, instruction, decide):
    fake.on_act = lambda ins, lst: decide(lst)

    async def go():
        async with make_ob() as ob:
            await ob.goto(site + "/effect")
            await ob.act(instruction)

    run(go())
    assert len(_entries(cache_dir)) == 1


def test_no_effect_not_checked_with_expect(site, fake, make_ob, cache_dir):
    fake.on_act = lambda ins, lst: click(lst, "无效按钮")

    async def go():
        async with make_ob() as ob:
            await ob.goto(site + "/effect")
            await ob.act("点击无效按钮", expect="text=设置")

    run(go())
    assert len(_entries(cache_dir)) == 1


def test_s1_no_effect_deletes_entry(site, fake, make_ob, cache_dir):
    fake.on_act = lambda ins, lst: click(lst, "保存")

    async def go(inert):
        async with make_ob() as ob:
            await ob.goto(site + "/effect")
            if inert:
                await ob.page.evaluate("document.querySelectorAll('button')[1].onclick = null")
                with pytest.raises(StepFailed) as info:
                    await ob.act("点击保存按钮")
                return info.value
            await ob.act("点击保存按钮")

    run(go(False))
    assert len(_entries(cache_dir)) == 1
    err = run(go(True))
    assert err.attempts[0].startswith("S1：") and "没有任何变化" in err.attempts[0]
    assert _entries(cache_dir) == [], "S1 回放没有效果时删除这条缓存"


# ---------- 失败截图、缓存目录 ----------


def test_failure_screenshot_taken_before_waiting(site, fake, make_ob, cache_dir):
    fake.on_act = lambda ins, lst: click(lst, "登录")

    async def go():
        async with make_ob() as ob:
            await ob.goto(site + "/login")
            with pytest.raises(StepFailed) as info:
                await ob.act("点击登录按钮", expect="#welcome")
            # 提示 1.5 秒后消失；expect 等满 10 秒后的页面上已经没有它
            return info.value, await ob.page.screenshot()

    err, now = run(go())
    assert err.screenshot == cache_dir / "t" / "failed.png"
    assert err.screenshot.read_bytes() != now, "失败截图应在提示消失前拍下"


def test_cache_layout(site, fake, make_ob, cache_dir):
    fake.on_act = lambda ins, lst: click(lst, "保存")

    async def go():
        async with make_ob("任务甲") as ob:
            await ob.goto(site + "/effect")
            await ob.act("点击保存按钮")

    run(go())
    assert (cache_dir / "任务甲" / "steps.jsonl").exists()
    assert (cache_dir / "vision_checked.json").exists()
    assert not list(cache_dir.glob("*.jsonl")), "缓存文件只在任务文件夹里"
