"""BW-14 对照：用 BrowserGym 的提取函数导出多个页面的可交互元素（JSON 行，每页一行）。

环境准备见 bench/README.md（单独的虚拟环境，不进入 obact 依赖）。
用法：python bench/browsergym_extract.py --width 800 --height 600 --settle-ms 300 URL[#seed=N] ...
URL 带 #seed=N 时按 MiniWoB++ 协议设种子并点击 START。
输出：{"url", "items": [{"bid", "tag", "role", "name", "clickable", "visibility", "bbox"}]}
只输出可交互角色或 BrowserGym 判定为可点击（clickable）的节点。
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
    "menuitemcheckbox",
    "menuitemradio",
    "tab",
    "switch",
    "slider",
    "spinbutton",
    "treeitem",
    "gridcell",
}


def extract(page) -> list:
    _pre_extract(page)
    snapshot = extract_dom_snapshot(page)
    axtree = extract_merged_axtree(page)
    extra = extract_dom_extra_properties(snapshot, scale_factor=1)
    # 标签名用于报告分类（body、label 等）；只取顶层文档
    tags = page.evaluate(
        "() => Object.fromEntries([...document.querySelectorAll('[bid]')]"
        ".map(e => [e.getAttribute('bid'), e.tagName.toLowerCase()]))"
    )
    _post_extract(page)
    items, seen = [], set()
    for node in axtree["nodes"]:
        bid = node.get("browsergym_id")
        if bid is None or bid in seen:
            continue
        role = node.get("role", {}).get("value", "")
        props = extra.get(bid, {})
        if role not in INTERACTIVE_ROLES and not props.get("clickable"):
            continue
        seen.add(bid)
        items.append(
            {
                "bid": bid,
                "tag": tags.get(bid, ""),
                "role": role,
                "name": node.get("name", {}).get("value", ""),
                "clickable": bool(props.get("clickable")),
                "visibility": props.get("visibility") or 0,
                "bbox": props.get("bbox"),
            }
        )
    return items


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("urls", nargs="+")
    ap.add_argument("--width", type=int, default=800)
    ap.add_argument("--height", type=int, default=600)
    ap.add_argument("--settle-ms", type=int, default=300)
    args = ap.parse_args()
    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--no-sandbox"])
        page = browser.new_page(viewport={"width": args.width, "height": args.height})
        for url in args.urls:
            base, _, frag = url.partition("#seed=")
            try:
                page.goto(base)
                if frag:
                    page.evaluate(f"Math.seedrandom({int(frag)})")
                    page.click("#sync-task-cover")
                page.wait_for_timeout(args.settle_ms)
                items = extract(page)
                out = {"url": url, "items": items}
            except Exception as e:  # noqa: BLE001 — 单页失败不影响其余页面
                out = {"url": url, "error": str(e)[:200]}
            sys.stdout.write(json.dumps(out, ensure_ascii=False) + "\n")
            sys.stdout.flush()
        browser.close()


if __name__ == "__main__":
    main()
