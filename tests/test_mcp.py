"""MCP 服务的进程内测试：内存里的客户端会话 + 假模型 + 本地测试页。子进程方式见 tests/smoke.py。"""

from mcp.shared.memory import create_connected_server_and_client_session as connect
from support import element, run

from obact.mcp_server import build_server

TOOLS = {"goto", "page_state", "scroll", "wait", "act", "read", "download", "upload", "extract", "save"}


def _text(result) -> str:
    return result.content[0].text


def test_tools_and_new_tools(site, fake, tmp_path):
    upload_file = tmp_path / "a.txt"
    upload_file.write_text("a", encoding="utf-8")

    async def go():
        async with connect(build_server("mcp_t", str(fake.env), headless=True)._mcp_server) as c:
            assert {t.name for t in (await c.list_tools()).tools} == TOOLS
            assert fake.calls["vision"] == 0, "列出工具时不打开浏览器、不做视觉检查"

            # hover：按编号悬停，不调用模型；之后清单里有子菜单项
            await c.call_tool("goto", {"url": site + "/hover"})
            state = _text(await c.call_tool("page_state", {}))
            r = await c.call_tool("act", {"instruction": "悬停在产品菜单上", "element_id": element(state, "产品"),
                                          "method": "hover"})
            assert not r.isError and "按编号" in _text(r)
            assert '"手机"' in _text(await c.call_tool("page_state", {}))

            # scroll：返回位置和是否到底
            await c.call_tool("goto", {"url": site + "/scroll"})
            r = _text(await c.call_tool("scroll", {}))
            assert "页面纵向位置" in r and "未到底" in r

            # wait：按条件、固定时长、超时
            await c.call_tool("goto", {"url": site + "/slow"})
            r = await c.call_tool("wait", {"until": "text=查看结果", "timeout": 10})
            assert not r.isError and "已满足" in _text(r)
            r = await c.call_tool("wait", {"timeout": 1})
            assert not r.isError and "已等待 1" in _text(r)
            r = await c.call_tool("wait", {"until": "text=没有", "timeout": 1})
            assert r.isError and "没有满足" in _text(r)

            # upload：按编号点击，选中文件
            await c.call_tool("goto", {"url": site + "/upload"})
            state = _text(await c.call_tool("page_state", {}))
            r = await c.call_tool("upload", {"instruction": "点击上传附件按钮", "files": [str(upload_file)],
                                             "element_id": element(state, "上传附件")})
            assert not r.isError and "已上传" in _text(r)

    run(go())
    assert fake.model_calls == 0, "按编号执行和 scroll、wait 都不调用模型"
