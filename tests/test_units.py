"""不需要浏览器和模型的单元测试：模型输出校验、回复解析、约束解码与回退、任务名检查。"""

import httpx
import openai
import pytest
from openai.types.chat import ChatCompletion
from pydantic import BaseModel, TypeAdapter
from support import run

from obact import core, llm
from obact.llm import LLM, Decision


def _completion(**message) -> ChatCompletion:
    return ChatCompletion.model_validate({
        "id": "x", "object": "chat.completion", "created": 0, "model": "m",
        "choices": [{"index": 0, "finish_reason": "stop", "message": {"role": "assistant", **message}}],
    })


def test_decision_null_fields_use_defaults():
    d = Decision.model_validate({"found": False, "blocked": None, "reason": None})
    assert d.blocked is False and d.reason == ""


def test_decision_click_and_hover_drop_args():
    for method in ("click", "hover"):
        d = Decision.model_validate({"found": True, "id": 3, "method": method, "args": ["多给的参数"]})
        assert d.args == []


def test_decision_fill_needs_args():
    with pytest.raises(ValueError):
        Decision.model_validate({"found": True, "id": 3, "method": "fill", "args": []})


def test_reply_falls_back_to_reasoning_content():
    assert llm._reply(_completion(content="", reasoning_content='{"found": false}')) == '{"found": false}'
    assert llm._reply(_completion(content='{"a": 1}', reasoning_content="思考")) == '{"a": 1}'
    assert llm._reply(_completion(content=None)) == ""
    empty = ChatCompletion.model_validate({"id": "x", "object": "chat.completion", "created": 0, "model": "m",
                                           "choices": []})
    assert llm._reply(empty) == ""


class _Book(BaseModel):
    title: str


class _Shelf(BaseModel):
    name: str
    books: list[_Book]


class _Recorder:
    """记录请求的 response_format；reject_schema 为真时对 json_schema 返回 400。"""

    def __init__(self, reply: str, reject_schema: bool = False):
        self.reply, self.reject_schema, self.formats = reply, reject_schema, []

    async def __call__(self, **kw):
        fmt = kw["response_format"]
        self.formats.append(fmt)
        if fmt["type"] == "json_schema" and self.reject_schema:
            request = httpx.Request("POST", "http://x")
            raise openai.BadRequestError("unsupported", response=httpx.Response(400, request=request), body=None)
        return _completion(content=self.reply)


def _llm(recorder) -> LLM:
    cfg = {"base_url": "http://127.0.0.1:1/v1", "model": "m", "api_key": "x", "coords": "pixel"}
    model = LLM({"fast": cfg, "smart": cfg})
    for slot in model.slots.values():
        slot.client.chat.completions.create = recorder
    return model


def test_requests_use_json_schema():
    rec = _Recorder('{"found": true, "id": 2, "method": "click", "args": []}')
    d = run(_llm(rec).decide("fast", "点击", "[2] button", b"", (1280, 800)))
    assert d.id == 2
    fmt = rec.formats[0]
    assert fmt["type"] == "json_schema" and fmt["json_schema"]["strict"] is False
    assert "found" in fmt["json_schema"]["schema"]["properties"]


def test_extract_schema_wraps_data_and_hoists_defs():
    rec = _Recorder('{"data": {"name": "书架", "books": [{"title": "三体"}]}}')
    shelf = run(_llm(rec).extract("fast", "书架", "文本", b"", TypeAdapter(_Shelf)))
    assert shelf.books[0].title == "三体"
    schema = rec.formats[0]["json_schema"]["schema"]
    assert schema["required"] == ["data"]
    # data 里引用 "#/$defs/…"，$defs 必须在最外层
    assert "$defs" in schema and "$defs" not in schema["properties"]["data"]


def test_json_schema_rejected_falls_back_to_json_object():
    rec = _Recorder('{"found": true, "id": 2, "method": "click", "args": []}', reject_schema=True)
    model = _llm(rec)
    run(model.decide("fast", "点击", "[2] button", b"", (1280, 800)))
    run(model.decide("fast", "点击", "[2] button", b"", (1280, 800)))
    assert [f["type"] for f in rec.formats] == ["json_schema", "json_object", "json_object"]
    assert model.slots["fast"].json_schema is False


@pytest.mark.parametrize("name", ["", "a/b", "a\\b", "a:b", 'a"b', "a?b", "a*b", "a<b", "a|b", "a.", "a ", ".", "..",
                                  "a\x01b"])
def test_bad_task_names_rejected(name):
    with pytest.raises(ValueError):
        core._check_task(name)


@pytest.mark.parametrize("name", ["task_shop", "中文任务", "a.b", "obact-1"])
def test_good_task_names_accepted(name):
    core._check_task(name)
