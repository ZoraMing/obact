"""与 TS 端 contract.test.ts 使用同一批样例，保证两端对契约的判定一致。"""

import json
from pathlib import Path

import pytest

from obact.contracts import default_contracts, schemas_dir

EXAMPLES = schemas_dir().parent / "examples"


def _cases():
    for target_dir in sorted(EXAMPLES.iterdir()):
        for f in sorted(target_dir.iterdir()):
            yield pytest.param(target_dir.name, f, id=f"{target_dir.name}/{f.name}")


def _read(f: Path) -> list:
    text = f.read_text("utf-8")
    if f.suffix == ".jsonl":
        return [json.loads(line) for line in text.splitlines() if line.strip()]
    return [json.loads(text)]


@pytest.mark.parametrize(("target", "path"), list(_cases()))
def test_example(target: str, path: Path) -> None:
    contracts = default_contracts()
    expect_valid = path.name.startswith("valid")
    assert expect_valid or path.name.startswith("invalid")
    for i, data in enumerate(_read(path), start=1):
        errs = contracts.errors(target, data)
        if expect_valid:
            assert not errs, f"第 {i} 条：{errs}"
        else:
            assert errs, f"第 {i} 条应当不通过"
