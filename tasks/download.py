"""OSWorld 风格 Web 任务 4：Web 资源筛选与文件下载

任务：在 The Internet 的文件下载页，找出文件名以 .txt 结尾的文件，下载前两个到指定目录，
     并生成一份下载清单（文件名、大小、SHA-256），保存为 JSON 和 CSV。
站点：https://the-internet.herokuapp.com/download（自动化测试练习站，文件由访客上传，列表会变）
覆盖的特性：extract 提取文件列表 + Python 按后缀筛选；download 点击后监听浏览器下载（15 秒内未触发视为失败、不写缓存）；
           下载链接用参数定位，第二个文件直接按第一个文件学到的缓存回放。
校验：下载的文件都在目标目录里、后缀正确且不为空；清单和实际文件一致。
"""

import asyncio
import hashlib
import json
from collections import Counter

from common import Checks, out_dir

from obact import Obact

SUFFIX = ".txt"
COUNT = 2


async def main():
    checks = Checks("download")
    out = out_dir("download")
    async with Obact(task="task_download") as ob:
        await ob.page.goto("https://the-internet.herokuapp.com/download")
        names = await ob.extract("页面上所有可下载文件的文件名", schema=list[str])
        # 同名文件会让下载链接无法唯一定位，只选列表里只出现一次的
        counts = Counter(names)
        picked = [n for n in counts if n.lower().endswith(SUFFIX) and counts[n] == 1][:COUNT]
        print(f"共 {len(names)} 个文件，选中 {picked}")

        manifest = []
        for name in picked:
            path = await ob.download("点击文件名为 {name} 的下载链接", save_to=out / "files", params={"name": name})
            data = path.read_bytes()
            manifest.append({"name": path.name, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()})
        manifest_json = ob.save(manifest, out / "manifest.json")
        ob.save(manifest, out / "manifest.csv")

    checks.check(len(picked) == COUNT, f"找到 {COUNT} 个 {SUFFIX} 文件")
    for item in manifest:
        path = out / "files" / item["name"]
        checks.check(path.exists() and item["bytes"] > 0 and item["name"].lower().endswith(SUFFIX), f"{item['name']} 已下载且不为空")
    saved = json.loads(manifest_json.read_text(encoding="utf-8"))
    checks.check([i["name"] for i in saved] == [i["name"] for i in manifest], "下载清单和实际文件一致")
    checks.finish()


if __name__ == "__main__":
    asyncio.run(main())
