# 示例与任务集

## 示例

examples/ 下的示例在仓库根目录运行，结果写到 workspace/outputs/：

```powershell
python examples/books.py Poetry      # 找分类里最便宜的书，读取商品描述，书单写成 CSV 和 Markdown，详情写成 JSON
python examples/download.py          # 在下载练习页挑一个 .txt 文件下载，文件列表写成 Markdown
python examples/runoob_dfs.py        # 在菜鸟教程找讲 DFS 且带 Python 代码的教程：换词、翻页、规则筛选加模型分级，给出多个结果
python examples/google_flights.py    # 在 Google Flights 搜索单程航班，用 smart 模型综合票价和耗时推荐航班
```

第一次运行每一步都会调用模型；再运行一次，act、read、download 按缓存回放，只有 extract 调用模型。

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
