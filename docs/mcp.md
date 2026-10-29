# MCP 服务

obact/mcp_server.py 通过 stdio 把 Obact 的操作作为原子工具提供给 AI 客户端：AI 决定每一步做什么，Obact 负责在页面上执行并缓存。一个服务进程对应一个任务（一个缓存文件夹）和一个浏览器会话，工具调用串行执行。

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

## 缓存命中

缓存键是“step（没有 step 时为 instruction）+ 页面路径”，AI 每次措辞不同就不会命中。所以 page_state 会列出本页面已缓存的步骤，服务说明（MCP instructions）要求 AI 把它们原样作为 step 传入，并把会变化的值写成 {占位符}、放进 params。

## 编号

act、download 可以用 page_state 的编号（element_id）直接指定目标，不调用内部模型。编号只对紧接着的一次 act 或 download 有效；执行前核对页面地址没有变、元素唯一匹配、名称与快照一致，不符时转内部模型按 instruction 定位。编号执行成功后，和模型定位一样写入缓存。

## 启动参数

```
obact-mcp [--task 任务名] [--env 路径] [--headless]
python -m obact.mcp_server [参数同上]
```

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| --task | 项目目录名 | 缓存文件夹 .obact/任务名/ |
| --env | .env | 配置文件，相对路径按项目目录解析 |
| --headless | 不加（有头） | 无头运行；不加时按 OBACT_HEADLESS，默认显示浏览器窗口 |

## 项目目录

环境变量 CLAUDE_PROJECT_DIR 存在时（Claude Code 会为服务进程设置），进程先切换到该目录，否则使用当前工作目录。.env、缓存目录以及 download、save 的相对路径，都按项目目录解析。

## 部署到项目

1. 安装：`uv tool install https://github.com/ZoraMing/obact/archive/refs/heads/master.zip`，再执行 `uvx playwright==1.58.0 install chromium`（版本与 pyproject.toml 中的 playwright 一致）。uv tool 会把 obact-mcp 放进 PATH，不需要激活虚拟环境。也可以在项目自己的虚拟环境里 pip install 同一个地址（本地源码用 `pip install -e 源码路径`），再执行 `playwright install chromium`，这时 obact-mcp 只在激活该环境后可用。
2. 在项目根目录放 .env，必填 MODEL_BASE_URL、MODEL_NAME、MODEL_KEY（完整配置见 [使用指南](guide.md#配置)）。
3. 在项目目录里执行 `claude mcp add obact -- obact-mcp`。这是本地作用域，只对你自己在这个项目里生效。

不建议用 `uvx --from 地址 obact-mcp` 作为启动命令：第一次启动要先下载依赖，可能超过 Claude Code 等待服务启动的时间（MCP_TIMEOUT，默认 30 秒）。

想把配置提交到项目、或者使用其他 MCP 客户端时，改为在项目根目录写 .mcp.json：

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
claude mcp add --scope local obact -- E:/myproject/.venv/Scripts/obact-mcp.exe
```

一个项目通常配一个条目就够了：不同流程的步骤按 step 和页面路径区分，可以共用一个缓存文件。需要分开缓存时写多个条目，用 `"args": ["--task", "shop"]` 区分。首次使用项目级 .mcp.json 时，Claude Code 会询问是否允许加载该服务。

## 运行与关闭

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

实现与验证方法见 [MCP 服务开发文档](mcp-server.md)。
