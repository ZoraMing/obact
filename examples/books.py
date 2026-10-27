"""示例：在 Books to Scrape（爬虫练习站）的指定分类里找最便宜的书，打开详情页并提取 UPC 和库存。

在仓库根目录运行：python examples/books.py [分类名]，例如 python examples/books.py Poetry
第一次运行每步都走模型并写入 .obact/books.jsonl；换一个分类再运行，act 步骤直接按缓存回放，只有 extract 调用模型。
"""

import asyncio
import sys

from pydantic import BaseModel

from obact import Obact


class Book(BaseModel):
    title: str
    price: float


class BookDetail(BaseModel):
    upc: str
    price: float
    stock: int


async def main(category: str):
    async with Obact(task="books", config="obact.yaml") as ob:
        await ob.page.goto("https://books.toscrape.com/")
        await ob.act("点击左侧分类列表中的 {category}", params={"category": category}, expect="**/category/books/**")

        # 判断交给代码：先提取数据，再用参数化的 act 操作选中的那一项
        books = await ob.extract("页面上所有书的书名和价格（数字，不含货币符号）", schema=list[Book])
        cheapest = min(books, key=lambda b: b.price)
        print(f"{category} 分类首页共 {len(books)} 本书，最便宜的是《{cheapest.title}》£{cheapest.price}")
        await ob.act("点击书名为 {title} 的链接", params={"title": cheapest.title}, expect="text=Product Description")

        detail = await ob.extract("这本书的 UPC、含税价格（数字）和库存数量（Availability 里的数字）", schema=BookDetail)
        print(f"UPC {detail.upc}，价格 £{detail.price}，库存 {detail.stock} 本")


asyncio.run(main(sys.argv[1] if len(sys.argv) > 1 else "Travel"))
