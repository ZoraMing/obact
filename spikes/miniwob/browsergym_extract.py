"""预研：用 BrowserGym 的提取函数导出页面的可交互元素，作为 BW-14 组件识别对照的基线。

准备（单独的虚拟环境，不进入 obact 依赖）：
  python -m venv spikes/.cache/venv-bg
  spikes/.cache/venv-bg/bin/pip install playwright==1.56.0 numpy pillow "lxml<6" \
      beautifulsoup4 pyparsing gymnasium
  spikes/.cache/venv-bg/bin/pip install --no-deps browsergym-core==0.14.3
  （browsergym-core 锁定 playwright==1.44；这里只用它的提取函数，换用与本机 Chromium 匹配的版本）

用法：
  spikes/.cache/venv-bg/bin/python spikes/miniwob/browsergym_extract.py URL [--miniwob-seed N]
输出：每行一个 JSON：{"bid", "role", "name", "clickable", "visibility", "bbox"}
"""

import argparse
import json
import sys

from browsergym.core.observation import (
    _post_extract,
    _pre_extract,
    extract_dom_extra_properties,
    extract_dom_snapshot,
    extract_merged_axtree,
)
from playwright.sync_api import sync_playwright

# 与 spikes/lib/refs.ts 的 INTERACTIVE_ROLES 保持一致，便于逐条比对
INTERACTIVE_ROLES = {
    "button",
    "link",
    "checkbox",
    "radio",
    "textbox",
    "searchbox",
    "combobox",
    "listbox",
    "option",
    "menuitem",
    "tab",
    "switch",
    "slider",
    "spinbutton",
    "treeitem",
}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("url")
    ap.add_argument("--miniwob-seed", type=int, default=None)
    args = ap.parse_args()

    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--no-sandbox"])
        page = browser.new_page(viewport={"width": 500, "height": 300})
        page.goto(args.url)
        if args.miniwob_seed is not None:
            page.evaluate(f"Math.seedrandom({args.miniwob_seed})")
            page.click("#sync-task-cover")

        _pre_extract(page)
        snapshot = extract_dom_snapshot(page)
        axtree = extract_merged_axtree(page)
        extra = extract_dom_extra_properties(snapshot, scale_factor=1)
        _post_extract(page)

        for node in axtree["nodes"]:
            role = node.get("role", {}).get("value", "")
            bid = node.get("browsergym_id")
            if role not in INTERACTIVE_ROLES or bid is None:
                continue
            props = extra.get(bid, {})
            row = {
                "bid": bid,
                "role": role,
                "name": node.get("name", {}).get("value", ""),
                "clickable": props.get("clickable"),
                "visibility": props.get("visibility"),
                "bbox": props.get("bbox"),
            }
            sys.stdout.write(json.dumps(row, ensure_ascii=False) + "\n")
        browser.close()


if __name__ == "__main__":
    main()
