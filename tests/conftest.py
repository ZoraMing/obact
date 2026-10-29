"""pytest 公共夹具：本地测试页服务、假模型、Obact 构造，以及 --real、--site 两个开关。

默认只跑不需要网络和模型的测试（假模型 + 本地测试页）。
--real：再跑用 .env 里真实模型的测试（本地测试页）；--site：再跑访问外网练习站的测试（同样用真实模型）。
"""

import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread

import pytest
from pages import PAGES
from support import FakeModel

from obact import Obact, llm

ROOT = Path(__file__).resolve().parent.parent


def pytest_addoption(parser):
    parser.addoption("--real", action="store_true", help="运行用 .env 里真实模型的测试")
    parser.addoption("--site", action="store_true", help="运行访问外网练习站的测试（用真实模型）")


def pytest_configure(config):
    config.addinivalue_line("markers", "real: 用 .env 里的真实模型，加 --real 时运行")
    config.addinivalue_line("markers", "site: 访问外网练习站并用真实模型，加 --site 时运行")


def pytest_collection_modifyitems(config, items):
    real, site = config.getoption("--real"), config.getoption("--site")
    for item in items:
        if "site" in item.keywords and not site:
            item.add_marker(pytest.mark.skip(reason="访问外网练习站，加 --site 运行"))
        elif "real" in item.keywords and not real:
            item.add_marker(pytest.mark.skip(reason="用真实模型，加 --real 运行"))


class _Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/api/slow":
            time.sleep(3)
            body = b"ok"
        elif self.path in PAGES:
            body = ("<!doctype html><meta charset=utf-8><title>测试页</title>" + PAGES[self.path]).encode()
        else:
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


@pytest.fixture(scope="session")
def site() -> str:
    """本地测试页服务的地址，如 http://127.0.0.1:端口；页面见 pages.py。"""
    server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_address[1]}"
    server.shutdown()


@pytest.fixture
def cache_dir(tmp_path, monkeypatch) -> Path:
    """本测试专用的缓存目录；环境变量优先于 .env，所以真实模型的测试也写到这里。"""
    path = tmp_path / "cache"
    monkeypatch.setenv("OBACT_CACHE_DIR", str(path))
    monkeypatch.setenv("OBACT_HEADLESS", "true")
    return path


@pytest.fixture
def fake(monkeypatch, tmp_path, cache_dir) -> FakeModel:
    """装上假模型，并准备一个只用于假模型的 .env（模型地址随便填）。"""
    model = FakeModel()

    async def chat(self, slot, messages, schema=None):
        return await model.chat(slot, messages, schema)

    monkeypatch.setattr(llm.LLM, "_chat", chat)
    # 配置写进环境变量而不是 .env：Obact 加载 .env 时写入的环境变量不会在测试结束后撤销，会串到后面用真实模型的测试
    for name, value in {"MODEL_BASE_URL": "http://127.0.0.1:1/v1", "MODEL_NAME": "fake", "MODEL_KEY": "x"}.items():
        monkeypatch.setenv(name, value)
    for name in ("MODEL_COORDS", "SMART_MODEL_BASE_URL", "SMART_MODEL_NAME", "SMART_MODEL_KEY", "SMART_MODEL_COORDS",
                 "OBACT_USER_DATA_DIR", "OBACT_EXECUTABLE_PATH", "OBACT_VIEWPORT"):
        monkeypatch.delenv(name, raising=False)
    model.env = tmp_path / "empty.env"
    model.env.write_text("", encoding="utf-8")
    return model


@pytest.fixture
def make_ob(fake):
    """构造用假模型的 Obact：make_ob("任务名")，配合 async with 使用；同一测试里多次构造共用缓存目录。"""
    return lambda task="t": Obact(task, env=fake.env, headless=True)


@pytest.fixture
def real(monkeypatch, cache_dir):
    """用 .env 里真实模型的 Obact 构造函数；calls 统计视觉检查以外的模型调用次数。"""
    env = ROOT / ".env"
    if not env.exists():
        pytest.skip("没有 .env，无法使用真实模型")
    original = llm.LLM._chat
    calls = {"n": 0}

    async def counted(self, slot, messages, schema=None):
        if not messages[-1]["content"][0]["text"].startswith("这张图片"):
            calls["n"] += 1
        return await original(self, slot, messages, schema)

    monkeypatch.setattr(llm.LLM, "_chat", counted)

    def make(task="real"):
        return Obact(task, env=env, headless=True)

    make.calls = calls
    return make
