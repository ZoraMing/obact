"""OSWorld 风格 Web 任务 1：电商比价与条件加购

任务：在 Demoblaze 商店的 Laptops 分类里找出最便宜的笔记本电脑，加入购物车并下单；
     把购物车清单保存为 CSV，把下单成功后的订单信息保存为 Markdown。
站点：https://www.demoblaze.com（自动化测试练习商店，无需登录）
覆盖的特性：extract 提取商品列表 + Python 判断最便宜；参数化 act 按商品名点击；
           下单弹窗打开后，遮挡检测只把弹窗里的元素交给模型；expect 校验跳转和弹窗。
校验：购物车里只有选中的商品；订单信息里的金额和姓名正确；结果文件内容正确。
"""

import asyncio
import csv

from common import Checks, out_dir
from pydantic import BaseModel

from obact import Obact

CATEGORY = "Laptops"
BUYER = {
    "Name": "Alex Mercer",
    "Country": "China",
    "City": "Shanghai",
    "Credit card": "4111111111111111",
    "Month": "12",
    "Year": "2027",
}


class Product(BaseModel):
    name: str
    price: float


async def main():
    checks = Checks("shop")
    out = out_dir("shop")
    async with Obact(task="task_shop") as ob:
        await ob.page.goto("https://www.demoblaze.com/")
        await ob.act("点击左侧分类列表中的 {category}", params={"category": CATEGORY})
        products = await ob.extract("页面上所有商品的名称和价格（数字，不含 $）", schema=list[Product])
        cheapest = min(products, key=lambda p: p.price)
        print(f"{CATEGORY} 共 {len(products)} 件商品，最便宜的是 {cheapest.name}（${cheapest.price:g}）")

        await ob.act("点击商品名称为 {name} 的链接", params={"name": cheapest.name}, expect="**/prod.html*")
        # 页面弹出的 Product added 提示框由 obact 自动接受
        await ob.act("点击 Add to cart 按钮")
        await ob.act("点击顶部导航栏的 Cart", expect="**/cart.html")
        cart = await ob.extract("购物车表格里每件商品的名称和价格（数字）", schema=list[Product])

        await ob.act("点击 Place Order 按钮", expect="#orderModal")
        for label, value in BUYER.items():
            await ob.act(f"在下单弹窗的 {label} 输入框输入 {{value}}", params={"value": value})
        await ob.act("点击 Purchase 按钮", expect="text=Thank you for your purchase!")
        receipt = await ob.read("购买成功提示框里的订单信息（Id、Amount、Card Number、Name、Date）")

        cart_file = ob.save(cart, out / "cart.csv")
        receipt_file = ob.save(f"# 订单信息\n\n{receipt}\n", out / "receipt.md")

    checks.check([p.name for p in cart] == [cheapest.name], f"购物车里只有 {cheapest.name}")
    checks.check(f"Amount: {cheapest.price:g} USD" in receipt, f"订单金额为 {cheapest.price:g} USD")
    checks.check(BUYER["Name"] in receipt, "订单姓名正确")
    with cart_file.open(encoding="utf-8-sig") as f:
        checks.check([row["name"] for row in csv.DictReader(f)] == [cheapest.name], "cart.csv 内容正确")
    checks.check("Amount" in receipt_file.read_text(encoding="utf-8"), "receipt.md 已保存订单信息")
    checks.finish()


if __name__ == "__main__":
    asyncio.run(main())
