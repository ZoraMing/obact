这是Mini-Stagehand 工程复刻技术规范（PRD & Technical Spec）。这份文档剔除了原项目中冗余的云平台耦合、复杂的多层抽象和遥测代码，只保留最核心的“混合蒸馏 + 结构化原子操作 + 自愈缓存”三大引擎。

---

## 一、 核心设计哲学（Design Philosophy）

1. **拒绝全自主长循环，只做确定性代码中的原子填充（Atomic over Autonomous）**：
业务流控制权（循环、条件判断、登录态管理）100% 交给传统 Playwright 代码；AI 只在传统 Selector 脆弱或难以编写的单个步骤上介入（通过 `act`、`extract`、`observe` 三个原语）。
2. **渲染态感知，而非源码感知（Rendered State over Raw HTML）**：
大模型绝不直接阅读原始 HTML 源码。必须通过浏览器底层渲染接口（`getBoundingClientRect` + `elementFromPoint` + `ComputedStyle`）获取**当前人类肉眼真正可见、未被弹窗遮挡**的交互元素树。
3. **索引对齐，禁止生成选择器（Index Grounding over Selector Hallucination）**：
禁止让大模型直接编写 XPath 或 CSS Selector（极易产生幻觉）。系统为每个可见元素分配整数索引 `[1], [2], ...`，大模型只需做单选题（返回整数 `id`），再由前端注入脚本逆向计算出 100% 准确的 XPath。
4. **大模型探路，传统脚本铺路（Explore Once, Replay Forever）**：
首次运行消耗大模型算力定位元素并逆向生成稳健的 XPath 存入本地缓存；后续重复运行直接回放 XPath（0 Token，毫秒级耗时）；仅当网页改版或出现意外弹窗导致 XPath 失效报错时，自动回退（Fallback）唤醒大模型重新定位并覆盖缓存。

---

## 二、 系统架构与全流程状态机图（ASCII 蓝图）

```text
================================================================================
                        Mini-Stagehand 核心执行流 (act / observe)
================================================================================

  [用户调用: page.act("点击搜索")]
                 │
                 ▼
      ┌──────────────────────┐
      │ 1. 计算缓存指纹 Key   │  Key = SHA256(URL_Pattern + Instruction)
      └──────────┬───────────┘
                 │
         ┌───────┴───────┐
         ▼ (命中 Cache)   ▼ (未命中 Miss)
┌─────────────────┐      │
│ 2. Playwright   │      │
│ 直接执行缓存动作 │      │
└────────┬────────┘      │
         │               │
    ┌────┴────┐          │
    ▼ (成功)  ▼ (报错/超时: 触发自愈 Self-Healing)
[直接返回]    └──────────┼───────────────────────────────┐
                         ▼                               ▼
           ┌──────────────────────────────────────────────────────────┐
           │ 3. 浏览器端注入 JS 蒸馏器 (DOM Distiller & Occlusion)     │
           │  • 遍历可交互节点 (button, input, a, [role=...])          │
           │  • 剔除宽高为0、opacity=0、视口外元素                     │
           │  • 遮挡检测: elementFromPoint(中心点) 过滤弹窗下方的元素  │
           │  • 生成稳定 XPath 并写入内存 Map: { index -> xpath }      │
           │  • (可选) 若开启视觉模式: 在网页绘制彩色数字框并截图(SoM) │
           └─────────────────────────────┬────────────────────────────┘
                                         │ 输出精简元素清单:
                                         │ [1] <input placeholder="代码">
                                         │ [2] <button> "搜索"
                                         ▼
           ┌──────────────────────────────────────────────────────────┐
           │ 4. 大模型结构化推理 (Structured LLM / VLM Call)          │
           │  • 输入: 指令 + 精简元素清单 (+ 可选 SoM 截图)            │
           │  • 约束: 强制 JSON Schema 输出                           │
           │  • 输出: {"id": 2, "method": "click", "args": []}        │
           └─────────────────────────────┬────────────────────────────┘
                                         │
                                         ▼
           ┌──────────────────────────────────────────────────────────┐
           │ 5. 动作映射与稳态执行 (Execution & DOM Settling)         │
           │  • 查表获取真实路径: xpath = Map.get(2)                  │
           │  • 执行 Playwright: page.locator(xpath).click()          │
           │  • 等待网络空闲与 DOM 变动稳定                           │
           └─────────────────────────────┬────────────────────────────┘
                                         │
                                         ▼
           ┌──────────────────────────────────────────────────────────┐
           │ 6. 缓存固化落盘 (Cache Persistence)                      │
           │  • 将 {Key: {xpath, method, args}} 写入本地 JSON/SQLite  │
           └──────────────────────────────────────────────────────────┘

```

---

## 三、 完整工程复刻规范（可直接喂给 AI 生成代码）

> **使用说明**：将下方分割线内的 Markdown 完整复制给 AI 编程助手，即可直接生成一套无废话、高可用的精简版 Stagehand。

---

### AI 编码指令：实现精简版 Stagehand (`MiniStagehand`)

请使用 **Python (Playwright Async API + Pydantic + OpenAI SDK 兼容接口)**（或按需替换为 TypeScript）实现一个名为 `MiniStagehand` 的轻量级浏览器自动化框架。要求代码高内聚、零冗余依赖，严格实现以下 5 个核心模块：

#### 模块 1：数据结构与 Schema 定义 (`schemas.py`)

使用 Pydantic 定义大模型强制结构化输出（Structured Outputs）的数据模型：

1. **`ObserveElement`**：
* `id`: `int`（页面蒸馏器分配的临时唯一编号）
* `tag`: `str`（HTML 标签名或 ARIA Role）
* `text`: `str`（元素的可见文本、placeholder 或 aria-label）
* `xpath`: `str`（前端计算出的精确 XPath，**不发给 LLM**，仅在宿主内存中保存映射）


2. **`LLMActionDecision`**（发给 LLM 的 `response_format`）：
* `element_id`: `Optional[int]`（目标元素编号；若页面无匹配元素需要滚动或无法完成则为 `None`）
* `method`: `Literal["click", "fill", "press", "select_option", "scroll_down", "none"]`
* `arguments`: `List[str]`（如 `fill` 的输入文本，或 `press` 的按键名如 `"Enter"`；无参数则为空列表 `[]`）
* `reason`: `str`（简短的一句话判断依据，限制在 20 字以内以节省 Token）



#### 模块 2：浏览器端 DOM 蒸馏与防遮挡注入脚本 (`dom_distiller.js`)

编写一段纯原生 JavaScript 函数 `window.__distillDOM(enableSoM = false)`，通过 `page.evaluate()` 注入页面。必须严格按顺序执行以下 5 步：

1. **清理旧标记**：移除页面上之前可能残留的 `#__stagehand_som_overlay` 容器。
2. **候选节点收集**：获取所有元素，筛选出原生交互标签（`a, button, input, select, textarea, summary`）或具有交互属性的节点（拥有 `role="button|link|tab|menuitem|checkbox|combobox"`, `onclick`, `tabindex >= 0` 或 `cursor: pointer`）。
3. **可见性与视口裁剪**：
* 调用 `el.getBoundingClientRect()`，剔除 `width < 4` 或 `height < 4` 的元素。
* 剔除完全处于当前视口（`window.innerWidth`, `window.innerHeight`）之外的元素。
* 调用 `window.getComputedStyle(el)`，剔除 `display === 'none'`, `visibility === 'hidden'`, `opacity === '0'` 或 `pointerEvents === 'none'` 的元素。


4. **中心点防遮挡检测（核心步骤）**：
* 计算元素中心坐标 `cx = rect.left + rect.width / 2`, `cy = rect.top + rect.height / 2`。
* 调用 `topEl = document.elementFromPoint(cx, cy)`。
* **判定规则**：如果 `topEl` 既不是 `el` 本身，也不在 `el` 内部（`!el.contains(topEl)`），且 `topEl` 也不包含 `el`（或 `topEl` 是一个遮罩层），则判定该元素被弹窗/浮层遮挡，**直接丢弃**。


5. **生成稳定 XPath 与 SoM 视觉框**：
* 为每个通过筛选的元素分配递增整数 `id`（从 `1` 开始）。
* 编写内部辅助函数 `getStableXPath(el)`：优先利用元素的 `@id`、`@data-testid`、`@name`、`@placeholder`、`@aria-label` 生成短路径；若无唯一属性，则回退生成带位置索引的层级路径（如 `/html/body/div[2]/button[1]`）。
* 若 `enableSoM == true`，在页面顶层创建一个 `position: fixed; pointer-events: none; z-index: 2147483647` 的 Canvas 或 SVG 图层，在每个 `rect` 周围画红色边框，并在左上角绘制带背景色的数字编号 `[id]`。
* 返回数组：`[{ id, tag, role, text, placeholder, xpath, rect }]`。



#### 模块 3：自愈缓存管理器 (`cache_manager.py`)

实现本地 JSON 文件缓存（默认保存在 `.stagehand_cache.json`）：

1. **生成指纹 `get_key(url: str, instruction: str) -> str**`：
* 将 URL 去除动态 Query 参数（保留 origin + pathname）与 `instruction` 拼接，计算 SHA256 哈希。


2. **读取与写入**：
* `get(key) -> Optional[Dict]`：返回 `{"xpath": str, "method": str, "arguments": List[str]}`。
* `set(key, data)`：写入并持久化到本地 JSON。
* `invalidate(key)`：当缓存动作执行失败时，删除旧记录。



#### 模块 4：核心执行引擎 (`stagehand.py`)

封装 `MiniStagehand` 类，持有 Playwright `page`、OpenAI 客户端（支持本地 vLLM 的 Qwen-9B 接口）及 `CacheManager`。实现以下 3 个核心异步方法：

##### 1. `async def observe(self, instruction: str, use_vision: bool = False) -> Tuple[LLMActionDecision, Dict[int, str]]`

* 调用 `page.evaluate(DOM_DISTILLER_JS, use_vision)` 获取可见无遮挡元素列表。
* 构建 `id_to_xpath = { item['id']: item['xpath'] }` 内存映射字典。
* 将元素列表格式化为极简文本行（不包含 `xpath` 和坐标，节省 Token）：
```text
[1] <input placeholder="输入合约代码">
[2] <button> "查询 V 反信号"

```


* 若 `use_vision=True`，调用 `page.screenshot()` 转为 Base64，执行完截图后立即调用 JS 移除页面上的 SoM 边框图层。
* 调用 LLM 接口（传入 System Prompt、元素列表文本、用户 `instruction` 及可选截图），强制使用 `LLMActionDecision` 作为 JSON Schema 约束输出。
* 返回 `(decision, id_to_xpath)`。

##### 2. `async def act(self, instruction: str, use_cache: bool = True, use_vision: bool = False) -> bool`

* **阶段 A（缓存快速通道）**：
* 若 `use_cache=True`，查询 `cache.get(key)`。
* 若命中缓存，尝试使用 `try...except` 执行 `_execute_playwright(xpath, method, arguments, timeout=3000)`。
* 若执行成功，直接返回 `True`（耗时毫秒级，0 模型调用）。
* 若抛出 `TimeoutError` 或元素不可见异常，打印日志 `"Cache miss/stale, triggering self-healing..."`，进入阶段 B。


* **阶段 B（大模型探路与自愈）**：
* 调用 `await self.observe(instruction, use_vision)` 获得 `(decision, id_to_xpath)`。
* 若 `decision.method == "scroll_down"`，执行 `page.mouse.wheel(0, 500)`。
* 若 `decision.element_id` 存在于 `id_to_xpath` 中：
* 取出真实 `xpath = id_to_xpath[decision.element_id]`。
* 调用 `await self._execute_playwright(xpath, decision.method, decision.arguments, timeout=5000)`。
* 执行成功后，若 `use_cache=True`，将 `{xpath, method, arguments}` 写入缓存（完成自愈更新）。
* 等待页面稳定（`await page.wait_for_load_state("domcontentloaded")` 及短暂 300ms 动画缓冲）。
* 返回 `True`。





##### 3. `async def extract(self, instruction: str, schema: Type[BaseModel]) -> BaseModel`

* 注入脚本提取当前页面可见区域的纯文本或蒸馏后的结构树。
* 调用 LLM，将用户传入的 Pydantic `schema` 作为 `response_format`，直接解析并返回结构化业务数据实例。

#### 模块 5：内置 System Prompt 规范

在代码中硬编码以下高密度 System Prompt（专为 Qwen-9B 等小模型优化，零废话直出 JSON）：

```text
你是一个精准的浏览器自动化执行引擎。
你将收到用户的【操作指令】以及当前页面可见、无遮挡的【可交互元素列表】（格式为：[编号] <标签> 文本/属性）。
请严格挑选最匹配指令的元素编号（element_id），并指定动作（method）与参数（arguments）。
规则：
1. 只能从列表中已有的数字编号中选择 element_id，严禁编造编号。
2. 若操作是点击，method 填 "click"，arguments 填 []。
3. 若操作是输入文本，method 填 "fill"，arguments 填 ["要输入的字符串"]。
4. 若当前列表没有目标元素且需要向下翻页，element_id 填 null，method 填 "scroll_down"。

```

---

## 四、 针对你的 Qwen-9B(本地小模型) 本地部署的专属优化建议

在将上述架构与你本地的 **vLLM + Qwen-9B** 对接时，有两个极佳的配合点：

1. **只传索引号，完全释放 9B 速度**：
由于前端 JS 已经算好了 XPath 并保存在 Python 字典里，Qwen-9B 只需要输出类似 `{"element_id": 14, "method": "click", "arguments": [], "reason": "匹配搜索按钮"}` 的固定短 JSON（不到 25 个 Token）。配合前面提到的 vLLM `--guided-decoding-backend xgrammar`，单步大模型决策耗时可以压到 **150ms ~ 250ms** 以内。
2. **双层 Fallback 策略（省算力又抗复杂页面）**：
在 `act()` 方法中设计三级降级：
* **Level 1（0 算力）**：跑本地 JSON 缓存里的 XPath（耗时 20ms）。
* **Level 2（纯文本蒸馏 + Qwen-9B）**：缓存失效时，跑 `use_vision=False` 的 DOM 蒸馏列表发给 Qwen-9B（耗时 200ms）。
* **Level 3（SoM 截图 + 视觉模型(云端更强的模型)）**：只有当 Level 2 报错或遇到 `<canvas>` 图表点击时，才开启 `use_vision=True` 截图发给多模态模型。这样既解决了纯 DOM 应付不了遮挡和动态结构的问题，又把算力消耗降到了极限。