"""示例：在 The Internet（自动化测试练习站）的下载页挑一个 .txt 文件下载，并把文件列表整理成 Markdown。

在仓库根目录运行：python examples/download.py
下载页的文件由访客上传，列表会变；下载那一步的选择器带 {name} 参数，换了文件名再运行仍按缓存回放。
结果写到 workspace/outputs/download/。
"""

import asyncio
from pathlib import Path

from obact import Obact

OUT = Path("workspace/outputs/download")


async def main():
    async with Obact(task="download") as ob:
        await ob.page.goto("https://the-internet.herokuapp.com/download")
        names = await ob.extract("页面上所有可下载文件的文件名", schema=list[str])
        name = next(n for n in names if n.lower().endswith(".txt"))
        print(f"共 {len(names)} 个文件，下载 {name}")

        path = await ob.download("点击文件名为 {name} 的下载链接", save_to=OUT, params={"name": name})
        print(f"文件大小 {path.stat().st_size} 字节，开头：{path.read_bytes()[:80]!r}")
        print("已保存：", ob.save(names, OUT / "files.md"))


asyncio.run(main())
