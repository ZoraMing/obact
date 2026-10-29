"""访问外网练习站 the-internet.herokuapp.com、用 .env 里真实模型的测试，加 --site 运行：pytest tests/test_site.py --site

只读或只做练习站允许的操作（悬停、滚动、上传测试文件、错误密码登录），不改动站点数据。
"""

import pytest
from pydantic import BaseModel
from support import run

from obact import StepFailed

pytestmark = pytest.mark.site
SITE = "https://the-internet.herokuapp.com"


def test_hover_reveals_profile_link(real):
    async def go():
        async with real("site") as ob:
            await ob.goto(SITE + "/hovers")
            await ob.act("悬停在第一张用户头像上")
            assert ob.last_step["method"] == "hover"
            await ob.act("点击第一张头像下方出现的 View profile 链接", expect="**/users/1")

    run(go())


def test_entry_ad_does_not_misclick(real):
    """进入页面就弹出广告框：模型应报告被挡住（按 Escape 关不掉时最后失败），不能绕过弹框点到别处。"""

    async def go():
        async with real("site") as ob:
            await ob.goto(SITE + "/entry_ad")
            await ob.wait_for("text=This is a modal window", 10)
            try:
                await ob.act("点击正文里的 click here 链接")
            except StepFailed as e:
                return e
            return None

    err = run(go())
    if err is not None:
        assert not err.executed, f"不应执行动作：{err.attempts}"
        assert any("挡" in a or "弹" in a for a in err.attempts), err.attempts


def test_infinite_scroll(real):
    async def go():
        async with real("site") as ob:
            await ob.goto(SITE + "/infinite_scroll")
            count = lambda: ob.page.locator(".jscroll-added").count()
            first = await count()
            for _ in range(3):
                await ob.scroll()
            assert await count() > first

    run(go())


def test_dynamic_loading_wait_for(real):
    async def go():
        async with real("site") as ob:
            await ob.goto(SITE + "/dynamic_loading/2")
            await ob.act("点击 Start 按钮")
            await ob.wait_for("text=Hello World!", 20)

    run(go())


def test_upload_file(real, tmp_path):
    file = tmp_path / "obact-upload-test.txt"
    file.write_text("obact upload test", encoding="utf-8")

    async def go():
        async with real("site") as ob:
            await ob.goto(SITE + "/upload")
            await ob.upload("点击选择文件的输入框", file)
            await ob.act("点击 Upload 按钮", expect="text=File Uploaded!")
            assert (await ob.page.inner_text("#uploaded-files")).strip() == file.name

    run(go())


class Row(BaseModel):
    last_name: str
    first_name: str
    email: str
    due: float
    web_site: str


def test_extract_table(real):
    async def go():
        async with real("site") as ob:
            await ob.goto(SITE + "/tables")
            return await ob.extract("Example 1 表格里的每一行（due 只填数字）", list[Row])

    rows = {r.email: r.due for r in run(go())}
    assert rows == {"jsmith@gmail.com": 50.0, "fbach@yahoo.com": 51.0, "jdoe@hotmail.com": 100.0,
                    "tconway@earthlink.net": 50.0}


def test_wrong_password_screenshot(real):
    async def go():
        async with real("site") as ob:
            await ob.goto(SITE + "/login")
            await ob.act("在 Username 输入框输入 {user}", params={"user": "tomsmith"})
            await ob.act("在 Password 输入框输入 {password}", params={"password": "wrong-password"})
            with pytest.raises(StepFailed) as info:
                await ob.act("点击 Login 按钮", expect="**/secure")
            return info.value

    err = run(go())
    assert err.executed and err.screenshot and err.screenshot.exists()
