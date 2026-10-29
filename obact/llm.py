"""模型调用：fast / smart 两个视觉模型槽位，OpenAI 格式接口，强制 JSON 输出。"""

import asyncio
import base64
import json
import re
import struct
import sys
import zlib
from dataclasses import dataclass
from typing import Any, Literal

import openai
from openai import AsyncOpenAI
from pydantic import BaseModel, ConfigDict, TypeAdapter, field_validator, model_validator

SLOTS = ("fast", "smart")
TIMEOUT_S = 120

ACT_PROMPT = """你是精准的浏览器自动化执行引擎。你会收到一条操作指令、当前页面的可交互元素清单和一张视口截图。
清单每行是一个元素：[编号] 标签 属性 "名称" value=当前值 @(x,y,宽x高)，坐标相对视口。标注“屏幕外”的元素不在截图里，但同样可以操作。截图中视口内的元素画了彩色框，框左上角是同一个编号。

只输出一个 JSON 对象，格式：
{"found": true, "id": 编号, "point": null, "method": "click", "args": [], "reason": "一句话说明为什么选它"}

规则：
1. id 只能从清单里已有的编号中选，不要编造。
2. method 只能是以下五种之一：
   click：点击，args 为 []
   hover：把鼠标悬停在元素上，用于展开悬停菜单、显示悬停才出现的按钮，args 为 []
   fill：在输入框中输入文字，args 为 ["文字"]，文字照抄指令原文，不要改写
   press：在元素上按键，args 为 ["Enter"] 这样的按键名
   select_option：在 select 下拉框中选择，args 为 ["选项文字"]
3. 目标是 canvas、地图、图表里画出来的内容、清单无法表示时，id 填 null，point 填目标位置 [x, y]，使用{coords}。
   按钮、链接、输入框这类普通元素不要用坐标。
4. 页面上找不到目标时，只输出 {"found": false, "reason": "找不到的原因"}。
5. 被弹窗、浮层挡住的元素不会出现在清单里。截图里能看到、清单里却没有的按钮、链接、输入框，就是被挡住了
   （半透明遮罩下面也能看到）。这时不要改选别的元素，也不要用坐标去点它，
   只输出 {"found": false, "blocked": true, "reason": "什么挡住了目标"}。
6. 只做指令要求的这一个动作，不要做别的。"""

EXTRACT_PROMPT = """你从网页中提取数据。你会收到提取要求、页面的文本内容和一张视口截图。
页面文本每行是一个可见的文本块：文字 @(x,y,宽x高)，坐标相对视口左上角，按页面顺序排列；标注“屏幕外”的行不在截图里。
表格的每个单元格、日历的每一格各占一行或几行，同一行的 y 相近，同一列的 x 相近。
链接的 title 写成 [title: …]，图片的 alt 写成 [img: …]；链接文字被截断时，title 里通常是完整文字。
只输出一个 JSON 对象，它只有一个键 "data"，"data" 的值必须符合下面的 JSON Schema：
{schema}

例如 Schema 是字符串数组时，输出 {"data": ["第一项", "第二项"]}；Schema 是只有 title 一个字段的对象时，输出 {"data": {"title": "书名"}}，
不要省掉字段名写成 {"data": "书名"}；不要把 "data" 换成 "items" 等其他键名。

规则：
1. 要求提取“所有”或一个列表时，页面文本中符合要求的每一条都要提取，不要遗漏。
2. 文字照抄页面原文；数字类型的字段只填数字。
3. 页面上没有的信息不要编造。
4. 表格、日历这类网格内容，按坐标和截图里的位置确定每个值属于哪一行、哪一列、哪一天，不要按文本顺序依次配对；
   某一格没有值时就是没有，不要把相邻格的值挪过来。"""

READ_PROMPT = """你是网页内容定位器。你会收到一条读取要求、当前页面的文本块清单和一张视口截图。
清单每行是一个文本块：[编号] 标签 "开头的文字"（总字数）@(x,y,宽x高)，坐标相对视口；标注“屏幕外”的块不在截图里。块之间可以嵌套，外层块包含内层块的全部文字。

只输出一个 JSON 对象，格式：
{"found": true, "id": 编号}

规则：
1. 选出完整包含所需内容、同时尽量少包含无关内容的那个块。
2. 所需内容分散在几个相邻的块里时，选包含它们的最小外层块。
3. id 只能从清单里已有的编号中选，不要编造。
4. 页面上找不到时，只输出 {"found": false}。"""

_THINK = re.compile(r"<think>.*?</think>", re.DOTALL)


class ModelError(Exception):
    """模型调用失败（已重试），或模型不满足要求。"""


class Decision(BaseModel):
    """模型对一步操作的判断；decide() 返回时 point 已换算成相对视口的 0-1 比例。

    blocked 为 true 表示模型认为目标被弹窗、浮层挡住；reason 是模型给出的一句理由，可以为空。
    """

    model_config = ConfigDict(coerce_numbers_to_str=True)

    found: bool
    id: int | None = None
    point: tuple[float, float] | None = None
    method: Literal["click", "fill", "press", "select_option", "hover"] = "click"
    args: list[str] = []
    blocked: bool = False
    reason: str = ""

    @field_validator("method", mode="before")
    @classmethod
    def _alias(cls, v):
        return {"type": "fill", "input": "fill", "select": "select_option"}.get(v, v)

    @field_validator("blocked", "reason", mode="before")
    @classmethod
    def _null(cls, v, info):
        # 模型常把用不到的字段写成 null
        return cls.model_fields[info.field_name].default if v is None else v

    @model_validator(mode="after")
    def _check(self):
        if not self.found:
            return self
        if self.method in ("click", "hover"):
            # click、hover 不用 args；模型多给的 args 里带着参数值时，会被当成已经模板化，绕过锚点
            self.args = []
        if self.id is None and self.point is None:
            raise ValueError("found 为 true 时必须给出 id 或 point")
        if self.method not in ("click", "hover") and not self.args:
            raise ValueError(f"{self.method} 需要 args")
        if self.id is None and self.method == "select_option":
            raise ValueError("坐标目标不支持 select_option")
        return self


class _Pick(BaseModel):
    """模型为 read 选出的文本块。"""

    found: bool
    id: int | None = None

    @model_validator(mode="after")
    def _check(self):
        if self.found and self.id is None:
            raise ValueError("found 为 true 时必须给出 id")
        return self


@dataclass
class _Slot:
    name: str
    model: str
    coords: str  # pixel：截图像素坐标；norm1000：0-1000 归一化坐标
    client: AsyncOpenAI
    json_schema: bool = True  # 接口是否接受 json_schema 约束解码；报 400 后改为 json_object


class LLM:
    def __init__(self, models: dict):
        """models 形如 {"fast": {"base_url", "model", "api_key", "coords"}, "smart": {...}}。"""
        self.slots: dict[str, _Slot] = {}
        for name in SLOTS:
            cfg = models[name]
            client = AsyncOpenAI(
                base_url=cfg["base_url"], api_key=cfg["api_key"] or "EMPTY", timeout=TIMEOUT_S, max_retries=0
            )
            self.slots[name] = _Slot(name, cfg["model"], cfg["coords"], client)

    async def check_vision(self) -> None:
        """向每个槽位发一张红色测试图，接口报错或认不出颜色就直接报错。"""
        await asyncio.gather(*(self._probe(slot) for slot in self.slots.values()))

    async def decide(self, slot_name: str, instruction: str, elements: str, image: bytes, size: tuple[int, int]) -> Decision:
        slot = self.slots[slot_name]
        w, h = size
        coords = f"截图像素坐标（截图宽 {w}、高 {h}）" if slot.coords == "pixel" else "0 到 1000 的归一化坐标"
        messages = [
            {"role": "system", "content": ACT_PROMPT.replace("{coords}", coords)},
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": f"操作指令：{instruction}\n\n可交互元素清单：\n{elements}"},
                    _image(image),
                ],
            },
        ]
        d = await self._ask(slot, messages, lambda text: Decision.model_validate(_load_json(text)), Decision.model_json_schema())
        if d.point is not None:
            sx, sy = (w, h) if slot.coords == "pixel" else (1000, 1000)
            d.point = (min(max(d.point[0] / sx, 0.0), 1.0), min(max(d.point[1] / sy, 0.0), 1.0))
        return d

    async def locate(self, slot_name: str, instruction: str, blocks: str, image: bytes) -> int | None:
        """为 read 选出文本块编号，找不到返回 None。"""
        slot = self.slots[slot_name]
        messages = [
            {"role": "system", "content": READ_PROMPT},
            {
                "role": "user",
                "content": [{"type": "text", "text": f"读取要求：{instruction}\n\n文本块清单：\n{blocks}"}, _image(image)],
            },
        ]
        pick = await self._ask(slot, messages, lambda text: _Pick.model_validate(_load_json(text)), _Pick.model_json_schema())
        return pick.id if pick.found else None

    async def extract(self, slot_name: str, instruction: str, text: str, image: bytes, adapter: TypeAdapter) -> Any:
        slot = self.slots[slot_name]
        schema = json.dumps(adapter.json_schema(), ensure_ascii=False)
        messages = [
            {"role": "system", "content": EXTRACT_PROMPT.replace("{schema}", schema)},
            {
                "role": "user",
                "content": [{"type": "text", "text": f"提取要求：{instruction}\n\n页面文本：\n{text}"}, _image(image)],
            },
        ]

        def parse(reply: str) -> Any:
            obj = _load_json(reply)
            # 模型偶尔换用 items 等键名；只有一个键时直接取它的值
            if isinstance(obj, dict) and "data" not in obj and len(obj) == 1:
                obj = {"data": next(iter(obj.values()))}
            if not isinstance(obj, dict) or "data" not in obj:
                raise ValueError("输出缺少 data 字段")
            return adapter.validate_python(obj["data"])

        # data 包一层后，把 $defs 提到最外层，"#/$defs/…" 的引用才找得到
        inner = adapter.json_schema()
        wrapped = {"type": "object", "properties": {"data": inner}, "required": ["data"]}
        if "$defs" in inner:
            wrapped["$defs"] = inner.pop("$defs")
        return await self._ask(slot, messages, parse, wrapped)

    async def _chat(self, slot: _Slot, messages: list, schema: dict | None = None) -> str:
        # 模型可能要很久才回复，先打印一行，避免看起来像卡住；不以“[obact] fast ”开头，tasks/run.py 不会计为模型步骤
        print(f"[obact] 等待 {slot.name} 模型 {slot.model} 回复……", file=sys.stderr, flush=True)
        # 给了 schema 时用 json_schema 约束解码，输出结构由接口保证；不用 strict，pydantic 的可选字段和默认值不满足它的要求
        if schema and slot.json_schema:
            fmt = {"type": "json_schema", "json_schema": {"name": "output", "schema": schema, "strict": False}}
            try:
                resp = await slot.client.chat.completions.create(
                    model=slot.model, messages=messages, temperature=0, response_format=fmt
                )
                return _reply(resp)
            except openai.BadRequestError as e:
                slot.json_schema = False
                print(f"[obact] {slot.name} 模型不支持 json_schema，改用 json_object：{str(e)[:120]}", file=sys.stderr, flush=True)
        resp = await slot.client.chat.completions.create(
            model=slot.model, messages=messages, temperature=0, response_format={"type": "json_object"}
        )
        return _reply(resp)

    async def _ask(self, slot: _Slot, messages: list, parse, schema: dict | None = None):
        """调用并解析；接口出错或 JSON 不合法时同一模型重试 1 次，仍失败抛 ModelError。schema 是输出要符合的 JSON Schema。"""
        error: Exception | None = None
        for _ in range(2):
            try:
                return parse(await self._chat(slot, messages, schema))
            except (openai.APIError, ValueError) as e:
                error = e
        raise ModelError(f"{type(error).__name__}: {str(error)[:300]}")

    async def _probe(self, slot: _Slot) -> None:
        messages = [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": '这张图片是什么颜色？用 JSON 回答：{"color": "颜色"}'},
                    _image(_red_png()),
                ],
            }
        ]
        try:
            reply = await self._chat(slot, messages)
        except openai.APIError as e:
            raise ModelError(f"{slot.name} 模型 {slot.model} 调用失败，可能不支持图像输入：{e}") from e
        if "红" not in reply and "red" not in reply.lower():
            raise ModelError(f"{slot.name} 模型 {slot.model} 没有认出测试图片，可能不支持视觉：{reply[:200]}")


def _reply(resp) -> str:
    """回复文字。有的接口出错时返回空的 choices，按空回复处理，交给解析报错和重试；
    有的推理模型（如 mimo）偶尔把答案只写在 reasoning_content 里、content 为空，这时改用 reasoning_content。"""
    if not resp.choices:
        return ""
    message = resp.choices[0].message
    return message.content or (message.model_extra or {}).get("reasoning_content") or ""


def _load_json(text: str) -> Any:
    """取回复中的 JSON 对象，容忍 <think> 段落和代码块包裹。"""
    text = _THINK.sub("", text)
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end < start:
        raise ValueError(f"回复中没有 JSON 对象：{text[:200]}")
    return json.loads(text[start : end + 1])


def _image(png: bytes) -> dict:
    return {"type": "image_url", "image_url": {"url": "data:image/png;base64," + base64.b64encode(png).decode()}}


def _red_png(size: int = 64) -> bytes:
    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data))

    row = b"\x00" + b"\xff\x00\x00" * size
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(row * size))
        + chunk(b"IEND", b"")
    )
