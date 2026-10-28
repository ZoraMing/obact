"""结果文件：按扩展名把数据写成 JSON、CSV、Markdown 或纯文本。"""

import csv
import io
import json
from pathlib import Path
from typing import Any

from pydantic_core import to_jsonable_python


def save(data: Any, path: str | Path) -> Path:
    """data 可以是字符串、BaseModel、字典或它们的列表。

    .csv 只接受对象或对象列表，每个对象一行；.md 中对象列表写成表格，单个对象写成“字段 | 值”表格。
    """
    path = Path(path)
    plain = to_jsonable_python(data)
    suffix = path.suffix.lower()
    if suffix == ".json":
        text = json.dumps(plain, ensure_ascii=False, indent=2) + "\n"
    elif suffix == ".csv":
        text = _csv(_rows(plain))
    elif suffix == ".md":
        text = plain if isinstance(plain, str) else _markdown(plain)
    elif suffix == ".txt":
        text = plain if isinstance(plain, str) else json.dumps(plain, ensure_ascii=False, indent=2) + "\n"
    else:
        raise ValueError(f"不支持的文件类型 {suffix or '（无扩展名）'}，可用 .json、.csv、.md、.txt")
    path.parent.mkdir(parents=True, exist_ok=True)
    # CSV 带 BOM，Excel 直接打开中文不乱码；newline="" 保持换行符原样
    path.write_text(text, encoding="utf-8-sig" if suffix == ".csv" else "utf-8", newline="")
    return path


def _rows(plain: Any) -> list[dict]:
    if isinstance(plain, dict):
        return [plain]
    if isinstance(plain, list) and all(isinstance(r, dict) for r in plain):
        return plain
    raise ValueError("CSV 只能保存对象或对象列表")


def _columns(rows: list[dict]) -> list[str]:
    cols: list[str] = []
    for row in rows:
        cols += [k for k in row if k not in cols]
    return cols


def _cell(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False)
    return str(value)


def _csv(rows: list[dict]) -> str:
    buf = io.StringIO()
    writer = csv.writer(buf, lineterminator="\n")
    cols = _columns(rows)
    writer.writerow(cols)
    writer.writerows([_cell(row.get(c)) for c in cols] for row in rows)
    return buf.getvalue()


def _markdown(plain: Any) -> str:
    if isinstance(plain, dict):
        return _table(["字段", "值"], [[k, v] for k, v in plain.items()])
    if isinstance(plain, list) and plain and all(isinstance(r, dict) for r in plain):
        cols = _columns(plain)
        return _table(cols, [[row.get(c) for c in cols] for row in plain])
    if isinstance(plain, list):
        return "".join(f"- {_md_cell(v)}\n" for v in plain)
    return f"```json\n{json.dumps(plain, ensure_ascii=False, indent=2)}\n```\n"


def _table(header: list, rows: list[list]) -> str:
    lines = ["| " + " | ".join(_md_cell(h) for h in header) + " |", "|" + " --- |" * len(header)]
    lines += ["| " + " | ".join(_md_cell(v) for v in row) + " |" for row in rows]
    return "\n".join(lines) + "\n"


def _md_cell(value: Any) -> str:
    return _cell(value).replace("|", "\\|").replace("\n", "<br>")
