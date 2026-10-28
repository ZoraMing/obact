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
{"found": true, "id": 编号, "point": null, "method": "click", "args": []}

规则：
1. id 只能从清单里已有的编号中选，不要编造。
2. method 只能是以下四种之一：
   click：点击，args 为 []
   fill：在输入框中输入文字，args 为 ["文字"]，文字照抄指令原文，不要改写
   press：在元素上按键，args 为 ["Enter"] 这样的按键名
   select_option：在 select 下拉框中选择，args 为 ["选项文字"]
3. 目标在 canvas、地图、图表等清单无法表示的区域内时，id 填 null，point 填目标位置 [x, y]，使用{coords}。
4. 页面上找不到目标时，只输出 {"found": false}。
5. 只做指令要求的这一个动作，不要做别的。"""

EXTRACT_PROMPT = """你从网页中提取数据。你会收到提取要求、页面的文本内容和一张视口截图。
只输出一个 JSON 对象，它只有一个键 "data"，"data" 的值必须符合下面的 JSON Schema：
{schema}

例如 Schema 是字符串数组时，输出 {"data": ["第一项", "第二项"]}；不要把 "data" 换成 "items" 等其他键名。

规则：
1. 要求提取“所有”或一个列表时，页面文本中符合要求的每一条都要提取，不要遗漏。
2. 文字照抄页面原文；数字类型的字段只填数字。
3. 页面上没有的信息不要编造。"""

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
    """模型对一步操作的判断；decide() 返回时 point 已换算成相对视口的 0-1 比例。"""

    model_config = ConfigDict(coerce_numbers_to_str=True)

    found: bool
    id: int | None = None
    point: tuple[float, float] | None = None
    method: Literal["click", "fill", "press", "select_option"] = "click"
    args: list[str] = []

    @field_validator("method", mode="before")
    @classmethod
    def _alias(cls, v):
        return {"type": "fill", "input": "fill", "select": "select_option"}.get(v, v)

    @model_validator(mode="after")
    def _check(self):
        if not self.found:
            return self
        if self.method == "click":
            # click 不用 args；模型多给的 args 里带着参数值时，会被当成已经模板化，绕过锚点
            self.args = []
        if self.id is None and self.point is None:
            raise ValueError("found 为 true 时必须给出 id 或 point")
        if self.method != "click" and not self.args:
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
        d = await self._ask(slot, messages, lambda text: Decision.model_validate(_load_json(text)))
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
        pick = await self._ask(slot, messages, lambda text: _Pick.model_validate(_load_json(text)))
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

        return await self._ask(slot, messages, parse)

    async def _chat(self, slot: _Slot, messages: list) -> str:
        # 模型可能要很久才回复，先打印一行，避免看起来像卡住；不以“[obact] fast ”开头，tasks/run.py 不会计为模型步骤
        print(f"[obact] 等待 {slot.name} 模型 {slot.model} 回复……", file=sys.stderr, flush=True)
        resp = await slot.client.chat.completions.create(
            model=slot.model, messages=messages, temperature=0, response_format={"type": "json_object"}
        )
        # 有的接口出错时返回空的 choices，按空回复处理，交给解析报错和重试
        return (resp.choices[0].message.content if resp.choices else None) or ""

    async def _ask(self, slot: _Slot, messages: list, parse):
        """调用并解析；接口出错或 JSON 不合法时同一模型重试 1 次，仍失败抛 ModelError。"""
        error: Exception | None = None
        for _ in range(2):
            try:
                return parse(await self._chat(slot, messages))
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
