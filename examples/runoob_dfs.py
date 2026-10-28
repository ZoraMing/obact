"""示例：在菜鸟教程（runoob.com）找讲深度优先搜索（DFS）、并且带 Python 代码的教程，给出多个结果。

这个任务不一定有确定的解：站内可能没有完全符合的文章，也可能有好几篇。取舍交给代码：
依次换用几个搜索词，每个搜索词最多看 MAX_PAGES 页搜索结果，按标题排序后逐个打开，
先用代码规则筛（正文提到深度优先、有 Python 函数定义），再让模型分级：DFS 是文章主题且有实现代码为“符合”，
有专门讲 DFS 的部分且有实现代码为“部分符合”。收集到 WANT 篇“符合”，或模型判断了 MAX_JUDGE 篇后停止，
按“符合、部分符合”的顺序列出全部结果；都不符合时如实报告未找到，并列出看过的文章和原因。

在仓库根目录运行：python examples/runoob_dfs.py
第一次运行时搜索、打开结果等步骤走模型并写入 .obact/runoob_dfs.jsonl；再次运行时这些步骤按缓存回放，
提取搜索结果、判断文章和读取代码仍然调用模型。结果写到 workspace/outputs/runoob_dfs/result.json。
"""

import asyncio
import re
from pathlib import Path
from typing import Literal

from pydantic import BaseModel

from obact import Obact, StepFailed

HOME = "https://www.runoob.com/"
TERMS = ["深度优先搜索", "DFS", "深度优先遍历"]  # 依次尝试，结果还不够时换下一个
WANT = 3  # 收集到这么多篇“符合”就停
MAX_PAGES = 2  # 每个搜索词最多看几页搜索结果
MAX_JUDGE = 8  # 最多让模型判断的文章数；打开文章和规则筛选不调用模型，不计入
OUT = Path("workspace/outputs/runoob_dfs")
GRADE = {"符合": 2, "部分符合": 1, "不符合": 0}


class Result(BaseModel):
    title: str
    summary: str


class Verdict(BaseModel):
    dfs: Literal["主题", "专门章节", "顺带提到"]
    python_dfs_code: bool
    reason: str


def score(r: Result) -> int:
    """搜索结果的摘要几乎都带搜索词，排序以标题为主。"""
    title = r.title.lower()
    s = 3 if "python" in title else 0
    s += 2 if "深度优先" in title or "dfs" in title else 0
    s += 1 if "python" in r.summary.lower() else 0
    return s


def rule_check(body: str) -> str | None:
    """不依赖模型的筛选：返回不符合的原因，可能符合时返回 None。"""
    if "深度优先" not in body and not re.search(r"\bdfs\b", body, re.IGNORECASE):
        return "正文没有提到深度优先或 DFS"
    if "python" not in body.lower() or not re.search(r"^\s*def \w+\(", body, re.MULTILINE):
        return "正文没有 Python 函数定义"
    return None


async def inspect(ob: Obact, title: str) -> dict:
    """打开一条搜索结果并分级。调用前后都停在搜索结果页。runoob 的文章在新标签页打开，act 返回时 ob.page 已是文章页。"""
    results_url = ob.page.url
    tabs = len(ob.page.context.pages)
    await ob.act("点击搜索结果中标题为 {title} 的链接", params={"title": title}, step="打开搜索结果")
    try:
        info = {"title": title, "url": ob.page.url, "grade": "不符合"}
        reason = rule_check(await ob.page.inner_text("body"))
        if reason:
            return {**info, "reason": reason}
        v = await ob.extract(
            "这篇文章里深度优先搜索（DFS）的分量：主题（整篇在讲 DFS）、专门章节（有专门讲 DFS 的部分）、"
            "顺带提到；文中有没有实现 DFS 的代码；reason 用一句话说明理由",
            schema=Verdict,
        )
        grade = "不符合"
        if v.python_dfs_code and v.dfs != "顺带提到":
            grade = "符合" if v.dfs == "主题" else "部分符合"
        info = {**info, "grade": grade, "judged": True, "reason": f"DFS {v.dfs}；{v.reason}"}
        if grade != "不符合":
            info["code"] = await ob.read("文章中实现深度优先搜索的那段代码")
        return info
    finally:
        # 回到搜索结果页：文章在新标签页打开时直接关掉它，否则重新打开结果页
        if len(ob.page.context.pages) > tabs:
            await ob.page.close()
        else:
            await ob.goto(results_url)


def enough(visited: list[dict]) -> bool:
    """收集到 WANT 篇“符合”，或者模型判断次数用完。"""
    found = sum(1 for v in visited if v["grade"] == "符合")
    judged = sum(1 for v in visited if v.get("judged"))
    return found >= WANT or judged >= MAX_JUDGE


async def search(ob: Obact, term: str, visited: list[dict]) -> None:
    """搜索一个词，逐页打开没看过的结果，判断结果追加到 visited。"""
    await ob.goto(HOME)
    await ob.act("在页面顶部的搜索框输入 {q}", params={"q": term}, step="输入搜索词")
    await ob.act("在搜索框中按回车键开始搜索", step="提交搜索", expect="**/?s=**")
    first_page = ob.page.url
    for n in range(1, MAX_PAGES + 1):
        if n > 1:
            # 翻页直接打开 runoob 的分页地址，不调用模型
            await ob.goto(f"{first_page}&page={n}")
        results = await ob.extract("搜索结果列表中每一条结果的标题和摘要", schema=list[Result])
        seen = {v["title"] for v in visited}
        candidates = sorted((r for r in results if r.title not in seen), key=score, reverse=True)
        print(f"搜索 {term!r} 第 {n} 页：{len(results)} 条结果，{len(candidates)} 条没看过", flush=True)
        if not candidates:
            break  # 超出最后一页时，页面上没有新结果
        for r in candidates:
            if enough(visited):
                return
            try:
                info = await inspect(ob, r.title)
            except StepFailed as e:
                info = {"title": r.title, "grade": "不符合", "reason": f"打开或判断失败：{e.attempts[-1]}"}
            visited.append(info)
            print(f"  {info['grade']}：{r.title}（{info['reason']}）", flush=True)


async def main() -> None:
    visited: list[dict] = []
    async with Obact(task="runoob_dfs") as ob:
        for term in TERMS:
            try:
                await search(ob, term, visited)
            except StepFailed as e:
                # 一个搜索词出错只跳过它，已经收集的结果照常保存
                print(f"搜索 {term!r} 出错，跳过：{e}", flush=True)
            found = sum(1 for v in visited if v["grade"] == "符合")
            print(f"搜索 {term!r} 结束：累计看过 {len(visited)} 篇，{found} 篇符合", flush=True)
            # 搜索可能在新标签页打开，换下一个搜索词前只留一个标签页
            for page in ob.page.context.pages[1:]:
                await page.close()
            if enough(visited):
                break

        matches = sorted((v for v in visited if v["grade"] != "不符合"), key=lambda v: -GRADE[v["grade"]])
        status = {"符合": "found", "部分符合": "partial"}[matches[0]["grade"]] if matches else "not_found"
        path = ob.save({"status": status, "matches": matches, "visited": visited}, OUT / "result.json")
    if matches:
        print(f"\n找到 {len(matches)} 篇（详情和代码见 {path}）：")
        for i, m in enumerate(matches, 1):
            print(f"{i}. [{m['grade']}] {m['title']}\n   {m['url']}\n   {m['reason']}")
    else:
        print(f"没有找到符合要求的教程，看过 {len(visited)} 篇，原因见 {path}")


asyncio.run(main())
