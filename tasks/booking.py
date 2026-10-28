"""OSWorld 风格 Web 任务 2：多条件表单检索与预订

任务：在 BlazeDemo 查询 Boston 到 London 的航班，预订其中最便宜的一班，填写乘客信息并用 American Express 付款；
     把航班列表保存为 CSV，把预订确认信息保存为 JSON。
站点：https://blazedemo.com（航班预订练习站，无需登录）
覆盖的特性：select_option 和 fill 的参数模板化；同一句指令模板填写多个输入框，缓存键相同，用 step 区分；
           祖先锚定（按航班号点击对应行的 Choose This Flight）；expect 校验每一步跳转的 URL。
校验：进入确认页；确认信息里的卡号尾号正确；结果文件内容正确。
"""

import asyncio
import csv
import json

from common import Checks, out_dir
from pydantic import BaseModel

from obact import Obact

FROM, TO = "Boston", "London"
CARD = "American Express"
PASSENGER = {
    "Name": "Alex Mercer",
    "Address": "1 Main St.",
    "City": "Boston",
    "State": "MA",
    "Zip Code": "02118",
    "Credit Card Number": "4111111111111111",
    "Name on Card": "Alex Mercer",
}


class Flight(BaseModel):
    flight: str
    airline: str
    departs: str
    arrives: str
    price: float


async def main():
    checks = Checks("booking")
    out = out_dir("booking")
    async with Obact(task="task_booking") as ob:
        await ob.page.goto("https://blazedemo.com/")
        await ob.act("在出发城市下拉框中选择 {city}", params={"city": FROM})
        await ob.act("在目的城市下拉框中选择 {city}", params={"city": TO})
        await ob.act("点击 Find Flights 按钮", expect="**/reserve.php")

        flights = await ob.extract("航班表里每个航班的航班号、航空公司、起飞时间、到达时间和价格（数字）", schema=list[Flight])
        cheapest = min(flights, key=lambda f: f.price)
        print(f"{FROM} → {TO} 共 {len(flights)} 个航班，最便宜的是 {cheapest.airline} {cheapest.flight}（${cheapest.price}）")
        await ob.act(
            "点击航班号为 {flight} 的那一行的 Choose This Flight 按钮", params={"flight": cheapest.flight}, expect="**/purchase.php"
        )

        # 同一句指令模板填写多个输入框：缓存键相同，用 step 给每个输入框单独的缓存条目
        for label, value in PASSENGER.items():
            await ob.act("在 {label} 输入框输入 {value}", params={"label": label, "value": value}, step=f"填写 {label}")
        await ob.act("在 Card Type 下拉框中选择 {card}", params={"card": CARD})
        await ob.act("点击 Purchase Flight 按钮", expect="**/confirmation.php")
        confirmation = await ob.read("确认页上的订单详情表格")

        flights_file = ob.save(flights, out / "flights.csv")
        record = {"flight": cheapest.model_dump(), "passenger": PASSENGER, "confirmation": confirmation}
        record_file = ob.save(record, out / "booking.json")

    checks.check("PendingCapture" in confirmation, "确认信息显示订单状态 PendingCapture")
    checks.check(PASSENGER["Credit Card Number"][-4:] in confirmation, "确认信息里的卡号尾号正确")
    with flights_file.open(encoding="utf-8-sig") as f:
        checks.check(len(list(csv.DictReader(f))) == len(flights), f"flights.csv 有 {len(flights)} 行")
    saved = json.loads(record_file.read_text(encoding="utf-8"))
    checks.check(saved["flight"]["flight"] == cheapest.flight, "booking.json 记录了所选航班")
    checks.finish()


if __name__ == "__main__":
    asyncio.run(main())
