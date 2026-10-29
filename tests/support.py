"""pytest 的辅助：假模型、在元素清单里按名称找编号、运行协程。"""

import asyncio
import json
import re
from collections import Counter


def run(coro):
    """在新的事件循环里运行协程；每个测试各开各的浏览器，互不影响。"""
    return asyncio.run(coro)


def element(lst: str, name: str, nth: int = 0) -> int:
    """元素清单里名称正好是 name 的第 nth 个元素的编号。"""
    ids = [int(m.group(1)) for m in re.finditer(rf'^\[(\d+)\] .*?"{re.escape(name)}"', lst, re.MULTILINE)]
    assert len(ids) > nth, f"清单里没有名称为 {name!r} 的元素：\n{lst}"
    return ids[nth]


def center(lst: str, name: str) -> tuple[int, int]:
    """元素清单里名称为 name 的元素在视口里的中心点（像素）。"""
    m = re.search(rf'^\[\d+\] .*?"{re.escape(name)}".*?@\((-?\d+),(-?\d+),(\d+)x(\d+)\)', lst, re.MULTILINE)
    assert m, f"清单里没有名称为 {name!r} 的元素：\n{lst}"
    x, y, w, h = map(int, m.groups())
    return x + w // 2, y + h // 2


class FakeModel:
    """替换 LLM._chat 的假模型，按用户消息开头区分调用类型。

    on_act(指令, 元素清单) 返回 act、download、upload 的决策；on_read(要求, 文本块清单) 返回 read 的结果；
    on_extract(要求, 页面文本) 返回 extract 的 data。calls 按类型计数，slots 记下每次 act 用的槽位，schemas 记下请求带的 schema。
    """

    def __init__(self):
        self.calls = Counter()
        self.slots: list[str] = []
        self.schemas: list[dict | None] = []
        self.on_act = lambda ins, lst: {"found": False, "reason": "没有设置 on_act"}
        self.on_read = lambda ins, lst: {"found": False}
        self.on_extract = lambda ins, text: []

    async def chat(self, slot, messages, schema=None) -> str:
        text = messages[-1]["content"][0]["text"]
        self.schemas.append(schema)
        if text.startswith("这张图片"):
            self.calls["vision"] += 1
            return '{"color": "红色"}'
        if text.startswith("操作指令："):
            self.calls["act"] += 1
            self.slots.append(slot.name)
            ins, lst = text[len("操作指令："):].split("\n\n可交互元素清单：\n", 1)
            return json.dumps(self.on_act(ins, lst), ensure_ascii=False)
        if text.startswith("读取要求："):
            self.calls["read"] += 1
            ins, lst = text[len("读取要求："):].split("\n\n文本块清单：\n", 1)
            return json.dumps(self.on_read(ins, lst), ensure_ascii=False)
        if text.startswith("提取要求："):
            self.calls["extract"] += 1
            ins, page = text[len("提取要求："):].split("\n\n页面文本：\n", 1)
            return json.dumps({"data": self.on_extract(ins, page)}, ensure_ascii=False)
        raise AssertionError(f"没见过的调用：{text[:40]}")

    @property
    def model_calls(self) -> int:
        """视觉检查以外的模型调用次数。"""
        return sum(n for kind, n in self.calls.items() if kind != "vision")


def click(lst: str, name: str, nth: int = 0, method: str = "click", args: list | None = None) -> dict:
    """按名称点击（或其他 method）的决策。"""
    return {"found": True, "id": element(lst, name, nth), "method": method, "args": args or [], "reason": "测试"}
