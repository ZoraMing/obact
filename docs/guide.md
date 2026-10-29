# 使用指南

快速开始见 [README](../README.zh-CN.md)。

## 配置

在项目根目录新建 .env（仓库里的 .env.example 是带注释的模板），填写模型的三项。大多数情况只需要这一个模型：

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

把 .env 和 .obact 加进你项目的 .gitignore，不要提交密钥。

## 接口一览

| 接口 | 说明 |
| --- | --- |
| Obact(task, env=".env", headless=None) | task 决定缓存文件夹名，不能用作文件夹名时抛 ValueError；env 是要加载的配置文件；headless 为 None 时读取 OBACT_HEADLESS |
| goto(url) | 打开地址，等页面稳定 |
| scroll() -> tuple[int, int] | 在鼠标当前位置向下滚动一屏，等页面稳定后返回滚动前后页面的纵向位置，两者相同说明已经到底 |
| act(instruction, params=None, step=None, expect=None, element_id=None, method="click", args=None) | 执行一步操作；element_id、method、args 见 [MCP 服务](mcp.md#编号) 的“编号” |
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

## 写指令的要点

1. 一个 act 只做一个动作，描述目标在页面上的样子，例如"点击右上角的购物车图标""在出发地输入框输入 {city}"。
2. 会变化的值一律放进 params，不要写死在指令里。参数值必须出现在定位用的选择器或输入内容中才能缓存，否则日志会提示"参数无法模板化，不缓存"，这一步每次都走模型。
3. 缓存键由指令模板和页面地址组成。用同一句指令模板操作同一页面上的不同目标时（例如用"在 {label} 输入框输入 {value}"依次填写多个输入框），给每次调用不同的 step，让它们各有一条缓存。
4. 需要按页面数据做判断时（比如选最便宜的），先 extract 取数据，在代码里判断，再用带参数的 act 去操作，这样这一步也能缓存。
5. 悬停才出现的菜单或按钮写成两步：先"悬停在顶部导航的产品菜单上"，再"点击子菜单中的 {name}"。

## expect

- 以 http://、https:// 或 ** 开头时按 URL 模式等待，例如 "**/inventory.html"。
- 其他写法按 Playwright 选择器等待元素可见，例如 "text=下单成功"、"#orderModal"。
- 最多等 10 秒；URL 模式只要求地址匹配，不等页面加载完。不通过时抛出 StepFailed，这一步不写缓存，也不再升级到 smart；如果这一步是按缓存回放的，还会删掉这条缓存，下次运行重新走模型。
- 没写 expect 时，act 的 click、press、fill、select_option 执行后会检查页面有没有任何变化（判定规则见 [架构与实现](architecture.md) 的执行后校验）。没有变化时视为动作没有生效：这一步不写缓存，升级到下一级重试（S1 → 编号 → fast → smart），S1 回放没有变化时还会删掉这条缓存；最后一级仍然没有变化时抛出 StepFailed。页面有变化但不是想要的结果（例如点错了元素）检查不出来，关键步骤仍然要写 expect。

## read、extract 和 save

- read 原样读出一块区域的全部文字，适合文章正文、商品描述、表格。第一次由模型从文本块清单里选区域，之后按缓存的位置直接读。
- extract 适合价格、名称这类零散字段，每次都调用模型。输入是页面文字和视口截图：页面文字一行一个可见文本块，带视口坐标，链接的 title、图片的 alt 和 ::before、::after 里的文字也在其中，最多 20000 字；fast 失败时升级到 smart。
- save 的 data 可以是字符串、pydantic 对象、字典或它们的列表。.json 原样写入；.csv 只接受对象或对象列表，每个对象一行，带 BOM 方便 Excel 打开中文；.md 中对象列表写成表格，单个对象写成"字段 | 值"表格，字符串原样写入；.txt 中字符串原样写入，其他内容写成 JSON。

## download、upload、wait_for、wait_for_human、scroll

download：点击后 15 秒内必须触发浏览器下载，否则视为这一步失败，抛出 StepFailed 并且不写缓存。文件按网站给出的文件名存到 save_to 目录。

upload：页面上常见的是隐藏的文件输入框加一个样式按钮，所以 upload 不直接填输入框，而是点击指令描述的按钮（或可见的文件输入框），接住弹出的文件选择框，把 files 选进去，再等页面稳定。点击后 5 秒内没有出现文件选择框视为这一步失败，抛出 StepFailed 并且不写缓存。

wait_for_human：需要人工登录或过验证码时调用。不给 until 时打印提示后等在终端按回车。给了 until 时不读终端，在当前页面上等条件满足后自动继续，适合没有终端的无人值守运行：写法与 expect 相同，以 http://、https:// 或 ** 开头时等地址匹配，否则等选择器对应的元素可见；timeout 秒（默认 300）内没有满足时抛出 TimeoutError。配合 OBACT_USER_DATA_DIR 使用，登录一次后，之后的运行可以复用登录状态。

wait_for：每一步本来就会等页面稳定（进行中的请求结束、DOM 连续 300ms 不变，最多 5 秒），但接口超过 2 秒的骨架屏、定时器延迟渲染、超过 5 秒才出现的组件等不到。这时用 wait_for 等明确的条件，写法同 expect，例如 ob.wait_for("text=共 20 条结果")；条件满足后再等页面稳定。没有明确条件可等时（倒计时按钮、网络或设备太慢），不给 until，固定等 timeout 秒，例如 ob.wait_for(timeout=5)；能写条件时优先写条件，固定等待在快的时候白等、慢的时候仍可能不够。

scroll：后加载的内容（懒加载图片、无限滚动列表）不滚动就不在页面上。scroll 用鼠标滚轮在鼠标当前位置向下滚一屏，然后等页面稳定；不移动鼠标，之前的悬停状态保留，鼠标停在可滚动的局部区域上时滚动的是那个区域。返回滚动前后页面的纵向位置，两者相同说明已经到底。page_state 的编号在 scroll 后失效。

## 日志

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

## 失败处理

失败处理：各级都失败或执行后校验不通过时抛出 StepFailed。它的 attempts 是各级尝试记录（S1、编号、fast、smart 各自失败的原因；选中的目标执行出错时带上编号和名称，模型找不到或目标被挡住时带上模型给的理由；动作没有让页面发生变化的一级记为“动作执行后页面没有任何变化”），screenshot 是失败时的截图，保存在缓存目录下的 任务名/failed.png；expect 不通过时，截图是动作执行并等页面稳定后、开始等 expect 之前拍的，几秒就消失的错误提示也能留下。executed 为 True 表示动作已经执行、只是执行后校验没有通过，包括没写 expect 时有一级执行了动作、页面却没有变化。

## 缓存

每个任务一个文件夹 .obact/任务名/，步骤缓存在其中的 steps.jsonl，每行一个步骤：

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

## 当前限制

1. 靠事件委托响应点击、自身没有任何交互特征的元素（部分 React 组件的下拉项、日历格子），只有视口内带短文字的叶子元素会进元素清单；只有图标或图片、文字超过 30 字、在视口外的仍然不在清单里，模型只能按坐标点击，这类步骤无法参数化缓存。
2. extract 的页面文字按块状元素分行并附带坐标，日历、复杂表格这类网格内容要靠模型按坐标和截图对应位置，仍可能对错；只取前 20000 字，坐标也占字数；链接和图片以外元素的 title 不读。
3. 缓存键包含 URL 路径，参数会改变路径的页面（不同分类、不同商品详情页、不同文章页）无法跨参数复用缓存。
4. 不支持 iframe 里的内容、shadow DOM、浏览器原生弹窗里的内容（alert、confirm、prompt 一律自动接受）。
5. wait_for_human 的 until 只能等地址匹配或元素出现，等不了元素消失、cookie 变化这类条件。
6. 没有写 expect 时，只能发现动作没有让页面发生任何变化；页面有变化但结果不对（点错了元素）仍会写入缓存。只改剪贴板、只播放声音、只通过 CSSOM 改样式这类页面上观察不到的动作，会被判成没有效果。
7. 视觉检查按“模型地址|模型名”记录，只在第一次使用时进行；之后接口失效或换了密钥，要等第一次真正调用模型时才会报错。
8. 页面脚本用 window.open 打开的新标签页无法事先判断，出现得比页面稳定还晚时，后续步骤仍会作用在原来的页面上。
