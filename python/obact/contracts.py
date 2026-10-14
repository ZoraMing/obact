"""按 packages/schemas 中冻结的 JSON Schema 校验数据，与 TS 端（@obact/schemas）同源。"""

from __future__ import annotations

import json
import os
from functools import cache
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry, Resource

SCHEMA_BASE = "https://obact.local/schemas/v1/"


def schemas_dir() -> Path:
    """Schema 目录：环境变量 OBACT_SCHEMAS_DIR，否则取仓库内 packages/schemas/schemas。"""
    env = os.environ.get("OBACT_SCHEMAS_DIR")
    if env:
        return Path(env)
    return Path(__file__).resolve().parents[2] / "packages" / "schemas" / "schemas"


def load_schemas(directory: Path | None = None) -> list[dict[str, Any]]:
    directory = directory or schemas_dir()
    return [json.loads(p.read_text("utf-8")) for p in sorted(directory.glob("*.json"))]


def schema_uri(target: str) -> str:
    """契约目标：`observe.json#/$defs/Result`，或简写 `observe.Result`、`action`。"""
    if "#" in target or target.endswith(".json"):
        return SCHEMA_BASE + target
    file, *defs = target.split(".")
    uri = f"{SCHEMA_BASE}{file}.json"
    return f"{uri}#/$defs/{'.'.join(defs)}" if defs else uri


class Contracts:
    def __init__(self, schemas: list[dict[str, Any]] | None = None) -> None:
        schemas = schemas if schemas is not None else load_schemas()
        self.registry: Registry = Registry().with_resources(
            (s["$id"], Resource.from_contents(s)) for s in schemas
        )
        self._validators: dict[str, Draft202012Validator] = {}

    def validator(self, target: str) -> Draft202012Validator:
        uri = schema_uri(target)
        if uri not in self._validators:
            self._validators[uri] = Draft202012Validator(
                {"$ref": uri}, registry=self.registry, format_checker=FormatChecker()
            )
        return self._validators[uri]

    def errors(self, target: str, data: Any) -> list[str]:
        """校验通过返回空列表。"""
        return [
            f"{'/'.join(map(str, e.absolute_path)) or '(根)'}: {e.message}"
            for e in self.validator(target).iter_errors(data)
        ]

    def check(self, target: str, data: Any) -> None:
        errs = self.errors(target, data)
        if errs:
            raise ValueError(f"不符合契约 {target}：" + "；".join(errs))


@cache
def default_contracts() -> Contracts:
    return Contracts()
