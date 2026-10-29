"""冒烟测试：本地测试页 + 真实模型，检查 Obact 和 MCP 服务的主流程。

第一遍从空缓存开始，各步骤由模型完成并写入缓存；第二遍 act、read、download 应全部按缓存回放，模型调用为 0。
覆盖：fill、select_option、click、按参数锚定所在行、target=_blank 表单回车打开新标签页、read、download、extract；
MCP 服务（stdio 子进程）：握手、goto、page_state、按编号 act、按指令 act。

在仓库根目录运行：python tests/smoke.py [--env 配置文件]
模型来自配置文件（默认 .env）；已存在的环境变量优先，换模型时可以直接在命令行设置 MODEL_BASE_URL、MODEL_NAME、MODEL_KEY。
缓存写到临时目录，测试页由本地 HTTP 服务提供，不访问外网。浏览器以无头方式运行。
"""

import argparse
import asyncio
import os
import re
import shutil
import sys
import tempfile
import threading
import time
from collections import Counter
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from pydantic import BaseModel

from obact import Obact, StepFailed, llm

INDEX = """<!doctype html><html><head><meta charset="utf-8"><title>Obact 冒烟测试</title></head><body>
<h1>航班查询</h1>
<label>出发城市 <input id="city" placeholder="出发城市"></label>
<label>舱位 <select id="cabin"><option>经济舱</option><option>商务舱</option></select></label>
<button onclick="result.textContent = '查询完成：' + city.value + '，' + cabin.value">查询</button>
<div id="result"></div>
<h2>商品</h2>
<table>
<tr><td>机票 A</td><td>¥320</td><td><button onclick="add('机票 A')">加入购物车</button></td></tr>
<tr><td>机票 B</td><td>¥180</td><td><button onclick="add('机票 B')">加入购物车</button></td></tr>
<tr><td>机票 C</td><td>¥260</td><td><button onclick="add('机票 C')">加入购物车</button></td></tr>
</table>
<div id="cart">购物车为空</div>
<form action="/search" target="_blank"><input name="q" placeholder="站内搜索"></form>
<p>使用说明：这是 Obact 冒烟测试用的本地页面，用来检查填写、选择、点击、参数锚定、新标签页、读取和下载在第一遍由模型完成，
第二遍按缓存回放。</p>
<a href="/report.txt" download="report.txt">下载报告</a>
<script>function add(name) { cart.textContent = '购物车：' + name; }</script>
</body></html>"""
SEARCH = """<!doctype html><html><head><meta charset="utf-8"><title>搜索结果</title></head><body>
<h1>搜索结果</h1><p>关于 {q} 的搜索结果共 3 条，按相关度排序。</p></body></html>"""
REPORT = "obact smoke report"
CALLS = Counter()


class Item(BaseModel):
    name: str
    price: float


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        url = urlsplit(self.path)
        if url.path == "/search":
            time.sleep(0.5)  # 新标签页晚一点才出现，检查 act 会等它
            body, kind = SEARCH.format(q=parse_qs(url.query).get("q", [""])[0]), "text/html"
        elif url.path == "/report.txt":
            body, kind = REPORT, "text/plain"
        else:
            body, kind = INDEX, "text/html"
        data = body.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", f"{kind}; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):
        pass


class Checks:
    def __init__(self):
        self.failed: list[str] = []

    def check(self, ok: bool, desc: str) -> None:
        print(f"[检查] {'通过' if ok else '失败'}：{desc}", flush=True)
        if not ok:
            self.failed.append(desc)


def count_calls() -> None:
    """统计各类模型调用的次数：按用户消息的开头区分。"""
    chat = llm.LLM._chat
    kinds = {"这张图片": "vision", "操作指令": "act", "读取要求": "read", "提取要求": "extract"}

    async def counted(self, slot, messages, schema=None):
        text = messages[-1]["content"][0]["text"]
        CALLS[next((v for k, v in kinds.items() if text.startswith(k)), "other")] += 1
        return await chat(self, slot, messages, schema)

    llm.LLM._chat = counted


async def flow(ob: Obact, home: str, out: Path, checks: Checks) -> None:
    await ob.goto(home)
    await ob.act("在出发城市输入框输入 {city}", params={"city": "上海"})
    await ob.act("在舱位下拉框选择 {cabin}", params={"cabin": "商务舱"})
    await ob.act("点击查询按钮", expect="text=查询完成：上海，商务舱")
    items = await ob.extract("表格里每个商品的名称和价格（数字，不含货币符号）", schema=list[Item])
    checks.check(len(items) == 3, f"extract 提取到 3 个商品：{[(i.name, i.price) for i in items]}")
    cheapest = min(items, key=lambda i: i.price)
    await ob.act(
        "点击商品 {name} 那一行的加入购物车按钮", params={"name": cheapest.name}, expect=f"text=购物车：{cheapest.name}"
    )
    note = await ob.read("“使用说明”开头的那段文字")
    checks.check("冒烟测试" in note, "read 读到使用说明")
    path = await ob.download("点击下载报告链接", save_to=out)
    checks.check(path.read_text(encoding="utf-8") == REPORT, "download 保存的文件内容正确")
    await ob.act("在站内搜索框输入 {q}", params={"q": "深度优先"})
    await ob.act("在站内搜索框按回车键", expect="**/search**")
    checks.check("/search" in ob.page.url and len(ob.page.context.pages) == 2, "回车后作用在新打开的标签页上")
    summary = await ob.read("搜索结果数量的那句话")
    checks.check("深度优先" in summary, "read 读到新标签页上的内容")
    await ob.page.close()


async def mcp_smoke(env: Path, home: str, project: Path, checks: Checks) -> None:
    """以子进程启动 MCP 服务，模拟 AI 客户端调用。"""
    passed = {k: v for k, v in os.environ.items() if k.startswith(("MODEL_", "SMART_MODEL_", "OBACT_"))}
    params = StdioServerParameters(
        command=sys.executable,
        args=["-m", "obact.mcp_server", "--env", str(env.resolve()), "--headless"],
        env={**passed, "CLAUDE_PROJECT_DIR": str(project)},
    )
    async with stdio_client(params) as (read, write), ClientSession(read, write) as session:
        await session.initialize()
        tools = {t.name for t in (await session.list_tools()).tools}
        checks.check(len(tools) == 10, f"MCP 列出 10 个工具：{sorted(tools)}")
        r = await session.call_tool("goto", {"url": home})
        checks.check(not r.isError and "Obact 冒烟测试" in r.content[0].text, "MCP goto")
        r = await session.call_tool("page_state", {})
        text = r.content[0].text
        checks.check(not r.isError and any(c.type == "image" for c in r.content), "MCP page_state 返回清单和截图")
        found = re.search(r"\[(\d+)\] button \"查询\"", text)
        checks.check(found is not None, "page_state 清单里有查询按钮")
        if found:
            r = await session.call_tool("act", {"instruction": "点击查询按钮", "element_id": int(found.group(1))})
            checks.check(not r.isError and "按编号执行" in r.content[0].text, "MCP 按编号 act，不调用模型")
        args = {"instruction": "点击商品 {name} 那一行的加入购物车按钮", "params": {"name": "机票 C"}}
        r = await session.call_tool("act", args)
        checks.check(not r.isError and "执行方式" in r.content[0].text, f"MCP 按指令 act：{r.content[0].text[:60]}")


async def main(env: Path) -> int:
    checks = Checks()
    work = Path(tempfile.mkdtemp(prefix="obact-smoke-"))
    os.environ["OBACT_CACHE_DIR"] = str(work / "cache")  # 已存在的环境变量优先于 .env，每次从空缓存开始
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    home = f"http://127.0.0.1:{server.server_address[1]}/"
    count_calls()
    try:
        for round_ in (1, 2):
            print(f"\n===== 第 {round_} 遍 =====", flush=True)
            CALLS.clear()
            try:
                async with Obact("smoke", env=env, headless=True) as ob:
                    await flow(ob, home, work / "downloads", checks)
            except StepFailed as e:
                checks.check(False, f"第 {round_} 遍执行到一半失败：{e}")
                break
            print(f"模型调用：{dict(CALLS)}", flush=True)
            if round_ == 2:
                replayed = CALLS["act"] + CALLS["read"] == 0
                checks.check(replayed, "第 2 遍 act、read、download 全部按缓存回放，没有调用模型")
        print("\n===== MCP 服务 =====", flush=True)
        await mcp_smoke(env, home, work, checks)
    finally:
        server.shutdown()
    if checks.failed:
        print(f"\n冒烟测试失败：{len(checks.failed)} 项，缓存和失败截图在 {work / 'cache'}")
        return 1
    shutil.rmtree(work, ignore_errors=True)
    print("\n冒烟测试全部通过")
    return 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Obact 冒烟测试")
    parser.add_argument("--env", default=".env", help="配置文件，默认 .env")
    sys.exit(asyncio.run(main(Path(parser.parse_args().env))))
