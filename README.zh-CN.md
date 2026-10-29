# Obact

[English](README.md) | 简体中文

用一句话描述网页上要做的每一步：第一次由视觉模型看着页面找到目标并执行，成功后把位置记下来；之后再做同样的事，直接按记下的位置执行，不再调用模型。页面改版、记录失效时，自动回到模型重新找，并更新记录。

- 学一次，之后不再调用模型：重复执行的流程，第二遍起速度和普通自动化脚本一个量级。
- 换参数也能复用：会变化的值（城市、商品名、航班号）写成 {占位符}，换成别的值照样按记录执行。
- 自愈：记录对不上页面时自动重新定位，不需要人工维护。
- 两种运行方式：MCP 方式在 Claude Code 里用自然语言让 AI 操作浏览器，不用写代码；Workflow 方式把流程写成 Python 脚本，按固定步骤执行。
- 模型自选：任意 OpenAI 格式、支持识图的模型，本地或云端都可以。

![同一任务跑两遍：第一遍由模型定位，第二遍按缓存回放](docs/images/demo.gif)

上图是 tasks/booking.py（在 blazedemo.com 查询并预订最便宜的航班）实际跑两遍的终端输出，等待模型的时间做了压缩：

| | 手写 Playwright 脚本 | 每步都问模型的 Agent | Obact |
| --- | --- | --- | --- |
| 编写 | 要自己找选择器 | 一句话 | 一句话 |
| 重复运行的成本和速度 | 无模型调用，快 | 每步调用模型，慢、贵 | 第一遍调用模型，之后和脚本一样 |
| 页面改版后 | 选择器失效，要手改 | 能适应 | 自动重新定位，更新缓存 |
| 结果是否可复现 | 是 | 每次路径可能不同 | 是，缓存是可读的 JSONL |

## 两种运行方式

| | MCP 方式 | Workflow 方式 |
| --- | --- | --- |
| 面向 | 不写代码的用户 | 程序员、二次开发 |
| 怎么用 | 在 Claude Code 里用中文说要做什么，Claude 调用 Obact 操作浏览器 | 写 Python 脚本，用 python 运行 |
| 谁决定下一步 | Claude 每一步看页面后决定，Obact 负责执行和缓存 | 脚本里写好的步骤，按顺序执行 |
| 适合 | 探索性、一次性的任务，不想写代码 | 要反复执行的固定流程 |
| 安装 | uv tool install，再用 claude mcp add 接入 | 在项目虚拟环境里 pip install |
| 缓存（操作记录）命中 | 措辞与已记录的步骤一致才命中；Claude 查看页面时会看到本页面已记录的步骤，并按原样复用 | 指令文字不变就命中，第二遍起 act、read、download 不调用模型 |

两种方式都要在使用的文件夹里放一个 .env，写上模型的接口地址、模型名和密钥。

## MCP 方式：在 Claude Code 中使用（不需要写代码）

Claude Code 是在终端里和 AI 对话、让 AI 帮你做事的工具。MCP 是它接入外部工具的方式：把 Obact 接进去以后，Claude 就能打开浏览器、查看页面、点击和输入、读出文字、把结果存成文件。你只需要用中文说要做什么。

### 准备

1. 已经装好的 [Claude Code](https://code.claude.com/docs)。
2. 一个支持识图的模型的三项信息（向模型服务商获取）：接口地址（通常以 /v1 结尾）、模型名、密钥。任意 OpenAI 格式的接口都可以，本地或云端都行。
3. 一个专门用来放 Obact 记录和输出文件的文件夹，下面称为“你的文件夹”。

安装有两种做法，选一种即可：让 Claude 帮你装，或者自己在终端里执行命令。

### 让 Claude 帮你装

在你想使用 Obact 的文件夹里打开 Claude Code，把下面这段话原样发给它：

```
请帮我安装并配置 Obact 浏览器自动化工具（https://github.com/ZoraMing/obact）：
1. 如果还没有 uv，按 https://docs.astral.sh/uv/ 的官方方法安装 uv。
2. 执行 uv tool install https://github.com/ZoraMing/obact/archive/refs/heads/master.zip
3. 执行 uvx playwright==1.58.0 install chromium 安装浏览器。
4. 在当前文件夹新建 .env，向我询问模型的接口地址、模型名和密钥，写成 MODEL_BASE_URL、MODEL_NAME、MODEL_KEY 三行；如果有 .gitignore，把 .env 和 .obact 加进去。
5. 执行 claude mcp add obact -- obact-mcp
完成后告诉我需要重启 Claude Code 还是在 /mcp 里重新连接。
```

### 自己动手装

在终端里依次执行（Windows 用 PowerShell）：

```powershell
# 1. 安装 uv（Python 工具管理器，会自动准备好 Python）；macOS、Linux 用 curl -LsSf https://astral.sh/uv/install.sh | sh
powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"

# 2. 关掉终端重新打开，安装 Obact 和它用的浏览器
uv tool install https://github.com/ZoraMing/obact/archive/refs/heads/master.zip
uvx playwright==1.58.0 install chromium

# 3. 进入你要使用的文件夹，把 Obact 接入 Claude Code
cd 你的文件夹
claude mcp add obact -- obact-mcp
```

然后在这个文件夹里新建一个名为 .env 的文本文件，写入：

```
MODEL_BASE_URL = 模型接口地址
MODEL_NAME = 模型名
MODEL_KEY = 你的密钥
```

用记事本保存时，“保存类型”选“所有文件”，否则文件会变成 .env.txt。等号右边换成你自己的值，不用加引号。

### 确认接好了

在你的文件夹里启动 Claude Code，输入 /mcp，列表里能看到 obact 就说明接入成功。看不到时，先确认是在你的文件夹里执行的 claude mcp add，再重启 Claude Code。

### 开始使用

在这个文件夹里启动 Claude Code，直接用中文说要做什么。说清楚打开哪个网站、要做什么、结果要什么形式（直接告诉你，还是存成表格），例如：

- 打开 books.toscrape.com 首页，像人一样在页面上点击进入 Travel 分类，找出最便宜的书，点开它的详情页，读出商品描述，用两三句话告诉我这本书讲什么、多少钱
- 打开 blazedemo.com，查一下从 Boston 到 London 的航班，把航班列表存成表格
- 帮我看看 1 月 1 日左右深圳去日本的机票，或者香港去日本的机票价格，尽量便宜一点

下图是 Claude Code 实际完成第一个例子的过程（按 claude -p，即 Claude Code 非交互模式的真实输出整理，用时 79 秒，画面做了压缩）：

![Claude Code 通过 obact 操作浏览器](docs/images/claude-code.gif)

Claude 第一次操作浏览器时会弹出一个浏览器窗口，你可以看着它操作。这个浏览器是 Obact 单独打开的，和你平时用的浏览器互不相干，里面没有你的书签和已登录的账号。Claude 查看页面时拿到的是元素清单和下面这样带编号框的截图，再选择要操作的元素。做成功的步骤会记录在你的文件夹下的 .obact 文件夹里，下次做同样的事会更快；保存的表格等文件也放在你的文件夹里。

![page_state 返回的带编号截图](docs/images/page-state.png)

### 示例：查机票

下图是第三个例子的实际过程（按 claude -p 的真实输出和每一步的浏览器截图整理，用时约 4 分钟，画面做了压缩）。Claude 在 Google 机票上分别查了深圳、香港出发去东京和大阪的单程票，又查了香港出发 12 月 31 日到 1 月 2 日的价格，最后汇总成对比和建议。票价是录制当天的查询结果，会随时变化。

![Claude Code 通过 obact 查机票](docs/images/flights.gif)

### 常见问题

| 情况 | 怎么办 |
| --- | --- |
| 没有 .env 或少写了某一项 | 第一次操作浏览器时会报错，Claude 会告诉你它在哪里找的 .env，并给出配置模板，照着补上即可 |
| 改了 .env 后不生效 | 在 Claude Code 里输入 /mcp，重新连接 obact |
| 要操作的网站需要登录账号，或者弹出验证码 | Claude 会请你在 Obact 打开的浏览器窗口里手动登录或完成验证，完成后告诉它继续 |
| 浏览器窗口被关掉了 | 下一次操作时会自动重新打开，之前打开的页面需要重新打开 |
| 网站登录一次后，下次不想再登录 | 见下面的“保留网站的登录状态” |
| 不想看到浏览器窗口 | 在 .env 里加一行 OBACT_HEADLESS = true，浏览器改在后台运行。这时没法手动登录或过验证码，需要的话先去掉这一行 |
| 模型经常找不到要点的东西 | Obact 默认用 .env 里的模型（称为 fast 模型），找不到时可以改用一个更强的备用模型（smart 模型）。在 .env 里加上 SMART_MODEL_BASE_URL、SMART_MODEL_NAME、SMART_MODEL_KEY 三行，和上面的模型同一家时只写 SMART_MODEL_NAME 即可，没写的项沿用上面的设置 |
| 更新 Obact | 重新执行第 2 步的 uv tool install 命令，加上 --reinstall，然后在 /mcp 里重新连接 |

### 保留网站的登录状态

这里的登录是指登录你要让 Claude 操作的网站，比如购物网站、论坛、后台管理系统的账号。默认情况下，Obact 每次打开浏览器都用一个全新的临时目录，浏览器关闭后，网站的登录状态（cookie）就丢了，下次还要重新登录。

想让登录状态保留下来，在 .env 里加一行：

```
OBACT_USER_DATA_DIR = workspace/profiles/default
```

等号右边是一个文件夹路径，浏览器会把 cookie、登录状态等数据存在这里，下次打开时接着用。路径可以自己定；写相对路径时，从你的文件夹算起，上面这行就是你的文件夹下的 workspace/profiles/default。改完 .env 后在 /mcp 里重新连接 obact，然后在 Obact 打开的浏览器里手动登录一次，之后就不用再登录了（网站自己让登录过期的除外）。

注意：

- 这个文件夹里存着你的登录信息，不要发给别人，也不要上传到网上。
- 同一时间只能有一个 Claude Code 会话使用这个文件夹，同时开两个会话时，后打开浏览器的那个会失败。

工具列表、缓存规则、启动参数、其他 MCP 客户端的配置方法见 [MCP 服务](docs/mcp.md)。

## Workflow 方式：写 Python 脚本

需要 Python 3.11 及以上。在项目虚拟环境中安装，项目根目录放 .env（同上，完整配置见 [使用指南](docs/guide.md#配置)）：

```powershell
pip install https://github.com/ZoraMing/obact/archive/refs/heads/master.zip   # 二次开发时改为 pip install -e 源码路径
playwright install chromium
```

```python
import asyncio
from pydantic import BaseModel
from obact import Obact


class Book(BaseModel):
    title: str
    price: float


async def main():
    async with Obact(task="books") as ob:                           # 缓存写到 .obact/books/steps.jsonl
        await ob.goto("https://books.toscrape.com/")
        await ob.act("点击左侧分类列表中的 {category}", params={"category": "Travel"}, expect="**/category/books/**")
        books = await ob.extract("页面上所有书的书名和价格", schema=list[Book])
        cheapest = min(books, key=lambda b: b.price)                 # 判断交给代码
        await ob.act("点击书名为 {title} 的链接", params={"title": cheapest.title})
        description = await ob.read("Product Description 标题下面的那段商品描述")
        ob.save(books, "books.csv")


asyncio.run(main())
```

连续执行两遍 python books.py：第一遍日志是“fast 视觉模型执行（无缓存）”，第二遍变成“S1 命中缓存，直接回放”。extract 每次都调用模型；日志出现“参数无法模板化，不缓存”的步骤也是，写法见 [使用指南](docs/guide.md#写指令的要点)。接口见下表，模块划分和实现细节见 [架构与实现](docs/architecture.md)。

## 接口

| 接口 | 作用 | 缓存 |
| --- | --- | --- |
| act | 点击、悬停、输入、按键、下拉选择 | 缓存目标位置 |
| read | 读出页面上某块区域（正文、表格、列表）的全部文字 | 缓存区域位置 |
| download | 点击触发下载并保存文件 | 缓存点击位置 |
| upload | 点击上传按钮，在文件选择框里选中本地文件 | 缓存点击位置 |
| extract | 按 pydantic schema 提取结构化数据 | 不缓存，每次调用模型 |
| save | 把结果写成 JSON、CSV、Markdown 或 TXT 文件 | — |
| scroll | 向下滚动一屏，让懒加载、无限滚动的内容出现 | 不调用模型 |
| wait_for | 等地址匹配、某个元素出现，或固定等一段时间 | 不调用模型 |
| wait_for_human | 暂停，等人工完成验证码、登录等操作 | — |

参数、expect 校验、日志含义、失败处理和缓存格式见 [使用指南](docs/guide.md)。

## 工作原理

![act() 总流程](docs/images/2-act-flow.svg)

1. 每一步生成缓存键：指令模板（或 step）加上页面的域名和路径。
2. 命中缓存时（S1）：核对选择器只匹配到一个元素、名称与缓存一致，然后直接执行。
3. 没命中或核对不符时（S2）：拍下元素清单和带编号的截图交给 fast 模型，模型选出编号；失败再交给 smart 模型。
4. 执行后校验：写了 expect 就等 expect；没写时检查页面有没有发生变化。通过才写缓存。
5. 写缓存时把参数值换回 {占位符}，生成可以换参数回放的选择器：

```json
{"key": "点击航班号为 {flight} 的那一行的 Choose This Flight 按钮|blazedemo.com/reserve.php",
 "selector": "xpath=//tr[.//text()[normalize-space(.)='{flight}']]//input[@type='submit']",
 "name": "Choose This Flight", "method": "click", "args": []}
```

详细设计见 [架构与实现](docs/architecture.md)。页面元素收集、选择器生成、页面稳定等待和反自动化检测参考了 [Stagehand](https://github.com/browserbase/stagehand)。

## 更多

| 文档 | 内容 |
| --- | --- |
| [使用指南](docs/guide.md) | 配置、接口参数、写指令的要点、expect、日志、失败处理、缓存、当前限制 |
| [MCP 服务](docs/mcp.md) | 工具列表、缓存命中、按编号执行、部署、运行与关闭 |
| [架构与实现](docs/architecture.md) | 模块划分、一步操作的流程、快照、选择器、参数模板化、页面稳定等待、模型调用 |
| [示例与任务集](tasks/README.md) | examples/ 的示例脚本，五个 OSWorld 风格的真实站点任务 |
| [测试](docs/testing.md) | 冒烟测试和三档 pytest |
| [设计文档](docs/Obact_PRD_v2.md) | 需求与设计依据 |
