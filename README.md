# Obact

Obact 是一个单任务网页自动化工具。脚本里每一步写一句自然语言指令：第一次运行时由视觉模型在页面上找到目标并执行（S2），成功后把定位结果缓存下来；之后的运行直接按缓存执行（S1），不调用模型。页面改版导致缓存失效时，自动回到模型重新定位并覆盖缓存（自愈）。

同一套能力既可以写成 Python 脚本按流程执行，也可以通过 MCP 服务交给 AI 客户端（如 Claude Code），由 AI 自主决定每一步。

设计依据见 docs/Obact_PRD_v2.md。页面元素收集、选择器生成、页面稳定等待和反自动化检测参考了 Stagehand，见 docs/stagehand_design.md。

## 功能

| 接口 | 作用 | 缓存 |
| --- | --- | --- |
| act | 点击、悬停、输入、按键、下拉选择 | 缓存目标位置 |
| read | 读出页面上某块区域（正文、表格、列表）的全部文字 | 缓存区域位置 |
| download | 点击触发下载并保存文件 | 缓存点击位置 |
| upload | 点击上传按钮，在文件选择框里选中本地文件 | 缓存点击位置 |
| extract | 按 pydantic schema 提取结构化数据 | 不缓存，每次调用模型 |
| save | 把结果写成 JSON、CSV、Markdown 或 TXT 文件 | — |
| scroll | 向下滚动一屏，让懒加载、无限滚动的内容出现 | 不缓存，不调用模型 |
| wait_for | 等加载慢的页面或组件：地址匹配、某个元素出现，或固定等一段时间 | 不缓存，不调用模型 |
| wait_for_human | 暂停，等人工完成验证码、登录等操作 | — |

其他特性：

- 两个模型槽位 fast 和 smart，fast 失败自动升级到 smart。两者都必须支持图像输入，接口为 OpenAI 格式，本地或云端都可以。
- 指令参数化：会变化的值用 {名称} 占位，缓存里存的是模板，换参数后仍按缓存回放。
- 执行后校验（expect），不通过时不写缓存。没写 expect 时检查动作有没有让页面发生变化，没有变化时不写缓存，升级到下一级重试。
- 点击打开新标签页时，后续步骤自动作用在新标签页上。
- 降低被识别为自动化浏览器的概率；可以指定浏览器用户目录，跨运行保留登录状态。
- MCP 服务：把操作作为原子工具提供给 AI 客户端，见“MCP 服务”一节。
- 自带一组 OSWorld 风格的 Web 任务和运行汇总脚本，见 tasks/。

## 安装

需要 Python 3.11 及以上。

```powershell
python -m venv .venv
.venv\Scripts\activate
pip install -e .
playwright install chromium
```

## 配置

复制 .env.example 为 .env，填写模型的三项。大多数情况只需要这一个模型：

```
MODEL_BASE_URL = https://example.com/v1
MODEL_NAME = 视觉模型名
MODEL_KEY = 你的密钥
```

想在这个模型失败时升级到一个更聪明的模型，再加 SMART_MODEL_NAME（接口不同时再加 SMART_MODEL_BASE_URL、SMART_MODEL_KEY）。

Obact 启动时自动加载当前目录下的 .env（也可以用 Obact(task, env="其他路径") 指定），已经存在的环境变量优先，不会被覆盖。支持 KEY=VALUE、KEY = "VALUE"、export KEY=VALUE，# 开头的行和不带引号的值后面的 " #" 都按注释处理。找不到 .env 或没有填模型地址、模型名时，报错会写明查找的路径，并附上一份可以直接填写的模板。

| 环境变量 | 说明 |
| --- | --- |
| MODEL_BASE_URL、MODEL_NAME、MODEL_KEY | 默认模型（fast 槽位）的接口地址、模型名、密钥，必填 |
| SMART_MODEL_BASE_URL、SMART_MODEL_NAME、SMART_MODEL_KEY | 可选，smart 槽位，fast 失败时升级使用；没写的项沿用 fast，都不写时 smart 就是同一个模型 |
| MODEL_COORDS、SMART_MODEL_COORDS | 模型按 0–1000 归一化输出坐标时（如 Qwen3-VL）设为 norm1000，默认 pixel |
| OBACT_VIEWPORT | 浏览器视口，默认 1280x800。canvas 目标按相对视口的比例缓存，视口固定后坐标才能复用 |
| OBACT_HEADLESS | 是否无头运行，默认 false（显示浏览器窗口）；wait_for_human 和人工登录需要窗口 |
| OBACT_CACHE_DIR | 缓存目录，默认 .obact；每个任务一个文件夹，放步骤缓存 steps.jsonl 和失败截图 failed.png，视觉检查记录 vision_checked.json 在根目录 |
| OBACT_USER_DATA_DIR | 浏览器用户目录，指定后登录状态和 cookie 跨运行保留；不填则每次使用临时目录 |
| OBACT_EXECUTABLE_PATH | 改用本机安装的 Chrome 等浏览器 |

视觉检查：第一次使用某个模型地址和模型名时，启动会向两个槽位各发一张红色测试图，接口不可用、模型名不存在或模型认不出颜色都会直接报错。通过后记在缓存目录的 vision_checked.json 中（只记“模型地址|模型名”，不含密钥），之后启动直接跳过；换了地址或模型会重新检查，删掉这个文件可以强制重新检查。

.env 和 .obact 都在 .gitignore 中，不提交到仓库。

## 快速开始

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
        ob.save(books, "workspace/outputs/books.csv")


asyncio.run(main())
```

examples/ 下的示例在仓库根目录运行，结果写到 workspace/outputs/：

```powershell
python examples/books.py Poetry      # 找分类里最便宜的书，读取商品描述，书单写成 CSV 和 Markdown，详情写成 JSON
python examples/download.py          # 在下载练习页挑一个 .txt 文件下载，文件列表写成 Markdown
python examples/runoob_dfs.py        # 在菜鸟教程找讲 DFS 且带 Python 代码的教程：换词、翻页、规则筛选加模型分级，给出多个结果
python examples/google_flights.py    # 在 Google Flights 搜索单程航班，用 smart 模型综合票价和耗时推荐航班
```

第一次运行每一步都会调用模型；再运行一次，act、read、download 按缓存回放，只有 extract 调用模型。

## 使用指南

接口一览：

| 接口 | 说明 |
| --- | --- |
| Obact(task, env=".env", headless=None) | task 决定缓存文件夹名，不能用作文件夹名时抛 ValueError；env 是要加载的配置文件；headless 为 None 时读取 OBACT_HEADLESS |
| goto(url) | 打开地址，等页面稳定 |
| scroll() -> tuple[int, int] | 在鼠标当前位置向下滚动一屏，等页面稳定后返回滚动前后页面的纵向位置，两者相同说明已经到底 |
| act(instruction, params=None, step=None, expect=None, element_id=None, method="click", args=None) | 执行一步操作；element_id、method、args 见 MCP 服务一节的“编号” |
| read(instruction, params=None, step=None) -> str | 返回区域内的全部文字 |
| download(instruction, save_to=".", params=None, step=None, element_id=None) -> Path | 返回保存后的文件路径 |
| upload(instruction, files, params=None, step=None, element_id=None) | files 是一个或多个本地文件路径；文件不存在时抛 FileNotFoundError |
| extract(instruction, schema, slot=None) | 返回符合 schema 的数据，schema 可以是 BaseModel 或 list[Model]、list[str] 这类类型；slot 填 "fast" 或 "smart" 时只用这个槽位 |
| save(data, path) -> Path | 按扩展名写文件 |
| wait_for(until=None, timeout=30) | 等条件满足后再等页面稳定，写法同 expect，超时抛 TimeoutError；不给 until 时固定等 timeout 秒 |
| wait_for_human(message, until=None, timeout=300) | 打印提示，在终端按回车后继续；给了 until 时等条件满足自动继续 |
| page_state()、page_info()、cached_steps() | 当前页面的元素清单和带编号框的截图（不调用模型）；地址、标题、标签页数；已缓存的步骤 |
| last_step | 最近一步的执行信息：执行方式、动作、元素名称或坐标、是否已缓存 |
| page | 当前 Playwright 页面；点击打开新标签页后指向最新打开的页面 |

写指令的要点：

1. 一个 act 只做一个动作，描述目标在页面上的样子，例如"点击右上角的购物车图标""在出发地输入框输入 {city}"。
2. 会变化的值一律放进 params，不要写死在指令里。参数值必须出现在定位用的选择器或输入内容中才能缓存，否则日志会提示"参数无法模板化，不缓存"，这一步每次都走模型。
3. 缓存键由指令模板和页面地址组成。用同一句指令模板操作同一页面上的不同目标时（例如用"在 {label} 输入框输入 {value}"依次填写多个输入框），给每次调用不同的 step，让它们各有一条缓存。
4. 需要按页面数据做判断时（比如选最便宜的），先 extract 取数据，在代码里判断，再用带参数的 act 去操作，这样这一步也能缓存。
5. 悬停才出现的菜单或按钮写成两步：先"悬停在顶部导航的产品菜单上"，再"点击子菜单中的 {name}"。

expect 的写法：

- 以 http://、https:// 或 ** 开头时按 URL 模式等待，例如 "**/inventory.html"。
- 其他写法按 Playwright 选择器等待元素可见，例如 "text=下单成功"、"#orderModal"。
- 最多等 10 秒；URL 模式只要求地址匹配，不等页面加载完。不通过时抛出 StepFailed，这一步不写缓存，也不再升级到 smart；如果这一步是按缓存回放的，还会删掉这条缓存，下次运行重新走模型。
- 没写 expect 时，act 的 click、press、fill、select_option 执行后会检查页面有没有任何变化（判定规则见“架构”一节的执行后校验）。没有变化时视为动作没有生效：这一步不写缓存，升级到下一级重试（S1 → 编号 → fast → smart），S1 回放没有变化时还会删掉这条缓存；最后一级仍然没有变化时抛出 StepFailed。页面有变化但不是想要的结果（例如点错了元素）检查不出来，关键步骤仍然要写 expect。

read、extract 和 save：

- read 原样读出一块区域的全部文字，适合文章正文、商品描述、表格。第一次由模型从文本块清单里选区域，之后按缓存的位置直接读。
- extract 适合价格、名称这类零散字段，每次都调用模型。输入是页面文字和视口截图：页面文字一行一个可见文本块，带视口坐标，链接的 title、图片的 alt 和 ::before、::after 里的文字也在其中，最多 20000 字；fast 失败时升级到 smart。
- save 的 data 可以是字符串、pydantic 对象、字典或它们的列表。.json 原样写入；.csv 只接受对象或对象列表，每个对象一行，带 BOM 方便 Excel 打开中文；.md 中对象列表写成表格，单个对象写成"字段 | 值"表格，字符串原样写入；.txt 中字符串原样写入，其他内容写成 JSON。

download：点击后 15 秒内必须触发浏览器下载，否则视为这一步失败，抛出 StepFailed 并且不写缓存。文件按网站给出的文件名存到 save_to 目录。

upload：页面上常见的是隐藏的文件输入框加一个样式按钮，所以 upload 不直接填输入框，而是点击指令描述的按钮（或可见的文件输入框），接住弹出的文件选择框，把 files 选进去，再等页面稳定。点击后 5 秒内没有出现文件选择框视为这一步失败，抛出 StepFailed 并且不写缓存。

wait_for_human：需要人工登录或过验证码时调用。不给 until 时打印提示后等在终端按回车。给了 until 时不读终端，在当前页面上等条件满足后自动继续，适合没有终端的无人值守运行：写法与 expect 相同，以 http://、https:// 或 ** 开头时等地址匹配，否则等选择器对应的元素可见；timeout 秒（默认 300）内没有满足时抛出 TimeoutError。配合 OBACT_USER_DATA_DIR 使用，登录一次后，之后的运行可以复用登录状态。

wait_for：每一步本来就会等页面稳定（进行中的请求结束、DOM 连续 300ms 不变，最多 5 秒），但接口超过 2 秒的骨架屏、定时器延迟渲染、超过 5 秒才出现的组件等不到。这时用 wait_for 等明确的条件，写法同 expect，例如 ob.wait_for("text=共 20 条结果")；条件满足后再等页面稳定。没有明确条件可等时（倒计时按钮、网络或设备太慢），不给 until，固定等 timeout 秒，例如 ob.wait_for(timeout=5)；能写条件时优先写条件，固定等待在快的时候白等、慢的时候仍可能不够。

scroll：后加载的内容（懒加载图片、无限滚动列表）不滚动就不在页面上。scroll 用鼠标滚轮在鼠标当前位置向下滚一屏，然后等页面稳定；不移动鼠标，之前的悬停状态保留，鼠标停在可滚动的局部区域上时滚动的是那个区域。返回滚动前后页面的纵向位置，两者相同说明已经到底。page_state 的编号在 scroll 后失效。

日志：每一步向标准错误打印一行结果，给了 step 时会带上步骤名；模型定位和按编号执行时，执行前还会打印一行选中的目标。

| 日志 | 含义 |
| --- | --- |
| [obact] S1 命中缓存，直接回放 | 按缓存执行，没有调用模型 |
| [obact] fast 视觉模型执行（无缓存） | 没有缓存，由 fast 视觉模型定位并执行，成功后写入缓存 |
| [obact] smart 视觉模型执行（无缓存） | fast 没有完成，由 smart 视觉模型定位并执行 |
| [obact] fast 视觉模型执行（缓存失效，已自愈） | 缓存核对不符或回放出错，由视觉模型重新定位并覆盖缓存 |
| [obact] 编号 按编号执行（无缓存） | 按调用方给出的 element_id 执行，没有调用模型，成功后写入缓存 |
| [obact] 目标（fast）：[12] "搜索"，xpath=…，click，理由：… | 执行前写明选中的目标：编号、名称、选择器（坐标目标为像素坐标）、动作和模型给的理由；按编号执行时为“目标（编号）”，没有理由。不写输入内容，理由里复述的输入内容换成 *** |
| [obact] 目标（fast）：被弹层挡住，按 Escape 后重新判断 | 模型报告目标被弹窗、浮层挡住，按一次 Escape 后由同一模型再判断一次 |
| （参数无法模板化，不缓存） | 参数值没有出现在选择器或输入内容中，这一步每次都走模型 |
| [obact] fast 视觉模型提取 | extract 调用了模型 |
| [obact] 已下载 路径 | download 保存了文件 |
| [obact] 等待 fast 模型 名称 回复…… | 正在调用模型（包括视觉检查和重试），模型回复前不会有新的日志 |

失败处理：各级都失败或执行后校验不通过时抛出 StepFailed。它的 attempts 是各级尝试记录（S1、编号、fast、smart 各自失败的原因；选中的目标执行出错时带上编号和名称，模型找不到或目标被挡住时带上模型给的理由；动作没有让页面发生变化的一级记为“动作执行后页面没有任何变化”），screenshot 是失败时的截图，保存在缓存目录下的 任务名/failed.png；expect 不通过时，截图是动作执行并等页面稳定后、开始等 expect 之前拍的，几秒就消失的错误提示也能留下。executed 为 True 表示动作已经执行、只是执行后校验没有通过，包括没写 expect 时有一级执行了动作、页面却没有变化。

缓存：每个任务一个文件夹 .obact/任务名/，步骤缓存在其中的 steps.jsonl，每行一个步骤：

```json
{"key": "点击航班号为 {flight} 的那一行的 Choose This Flight 按钮|blazedemo.com/reserve.php",
 "selector": "xpath=//tr[.//text()[normalize-space(.)='{flight}']]//input[@type='submit']",
 "name": "Choose This Flight", "method": "click", "args": []}
```

| 字段 | 含义 |
| --- | --- |
| key | step 或指令模板，加上 URL 的域名和路径（去掉查询串，纯数字路径段换成 *） |
| selector | 稳定的 XPath，参数值已替换成 {参数名} |
| point | canvas 等目标的坐标，相对视口的 0–1 比例，与 selector 二选一 |
| name | 目标元素的可访问名称，S1 执行前用来核对 |
| method、args | 动作及其参数：click、hover、fill、press、select_option；read 的条目为 read |

只有执行成功的步骤写入缓存：expect 不通过、download 没有触发下载、没写 expect 的 act 执行后页面没有变化，都不写缓存。任务名用作文件夹名，为空、含 <>:"/\|?* 或控制字符、以空格或点结尾时，构造 Obact 直接抛 ValueError，需要换一个名字。想让某个任务重新学习，删掉它的文件夹（或其中的 steps.jsonl）即可。损坏的行会被跳过并打印警告。写入前会重新读取文件，多个进程同时使用同一个任务时不会互相覆盖条目。

## MCP 服务

obact/mcp_server.py 通过 stdio 把上面的操作作为原子工具提供给 AI 客户端：AI 决定每一步做什么，Obact 负责在页面上执行并缓存。一个服务进程对应一个任务（一个缓存文件夹）和一个浏览器会话，工具调用串行执行。

| 工具 | 作用 |
| --- | --- |
| goto | 打开 http、https 网址，返回标题、地址和标签页数 |
| page_state | 返回标题、地址、本页面已缓存的步骤、可交互元素清单（带编号）和带编号框的截图，不调用模型 |
| scroll | 在鼠标当前位置向下滚动一屏，返回滚动前后页面的纵向位置、是否已到底和当前页面；不调用模型，编号随之失效 |
| wait | 等条件满足（until 写法同 expect，如 text=加载完成；timeout 默认 30 秒），不给 until 时固定等 timeout 秒，返回当前页面；条件超时报错，不调用模型 |
| act | 执行一步操作，返回执行方式（按缓存回放、按编号执行、模型定位）、操作的元素、是否已缓存和当前页面 |
| read | 读取区域文字，超过 max_chars（默认 20000）时截断并注明总字数 |
| download | 点击触发下载，返回文件路径 |
| upload | 点击上传按钮，选中 files 里的本地文件（相对路径按项目目录解析），返回执行方式和当前页面 |
| extract | 按字段字典提取数据，如 `{"title": "str", "price": "float", "rating": "int?"}`。类型为 str、int、float、bool，带 ? 表示可以为空；many 为 true 时返回列表 |
| save | 按扩展名保存数据文件，不需要浏览器 |

act、read、download、extract 失败时，返回错误文字和失败截图；动作已执行、只是执行后校验未通过时会注明，提醒 AI 不要直接重试。没有 .env 或缺少必填项时，第一次调用工具会返回错误，写明查找的路径并附上配置模板，由 AI 转告用户。

缓存命中：缓存键是“step（没有 step 时为 instruction）+ 页面路径”，AI 每次措辞不同就不会命中。所以 page_state 会列出本页面已缓存的步骤，服务说明（MCP instructions）要求 AI 把它们原样作为 step 传入，并把会变化的值写成 {占位符}、放进 params。

编号：act、download 可以用 page_state 的编号（element_id）直接指定目标，不调用内部模型。编号只对紧接着的一次 act 或 download 有效；执行前核对页面地址没有变、元素唯一匹配、名称与快照一致，不符时转内部模型按 instruction 定位。编号执行成功后，和模型定位一样写入缓存。

启动参数：

```
obact-mcp [--task 任务名] [--env 路径] [--headless]
python -m obact.mcp_server [参数同上]
```

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| --task | 项目目录名 | 缓存文件夹 .obact/任务名/ |
| --env | .env | 配置文件，相对路径按项目目录解析 |
| --headless | 不加（有头） | 无头运行；不加时按 OBACT_HEADLESS，默认显示浏览器窗口 |

项目目录：环境变量 CLAUDE_PROJECT_DIR 存在时（Claude Code 会为服务进程设置），进程先切换到该目录，否则使用当前工作目录。.env、缓存目录以及 download、save 的相对路径，都按项目目录解析。

部署到项目：

1. 在项目使用的 Python 环境中安装：`pip install -e E:/project/obact`（在本仓库内为 `pip install -e .`），再执行 `playwright install chromium`。
2. 在项目根目录放 .env（模板见 .env.example）。
3. 在项目根目录写 .mcp.json：

```json
{
  "mcpServers": {
    "obact": {
      "command": "obact-mcp"
    }
  }
}
```

`obact-mcp` 必须能在 PATH 中找到，即先激活安装了 obact 的虚拟环境，再在该终端里启动 Claude Code。也可以把 command 写成虚拟环境里 python 的绝对路径、args 写 `["-m", "obact.mcp_server"]`，这样不用激活，但换一台机器要改路径；不想把本机路径提交到仓库时，用本地作用域：

```
claude mcp add --scope local obact -- E:/project/obact/.venv/Scripts/obact-mcp.exe
```

一个项目通常配一个条目就够了：不同流程的步骤按 step 和页面路径区分，可以共用一个缓存文件。需要分开缓存时写多个条目，用 `"args": ["--task", "shop"]` 区分。首次使用项目级 .mcp.json 时，Claude Code 会询问是否允许加载该服务。

运行与关闭：

| 场景 | 行为 |
| --- | --- |
| 启动 | 会话连接服务时由客户端启动进程，立即完成握手，不打开浏览器、不调用模型 |
| 首次使用 | 第一次调用 goto、page_state、scroll、wait、act、read、download、upload、extract 时打开浏览器（视觉检查没有记录时先检查）；失败时这次调用返回错误和原因，下次调用会重试 |
| 浏览器被关掉 | 关掉窗口或浏览器崩溃后，下一次调用自动重新打开，并提示之前的页面状态已丢失 |
| 关闭 | 会话结束或在 /mcp 中断开时，客户端关闭标准输入，进程退出。Claude Code 约 300 毫秒后会结束服务的进程树，浏览器通常来不及正常关闭；设置了 OBACT_USER_DATA_DIR 时，最近写入的登录状态不保证已经保存 |
| 改代码或 .env 后 | 运行中的进程不会加载新内容，需要在 /mcp 中重连该服务 |
| 手动运行 | 在终端直接运行时，进程等待标准输入里的协议消息，看起来像卡住，这是正常的。按 Ctrl+C 退出 |
| 日志 | 写在标准错误（UTF-8），由客户端收集；标准输出只用于协议消息 |

不提供 wait_for_human：在终端按回车的方式读取标准输入，与 stdio 通道冲突。需要人工介入时，AI 应停下来，请用户在浏览器窗口中处理。

并发：同一项目同时开多个会话时，每个会话各有一个服务进程，缓存条目不会互相覆盖；但两个浏览器不能共用同一个 OBACT_USER_DATA_DIR，后打开的会失败。

实现与验证方法见 docs/mcp-server.md。

## OSWorld 风格的 Web 任务

OSWorld 的 Chrome 评测集里，不少任务的最后一步要在本地应用里完成，例如"把查到的表格存成 CSV""把网页正文存成 Markdown"。在 obact 中这类尾端操作直接用 ob.save() 完成，跨应用任务就变成了纯 Web 任务。tasks/ 下按五类典型任务各写了一个，每个任务结束时像 OSWorld 的评测函数一样逐项校验结果：

| 任务 | 站点 | 任务内容 | 测试的 obact 特性 |
| --- | --- | --- | --- |
| shop.py 电商比价与条件加购 | demoblaze.com | 在 Laptops 分类找最便宜的商品，加入购物车并下单；购物车存 CSV，订单信息存 Markdown | extract + Python 判断；按商品名参数化点击；下单弹窗打开时的遮挡检测；expect 校验跳转和弹窗 |
| booking.py 多条件表单检索与预订 | blazedemo.com | 查询 Boston 到 London 的航班，预订最便宜的一班并填写乘客和付款信息；航班列表存 CSV，确认信息存 JSON | select_option、fill 参数模板化；同一句指令模板用 step 区分多个输入框；按航班号锚定所在行；expect 校验 URL |
| archive.py 数据聚合与本地归档 | quotes.toscrape.com、docs.python.org | 收集两页名言存 CSV 和 JSON；作者简介和 Python 文档章节存 Markdown | extract 列表提取；read 读取长文本区域；翻页链接的缓存复用；save 按扩展名格式化 |
| download.py Web 资源筛选与文件下载 | the-internet.herokuapp.com/download | 按后缀筛出文件并下载到指定目录，生成带 SHA-256 的下载清单 | download 下载监听；参数化定位下载链接，第二个文件直接按缓存回放 |
| community.py 社区/后台状态变更 | conduit.bondaracademy.com | 自动登录（没有账号时自动注册），发文章、发评论、改简介，到个人主页找到文章，记录存 JSON，最后删除评论和文章 | act 自动填写登录或注册表单，失败时 wait_for_human；OBACT_USER_DATA_DIR 复用登录态；read 读取正文；按评论内容定位删除图标 |

运行方式（在仓库根目录）：

```powershell
python tasks/run.py                    # 依次运行全部任务，最后打印汇总表
python tasks/run.py shop booking       # 只运行指定任务
python tasks/shop.py                   # 单独运行一个任务
```

汇总表列出每个任务的结果、S1 命中次数和走模型的步骤数（由模型完成的步骤，不含视觉检查、fast 失败后升级前的那次调用和重试）。第一遍运行各步骤走模型并写入缓存，第二遍可以看到 act、read、download 都变成“S1 命中缓存，直接回放”，只剩 extract 调用模型。结果文件写到 workspace/outputs/tasks/任务名/。

community.py 会自动登录 Conduit：第一次运行时在注册页新建一个测试账号，打印用户名、邮箱和密码，并保存到 workspace/outputs/tasks/community/account.json，之后的运行直接用它登录；登录失败（例如练习站清空了数据）时重新注册并覆盖保存。注册也失败时（例如站点加了验证码）改为等你在浏览器里手动登录后按回车。设置 OBACT_USER_DATA_DIR 时，已登录的浏览器会直接复用。它会真实地发布文章和评论，并在结束前删除；发布文章后中途失败时，直接删除文章再退出。文章页的地址每次不同，这部分步骤每次都会调用模型；个人主页文章卡片的名称里带有每次不同的简介，按标题打开文章这一步每次都会自愈。

## 测试

tests/smoke.py 是冒烟测试：用本地测试页和 .env 里配置的真实模型跑两遍主流程，第一遍各步骤由模型完成并写缓存，第二遍检查 act、read、download 全部按缓存回放；最后以子进程启动 MCP 服务，检查握手、goto、page_state、按编号和按指令的 act。缓存写到临时目录，不访问外网，浏览器无头运行。

```powershell
python tests/smoke.py                  # 用 .env 里的模型
python tests/smoke.py --env 其他配置    # 用另一个配置文件
```

换模型测试时，也可以直接在命令行设置 MODEL_BASE_URL、MODEL_NAME、MODEL_KEY，它们优先于 .env。全部通过时退出码为 0；失败时保留缓存目录和失败截图，并打印路径。

pytest 测试（先安装：pip install -e .[test]）分三档，默认只跑第一档：

| 档 | 命令 | 内容 | 需要 |
| --- | --- | --- | --- |
| 默认 | pytest | 单元测试（模型输出校验、约束解码与回退、任务名）；浏览器 + 本地测试页 + 假模型的功能测试（hover、blocked、scroll、wait_for、upload、伪元素名称、事件委托元素、extract 文本、没有效果的判断、失败截图、缓存目录），能缓存的跑两遍检查回放；MCP 进程内测试 | 无网络、无模型，约 2 分钟 |
| --real | pytest --real | 再加上用 .env 里真实模型的测试：同样的本地测试页，检查模型会不会输出 hover、blocked，extract 是否对齐，两遍回放 | 真实模型，约 3 分钟 |
| --site | pytest --site | 再加上练习站 the-internet.herokuapp.com 上的测试：悬停头像、进入即弹广告、无限滚动、慢加载、上传文件、表格提取、错误密码 | 外网 + 真实模型，约 3 分钟 |

测试页在 tests/pages.py，假模型和辅助函数在 tests/support.py，夹具在 tests/conftest.py。每个测试用自己的临时缓存目录，不影响 .obact。

## 架构

```
用户脚本            MCP 客户端 ── mcp_server.py
   │  act / read / download / extract / save
   ▼
core.py ── 唯一的编排者：加载 .env，S1 → 编号 → fast → smart，执行动作，执行后校验
   │            │             │              │
   ▼            ▼             ▼              ▼
snapshot.py   cache.py      llm.py         output.py
snapshot.js   缓存键、模板   fast / smart   结果文件
   │          .obact/任务名/  OpenAI 格式接口
   ▼
浏览器页面（Playwright + Chromium）
```

| 模块 | 职责 |
| --- | --- |
| core.py | Obact 类：读配置、启动浏览器、编排每一步、执行动作、校验结果、写缓存、抛出 StepFailed |
| snapshot.js | 注入页面的脚本：收集元素和文本块、生成 extract 用的带坐标文本、遮挡检测、生成选择器、参数锚定、画编号框、等待 DOM 稳定、判断动作是否会打开新标签页 |
| snapshot.py | 调用 snapshot.js，组装发给模型的清单文字、截图和"编号 → 选择器"对照表；跟踪进行中的网络请求，等待页面稳定 |
| cache.py | 缓存键生成、参数模板化与回填、JSONL 读写 |
| llm.py | 两个模型槽位、提示词、视觉能力检查、JSON 解析与重试 |
| output.py | 按扩展名把结果写成文件 |
| mcp_server.py | MCP 服务：工具定义、延迟打开和重建浏览器、结果与错误的格式化 |

core 是唯一的编排者，snapshot、cache、llm、output 互不引用；浏览器只由 core（执行动作）和 snapshot（读取页面）访问；mcp_server 只调用 core 的公开方法。

一步操作的流程（act、read、download 相同）：

```
生成缓存键：step 或指令模板 | 域名 + 路径
├─ 缓存命中 → S1：等元素出现 → 核对 → 执行 → 执行后校验 → 返回
│               核对不符或执行出错 → 转 S2
│               没写 expect、执行后页面没有变化 → 删除这条缓存，转 S2
│               执行后校验不通过 → 删除这条缓存，抛 StepFailed
└─ S2：给了 element_id 时先按编号执行，核对不符再转模型
       快照 → fast 模型 → 执行 → 执行后校验 → 写缓存 → 返回
         模型报告目标被弹层挡住 → 按一次 Escape，重新快照，同一模型再判断一次，仍被挡住或找不到时换 smart
         模型找不到、编号无效、执行出错，或没写 expect、执行后页面没有变化 → 换 smart 再来一次 → 仍失败抛 StepFailed
         执行后校验不通过 → 直接抛 StepFailed，不写缓存、不升级
```

执行后校验：act 写了 expect 时是 expect，没写时检查动作有没有效果；download 是"15 秒内触发下载"；read 不校验。

动作有没有效果（只检查 act 的 click、press、fill、select_option）：从紧挨着动作执行之前开始观察，到动作后的页面稳定等待结束为止，下面任何一项成立都算有效果：地址变了；标签页数变了；DOM 有变化（节点增删、属性、文字，不含编号框）；页面发生了滚动；焦点元素变了（点击后焦点落在按钮、链接或 body 上不算，这是浏览器点击本身带来的）；表单控件的值、勾选、选中状态变了；页面发生导航；fill、select_option 后目标的值等于要求的值（填入与原值相同的内容）；目标是 canvas、iframe、embed、object、video 或 shadow DOM 宿主，或包含这类元素（内部变化观察不到）。观察期间页面自己的变化（轮播、计时器）会让检查判为有效果，这是有意的取舍：宁可漏判，不把有效果的动作判成没有效果。

快照有两种：

- 元素清单（act、download）：收集原生交互标签、带交互 role、onclick、tabindex 的元素，以及 cursor:pointer 的最外层元素；视口内没有子元素、带一段不超过 30 字短文字（含字母或数字）、不在 label 和上述元素里面的叶子元素也收进来，用于靠事件委托响应点击的下拉项、日历格子，超过上限时先舍弃它们；剔除不可见、禁用、过小的元素；中心在视口内的元素做五点遮挡检测，被弹窗盖住的不进清单，模型判断目标被挡住时返回 blocked，不改选别的元素；整页最多 300 个，视口外的标注"屏幕外"，执行时由 Playwright 自动滚动。名称依次取 aria-label、aria-labelledby、label、placeholder、文字、title、alt，都没有时取元素本身和后代的 ::before、::after 里引号中的文字（去掉图标字体的私用区字符）。视口内元素在截图上画编号框。模型返回编号，canvas 等无法编号的目标返回坐标。
- 文本块清单（read）：收集文字不少于 10 字的块级元素（div、p、table、ul、section 等），文字与外层完全相同的包装元素只保留最外层；每行给出开头 60 字和总字数，截图不画框。模型返回编号。

选择器生成：从目标元素往上最多 6 层，依次尝试 data-testid、data-test、data-qa、id（排除自动生成的）、name、aria-label、placeholder、title、alt、目标自身的短文本、type、role，找到能唯一定位的条件后在下面接位置路径；都不行时用从 /html 开始的绝对路径。每个选择器生成时都在页面上校验只匹配到这个元素。

参数模板化与锚定：写缓存时，出现在输入内容中的参数值在输入内容里替换成 {参数名}；其余参数值出现在选择器的字符串字面量中时替换成 {参数名}。输入内容里的参数不会替换进选择器，例如输入 2 时不会把 qty-2 改成 qty-{qty}。click、hover 不带输入内容，模型多给的 args 会被丢掉。参数值不在选择器里时（例如按航班号点对应行的按钮），从目标往上找第一个文字包含参数值的祖先，生成 //tr[.//text()[normalize-space(.)='{flight}']]//input[@type='submit'] 这样的锚定选择器：先要求某个文字节点正好等于参数值，不行再退回包含；锚点下面的条件（属性条件或位置路径）必须本身不能唯一定位，否则换参数后仍会命中原来的元素。仍无法模板化时这一步不写缓存。回放时参数值填回选择器后重新加引号，值里带引号也不会破坏选择器。

S1 核对：act 和 download 要求选择器只匹配到一个可见元素，并且可访问名称与缓存一致；read 的区域内容本身会变，只要求唯一匹配且有文字；坐标条目不核对。

等待页面稳定：每个动作执行后、每次拍快照前，都等进行中的文档、脚本、xhr、fetch 请求结束，并且 DOM 连续 300 毫秒没有节点变化，总共最多 5 秒。超过 2 秒还没结束的请求视为卡住，不再等待（例如连不上的第三方统计脚本）。请求通过 Playwright 事件跟踪，页面感知不到。点击 target=_blank 的链接、提交 target=_blank 的表单时，先等新标签页出现（最多 10 秒），再在新标签页上等稳定。

模型调用：请求带 response_format json_schema，按 Decision、文本块编号或 extract 的 schema 做约束解码，接口支持时输出结构由解码保证；接口不接受 json_schema（返回 400）时，这个模型槽位改用 json_object 并打印一行提示。回复用 pydantic 校验；content 为空时改用 reasoning_content（有的推理模型偶尔把答案只写在那里）；接口出错或 JSON 不合法时同一模型重试 1 次，仍失败则升级到下一级。

反自动化检测：启动参数带 --disable-blink-features=AutomationControlled；注入脚本把 navigator.webdriver 置为 false、删除 Playwright 的全局变量、修正通知权限查询的返回值；可通过 OBACT_USER_DATA_DIR 保留登录状态，通过 OBACT_EXECUTABLE_PATH 使用本机 Chrome。

## 当前限制

1. 靠事件委托响应点击、自身没有任何交互特征的元素（部分 React 组件的下拉项、日历格子），只有视口内带短文字的叶子元素会进元素清单；只有图标或图片、文字超过 30 字、在视口外的仍然不在清单里，模型只能按坐标点击，这类步骤无法参数化缓存。
2. extract 的页面文字按块状元素分行并附带坐标，日历、复杂表格这类网格内容要靠模型按坐标和截图对应位置，仍可能对错；只取前 20000 字，坐标也占字数；链接和图片以外元素的 title 不读。
3. 缓存键包含 URL 路径，参数会改变路径的页面（不同分类、不同商品详情页、不同文章页）无法跨参数复用缓存。
4. 不支持 iframe 里的内容、shadow DOM、浏览器原生弹窗里的内容（alert、confirm、prompt 一律自动接受）和文件上传。
5. wait_for_human 的 until 只能等地址匹配或元素出现，等不了元素消失、cookie 变化这类条件。
6. 没有写 expect 时，只能发现动作没有让页面发生任何变化；页面有变化但结果不对（点错了元素）仍会写入缓存。只改剪贴板、只播放声音、只通过 CSSOM 改样式这类页面上观察不到的动作，会被判成没有效果。
7. 视觉检查按“模型地址|模型名”记录，只在第一次使用时进行；之后接口失效或换了密钥，要等第一次真正调用模型时才会报错。
8. 页面脚本用 window.open 打开的新标签页无法事先判断，出现得比页面稳定还晚时，后续步骤仍会作用在原来的页面上。

## 目录结构

```
obact/
  core.py              编排层
  snapshot.py          页面快照与页面稳定等待
  snapshot.js          注入页面的脚本
  cache.py             缓存
  llm.py               模型调用与提示词
  output.py            结果文件
  mcp_server.py        MCP 服务
examples/              使用示例
tasks/                 OSWorld 风格的 Web 任务和运行汇总脚本 run.py
tests/smoke.py         冒烟测试（本地测试页 + 真实模型 + MCP 子进程）
docs/
  Obact_PRD_v2.md      设计文档
  mcp-server.md        MCP 服务的实现与验证
  stagehand_design.md  Stagehand 设计参考
.env.example           配置模板
.mcp.json              本仓库的 MCP 配置
pyproject.toml
AGENTS.md              给编码代理的项目说明
```
