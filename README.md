# Obact

Obact 是一个单任务网页自动化工具。脚本里每一步写一句自然语言指令：第一次运行时由视觉模型在页面上找到目标并执行（S2），成功后把定位结果缓存下来；之后的运行直接按缓存执行（S1），不调用模型。页面改版导致缓存失效时，自动回到模型重新定位并覆盖缓存（自愈）。

设计依据见 Obact_PRD_v2.md。页面元素收集、选择器生成、页面稳定等待和反自动化检测参考了 Stagehand，见 stagehand_design.md。

## 功能

| 接口 | 作用 | 缓存 |
| --- | --- | --- |
| act | 点击、输入、按键、下拉选择 | 缓存目标位置 |
| read | 读出页面上某块区域（正文、表格、列表）的全部文字 | 缓存区域位置 |
| download | 点击触发下载并保存文件 | 缓存点击位置 |
| extract | 按 pydantic schema 提取结构化数据 | 不缓存，每次调用模型 |
| save | 把结果写成 JSON、CSV、Markdown 或 TXT 文件 | — |
| wait_for_human | 暂停，等人工完成验证码、登录等操作 | — |

其他特性：

- 两个模型槽位 fast 和 smart，fast 失败自动升级到 smart。两者都必须支持图像输入，接口为 OpenAI 格式，本地或云端都可以。
- 指令参数化：会变化的值用 {名称} 占位，缓存里存的是模板，换参数后仍按缓存回放。
- 执行后校验（expect），不通过时不写缓存。
- 降低被识别为自动化浏览器的概率；可以指定浏览器用户目录，跨运行保留登录状态。
- 配置全部写在 .env 中，启动时自动加载。
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

复制 .env.example 为 .env，至少填写模型的三项：

```
OPENAI_URL = https://example.com/v1
OPENAI_MODEL = 视觉模型名
OPENAI_KEY = 你的密钥
```

Obact 启动时自动加载当前目录下的 .env（也可以用 Obact(task, env="其他路径") 指定），已经存在的环境变量优先，不会被覆盖。支持 KEY=VALUE、KEY = "VALUE"、export KEY=VALUE，# 开头的行和不带引号的值后面的 " #" 都按注释处理。

| 环境变量 | 说明 |
| --- | --- |
| OPENAI_URL、OPENAI_MODEL、OPENAI_KEY | fast 槽位的接口地址、模型名、密钥 |
| OBACT_FAST_URL、OBACT_FAST_MODEL、OBACT_FAST_KEY | 可选，单独设置 fast 槽位，优先于 OPENAI_* |
| OBACT_SMART_URL、OBACT_SMART_MODEL、OBACT_SMART_KEY | 可选，设置 smart 槽位，没写的项沿用 fast |
| OBACT_FAST_COORDS、OBACT_SMART_COORDS | 模型按 0–1000 归一化输出坐标时（如 Qwen3-VL）设为 norm1000，默认 pixel |
| OBACT_VIEWPORT | 浏览器视口，默认 1280x800。canvas 目标按相对视口的比例缓存，视口固定后坐标才能复用 |
| OBACT_HEADLESS | 是否无头运行，默认 false；wait_for_human 需要有头浏览器 |
| OBACT_CACHE_DIR | 缓存目录，默认 .obact |
| OBACT_USER_DATA_DIR | 浏览器用户目录，指定后登录状态和 cookie 跨运行保留；不填则每次使用临时目录 |
| OBACT_EXECUTABLE_PATH | 改用本机安装的 Chrome 等浏览器 |

启动时会向两个槽位各发一张红色测试图，接口不可用、模型名不存在或模型认不出颜色都会直接报错。.env 已在 .gitignore 中，不要提交。

## 快速开始

```python
import asyncio
from pydantic import BaseModel
from obact import Obact


class Book(BaseModel):
    title: str
    price: float


async def main():
    async with Obact(task="books") as ob:                           # 缓存写到 .obact/books.jsonl
        await ob.page.goto("https://books.toscrape.com/")
        await ob.act("点击左侧分类列表中的 {category}", params={"category": "Travel"}, expect="**/category/books/**")
        books = await ob.extract("页面上所有书的书名和价格", schema=list[Book])
        cheapest = min(books, key=lambda b: b.price)                 # 判断交给代码
        await ob.act("点击书名为 {title} 的链接", params={"title": cheapest.title})
        description = await ob.read("Product Description 标题下面的那段商品描述")
        ob.save(books, "workspace/outputs/books.csv")


asyncio.run(main())
```

examples/ 下有几个示例，在仓库根目录运行，结果写到 workspace/outputs/：

```powershell
python examples/books.py Poetry    # 找分类里最便宜的书，读取商品描述，书单写成 CSV 和 Markdown，详情写成 JSON
python examples/download.py        # 在下载练习页挑一个 .txt 文件下载，文件列表写成 Markdown
```

第一次运行每一步都会调用模型；再运行一次，act、read、download 按缓存回放，只有 extract 调用模型。

## 使用指南

接口一览：

| 接口 | 说明 |
| --- | --- |
| Obact(task, env=".env") | task 决定缓存文件名；env 是要加载的配置文件 |
| act(instruction, params=None, step=None, expect=None) | 执行一步操作 |
| read(instruction, params=None, step=None) -> str | 返回区域内的全部文字 |
| download(instruction, save_to=".", params=None, step=None) -> Path | 返回保存后的文件路径 |
| extract(instruction, schema) | 返回符合 schema 的数据，schema 可以是 BaseModel 或 list[Model]、list[str] 这类类型 |
| save(data, path) -> Path | 按扩展名写文件 |
| wait_for_human(message) | 打印提示，在终端按回车后继续 |
| page | 当前 Playwright 页面；点击打开新标签页后指向最新打开的页面 |

写指令的要点：

1. 一个 act 只做一个动作，描述目标在页面上的样子，例如"点击右上角的购物车图标""在出发地输入框输入 {city}"。
2. 会变化的值一律放进 params，不要写死在指令里。参数值必须出现在定位用的选择器或输入内容中才能缓存，否则日志会提示"参数无法模板化，不缓存"，这一步每次都走模型。
3. 缓存键由指令模板和页面地址组成。用同一句指令模板操作同一页面上的不同目标时（例如用"在 {label} 输入框输入 {value}"依次填写多个输入框），给每次调用不同的 step，让它们各有一条缓存。
4. 需要按页面数据做判断时（比如选最便宜的），先 extract 取数据，在代码里判断，再用带参数的 act 去操作，这样这一步也能缓存。

expect 的写法：

- 以 http://、https:// 或 ** 开头时按 URL 模式等待，例如 "**/inventory.html"。
- 其他写法按 Playwright 选择器等待元素可见，例如 "text=下单成功"、"#orderModal"。
- 最多等 10 秒；URL 模式只要求地址匹配，不等页面加载完。不通过时抛出 StepFailed，这一步不写缓存，也不再升级到 smart；如果这一步是按缓存回放的，还会删掉这条缓存，下次运行重新走模型。

read、extract 和 save：

- read 原样读出一块区域的全部文字，适合文章正文、商品描述、表格。第一次由模型从文本块清单里选区域，之后按缓存的位置直接读。
- extract 适合价格、名称这类零散字段，每次都调用模型。输入是整页文字（前 20000 字）和视口截图，fast 失败时升级到 smart。
- save 的 data 可以是字符串、pydantic 对象、字典或它们的列表。.json 原样写入；.csv 只接受对象或对象列表，每个对象一行，带 BOM 方便 Excel 打开中文；.md 中对象列表写成表格，单个对象写成"字段 | 值"表格，字符串原样写入；.txt 中字符串原样写入，其他内容写成 JSON。

download：点击后 15 秒内必须触发浏览器下载，否则视为这一步失败，抛出 StepFailed 并且不写缓存。文件按网站给出的文件名存到 save_to 目录。

wait_for_human：需要人工登录或过验证码时调用。配合 OBACT_USER_DATA_DIR 使用，登录一次后，之后的运行可以复用登录状态。

日志：每一步打印一行，给了 step 时会带上步骤名。

| 日志 | 含义 |
| --- | --- |
| [obact] S1 命中缓存，直接回放 | 按缓存执行，没有调用模型 |
| [obact] fast 视觉模型执行（无缓存） | 没有缓存，由 fast 视觉模型定位并执行，成功后写入缓存 |
| [obact] smart 视觉模型执行（无缓存） | fast 没有完成，由 smart 视觉模型定位并执行 |
| [obact] fast 视觉模型执行（缓存失效，已自愈） | 缓存核对不符或回放出错，由视觉模型重新定位并覆盖缓存 |
| （参数无法模板化，不缓存） | 参数值没有出现在选择器或输入内容中，这一步每次都走模型 |
| [obact] fast 视觉模型提取 | extract 调用了模型 |
| [obact] 已下载 路径 | download 保存了文件 |

失败处理：各级都失败或执行后校验不通过时抛出 StepFailed。它的 attempts 是各级尝试记录（S1、fast、smart 各自失败的原因），screenshot 是失败时的截图，保存在缓存目录下的 任务名_failed.png。

缓存：每个任务一个文件 .obact/任务名.jsonl，每行一个步骤：

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
| method、args | 动作及其参数：click、fill、press、select_option；read 的条目为 read |

想让某个任务重新学习，删掉它的 jsonl 文件即可。缓存文件可以提交到 git 记录版本；损坏的行会被跳过并打印警告。

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

汇总表列出每个任务的结果、S1 命中次数和走模型的步骤数（由模型完成的步骤，不含启动时的视觉检查、fast 失败后升级前的那次调用和重试）。第一遍运行各步骤走模型并写入缓存，第二遍可以看到 act、read、download 都变成“S1 命中缓存，直接回放”，只剩 extract 调用模型。结果文件写到 workspace/outputs/tasks/任务名/。

community.py 会自动登录 Conduit：依次使用 .env 中的 CONDUIT_EMAIL、CONDUIT_PASSWORD，上次自动注册并保存在 workspace/outputs/tasks/community/account.json 的测试账号；都没有或登录失败时在注册页新建一个测试账号并保存，之后的运行直接用它登录。注册也失败时（例如站点加了验证码）改为等你在浏览器里手动登录后按回车。设置 OBACT_USER_DATA_DIR 时，已登录的浏览器会直接复用。它会真实地发布文章和评论，并在结束前删除；发布文章后中途失败时，直接删除文章再退出。文章页的地址每次不同，这部分步骤每次都会调用模型；个人主页文章卡片的名称里带有每次不同的简介，按标题打开文章这一步每次都会自愈。

## 架构

```
用户脚本
   │  act / read / download / extract / save
   ▼
core.py ── 唯一的编排者：加载 .env，S1 → fast → smart，执行动作，执行后校验
   │            │             │              │
   ▼            ▼             ▼              ▼
snapshot.py   cache.py      llm.py         output.py
snapshot.js   缓存键、模板   fast / smart   结果文件
   │          .obact/*.jsonl  OpenAI 格式接口
   ▼
浏览器页面（Playwright + Chromium）
```

| 模块 | 职责 |
| --- | --- |
| core.py | Obact 类：读配置、启动浏览器、编排每一步、执行动作、校验结果、写缓存、抛出 StepFailed |
| snapshot.js | 注入页面的脚本：收集元素和文本块、遮挡检测、生成选择器、参数锚定、画编号框、等待 DOM 稳定 |
| snapshot.py | 调用 snapshot.js，组装发给模型的清单文字、截图和"编号 → 选择器"对照表；跟踪进行中的网络请求，等待页面稳定 |
| cache.py | 缓存键生成、参数模板化与回填、JSONL 读写 |
| llm.py | 两个模型槽位、提示词、视觉能力检查、JSON 解析与重试 |
| output.py | 按扩展名把结果写成文件 |

core 是唯一的编排者，snapshot、cache、llm、output 互不引用；浏览器只由 core（执行动作）和 snapshot（读取页面）访问。

一步操作的流程（act、read、download 相同）：

```
生成缓存键：step 或指令模板 | 域名 + 路径
├─ 缓存命中 → S1：等元素出现 → 核对 → 执行 → 执行后校验 → 返回
│               核对不符或执行出错 → 转 S2
│               执行后校验不通过 → 删除这条缓存，抛 StepFailed
└─ S2：快照 → fast 模型 → 执行 → 执行后校验 → 写缓存 → 返回
         模型找不到、编号无效或执行出错 → 换 smart 再来一次 → 仍失败抛 StepFailed
         执行后校验不通过 → 直接抛 StepFailed，不写缓存、不升级
```

执行后校验：act 是 expect，download 是"15 秒内触发下载"，read 不校验。

快照有两种：

- 元素清单（act、download）：收集原生交互标签、带交互 role、onclick、tabindex 的元素，以及 cursor:pointer 的最外层元素；剔除不可见、禁用、过小的元素；中心在视口内的元素做五点遮挡检测，被弹窗盖住的不进清单；整页最多 300 个，视口外的标注"屏幕外"，执行时由 Playwright 自动滚动。视口内元素在截图上画编号框。模型返回编号，canvas 等无法编号的目标返回坐标。
- 文本块清单（read）：收集文字不少于 10 字的块级元素（div、p、table、ul、section 等），文字与外层完全相同的包装元素只保留最外层；每行给出开头 60 字和总字数，截图不画框。模型返回编号。

选择器生成：从目标元素往上最多 6 层，依次尝试 data-testid、data-test、data-qa、id（排除自动生成的）、name、aria-label、placeholder、title、alt、目标自身的短文本、type、role，找到能唯一定位的条件后在下面接位置路径；都不行时用从 /html 开始的绝对路径。每个选择器生成时都在页面上校验只匹配到这个元素。

参数模板化与锚定：写缓存时，出现在输入内容中的参数值在输入内容里替换成 {参数名}；其余参数值出现在选择器的字符串字面量中时替换成 {参数名}。输入内容里的参数不会替换进选择器，例如输入 2 时不会把 qty-2 改成 qty-{qty}。click 不带输入内容，模型多给的 args 会被丢掉。参数值不在选择器里时（例如按航班号点对应行的按钮），从目标往上找第一个文字包含参数值的祖先，生成 //tr[.//text()[normalize-space(.)='{flight}']]//input[@type='submit'] 这样的锚定选择器：先要求某个文字节点正好等于参数值，不行再退回包含；锚点下面的条件（属性条件或位置路径）必须本身不能唯一定位，否则换参数后仍会命中原来的元素。仍无法模板化时这一步不写缓存。回放时参数值填回选择器后重新加引号，值里带引号也不会破坏选择器。

S1 核对：act 和 download 要求选择器只匹配到一个可见元素，并且可访问名称与缓存一致；read 的区域内容本身会变，只要求唯一匹配且有文字；坐标条目不核对。

等待页面稳定：每个动作执行后、每次拍快照前，都等进行中的文档、脚本、xhr、fetch 请求结束，并且 DOM 连续 300 毫秒没有节点变化，总共最多 5 秒。超过 2 秒还没结束的请求视为卡住，不再等待（例如连不上的第三方统计脚本）。请求通过 Playwright 事件跟踪，页面感知不到。

模型调用：请求带 response_format json_object，回复用 pydantic 校验；接口出错或 JSON 不合法时同一模型重试 1 次，仍失败则升级到下一级。

反自动化检测：启动参数带 --disable-blink-features=AutomationControlled；注入脚本把 navigator.webdriver 置为 false、删除 Playwright 的全局变量、修正通知权限查询的返回值；可通过 OBACT_USER_DATA_DIR 保留登录状态，通过 OBACT_EXECUTABLE_PATH 使用本机 Chrome。

## 当前限制

1. 靠事件委托响应点击、自身没有任何交互特征的元素（部分 React 组件的下拉项、日历格子）不在元素清单里，模型只能按坐标点击，这类步骤无法参数化缓存。
2. extract 的输入是拍平的整页文字，日历、复杂表格这类网格内容可能对错位置；只取前 20000 字，也读不到 title、alt 等属性里的文字。
3. 缓存键包含 URL 路径，参数会改变路径的页面（不同分类、不同商品详情页、不同文章页）无法跨参数复用缓存。
4. 不支持 iframe 里的内容、shadow DOM、浏览器原生弹窗里的内容（alert、confirm、prompt 一律自动接受）和文件上传。
5. wait_for_human 只能在终端按回车继续。
6. 没有写 expect 时，执行不报错即视为成功并写入缓存。
7. 启动时的视觉检查每次运行都会调用模型，全部命中缓存的运行也需要模型接口可用。

## 目录结构

```
obact/
  core.py          编排层
  snapshot.py      页面快照与页面稳定等待
  snapshot.js      注入页面的脚本
  cache.py         缓存
  llm.py           模型调用与提示词
  output.py        结果文件
examples/          使用示例
tasks/             OSWorld 风格的 Web 任务和运行汇总脚本 run.py
.env.example       配置模板
pyproject.toml
Obact_PRD_v2.md    设计文档
stagehand_design.md
AGENTS.md          给编码代理的项目说明
```
