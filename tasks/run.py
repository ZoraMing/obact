"""依次运行任务集，汇总每个任务的结果、S1 命中次数和走模型的步骤数。

在仓库根目录运行：python tasks/run.py [任务名 ...]，不写任务名时运行全部。
第一遍运行时各步骤走模型并写入缓存；再运行一遍，可以对比 S1 命中次数和走模型的步骤数的变化。
走模型的步骤数按日志统计 act、read、download、extract 中由模型完成的步骤，不含启动时的视觉检查、
fast 失败后升级到 smart 之前的那次调用、同一模型的重试，以及最终失败的步骤。
"""

import os
import subprocess
import sys
import time
from pathlib import Path

TASKS = ["shop", "booking", "archive", "download", "community"]


def run(name: str) -> tuple[str, bool, int, int, float]:
    start = time.time()
    proc = subprocess.Popen(
        [sys.executable, str(Path(__file__).with_name(f"{name}.py"))],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        env={**os.environ, "PYTHONIOENCODING": "utf-8"},
    )
    s1 = model = 0
    for line in proc.stdout:
        print(line, end="", flush=True)
        if line.startswith("[obact] S1 "):
            s1 += 1
        elif line.startswith(("[obact] fast ", "[obact] smart ")):
            model += 1
    return name, proc.wait() == 0, s1, model, time.time() - start


def main(names: list[str]) -> None:
    rows = []
    for name in names or TASKS:
        print(f"\n===== {name} =====", flush=True)
        rows.append(run(name))
    print("\n| 任务 | 结果 | S1 命中 | 走模型的步骤 | 用时 |\n| --- | --- | --- | --- | --- |")
    for name, ok, s1, model, seconds in rows:
        print(f"| {name} | {'通过' if ok else '失败'} | {s1} | {model} | {seconds:.0f}s |")
    sys.exit(0 if all(r[1] for r in rows) else 1)


if __name__ == "__main__":
    main(sys.argv[1:])
