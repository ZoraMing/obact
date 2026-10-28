"""OSWorld 风格 Web 任务 5：社区/后台状态变更

任务：登录 Conduit 社区，发布一篇新文章并发表评论，再修改文章简介；到个人主页的文章列表里找到这篇文章，
     把文章正文、评论和修改记录保存为 JSON；最后删除评论和文章，恢复原状。
站点：https://conduit.bondaracademy.com（RealWorld 社区练习站，允许自由注册）
覆盖的特性：自动登录（act 填写登录或注册表单）；自动登录失败时 wait_for_human 等人工登录；
           设置 OBACT_USER_DATA_DIR 时复用已有的登录态；read 读取文章正文；按评论内容参数化定位删除图标。
登录账号：依次使用 .env 中的 CONDUIT_EMAIL、CONDUIT_PASSWORD，上次自动注册并保存在
         workspace/outputs/tasks/community/account.json 的测试账号；都没有或登录失败时在注册页新建一个测试账号并保存。
说明：文章页的 URL 里带文章标识，每次运行都不同，这部分步骤每次都会调用模型。发布文章后中途失败时，直接删除文章再退出。
校验：read 读到文章正文；评论发表后出现在文章下（expect）；个人主页文章列表里有这篇文章且简介已更新；
     评论已删除；删除文章后回到首页（expect）。
"""

import asyncio
import json
import os
import secrets
import time
from pathlib import Path

from common import Checks, out_dir
from playwright.async_api import Error as PlaywrightError
from pydantic import BaseModel

from obact import Obact, StepFailed

SITE = "https://conduit.bondaracademy.com/"


class Preview(BaseModel):
    title: str
    description: str


async def logged_in(ob: Obact) -> bool:
    # 导航栏按登录状态渲染，登录态可能晚于页面其他部分出现，等 New Article 链接最多 5 秒
    try:
        await ob.page.locator("a[href='/editor']").wait_for(timeout=5000)
    except PlaywrightError:
        return False
    return True


def saved_account(path: Path) -> dict | None:
    """.env 中的账号优先，其次是上次自动注册保存的测试账号。"""
    email, password = os.environ.get("CONDUIT_EMAIL"), os.environ.get("CONDUIT_PASSWORD")
    if email and password:
        return {"email": email, "password": password}
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else None


async def login(ob: Obact, account_file: Path) -> None:
    """自动登录：有账号先登录，没有账号或登录失败时注册一个测试账号并保存；都失败时等人工登录。"""
    account = saved_account(account_file)
    try:
        if account:
            try:
                await ob.act("点击顶部导航的 Sign in", expect="**/login")
                await ob.act("在 Email 输入框输入 {email}", params={"email": account["email"]})
                await ob.act("在 Password 输入框输入 {password}", params={"password": account["password"]})
                await ob.act("点击 Sign in 按钮", expect="a[href='/editor']")
                return
            except StepFailed as e:
                # 练习站的数据可能被清空，账号失效时改为注册新账号
                print(f"账号 {account['email']} 登录失败，改为注册新账号：{e}")
                await ob.page.goto(SITE)
        suffix = secrets.token_hex(4)
        account = {"username": f"obact{suffix}", "email": f"obact.{suffix}@example.com", "password": f"Obact-{suffix}"}
        await ob.act("点击顶部导航的 Sign up", expect="**/register")
        await ob.act("在 Username 输入框输入 {username}", params={"username": account["username"]})
        await ob.act("在 Email 输入框输入 {email}", params={"email": account["email"]})
        await ob.act("在 Password 输入框输入 {password}", params={"password": account["password"]})
        await ob.act("点击 Sign up 按钮", expect="a[href='/editor']")
        ob.save(account, account_file)
        print(f"已注册测试账号 {account['email']}，保存在 {account_file}")
    except StepFailed as e:
        print(f"自动登录失败：{e}")
        await ob.wait_for_human("请在打开的浏览器里登录 Conduit（没有账号先点 Sign up 注册），登录后回到这里")
        await ob.page.goto(SITE)


async def main():
    checks = Checks("community")
    out = out_dir("community")
    stamp = time.strftime("%Y%m%d-%H%M%S")
    title = f"Obact test {stamp}"
    comment = f"Obact comment {stamp}"
    new_desc = f"Updated by Obact at {stamp}"

    async with Obact(task="task_community") as ob:
        await ob.page.goto(SITE)
        if not await logged_in(ob):
            await login(ob, out / "account.json")
        checks.check(await logged_in(ob), "已登录")

        # 发布文章
        await ob.act("点击顶部导航的 New Article", expect="**/editor")
        await ob.act("在 Article Title 输入框输入 {title}", params={"title": title})
        await ob.act("在文章简介输入框输入 {desc}", params={"desc": "Published by Obact"})
        await ob.act("在文章正文输入框输入 {body}", params={"body": "This article was created by an Obact task."})
        await ob.act("点击 Publish Article 按钮", expect="**/article/**")
        article_url = ob.page.url
        try:
            body = await ob.read("文章正文")

            # 发表评论
            await ob.act("在评论输入框输入 {comment}", params={"comment": comment})
            await ob.act("点击 Post Comment 按钮", expect=f"text={comment}")

            # 状态变更：修改文章简介
            await ob.act("点击 Edit Article 按钮", expect="**/editor/**")
            await ob.act("在文章简介输入框输入 {desc}", params={"desc": new_desc}, step="修改文章简介")
            await ob.act("点击 Publish Article 按钮", expect="**/article/**", step="更新文章")

            # 在个人主页的文章列表里找到这篇文章。文章页更新后顶部导航可能不显示用户名，从作者名进入个人主页
            await ob.act("点击文章标题下方作者的用户名", expect="**/profile/**")
            previews = await ob.extract("文章列表里每篇文章的标题和简介", schema=list[Preview])
            print(f"个人主页的文章：{[p.title for p in previews]}")
            found = [p for p in previews if p.title == title]
            if found:
                await ob.act("点击标题为 {title} 的文章", params={"title": title}, expect="**/article/**")
            else:
                await ob.page.goto(article_url)
            record = {"title": title, "url": article_url, "body": body, "comment": comment, "description": new_desc}
            ob.save(record, out / "article.json")

            # 清理：删除评论和文章，不论上面是否找到
            await ob.act("点击评论 {comment} 下方的删除图标", params={"comment": comment})
            comment_gone = await ob.page.locator(f"text={comment}").count() == 0
            await ob.act("点击 Delete Article 按钮", expect=SITE)
        except Exception:
            # 中途失败时直接删除文章再退出，评论挂在文章下，不把测试内容留在站点上
            await ob.page.goto(article_url)
            await ob.page.get_by_role("button", name="Delete Article").first.click(timeout=5000)
            raise

    checks.check("created by an Obact task" in body, "read 读到了文章正文")
    checks.check(bool(found), "个人主页文章列表里有这篇文章")
    checks.check(any(p.description == new_desc for p in found), "文章简介已更新")
    checks.check(comment_gone, "评论已删除")
    checks.finish()


if __name__ == "__main__":
    asyncio.run(main())
