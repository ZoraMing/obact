"""OSWorld 风格 Web 任务 3：数据聚合与本地归档

任务：收集 Quotes to Scrape 前两页的全部名言（正文、作者、标签），保存为 CSV 和 JSON；
     打开名言最多的那位作者的介绍页，把作者简介保存为 Markdown；
     再把 Python 官方文档 csv 模块的 Module contents 章节正文保存为 Markdown。
     原本要在本地编辑器或表格软件里完成的“存成 CSV / Markdown”，由 ob.save() 完成。
站点：https://quotes.toscrape.com（爬虫练习站）、https://docs.python.org（技术文档）
覆盖的特性：extract 列表提取；read 读取长文本区域并缓存位置；翻页链接的缓存复用；
           save 按扩展名写 CSV（带 BOM）、JSON、Markdown。
校验：两页共 20 条名言；作者简介和文档章节内容正确；结果文件内容正确。
"""

import asyncio
import csv
import json
from collections import Counter

from common import Checks, out_dir
from pydantic import BaseModel

from obact import Obact


class Quote(BaseModel):
    text: str
    author: str
    tags: list[str]


async def main():
    checks = Checks("archive")
    out = out_dir("archive")
    async with Obact(task="task_archive") as ob:
        await ob.page.goto("https://quotes.toscrape.com/")
        quotes = await ob.extract("页面上每条名言的正文（不含引号）、作者和标签", schema=list[Quote])
        await ob.act("点击页面底部的 Next 链接翻到下一页", expect="**/page/2/")
        quotes += await ob.extract("页面上每条名言的正文（不含引号）、作者和标签", schema=list[Quote])
        author, count = Counter(q.author for q in quotes).most_common(1)[0]
        print(f"共 {len(quotes)} 条名言，名言最多的作者是 {author}（{count} 条）")

        rows = [{"text": q.text, "author": q.author, "tags": ", ".join(q.tags)} for q in quotes]
        quotes_csv = ob.save(rows, out / "quotes.csv")
        quotes_json = ob.save(quotes, out / "quotes.json")

        await ob.act("点击作者 {author} 名字后面的 (about) 链接", params={"author": author}, expect="**/author/**")
        bio = await ob.read("作者简介 Description 下面的正文")
        bio_md = ob.save(f"# {author}\n\n{bio}\n", out / "author.md")

        await ob.page.goto("https://docs.python.org/3/library/csv.html")
        section = await ob.read("Module contents 这一整节的正文")
        doc_md = ob.save(f"# csv 模块：Module contents\n\n{section}\n", out / "python_csv_module_contents.md")

    checks.check(len(quotes) == 20, f"两页共提取 {len(quotes)} 条名言（应为 20）")
    with quotes_csv.open(encoding="utf-8-sig") as f:
        checks.check(len(list(csv.DictReader(f))) == 20, "quotes.csv 有 20 行")
    checks.check(len(json.loads(quotes_json.read_text(encoding="utf-8"))) == 20, "quotes.json 有 20 条")
    checks.check(len(bio) > 200 and author.split()[-1] in bio, f"author.md 是 {author} 的简介")
    checks.check("csv.reader" in section and "csv.writer" in section, "文档章节包含 csv.reader 和 csv.writer 的说明")
    checks.check(bio_md.exists() and doc_md.exists(), "Markdown 文件已保存")
    checks.finish()


if __name__ == "__main__":
    asyncio.run(main())
