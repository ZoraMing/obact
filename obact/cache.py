"""步骤缓存：每个任务一个 JSONL 文件，负责缓存键生成、参数模板化与回填、读写。"""

import json
import os
import re
from pathlib import Path
from urllib.parse import urlsplit

# XPath 里的字符串字面量；参数值只在字面量内替换，避免误改 div[1] 这类位置下标
_LITERAL = re.compile(r"'[^']*'|\"[^\"]*\"")


def cache_key(label: str, url: str) -> str:
    """step 或指令模板，加上 URL 的域名和路径（去掉查询串，纯数字路径段换成 *）。"""
    parts = urlsplit(url)
    path = "/".join("*" if seg.isdigit() else seg for seg in parts.path.split("/"))
    return f"{label}|{parts.netloc}{path}"


def render(text: str, params: dict[str, str]) -> str:
    """把 {参数名} 填回参数值。"""
    for name, value in params.items():
        text = text.replace("{" + name + "}", value)
    return text


def _sub(text: str, pairs: list[tuple[str, str]], hits: set[str]) -> str:
    for name, value in pairs:
        if value and value in text:
            text = text.replace(value, "{" + name + "}")
            hits.add(name)
    return text


def _templatize_parts(selector: str | None, args: list[str], params: dict[str, str]):
    # 长的参数值先替换，避免短值是长值的一部分时被拆开
    pairs = sorted(params.items(), key=lambda kv: len(kv[1]), reverse=True)
    hits: set[str] = set()
    if selector is not None:
        selector = _LITERAL.sub(lambda m: _sub(m.group(0), pairs, hits), selector)
    args = [_sub(a, pairs, hits) for a in args]
    return selector, args, hits


def untemplated(selector: str | None, args: list[str], params: dict[str, str]) -> list[str]:
    """既不在 selector 字面量里、也不在 args 里的参数值。"""
    _, _, hits = _templatize_parts(selector, args, params)
    return [value for name, value in params.items() if name not in hits]


def templatize(entry: dict, params: dict[str, str]) -> dict | None:
    """参数值替换成 {参数名}；有参数无法模板化时返回 None，这一步不缓存。"""
    selector, args, hits = _templatize_parts(entry.get("selector"), entry["args"], params)
    if hits != set(params):
        return None
    out = dict(entry, args=args)
    if selector is not None:
        out["selector"] = selector
    if "name" in out:
        pairs = sorted(params.items(), key=lambda kv: len(kv[1]), reverse=True)
        out["name"] = _sub(out["name"], pairs, set())
    return out


class Cache:
    def __init__(self, path: Path):
        self.path = path
        self._entries: dict[str, dict] = {}
        if not path.exists():
            return
        for no, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if not line.strip():
                continue
            try:
                entry = json.loads(line)
                if not (
                    isinstance(entry, dict)
                    and isinstance(entry.get("key"), str)
                    and ("selector" in entry or "point" in entry)
                    and "method" in entry
                ):
                    raise ValueError("缺少必需字段")
            except ValueError as e:
                print(f"[obact] 警告：{path} 第 {no} 行损坏，已跳过（{e}）", flush=True)
                continue
            self._entries[entry["key"]] = entry

    def get(self, key: str) -> dict | None:
        return self._entries.get(key)

    def put(self, entry: dict) -> None:
        """写入或覆盖条目，整文件重写。"""
        self._entries[entry["key"]] = entry
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(
            "".join(json.dumps(e, ensure_ascii=False) + "\n" for e in self._entries.values()), encoding="utf-8"
        )
        os.replace(tmp, self.path)
