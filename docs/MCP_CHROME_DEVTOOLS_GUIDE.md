# Chrome DevTools MCP 工具集设计与使用规范文档

本文档完整收录 Chrome DevTools Model Context Protocol (MCP) 官方工具集的架构设计、32 个工具的代码契约与智能体操作提示词规范，供自动化框架与工作流设计参考。

## 目录
1. 系统定位与核心设计思想
2. 智能体操作提示词与最佳实践规范
3. 全量工具分类总览 (共 32 个工具)
4. 工具详细代码契约与 Schema 定义
5. 对 Obact 项目的架构参考与改进建议

## 一、系统定位与核心设计思想

Chrome DevTools MCP 是面向大语言模型（LLM / Agent）设计的现代化浏览器自动化与调试交互协议。它的核心设计思想包括：

- 双向数据流与即时决策：每个工具执行完毕后，将结果结构化返回给调用者，支持在下一步根据前一步的返回内容进行分支决策。
- A11y 无障碍树优先（Snapshot-first）：通过 take_snapshot 获取带有全局唯一 UID 的元素快照，取代脆弱的 CSS/XPath 选择器。
- 网络与控制台一等公民：将网络请求（XHR/Fetch）和控制台日志列为标准查询工具，动态数据可直接从接口层获取，绕过复杂的 DOM 解析。
- 脚本双向管道与直接存盘：evaluate_script 支持传参、支持从本地文件读取源码，并支持直接将求值结果保存到指定文件。

## 二、智能体操作提示词与最佳实践规范

在调用该工具集时，官方及系统层推荐遵循以下准则：

1. 页面观察首选快照（take_snapshot）：
优先调用 take_snapshot 获取文本结构树，成本低、信息密度高且自带元素 UID；仅在需要视觉验证或处理 Canvas 绘图时调用 take_screenshot。

2. 元素交互基于快照 UID：
在交互前先获取最新快照，页面发生导航或显著变更后，旧的 UID 会失效，应重新获取快照以取得最新元素 UID。

3. 表单填充优先使用批量填表（fill_form）：
多字段表单优先使用 fill_form 一次性提交全部键值对，减少往返延迟；单字段使用 fill。

4. 动态数据首选网络截获：
对于列表、详情、报表等动态数据，优先通过 list_network_requests 查询对应接口，再用 get_network_request 提取干净的原始 JSON 数据。

5. 异步等待规范：
页面操作后调用 wait_for 等待目标文本出现，避免硬编码休眠；执行只读脚本时，将 evaluate_script 的 waitForStableDom 设为 false 以提升执行速度。

## 三、全量工具分类总览

| 类别 | 工具名称 | 功能简述 |
|---|---|---|
| 页面导航与管理 | navigate_page | 页面跳转、刷新、后退、前进 |
| | new_page | 新建标签页并可指定初始 URL |
| | close_page | 关闭指定标签页 |
| | list_pages | 获取所有打开的标签页列表 |
| | select_page | 激活并切换到指定标签页 |
| | resize_page | 调整指定页面的视口宽高 |
| 交互与表单 | click | 单击、双击或右击指定 UID 元素 |
| | fill | 填充单个输入框内容 |
| | fill_form | 批量填充整个表单的多个输入项 |
| | type_text | 模拟逐字键盘打字输入 |
| | press_key | 派发特定按键组合（如 Enter、Tab、Ctrl+A） |
| | hover | 鼠标悬停在指定元素上方 |
| | drag | 拖拽元素到目标坐标 |
| | upload_file | 上传本地文件到文件输入框 |
| | handle_dialog | 处理 alert、confirm、prompt 弹窗对话框 |
| 状态观察与提取 | take_snapshot | 基于 A11y 树获取带 uid 的文本快照 |
| | take_screenshot | 捕获页面、元素或全尺寸截图 |
| | wait_for | 等待指定文本在页面上出现并可见 |
| | get_css_styles | 获取目标元素的计算样式和 CSS 属性 |
| 脚本执行与数据流 | evaluate_script | 页面内执行 JS，支持传参并直接存盘到文件 |
| 网络与控制台 | list_network_requests | 列出页面最近的网络请求，支持类型过滤 |
| | get_network_request | 按请求 ID 读取完整请求头和响应主体 |
| | list_console_messages | 查看控制台输出（log、warn、error） |
| | get_console_message | 获取单条控制台消息的完整详情 |
| 环境模拟与设备 | emulate | 模拟移动设备、地理位置、深色模式、网络状况 |
| 性能与分析诊断 | lighthouse_audit | 执行 Lighthouse 审计并生成质量报告 |
| | performance_start_trace | 开始记录 Chrome Performance Trace |
| | performance_stop_trace | 停止性能追踪并导出 trace 文件 |
| | performance_analyze_insight | 针对特定性能洞察项进行深入分析 |
| | take_heapsnapshot | 导出 V8 堆内存快照文件排查内存泄漏 |
| | screencast_start / stop | 开启或停止页面连续帧流传输 |

## 四、工具详细代码契约与 Schema 定义

### click

Clicks on the provided element

参数 Schema 定义：

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "additionalProperties": false,
  "properties": {
    "dblClick": {
      "description": "Set to true for double clicks. Default is false.",
      "type": "boolean"
    },
    "includeSnapshot": {
      "description": "Whether to include a snapshot in the response. Default is false.",
      "type": "boolean"
    },
    "pageId": {
      "description": "Targets a specific page by ID.",
      "type": "number"
    },
    "uid": {
      "description": "The uid of an element on the page from the page content snapshot",
      "type": "string"
    }
  },
  "required": [
    "pageId",
    "uid"
  ],
  "type": "object"
}
```

### close_page

Closes the page by its index. The last open page cannot be closed.

参数 Schema 定义：

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "additionalProperties": false,
  "properties": {
    "pageId": {
      "description": "The ID of the page to close. Call list_pages to list pages.",
      "type": "number"
    }
  },
  "required": [
    "pageId"
  ],
  "type": "object"
}
```

### drag

Drag an element onto another element

参数 Schema 定义：

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "additionalProperties": false,
  "properties": {
    "from_uid": {
      "description": "The uid of the element to drag",
      "type": "string"
    },
    "includeSnapshot": {
      "description": "Whether to include a snapshot in the response. Default is false.",
      "type": "boolean"
    },
    "pageId": {
      "description": "Targets a specific page by ID.",
      "type": "number"
    },
    "to_uid": {
      "description": "The uid of the element to drop into",
      "type": "string"
    }
  },
  "required": [
    "pageId",
    "from_uid",
    "to_uid"
  ],
  "type": "object"
}
```

### emulate

Emulates various features on the target page. Each call replaces all emulation settings (except extraHttpHeaders), so pass all desired settings in a single call.

参数 Schema 定义：

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "additionalProperties": false,
  "properties": {
    "colorScheme": {
      "description": "Emulate the dark or the light mode. Omit or set to \"auto\" to reset to the default.",
      "enum": [
        "dark",
        "light",
        "auto"
      ],
      "type": "string"
    },
    "cpuThrottlingRate": {
      "description": "Represents the CPU slowdown factor. Omit or set the rate to 1 to disable throttling",
      "maximum": 20,
      "minimum": 1,
      "type": "number"
    },
    "extraHttpHeaders": {
      "description": "Extra HTTP headers as a JSON string object, e.g. {\"X-Custom\": \"value\", \"Authorization\": \"Bearer token\"}. Headers are included into every HTTP request originating from the page and persist across navigations until cleared. Pass an empty string to clear all extra headers.",
      "type": "string"
    },
    "forcedColors": {
      "description": "Emulate the `forced-colors` CSS media feature. Omit or set to \"auto\" to reset to the default.",
      "enum": [
        "active",
        "none",
        "auto"
      ],
      "type": "string"
    },
    "geolocation": {
      "description": "Geolocation (`<latitude>,<longitude>`) to emulate. Latitude between -90 and 90. Longitude between -180 and 180. Omit to clear the geolocation override.",
      "type": "string"
    },
    "networkConditions": {
      "description": "Throttle network. Omit to disable throttling.",
      "enum": [
        "Offline",
        "Slow 3G",
        "Fast 3G",
        "Slow 4G",
        "Fast 4G"
      ],
      "type": "string"
    },
    "pageId": {
      "description": "Targets a specific page by ID.",
      "type": "number"
    },
    "prefersContrast": {
      "description": "Emulate the `prefers-contrast` CSS media feature. Omit or set to \"auto\" to reset to the default.",
      "enum": [
        "more",
        "less",
        "custom",
        "no-preference",
        "auto"
      ],
      "type": "string"
    },
    "prefersReducedMotion": {
      "description": "Emulate the `prefers-reduced-motion` CSS media feature. Omit or set to \"auto\" to reset to the default.",
      "enum": [
        "reduce",
        "no-preference",
        "auto"
      ],
      "type": "string"
    },
    "userAgent": {
      "description": "User agent to emulate. Omit or set to empty string to clear the user agent override.",
      "type": "string"
    },
    "viewport": {
      "description": "Emulate device viewports '<width>x<height>x<devicePixelRatio>[,mobile][,touch][,landscape]'. 'touch' and 'mobile' to emulate mobile devices. 'landscape' to emulate landscape mode. Omit to clear the viewport override.",
      "type": "string"
    }
  },
  "required": [
    "pageId"
  ],
  "type": "object"
}
```

### evaluate_script

Evaluate JavaScript inside the target page. The source can be provided inline or loaded from a local file. Returns the response as JSON, so returned values have to be JSON-serializable.

参数 Schema 定义：

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "additionalProperties": false,
  "properties": {
    "args": {
      "description": "An optional list of arguments (element uids from the page content snapshot) to pass to the function.",
      "items": {
        "description": "The uid of an element on the page from the page content snapshot",
        "type": "string"
      },
      "type": "array"
    },
    "dialogAction": {
      "description": "Handle dialogs while execution. \"accept\", \"dismiss\", or string for response of window.prompt. Defaults to accept.",
      "type": "string"
    },
    "filePath": {
      "description": "The absolute or relative path to a file to save the script output to. If omitted, the output is returned inline.",
      "type": "string"
    },
    "format": {
      "description": "How to interpret the source. \"function\" treats it as a function declaration and supports args. \"script\" evaluates it as classic JavaScript and does not support args. Defaults to \"function\". ECMAScript modules are not supported.",
      "enum": [
        "function",
        "script"
      ],
      "type": "string"
    },
    "function": {
      "description": "JavaScript source to execute in the target page. Provide either this or sourcePath, but not both. The source is interpreted according to format.\nExample without arguments: `() => document.title` or `async () => await fetch(\"example.com\")`.\nExample with arguments: `(el) => el.innerText`\n",
      "type": "string"
    },
    "pageId": {
      "description": "Targets a specific page by ID.",
      "type": "number"
    },
    "sourcePath": {
      "description": "The absolute or relative path to a JavaScript file on the MCP server's local filesystem. Provide either this or function, but not both.",
      "type": "string"
    },
    "waitForStableDom": {
      "description": "Whether to wait for the DOM to settle. Pass false if the script only reads data. Defaults to true.",
      "type": "boolean"
    }
  },
  "required": [
    "pageId"
  ],
  "type": "object"
}
```

### fill

Type text into an input, text area or select an option from a <select> element.

参数 Schema 定义：

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "additionalProperties": false,
  "properties": {
    "includeSnapshot": {
      "description": "Whether to include a snapshot in the response. Default is false.",
      "type": "boolean"
    },
    "pageId": {
      "description": "Targets a specific page by ID.",
      "type": "number"
    },
    "uid": {
      "description": "The uid of an element on the page from the page content snapshot",
      "type": "string"
    },
    "value": {
      "description": "The value to fill in. \"true\" or \"false\" for checkboxes and toggles, \"true\" for radio buttons.",
      "type": "string"
    }
  },
  "required": [
    "pageId",
    "uid",
    "value"
  ],
  "type": "object"
}
```

### fill_form

Fill out multiple form elements (inputs, selects, checkboxes, radios) at once. ALWAYS prefer this tool over multiple individual 'fill' or 'click' calls when interacting with forms. It is significantly faster, more reliable, and reduces turn count. Example: Fill username, password, and check "Remember Me" in one call.

参数 Schema 定义：

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "additionalProperties": false,
  "properties": {
    "elements": {
      "description": "Elements from snapshot to fill out.",
      "items": {
        "description": "An element to fill out",
        "properties": {
          "uid": {
            "description": "The uid of the element to fill out",
            "type": "string"
          },
          "value": {
            "description": "Value for the element. \"true\" or \"false\" for checkboxes and toggles, \"true\" for radio buttons.",
            "type": "string"
          }
        },
        "required": [
          "uid",
          "value"
        ],
        "type": "object"
      },
      "type": "array"
    },
    "includeSnapshot": {
      "description": "Whether to include a snapshot in the response. Default is false.",
      "type": "boolean"
    },
    "pageId": {
      "description": "Targets a specific page by ID.",
      "type": "number"
    }
  },
  "required": [
    "pageId",
    "elements"
  ],
  "type": "object"
}
```

### get_console_message

Gets a console message by its ID. You can get all messages by calling list_console_messages.

参数 Schema 定义：

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "additionalProperties": false,
  "properties": {
    "msgid": {
      "description": "The msgid of a console message on the page from the listed console messages",
      "type": "number"
    },
    "pageId": {
      "description": "Targets a specific page by ID.",
      "type": "number"
    }
  },
  "required": [
    "pageId",
    "msgid"
  ],
  "type": "object"
}
```

### get_css_styles

Retrieve matched CSS rules, inline styles (element.style), inherited styles, custom properties, and cascade wrappers (@layer, @media, @container, @scope) for an element identified by its UID.
Rules are ordered from highest to lowest cascade precedence and include source line numbers (e.g. index:196). Active (winning) declarations have no prefix tag, while (losing) overridden declarations are prefixed with [overloaded].
Treat the output as authoritative and complete.
Results are paginated (10 rules per page by default); use pageIdx to page through the remaining rules. Requires a UID from take_snapshot.

参数 Schema 定义：

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "additionalProperties": false,
  "properties": {
    "pageId": {
      "description": "Targets a specific page by ID.",
      "type": "number"
    },
    "pageIdx": {
      "default": 0,
      "description": "Page number to return (0-based). Defaults to 0 (the first page).",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "pageSize": {
      "default": 10,
      "description": "Maximum number of CSS rules to return per page. Defaults to 10.",
      "exclusiveMinimum": 0,
      "maximum": 9007199254740991,
      "type": "integer"
    },
    "uid": {
      "description": "The uid of the element on the page from the page content snapshot to inspect CSS styles for",
      "type": "string"
    }
  },
  "required": [
    "pageId",
    "uid"
  ],
  "type": "object"
}
```

### get_network_request

Gets a network request by an optional reqid, if omitted returns the currently selected request in the DevTools Network panel. Useful for inspecting request headers (including 'Cookie') and response headers (including 'Set-Cookie' and directives).

参数 Schema 定义：

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "additionalProperties": false,
  "properties": {
    "pageId": {
      "description": "Targets a specific page by ID.",
      "type": "number"
    },
    "reqid": {
      "description": "The reqid of the network request. If omitted returns the currently selected request in the DevTools Network panel.",
      "type": "number"
    },
    "requestFilePath": {
      "description": "The absolute or relative path to a .network-request file to save the request body to. If omitted, the body is returned inline.",
      "type": "string"
    },
    "responseFilePath": {
      "description": "The absolute or relative path to a .network-response file to save the response body to. If omitted, the body is returned inline.",
      "type": "string"
    }
  },
  "required": [
    "pageId"
  ],
  "type": "object"
}
```

### handle_dialog

If a browser dialog was opened, use this command to handle it

参数 Schema 定义：

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "additionalProperties": false,
  "properties": {
    "action": {
      "description": "Whether to dismiss or accept the dialog",
      "enum": [
        "accept",
        "dismiss"
      ],
      "type": "string"
    },
    "pageId": {
      "description": "Targets a specific page by ID.",
      "type": "number"
    },
    "promptText": {
      "description": "Optional prompt text to enter into the dialog.",
      "type": "string"
    }
  },
  "required": [
    "pageId",
    "action"
  ],
  "type": "object"
}
```

### hover

Hover over the provided element

参数 Schema 定义：

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "additionalProperties": false,
  "properties": {
    "includeSnapshot": {
      "description": "Whether to include a snapshot in the response. Default is false.",
      "type": "boolean"
    },
    "pageId": {
      "description": "Targets a specific page by ID.",
      "type": "number"
    },
    "uid": {
      "description": "The uid of an element on the page from the page content snapshot",
      "type": "string"
    }
  },
  "required": [
    "pageId",
    "uid"
  ],
  "type": "object"
}
```

### lighthouse_audit

Get Lighthouse scores, failing audits, and the DOM nodes they flag for accessibility, SEO, best practices, and agentic browsing. Full reports are saved to disk. This excludes performance. For performance audits, run performance_start_trace

参数 Schema 定义：

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "additionalProperties": false,
  "properties": {
    "device": {
      "default": "desktop",
      "description": "Device to emulate.",
      "enum": [
        "desktop",
        "mobile"
      ],
      "type": "string"
    },
    "mode": {
      "default": "navigation",
      "description": "\"navigation\" reloads & audits. \"snapshot\" analyzes current state.",
      "enum": [
        "navigation",
        "snapshot"
      ],
      "type": "string"
    },
    "outputDirPath": {
      "description": "Directory for reports. If omitted, uses temporary files.",
      "type": "string"
    },
    "pageId": {
      "description": "Targets a specific page by ID.",
      "type": "number"
    }
  },
  "required": [
    "pageId"
  ],
  "type": "object"
}
```

### list_console_messages

List all console messages for the target page since the last navigation.

参数 Schema 定义：

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "additionalProperties": false,
  "properties": {
    "includePreservedMessages": {
      "default": false,
      "description": "Set to true to return the preserved messages over the last 3 navigations.",
      "type": "boolean"
    },
    "includeStackTraces": {
      "default": false,
      "description": "Set to true to include the stack trace for each message when available. Increases the response size.",
      "type": "boolean"
    },
    "pageId": {
      "description": "Targets a specific page by ID.",
      "type": "number"
    },
    "pageIdx": {
      "description": "Page number to return (0-based). When omitted, returns the first page. Ignored unless pageSize is set.",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "pageSize": {
      "description": "Maximum number of messages to return. When omitted, returns all messages.",
      "exclusiveMinimum": 0,
      "maximum": 9007199254740991,
      "type": "integer"
    },
    "serviceWorkerId": {
      "description": "Filter messages by the service worker ID shown by list_pages (sw-N).",
      "type": "string"
    },
    "types": {
      "description": "Filter messages to only return messages of the specified resource types. When omitted or empty, returns all messages.",
      "items": {
        "enum": [
          "log",
          "debug",
          "info",
          "error",
          "warn",
          "dir",
          "dirxml",
          "table",
          "trace",
          "clear",
          "startGroup",
          "startGroupCollapsed",
          "endGroup",
          "assert",
          "profile",
          "profileEnd",
          "count",
          "timeEnd",
          "verbose",
          "issue"
        ],
        "type": "string"
      },
      "type": "array"
    }
  },
  "required": [
    "pageId"
  ],
  "type": "object"
}
```

### list_network_requests

Lists the most recent requests for the target page since the last navigation.

参数 Schema 定义：

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "additionalProperties": false,
  "properties": {
    "includePreservedRequests": {
      "default": false,
      "description": "Set to true to return the preserved requests over the last 3 navigations.",
      "type": "boolean"
    },
    "pageId": {
      "description": "Targets a specific page by ID.",
      "type": "number"
    },
    "pageIdx": {
      "description": "Page number to return (0-based). When omitted, returns the first page. Ignored unless pageSize is set.",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "pageSize": {
      "description": "Maximum number of requests to return. When omitted, returns all requests.",
      "exclusiveMinimum": 0,
      "maximum": 9007199254740991,
      "type": "integer"
    },
    "resourceTypes": {
      "description": "Filter requests to only return requests of the specified resource types. When omitted or empty, returns all requests.",
      "items": {
        "enum": [
          "document",
          "stylesheet",
          "image",
          "media",
          "font",
          "script",
          "texttrack",
          "xhr",
          "fetch",
          "prefetch",
          "eventsource",
          "manifest",
          "signedexchange",
          "ping",
          "cspviolationreport",
          "preflight",
          "fedcm",
          "other"
        ],
        "type": "string"
      },
      "type": "array"
    }
  },
  "required": [
    "pageId"
  ],
  "type": "object"
}
```

### list_pages

Get a list of pages open in the browser.

参数 Schema 定义：

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "additionalProperties": false,
  "properties": {},
  "type": "object"
}
```

### navigate_page

Go to a URL, or back, forward, or reload. Use project URL if not specified otherwise.

参数 Schema 定义：

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "additionalProperties": false,
  "properties": {
    "handleBeforeUnload": {
      "description": "Whether to auto accept or beforeunload dialogs triggered by this navigation. Default is accept.",
      "enum": [
        "accept",
        "dismiss"
      ],
      "type": "string"
    },
    "ignoreCache": {
      "description": "Whether to ignore cache on reload.",
      "type": "boolean"
    },
    "initScript": {
      "description": "A JavaScript script to be executed on each new document before any other scripts for the next navigation.",
      "type": "string"
    },
    "pageId": {
      "description": "Targets a specific page by ID.",
      "type": "number"
    },
    "timeout": {
      "description": "Maximum wait time in milliseconds. If set to 0, the default timeout will be used.",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "type": {
      "description": "Navigate the page by URL, back or forward in history, or reload.",
      "enum": [
        "url",
        "back",
        "forward",
        "reload"
      ],
      "type": "string"
    },
    "url": {
      "description": "Target URL (only type=url)",
      "type": "string"
    }
  },
  "required": [
    "pageId"
  ],
  "type": "object"
}
```

### new_page

Open a new tab and load a URL. Use project URL if not specified otherwise.

参数 Schema 定义：

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "additionalProperties": false,
  "properties": {
    "background": {
      "description": "Whether to open the page in the background without bringing it to the front. Default is false (foreground).",
      "type": "boolean"
    },
    "isolatedContext": {
      "description": "If specified, the page is created in an isolated browser context with the given name. Pages in the same browser context share cookies and storage. Pages in different browser contexts are fully isolated (useful for clean-slate testing of cookies and authentication).",
      "type": "string"
    },
    "timeout": {
      "description": "Maximum wait time in milliseconds. If set to 0, the default timeout will be used.",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "url": {
      "description": "URL to load in a new page.",
      "type": "string"
    }
  },
  "required": [
    "url"
  ],
  "type": "object"
}
```

### performance_analyze_insight

Provides more detailed information on a specific Performance Insight of an insight set that was highlighted in the results of a trace recording.

参数 Schema 定义：

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "additionalProperties": false,
  "properties": {
    "insightName": {
      "description": "The name of the Insight you want more information on. For example: \"DocumentLatency\" or \"LCPBreakdown\"",
      "type": "string"
    },
    "insightSetId": {
      "description": "The id for the specific insight set. Only use the ids given in the \"Available insight sets\" list.",
      "type": "string"
    },
    "pageId": {
      "description": "Targets a specific page by ID.",
      "type": "number"
    }
  },
  "required": [
    "pageId",
    "insightSetId",
    "insightName"
  ],
  "type": "object"
}
```

### performance_start_trace

Start a performance trace on the target webpage. Use to find frontend performance issues, Core Web Vitals (LCP, INP, CLS), and improve page load speed.

参数 Schema 定义：

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "additionalProperties": false,
  "properties": {
    "autoStop": {
      "default": true,
      "description": "Determines if the trace recording should be automatically stopped.",
      "type": "boolean"
    },
    "filePath": {
      "description": "The absolute file path, or a file path relative to the current working directory, to save the raw trace data. For example, trace.json.gz (compressed) or trace.json (uncompressed).",
      "type": "string"
    },
    "ignoreCache": {
      "description": "Whether to bypass the HTTP cache when reloading the page, to measure a cold page load. Only applies if reload is true.",
      "type": "boolean"
    },
    "pageId": {
      "description": "Targets a specific page by ID.",
      "type": "number"
    },
    "reload": {
      "default": true,
      "description": "Determines if, once tracing has started, the target page should be automatically reloaded. Navigate the page to the right URL using the navigate_page tool BEFORE starting the trace if reload or autoStop is set to true.",
      "type": "boolean"
    }
  },
  "required": [
    "pageId"
  ],
  "type": "object"
}
```

### performance_stop_trace

Stop the active performance trace recording on the target webpage.

参数 Schema 定义：

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "additionalProperties": false,
  "properties": {
    "filePath": {
      "description": "The absolute file path, or a file path relative to the current working directory, to save the raw trace data. For example, trace.json.gz (compressed) or trace.json (uncompressed).",
      "type": "string"
    },
    "pageId": {
      "description": "Targets a specific page by ID.",
      "type": "number"
    }
  },
  "required": [
    "pageId"
  ],
  "type": "object"
}
```

### press_key

Press a key or key combination. Use this when other input methods like fill() cannot be used (e.g., keyboard shortcuts, navigation keys, or special key combinations).

参数 Schema 定义：

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "additionalProperties": false,
  "properties": {
    "includeSnapshot": {
      "description": "Whether to include a snapshot in the response. Default is false.",
      "type": "boolean"
    },
    "key": {
      "description": "A key or a combination (e.g., \"Enter\", \"Control+A\", \"Control++\", \"Control+Shift+R\"). Modifiers: Control, Shift, Alt, Meta",
      "type": "string"
    },
    "pageId": {
      "description": "Targets a specific page by ID.",
      "type": "number"
    }
  },
  "required": [
    "pageId",
    "key"
  ],
  "type": "object"
}
```

### resize_page

Resizes the page's window so that the page has specified dimension

参数 Schema 定义：

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "additionalProperties": false,
  "properties": {
    "height": {
      "description": "Page height",
      "exclusiveMinimum": 0,
      "maximum": 9007199254740991,
      "type": "integer"
    },
    "pageId": {
      "description": "Targets a specific page by ID.",
      "type": "number"
    },
    "width": {
      "description": "Page width",
      "exclusiveMinimum": 0,
      "maximum": 9007199254740991,
      "type": "integer"
    }
  },
  "required": [
    "pageId",
    "width",
    "height"
  ],
  "type": "object"
}
```

### screencast_start

Starts recording a screencast (video) of the target page.

参数 Schema 定义：

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "additionalProperties": false,
  "properties": {
    "filePath": {
      "description": "Output file path (.mp4). Uses mkdtemp to generate a unique path if not provided.",
      "type": "string"
    },
    "pageId": {
      "description": "Targets a specific page by ID.",
      "type": "number"
    }
  },
  "required": [
    "pageId"
  ],
  "type": "object"
}
```

### screencast_stop

Stops the active screencast recording on the target page.

参数 Schema 定义：

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "additionalProperties": false,
  "properties": {
    "pageId": {
      "description": "Targets a specific page by ID.",
      "type": "number"
    }
  },
  "required": [
    "pageId"
  ],
  "type": "object"
}
```

### select_page

Select a page as a context for future tool calls.

参数 Schema 定义：

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "additionalProperties": false,
  "properties": {
    "bringToFront": {
      "description": "Whether to focus the page and bring it to the top.",
      "type": "boolean"
    },
    "pageId": {
      "description": "The ID of the page to select. Call list_pages to get available pages.",
      "type": "number"
    }
  },
  "required": [
    "pageId"
  ],
  "type": "object"
}
```

### take_heapsnapshot

Capture a heap snapshot of the target page. Use to analyze the memory distribution of JavaScript objects and debug memory leaks.

参数 Schema 定义：

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "additionalProperties": false,
  "properties": {
    "filePath": {
      "description": "A path to a .heapsnapshot file to save the heapsnapshot to.",
      "type": "string"
    },
    "pageId": {
      "description": "Targets a specific page by ID.",
      "type": "number"
    }
  },
  "required": [
    "pageId",
    "filePath"
  ],
  "type": "object"
}
```

### take_screenshot

Take a screenshot of the page or element.

参数 Schema 定义：

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "additionalProperties": false,
  "properties": {
    "filePath": {
      "description": "The absolute path, or a path relative to the current working directory, to save the screenshot to instead of attaching it to the response.",
      "type": "string"
    },
    "format": {
      "default": "png",
      "description": "Type of format to save the screenshot as. Default is \"png\"",
      "enum": [
        "png",
        "jpeg",
        "webp"
      ],
      "type": "string"
    },
    "fullPage": {
      "description": "If set to true takes a screenshot of the full page instead of the currently visible viewport. Incompatible with uid.",
      "type": "boolean"
    },
    "pageId": {
      "description": "Targets a specific page by ID.",
      "type": "number"
    },
    "quality": {
      "description": "Compression quality for JPEG and WebP formats (0-100). Higher values mean better quality but larger file sizes. Ignored for PNG format.",
      "maximum": 100,
      "minimum": 0,
      "type": "number"
    },
    "uid": {
      "description": "The uid of an element on the page from the page content snapshot. If omitted, takes a page screenshot.",
      "type": "string"
    }
  },
  "required": [
    "pageId"
  ],
  "type": "object"
}
```

### take_snapshot

Take a text snapshot of the target page based on the a11y tree. The snapshot lists page elements along with a unique
identifier (uid). Always use the latest snapshot. Prefer taking a snapshot over taking a screenshot. The snapshot indicates the element selected
in the DevTools Elements panel (if any).

参数 Schema 定义：

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "additionalProperties": false,
  "properties": {
    "filePath": {
      "description": "The absolute path, or a path relative to the current working directory, to save the snapshot to instead of attaching it to the response.",
      "type": "string"
    },
    "pageId": {
      "description": "Targets a specific page by ID.",
      "type": "number"
    },
    "verbose": {
      "description": "Whether to include all possible information available in the full a11y tree. Default is false.",
      "type": "boolean"
    }
  },
  "required": [
    "pageId"
  ],
  "type": "object"
}
```

### type_text

Type text using keyboard into a previously focused input

参数 Schema 定义：

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "additionalProperties": false,
  "properties": {
    "pageId": {
      "description": "Targets a specific page by ID.",
      "type": "number"
    },
    "submitKey": {
      "description": "Optional key to press after typing. E.g., \"Enter\", \"Tab\", \"Escape\"",
      "type": "string"
    },
    "text": {
      "description": "The text to type",
      "type": "string"
    }
  },
  "required": [
    "pageId",
    "text"
  ],
  "type": "object"
}
```

### upload_file

Upload a file through a provided element.

参数 Schema 定义：

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "additionalProperties": false,
  "properties": {
    "filePaths": {
      "description": "One or more files paths to upload. File paths have to be local to the browser instance (not the MCP).",
      "items": {
        "type": "string"
      },
      "minItems": 1,
      "type": "array"
    },
    "includeSnapshot": {
      "description": "Whether to include a snapshot in the response. Default is false.",
      "type": "boolean"
    },
    "pageId": {
      "description": "Targets a specific page by ID.",
      "type": "number"
    },
    "uid": {
      "description": "The uid of the file input element or an element that will open file chooser on the page from the page content snapshot",
      "type": "string"
    }
  },
  "required": [
    "pageId",
    "uid",
    "filePaths"
  ],
  "type": "object"
}
```

### wait_for

Wait for the specified text to appear on the selected page. By default, hidden text is also matched. Set visible to true to wait until the matched text is visible.

参数 Schema 定义：

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "additionalProperties": false,
  "properties": {
    "pageId": {
      "description": "Targets a specific page by ID.",
      "type": "number"
    },
    "text": {
      "description": "Non-empty list of texts. Resolves when any value appears on the page.",
      "items": {
        "type": "string"
      },
      "minItems": 1,
      "type": "array"
    },
    "timeout": {
      "description": "Maximum wait time in milliseconds. If set to 0, the default timeout will be used.",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "visible": {
      "default": false,
      "description": "If true, wait until the matching text is visible. By default, hidden text also counts.",
      "type": "boolean"
    }
  },
  "required": [
    "pageId",
    "text"
  ],
  "type": "object"
}
```

## 五、对 Obact 项目的架构参考与改进建议

1. 引入双向数据流步骤：
在工作流中增加带 as 变量绑定的 evaluate_script 步骤，允许脚本求值结果直接存为后续步骤的变量，或者通过 filePath 参数直接保存到 workspace/outputs。

2. 开放一等公民网络接口查询：
在 core 和 workflow 中增加类似 list_network_requests 和 get_network_request 的动作，对于大响应体直接进行流式写入，避免 CDP inspector cache 逐出问题。

3. 引入无障碍树（A11y）UID 定位机制：
在现有的 CSS / Role 定位器之外，支持基于 A11y Snapshot 的临时 UID 定位，降低大型复杂单页应用的定位难度与观察数据量。
