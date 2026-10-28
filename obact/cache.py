"""步骤缓存：每个任务一个 JSONL 文件，负责缓存键生成、参数模板化与回填、读写。"""

import json
import os
import re
import sys
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


def render_selector(selector: str, params: dict[str, str]) -> str:
    """把参数填回选择器；每个字面量填好后按 XPath 规则重新加引号，参数值里的引号不会破坏或改写选择器。"""
    return _LITERAL.sub(lambda m: _xpath_literal(render(m.group(0)[1:-1], params)), selector)


def _xpath_literal(value: str) -> str:
    """与 snapshot.js 的 esc 一致。"""
    if "'" not in value:
        return f"'{value}'"
    if '"' not in value:
        return f'"{value}"'
    parts = [p for p in re.split(r"('+)", value) if p]
    return "concat(" + ",".join(f'"{p}"' if p.startswith("'") else f"'{p}'" for p in parts) + ")"


def _sub(text: str, pairs: list[tuple[str, str]], hits: set[str]) -> str:
    for name, value in pairs:
        if value and value in text:
            text = text.replace(value, "{" + name + "}")
            hits.add(name)
    return text


def _templatize_parts(selector: str | None, args: list[str], params: dict[str, str]):
    """返回模板化后的 selector、args、命中的参数名，以及用于定位的参数（不在 args 里的那些）。

    出现在 args 里的参数是输入内容，只在 args 中替换；它的值碰巧也出现在选择器里时（如 qty-2 里的 2）不替换，
    否则换值回放会定位到别的元素。
    """
    # 长的参数值先替换，避免短值是长值的一部分时被拆开
    pairs = sorted(params.items(), key=lambda kv: len(kv[1]), reverse=True)
    hits: set[str] = set()
    args = [_sub(a, pairs, hits) for a in args]
    locate = [(name, value) for name, value in pairs if name not in hits]
    if selector is not None:
        selector = _LITERAL.sub(lambda m: _sub(m.group(0), locate, hits), selector)
    return selector, args, hits, locate


def untemplated(selector: str | None, args: list[str], params: dict[str, str]) -> list[str]:
    """既不在 selector 字面量里、也不在 args 里的参数值。"""
    _, _, hits, _ = _templatize_parts(selector, args, params)
    return [value for name, value in params.items() if name not in hits]


def templatize(entry: dict, params: dict[str, str]) -> dict | None:
    """参数值替换成 {参数名}；有参数无法模板化时返回 None，这一步不缓存。"""
    selector, args, hits, locate = _templatize_parts(entry.get("selector"), entry["args"], params)
    if hits != set(params):
        return None
    out = dict(entry, args=args)
    if selector is not None:
        out["selector"] = selector
    if "name" in out:
        out["name"] = _sub(out["name"], locate, set())
    return out


class Cache:
    def __init__(self, path: Path):
        self.path = path
        self._entries = self._load(warn=True)

    def _load(self, warn: bool) -> dict[str, dict]:
        entries: dict[str, dict] = {}
        if not self.path.exists():
            return entries
        for no, line in enumerate(self.path.read_text(encoding="utf-8").splitlines(), 1):
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
                if warn:
                    print(f"[obact] 警告：{self.path} 第 {no} 行损坏，已跳过（{e}）", file=sys.stderr, flush=True)
                continue
            entries[entry["key"]] = entry
        return entries

    def get(self, key: str) -> dict | None:
        return self._entries.get(key)

    def on_page(self, url: str) -> list[tuple[str, dict]]:
        """该页面（域名 + 路径）下的缓存条目，连同键中 step 或指令模板的部分。"""
        suffix = cache_key("", url)
        return [(k[: -len(suffix)], e) for k, e in self._entries.items() if k.endswith(suffix)]

    def put(self, entry: dict) -> None:
        """写入或覆盖条目。先重新读取文件，保留其他进程写入的条目，再整文件重写。"""
        self._entries = self._load(warn=False)
        self._entries[entry["key"]] = entry
        self._write()

    def delete(self, key: str) -> None:
        """删除条目。先重新读取文件，保留其他进程写入的条目，再整文件重写。"""
        self._entries = self._load(warn=False)
        if self._entries.pop(key, None) is not None:
            self._write()

    def _write(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(
            "".join(json.dumps(e, ensure_ascii=False) + "\n" for e in self._entries.values()), encoding="utf-8"
        )
        os.replace(tmp, self.path)
