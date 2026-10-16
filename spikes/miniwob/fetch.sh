#!/usr/bin/env bash
# 下载 MiniWoB++（MIT 许可）的发布包并解出 HTML 任务页，不安装它的 Python 环境。
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p .cache/dl
pip download --no-deps -q -d .cache/dl "miniwob==1.1.0"
rm -rf .cache/miniwob-pkg
python3 -m zipfile -e .cache/dl/miniwob-1.1.0-py3-none-any.whl .cache/miniwob-pkg
echo "MiniWoB++ 任务页：$(pwd)/.cache/miniwob-pkg/miniwob/html/miniwob（$(ls .cache/miniwob-pkg/miniwob/html/miniwob | wc -l) 个）"
