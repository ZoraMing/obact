"""任务集公共部分：输出目录和结果校验。"""

import sys
from pathlib import Path

OUT_ROOT = Path("workspace/outputs/tasks")


def out_dir(task: str) -> Path:
    path = OUT_ROOT / task
    path.mkdir(parents=True, exist_ok=True)
    return path


class Checks:
    """收集校验结果，相当于 OSWorld 的评测函数。finish 时有未通过项就以退出码 1 结束，供 run.py 统计。"""

    def __init__(self, task: str):
        self.task = task
        self.failed: list[str] = []

    def check(self, ok: bool, desc: str) -> None:
        print(f"[校验] {'通过' if ok else '失败'}：{desc}", flush=True)
        if not ok:
            self.failed.append(desc)

    def finish(self) -> None:
        if self.failed:
            print(f"[任务] {self.task} 失败：{len(self.failed)} 项校验未通过", flush=True)
            sys.exit(1)
        print(f"[任务] {self.task} 通过", flush=True)
