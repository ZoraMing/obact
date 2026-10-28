"""示例：在 Google Flights 搜索 2026-12-25 苏黎世到伦敦的单程经济舱航班，由 smart 模型综合票价和耗时推荐航班。

只搜索、不选择或预订航班。搜索前的每一步都是一句 act，下拉框、输入框、日期选择都按缓存回放；
最后的推荐用 extract 并指定 slot="smart"，每次都调用模型。

在仓库根目录运行：python examples/google_flights.py
结果写到 workspace/outputs/google_flights/：推荐列表的 Markdown 表格和 CSV。
"""

import asyncio
from pathlib import Path

from playwright.async_api import Error as PlaywrightError
from pydantic import BaseModel

from obact import Obact

URL = "https://www.google.com/travel/flights?hl=en"
OUT = Path("workspace/outputs/google_flights")


class FlightRecommendation(BaseModel):
    rank: int
    airline: str
    departure_time: str
    arrival_time: str
    duration: str
    stops: str
    price: str
    analysis: str  # 推荐理由（分析为什么该航班兼具便宜与耗时短的优势）


async def main():
    async with Obact(task="google_flights") as ob:
        await ob.goto(URL)

        # 处理可能出现的 Google Cookie 授权弹窗
        try:
            consent = ob.page.locator("button:has-text('Accept all'), button:has-text('Reject all')")
            if await consent.first.is_visible():
                await consent.first.click()
        except PlaywrightError:
            pass

        # 1. 切换为单程（One way）
        await ob.act("点击航程类型下拉框，当前显示为 {trip_type}", params={"trip_type": "Round trip"})
        await ob.act("在航程类型菜单中点击选择 {target_type}", params={"target_type": "One way"})

        # 2. 填写出发地（Zurich）
        await ob.act("点击出发地输入框（Where from?）")
        await ob.act("在出发地输入框中输入 {origin}", params={"origin": "Zurich"})
        await ob.act("在搜索建议列表中点击 {origin} 选项", params={"origin": "Zurich"})

        # 3. 填写目的地（London）
        await ob.act("点击目的地输入框（Where to?）")
        await ob.act("在目的地输入框中输入 {dest}", params={"dest": "London"})
        await ob.act("在搜索建议列表中点击 {dest} 选项", params={"dest": "London"})

        # 4. 选择出发日期（12 25, 2026）
        await ob.act("点击出发日期输入框（Departure）")
        await ob.act("在日期输入框中输入 {date}", params={"date": "12/25/2026"})
        await ob.act("点击日期选择器弹窗右下角的 Done 完成按钮")

        # 5. 点击搜索并等待匹配的航班结果出现
        await ob.act("点击 Search 或 Explore 搜索航班按钮", expect="text=Top flights")

        # 6. 使用 smart 槽位模型综合权衡价格与时长，挑选并推荐性价比最高（尽可能便宜且耗时短）的航班
        prompt = (
            "从页面显示的航班列表中，综合考虑票价和飞行耗时，选出性价比最高（尽可能便宜、耗时尽可能短且尽量直飞）"
            "的优质航班，给出排名、详细参数以及推荐理由分析。"
        )
        recommendations = await ob.extract(prompt, schema=list[FlightRecommendation], slot="smart")

        print(f"smart 模型已挑选出 {len(recommendations)} 个高性价比航班：")
        for item in recommendations:
            print(f"[{item.rank}] {item.airline} | {item.duration} | {item.price} | {item.analysis}")

        # 7. 保存为 Markdown 表格文档与 CSV
        md_file = ob.save(recommendations, OUT / "recommended_flights.md")
        csv_file = ob.save(recommendations, OUT / "recommended_flights.csv")
        print(f"Markdown 文档已保存至：{md_file}")
        print(f"CSV 数据已保存至：{csv_file}")


if __name__ == "__main__":
    asyncio.run(main())
