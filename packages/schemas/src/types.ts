// 本文件由 scripts/gen-types.ts 生成，请勿手改；改动请改 schemas/*.json 后运行 npm run gen:types。

/**
 * act 方法的参数：一个动作（FR-12、FR-32，PRD 7.7）。命名对齐 chrome-devtools-mcp。除 new_page 外都必须带 pageId。
 */
export type Action = Common &
  (
    | Click
    | Hover
    | Fill
    | FillForm
    | TypeText
    | PressKey
    | Drag
    | UploadFile
    | HandleDialog
    | Scroll
    | ClickAt
    | MouseMove
    | NavigatePage
    | NewPage
    | SelectPage
    | ClosePage
    | TakeScreenshot
    | WaitFor
    | Assert
    | Extract
    | EvaluateScript
  );
/**
 * 检查项，用于前置/后置检查、断言、等待和条件。每项只含一种检查。
 */
export type Assertion = {
  [k: string]: unknown | undefined;
} & {
  text_present?: string;
  text_absent?: string;
  element_present?: Locator;
  element_absent?: Locator;
  /**
   * 正则。
   */
  url_matches?: string;
  /**
   * 正则。
   */
  title_matches?: string;
  /**
   * 页面签名 ID（FR-08）。
   */
  signature?: string;
  value_equals?: {
    target: Locator;
    value: string;
  };
  /**
   * 页面内求值为真值的 JS 表达式。
   */
  expr?: string;
  timeout_ms?: number;
};
/**
 * 持久定位器（FR-07）：属性/CSS 与 角色+名称 两类，可加 within 容器消歧、frame 路径。工作流中只允许用定位器，不允许用编号。
 */
export type Locator = {
  [k: string]: unknown | undefined;
} & {
  css?: string;
  role?: string;
  name?: string;
  /**
   * name 是否精确匹配，默认 true。
   */
  exact?: boolean;
  /**
   * 所在容器（业务主键所在行等）的 CSS 选择器。
   */
  within?: string;
  /**
   * 从顶层到目标 frame 的 iframe 选择器链。
   */
  frame?: string[];
};
/**
 * 动作目标：按编号（仅单次调用，会话内有效）或按定位器。
 */
export type Target = {
  [k: string]: unknown | undefined;
} & {
  /**
   * observe 分配的元素编号；会话内递增、不复用（FR-06）。
   */
  ref?: number;
  css?: string;
  role?: string;
  name?: string;
  exact?: boolean;
  within?: string;
  frame?: string[];
};
export type Modifiers = ('Alt' | 'Control' | 'Meta' | 'Shift')[];
/**
 * 视口像素坐标 [x, y]。
 *
 * @minItems 2
 * @maxItems 2
 */
export type Point = [unknown, unknown];
/**
 * 检查项的公共部分（不限制额外字段）。
 */
export type AssertionResult = {
  [k: string]: unknown | undefined;
} & {
  pass: boolean;
  detail?: string;
};
/**
 * 包围盒 [x, y, width, height]，视口像素。
 *
 * @minItems 4
 * @maxItems 4
 */
export type BBox = [unknown, unknown, unknown, unknown];
/**
 * 检查项的公共部分（不限制额外字段）。
 */
export type AssertionCore = {
  [k: string]: unknown | undefined;
} & {
  text_present?: string;
  text_absent?: string;
  element_present?: Locator;
  element_absent?: Locator;
  /**
   * 正则。
   */
  url_matches?: string;
  /**
   * 正则。
   */
  title_matches?: string;
  /**
   * 页面签名 ID（FR-08）。
   */
  signature?: string;
  value_equals?: {
    target: Locator;
    value: string;
  };
  /**
   * 页面内求值为真值的 JS 表达式。
   */
  expr?: string;
  timeout_ms?: number;
};
export type Empty = Record<string, never>;
export type Value =
  | (string | number | boolean | null)
  | Value[]
  | {
      [k: string]: Value | undefined;
    };
export type ParamsSetParams = {
  key: string;
  value: Value;
  scope: 'workflow' | 'site' | 'global';
  workflow?: string;
  site?: string;
};
/**
 * JSONL 工作流的一行（FR-16，PRD 7.4）：动作调用的格式 + 步骤字段，或控制流步骤。工作流里的目标只能是定位器，不能是编号。字符串值可含模板 {{param:..}}、{{var:..}}、{{file:..}}。
 */
export type Step = StepCommon &
  Common &
  (
    | (
        | Click
        | Hover
        | Fill
        | FillForm
        | TypeText
        | PressKey
        | Drag
        | UploadFile
        | HandleDialog
        | Scroll
        | ClickAt
        | MouseMove
        | NavigatePage
        | NewPage
        | SelectPage
        | ClosePage
        | TakeScreenshot
        | WaitFor
        | Assert
        | Extract
        | EvaluateScript
      )
    | LoopBeginStep
    | LoopEndStep
    | BreakStep
    | IfStep
    | ElseStep
    | EndIfStep
    | CallStep
    | SetVarStep
    | CheckpointStep
  );
export type IfStep = {
  [k: string]: unknown | undefined;
} & {
  op: 'if';
  /**
   * @minItems 1
   */
  checks?: [Assertion, ...Assertion[]];
  /**
   * 模板值，与 equals 比较。
   */
  value?: string;
  equals?: string | number | boolean | null;
};
export type RpcRequest = (
  | CallObserve
  | CallAct
  | CallActBatch
  | CallResolveLocator
  | CallListNetworkRequests
  | CallGetNetworkRequest
  | CallAskHuman
  | CallHumanReply
  | CallFilesList
  | CallFilesRead
  | CallFilesWrite
  | CallRun
  | CallPause
  | CallResume
  | CallStop
  | CallStatus
  | CallSwitchMode
  | CallParamsGet
  | CallParamsSet
  | CallTaskLoad
  | CallTaskEvaluate
) & {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: unknown;
};
export type RpcNotification = (
  | {
      method?: 'step';
      params?: StepEvent;
    }
  | {
      method?: 'need_human';
      params?: NeedHumanEvent;
    }
  | {
      method?: 'ask_save';
      params?: AskSaveEvent;
    }
  | {
      method?: 'unverified';
      params?: UnverifiedEvent;
    }
  | {
      method?: 'run_done';
      params?: RunDoneEvent;
    }
) & {
  jsonrpc: '2.0';
  method: string;
  params: unknown;
};
export type RpcResponse = {
  [k: string]: unknown | undefined;
} & {
  jsonrpc: '2.0';
  id: (string | number) | null;
  result?: unknown;
  error?: RpcError;
};
export type RuleAction = Common &
  (
    | Click
    | Hover
    | Fill
    | FillForm
    | TypeText
    | PressKey
    | Drag
    | UploadFile
    | HandleDialog
    | Scroll
    | ClickAt
    | MouseMove
    | NavigatePage
    | NewPage
    | SelectPage
    | ClosePage
    | TakeScreenshot
    | WaitFor
    | Assert
    | Extract
    | EvaluateScript
  ) & {
    target?: Locator;
  };
/**
 * 弹窗规则文件（FR-23）：只在定位失败或被遮挡时检查，命中则执行处理动作后重试当前步骤。可放在工作流目录或工作区全局。
 */
export type PopupRules = PopupRule[];
export type PageSignature = {
  [k: string]: unknown | undefined;
} & {
  id: string;
  /**
   * login / captcha 用于登录检测与人机验证检测。
   */
  kind?: 'page' | 'login' | 'captcha';
  /**
   * URL 正则。
   */
  url?: string;
  /**
   * 标题正则。
   */
  title?: string;
  must_exist?: Locator[];
  must_not_exist?: Locator[];
};
/**
 * workflows/<名称>/signatures.json：页面签名列表（FR-08）。
 */
export type Signatures = PageSignature[];

export interface ObactContracts {
  ActBatch_Params?: ActBatchParams;
  ActBatch_Result?: ActBatchResult;
  ActResult?: ActResult;
  Action?: Action;
  Action_Common?: Common;
  Action_Op?:
    | Click
    | Hover
    | Fill
    | FillForm
    | TypeText
    | PressKey
    | Drag
    | UploadFile
    | HandleDialog
    | Scroll
    | ClickAt
    | MouseMove
    | NavigatePage
    | NewPage
    | SelectPage
    | ClosePage
    | TakeScreenshot
    | WaitFor
    | Assert
    | Extract
    | EvaluateScript;
  Action_MouseButton?: 'left' | 'right' | 'middle';
  Action_Modifiers?: Modifiers;
  Action_Click?: Click;
  Action_Hover?: Hover;
  /**
   * 文本框填文本；下拉框填选项文本或值；复选框填布尔。可含模板 {{param:..}} / {{var:..}}。
   */
  Action_FillValue?: string | number | boolean;
  Action_Fill?: Fill;
  Action_FillForm?: FillForm;
  Action_TypeText?: TypeText;
  Action_PressKey?: PressKey;
  Action_DragEnd?: Target | Point;
  Action_Drag?: Drag;
  Action_UploadFile?: UploadFile;
  Action_HandleDialog?: HandleDialog;
  Action_Scroll?: Scroll;
  Action_ClickAt?: ClickAt;
  Action_MouseMove?: MouseMove;
  Action_NavigatePage?: NavigatePage;
  Action_NewPage?: NewPage;
  Action_SelectPage?: SelectPage;
  Action_ClosePage?: ClosePage;
  Action_TakeScreenshot?: TakeScreenshot;
  Action_WaitFor?: WaitFor;
  Action_Assert?: Assert;
  Action_DomSource?: DomSource;
  Action_ResponseSource?: ResponseSource;
  Action_Extract?: Extract;
  Action_EvaluateScript?: EvaluateScript;
  Checkpoint?: Checkpoint;
  Checkpoint_RunId?: string;
  /**
   * SUSPENDED：为切换有头/无头挂起；TRIPPED：熔断（FR-19）。
   */
  Checkpoint_RunState?:
    | 'RUNNING'
    | 'PAUSED'
    | 'NEED_HUMAN'
    | 'SUSPENDED'
    | 'STOPPED'
    | 'FAILED'
    | 'TRIPPED'
    | 'DONE';
  /**
   * 工具内标签页 ID（FR-04）。
   */
  Common_PageId?: string;
  /**
   * observe 分配的元素编号；会话内递增、不复用（FR-06）。
   */
  Common_Ref?: number;
  Common_Point?: Point;
  Common_BBox?: BBox;
  Common_Mode?: 'headed' | 'headless';
  Common_Timestamp?: string;
  Common_Locator?: Locator;
  Common_Target?: Target;
  Common_AssertionCore?: AssertionCore;
  Common_Assertion?: Assertion;
  Common_AssertionResult?: AssertionResult;
  /**
   * 失败原因代码。
   */
  Common_ErrorCode?:
    | 'invalid_params'
    | 'page_not_found'
    | 'stale_ref'
    | 'not_found'
    | 'not_unique'
    | 'not_actionable'
    | 'obscured'
    | 'landing_mismatch'
    | 'timeout'
    | 'navigation_failed'
    | 'assertion_failed'
    | 'dialog_blocking'
    | 'response_timeout'
    | 'captcha_detected'
    | 'login_required'
    | 'path_outside_workspace'
    | 'script_error'
    | 'browser_disconnected'
    | 'internal';
  Common_Error?: ObactError;
  Common_Viewport?: Viewport;
  Events_Step?: StepEvent;
  Events_NeedHuman?: NeedHumanEvent;
  Events_AskSave?: AskSaveEvent;
  Events_Unverified?: UnverifiedEvent;
  Events_RunDone?: RunDoneEvent;
  Events_RunStats?: RunStats;
  Methods_RunRef?: RunRef;
  Methods_RunStateResult?: RunStateResult;
  Methods_Empty?: Empty;
  Methods_ResolveLocatorParams?: ResolveLocatorParams;
  Methods_ResolveLocatorResult?: ResolveLocatorResult;
  Methods_NetworkEntry?: NetworkEntry;
  Methods_ListNetworkRequestsParams?: ListNetworkRequestsParams;
  Methods_ListNetworkRequestsResult?: ListNetworkRequestsResult;
  Methods_GetNetworkRequestParams?: GetNetworkRequestParams;
  Methods_GetNetworkRequestResult?: GetNetworkRequestResult;
  Methods_AskHumanParams?: AskHumanParams;
  Methods_AskHumanResult?: AskHumanResult;
  Methods_HumanReplyParams?: HumanReplyParams;
  Methods_FileEntry?: FileEntry;
  /**
   * 相对 workspace/files 的路径；越出工作区报 path_outside_workspace（FR-35）。
   */
  Methods_WorkspacePath?: string;
  Methods_Encoding?: 'utf8' | 'base64';
  Methods_FilesListParams?: FilesListParams;
  Methods_FilesListResult?: FilesListResult;
  Methods_FilesReadParams?: FilesReadParams;
  Methods_FilesReadResult?: FilesReadResult;
  Methods_FilesWriteParams?: FilesWriteParams;
  Methods_FilesWriteResult?: FilesWriteResult;
  Methods_RunParams?: RunParams;
  Methods_StatusResult?: StatusResult;
  Methods_SwitchModeParams?: SwitchModeParams;
  Methods_SwitchModeResult?: SwitchModeResult;
  Methods_ParamScope?: 'workflow' | 'site' | 'global';
  Methods_ParamsGetParams?: ParamsGetParams;
  Methods_ParamsGetResult?: ParamsGetResult;
  Methods_ParamsSetParams?: ParamsSetParams;
  Methods_TaskLoadParams?: TaskLoadParams;
  Methods_TaskLoadResult?: TaskLoadResult;
  Methods_TaskEvaluateParams?: TaskEvaluateParams;
  Methods_TaskEvaluateResult?: TaskEvaluateResult;
  Observe_View?: 'text' | 'screenshot' | 'som' | 'axtree';
  Observe_Params?: ObserveParams;
  Observe_ElementStates?: ElementStates;
  Observe_Element?: ObservedElement;
  Observe_Result?: ObserveResult;
  Params?: ParamsFile;
  Params_Scope?: Scope;
  Params_Value?: Value;
  Rpc_Id?: string | number;
  Rpc_Request?: RpcRequest;
  Rpc_Notification?: RpcNotification;
  Rpc_Response?: RpcResponse;
  Rpc_RpcError?: RpcError;
  Rules?: PopupRules;
  Rules_Rule?: PopupRule;
  Rules_RuleAction?: RuleAction;
  SideEffect?: SideEffectRecord;
  Signatures?: Signatures;
  Signatures_Signature?: PageSignature;
  Step?: Step;
  Step_StepCommon?: StepCommon;
  Step_LoopBegin?: LoopBeginStep;
  Step_LoopEnd?: LoopEndStep;
  Step_Break?: BreakStep;
  Step_If?: IfStep;
  Step_Else?: ElseStep;
  Step_EndIf?: EndIfStep;
  Step_Call?: CallStep;
  Step_SetVar?: SetVarStep;
  Step_Checkpoint?: CheckpointStep;
  Task?: Task;
  Task_ScoringItem?: ScoringItem;
  Trajectory?: TrajectoryRecord;
  Unverified?: UnverifiedRecord;
  Workflow?: WorkflowMeta;
}
/**
 * observe：结束后要返回的观察，省略则不观察。
 */
export interface ActBatchParams {
  /**
   * @minItems 1
   */
  actions: [Action, ...Action[]];
  observe?: ObserveParams;
}
export interface Common {
  op: string;
  /**
   * 工具内标签页 ID（FR-04）。
   */
  pageId?: string;
  timeout_ms?: number;
  /**
   * 后置检查；通过即继续（FR-14）。
   */
  post?: Assertion[];
  /**
   * 是否返回页面变化差异，默认 false（FR-15）。
   */
  diff?: boolean;
  /**
   * 动作后截图。
   */
  screenshot?: boolean;
}
export interface Click {
  op: 'click';
  target: Target;
  button?: 'left' | 'right' | 'middle';
  double?: boolean;
  modifiers?: Modifiers;
}
export interface Hover {
  op: 'hover';
  target: Target;
}
export interface Fill {
  op: 'fill';
  target: Target;
  /**
   * 文本框填文本；下拉框填选项文本或值；复选框填布尔。可含模板 {{param:..}} / {{var:..}}。
   */
  value: string | number | boolean;
}
export interface FillForm {
  op: 'fill_form';
  /**
   * @minItems 1
   */
  elements: [
    {
      target: Target;
      /**
       * 文本框填文本；下拉框填选项文本或值；复选框填布尔。可含模板 {{param:..}} / {{var:..}}。
       */
      value: string | number | boolean;
    },
    ...{
      target: Target;
      /**
       * 文本框填文本；下拉框填选项文本或值；复选框填布尔。可含模板 {{param:..}} / {{var:..}}。
       */
      value: string | number | boolean;
    }[],
  ];
}
/**
 * 在当前焦点（或先聚焦 target）逐字键入。
 */
export interface TypeText {
  op: 'type_text';
  text: string;
  target?: Target;
}
export interface PressKey {
  op: 'press_key';
  /**
   * 如 Enter、Control+A。
   */
  key: string;
}
/**
 * 按元素或按坐标拖拽（FR-32）。
 */
export interface Drag {
  op: 'drag';
  from: Target | Point;
  to: Target | Point;
}
export interface UploadFile {
  op: 'upload_file';
  target: Target;
  /**
   * 工作区内的相对路径。
   *
   * @minItems 1
   */
  files: [string, ...string[]];
}
export interface HandleDialog {
  op: 'handle_dialog';
  action: 'accept' | 'dismiss';
  prompt_text?: string;
}
/**
 * 滚动：给 target 则在该元素上滚动；给 at 则在该坐标处滚动；都不给则滚动页面。
 */
export interface Scroll {
  op: 'scroll';
  target?: Target;
  at?: Point;
  dx?: number;
  dy?: number;
}
export interface ClickAt {
  op: 'click_at';
  x: number;
  y: number;
  button?: 'left' | 'right' | 'middle';
  double?: boolean;
  modifiers?: Modifiers;
}
export interface MouseMove {
  op: 'mouse_move';
  x: number;
  y: number;
}
export interface NavigatePage {
  op: 'navigate_page';
  type?: 'url' | 'back' | 'forward' | 'reload';
  url?: string;
}
/**
 * 新建标签页；pageId 为期望使用的 ID，省略时由工具分配并在 effects.new_pages 返回。
 */
export interface NewPage {
  op: 'new_page';
  url?: string;
}
export interface SelectPage {
  op: 'select_page';
}
export interface ClosePage {
  op: 'close_page';
}
export interface TakeScreenshot {
  op: 'take_screenshot';
  target?: Target;
  full_page?: boolean;
  /**
   * 工作区内保存路径；省略时自动命名。
   */
  path?: string;
}
export interface WaitFor {
  op: 'wait_for';
  /**
   * 全部满足即结束。
   *
   * @minItems 1
   */
  until: [Assertion, ...Assertion[]];
}
export interface Assert {
  op: 'assert';
  /**
   * @minItems 1
   */
  checks: [Assertion, ...Assertion[]];
}
export interface Extract {
  op: 'extract';
  source: DomSource | ResponseSource;
  /**
   * 主键字段，用于去重。
   */
  key?: string;
  wait_ms?: number;
  /**
   * 写入的采集输出名。
   */
  into?: string;
  /**
   * 同时存入的运行变量名。
   */
  as?: string;
}
/**
 * 页面抽取（FR-09）。
 */
export interface DomSource {
  type: 'dom';
  kind: 'table' | 'list' | 'kv';
  root: Locator;
  /**
   * 列表项的 CSS 选择器（相对 root）。
   */
  item?: string;
  /**
   * 字段名 → 相对选择器；可用 "sel@attr" 取属性。
   */
  fields?: {
    [k: string]: string | undefined;
  };
  pagination?: {
    next: Locator;
    max_pages?: number;
  };
  scroll?: {
    container?: Locator;
    max_rounds?: number;
    /**
     * 连续多少轮没有新数据就结束。
     */
    idle_rounds?: number;
  };
}
/**
 * 接口截获（FR-10，PRD 5.6）：读取上一个动作开始之后到达、URL 匹配的最近一条 JSON 响应。
 */
export interface ResponseSource {
  type: 'response';
  /**
   * URL 正则。
   */
  url: string;
  method?: string;
  /**
   * 字段路径，如 data.list。
   */
  path: string;
}
export interface EvaluateScript {
  op: 'evaluate_script';
  /**
   * JS 函数源码，如 "() => document.title"。
   */
  function: string;
  args?: unknown[];
  /**
   * 结果存入的运行变量名（工作流中）。
   */
  as?: string;
}
export interface ObserveParams {
  /**
   * 工具内标签页 ID（FR-04）。
   */
  pageId: string;
  /**
   * 默认 ["text"]。
   */
  views?: ('text' | 'screenshot' | 'som' | 'axtree')[];
  /**
   * 文本快照与摘要的字符预算，默认 40000。
   */
  max_chars?: number;
}
export interface ActBatchResult {
  results: ActResult[];
  /**
   * 失败停止的动作下标；全部成功为 null。
   */
  stopped_at: number | null;
  observation?: ObserveResult;
}
/**
 * act 方法的返回（FR-15，PRD 7.3）。
 */
export interface ActResult {
  status: 'ok' | 'error';
  error?: ObactError;
  /**
   * 实际命中目标所用的方式；无目标的动作为 null。
   */
  locator_used?: 'ref' | 'css' | 'role' | 'coord' | null;
  duration_ms: number;
  screenshot_path?: string | null;
  effects: {
    navigated: boolean;
    /**
     * Items: 工具内标签页 ID（FR-04）。
     */
    new_pages: string[];
    dialogs: {
      type: 'alert' | 'confirm' | 'prompt' | 'beforeunload';
      message: string;
      handled?: 'accept' | 'dismiss' | 'pending';
    }[];
    changed: boolean;
  };
  assertions?: AssertionResult[];
  /**
   * 页面变化差异（仅在请求时返回）。
   */
  diff?: string | null;
  /**
   * extract、evaluate_script 等动作的返回数据。
   */
  data?: {
    [k: string]: unknown | undefined;
  };
  /**
   * 本动作的序号，接口缓存按它判定响应先后（PRD 5.6）。
   */
  action_seq?: number;
}
export interface ObactError {
  /**
   * 失败原因代码。
   */
  code:
    | 'invalid_params'
    | 'page_not_found'
    | 'stale_ref'
    | 'not_found'
    | 'not_unique'
    | 'not_actionable'
    | 'obscured'
    | 'landing_mismatch'
    | 'timeout'
    | 'navigation_failed'
    | 'assertion_failed'
    | 'dialog_blocking'
    | 'response_timeout'
    | 'captcha_detected'
    | 'login_required'
    | 'path_outside_workspace'
    | 'script_error'
    | 'browser_disconnected'
    | 'internal';
  message: string;
  details?: {
    [k: string]: unknown | undefined;
  };
}
export interface ObserveResult {
  /**
   * 工具内标签页 ID（FR-04）。
   */
  pageId: string;
  url: string;
  title: string;
  /**
   * 命中的页面签名 ID，未命中为 null（FR-08）。
   */
  signature: string | null;
  canvas_warning: boolean;
  /**
   * 编号元素表（view=text）。
   */
  snapshot_text?: string;
  elements: ObservedElement[];
  /**
   * 页面文本摘要。
   */
  text_md: string;
  truncated: boolean;
  viewport: Viewport;
  screenshot_path?: string;
  /**
   * 编号框截图路径（view=som）。
   */
  som_path?: string;
  /**
   * 可访问性树文本（view=axtree），编号与 elements 一致。
   */
  axtree?: string;
}
export interface ObservedElement {
  /**
   * observe 分配的元素编号；会话内递增、不复用（FR-06）。
   */
  ref: number;
  role: string;
  name: string;
  value?: string;
  states?: ElementStates;
  bbox: BBox;
  visible_ratio: number;
  clickable: boolean;
  /**
   * 所在行或容器（业务主键）的 CSS 选择器。
   */
  within?: string;
  /**
   * 所在 frame 的 iframe 选择器链；顶层文档省略。
   */
  frame?: string[];
}
export interface ElementStates {
  disabled?: boolean;
  /**
   * true / false / "mixed"
   */
  checked?: boolean | string;
  selected?: boolean;
  expanded?: boolean;
  focused?: boolean;
  required?: boolean;
  readonly?: boolean;
  editable?: boolean;
}
export interface Viewport {
  width: number;
  height: number;
  /**
   * 截图像素 / 视口像素 的比例（FR-31）。
   */
  scale: number;
}
/**
 * runs/<run_id>/checkpoint.json：续跑用的进度文件，原子写入（FR-17，PRD 7.5）。
 */
export interface Checkpoint {
  run_id: string;
  workflow: string;
  mode: 'headed' | 'headless';
  /**
   * SUSPENDED：为切换有头/无头挂起；TRIPPED：熔断（FR-19）。
   */
  state:
    | 'RUNNING'
    | 'PAUSED'
    | 'NEED_HUMAN'
    | 'SUSPENDED'
    | 'STOPPED'
    | 'FAILED'
    | 'TRIPPED'
    | 'DONE';
  /**
   * 下一步要执行（或正在执行）的步骤。
   */
  step_id: string;
  /**
   * loop_begin 的 step_id → 当前条目下标。
   */
  loop_index?: {
    [k: string]: number | undefined;
  };
  /**
   * 运行变量（敏感参数不写入）。
   */
  vars?: {
    [k: string]: unknown | undefined;
  };
  /**
   * 采集与处理进度游标。
   */
  cursor?: {
    [k: string]: unknown | undefined;
  };
  /**
   * 检查点写入序号，单调递增。
   */
  seq?: number;
  updated_at?: string;
}
export interface StepEvent {
  run_id: string;
  step_id: string;
  status: 'start' | 'ok' | 'error' | 'skipped' | 'unverified';
  loop_index?: {
    [k: string]: number | undefined;
  };
  duration_ms?: number;
  error?: ObactError;
}
/**
 * 需要人工接管或回答问题（FR-20、FR-34 共用通道）。
 */
export interface NeedHumanEvent {
  /**
   * 回答或确认时引用。
   */
  request_id: string;
  run_id?: string;
  reason:
    | 'captcha'
    | 'login_missing_param'
    | 'locator_failed'
    | 'manual_pause'
    | 'question'
    | 'infeasible';
  step_id?: string;
  /**
   * 工具内标签页 ID（FR-04）。
   */
  pageId?: string;
  message: string;
  options?: string[];
  screenshot?: string;
  priority?: 'normal' | 'high';
}
/**
 * 接管结束确认：写回性质三选一 + 要存进参数库的输入（FR-21）。
 */
export interface AskSaveEvent {
  request_id: string;
  run_id: string;
  step_id?: string;
  writeback_options: ('once' | 'popup_rule' | 'workflow_step')[];
  params?: {
    key: string;
    /**
     * 敏感参数显示为 ***。
     */
    preview?: string;
    suggested_scope?: 'workflow' | 'site' | 'global';
  }[];
}
/**
 * runs/<run_id>/unverified.jsonl 的一行：单次提交已发出但结果未确认，绝不自动重试（FR-18，PRD 7.5）。
 */
export interface UnverifiedEvent {
  run_id: string;
  step_id: string;
  idempotency_key: string;
  time: string;
  reason: 'post_timeout' | 'post_failed' | 'crash' | 'stuck' | 'navigation_lost' | 'browser_lost';
  screenshot?: string | null;
  /**
   * 人工核实结果；未核实时省略。
   */
  resolution?: {
    outcome: 'done' | 'not_done';
    time: string;
    note?: string;
  };
}
export interface RunDoneEvent {
  run_id: string;
  state: 'DONE' | 'STOPPED' | 'FAILED' | 'TRIPPED';
  stats: RunStats;
  report_path?: string;
}
export interface RunStats {
  steps: number;
  ok: number;
  failed: number;
  human: number;
  resumes: number;
  unverified: number;
}
export interface RunRef {
  run_id: string;
}
export interface RunStateResult {
  run_id: string;
  /**
   * SUSPENDED：为切换有头/无头挂起；TRIPPED：熔断（FR-19）。
   */
  state:
    | 'RUNNING'
    | 'PAUSED'
    | 'NEED_HUMAN'
    | 'SUSPENDED'
    | 'STOPPED'
    | 'FAILED'
    | 'TRIPPED'
    | 'DONE';
}
export interface ResolveLocatorParams {
  /**
   * 工具内标签页 ID（FR-04）。
   */
  pageId: string;
  /**
   * observe 分配的元素编号；会话内递增、不复用（FR-06）。
   */
  ref: number;
}
/**
 * 两类定位器均实测唯一（FR-07）；某一类无法唯一时省略该类字段。
 */
export interface ResolveLocatorResult {
  locator: Locator;
  unique: boolean;
}
export interface NetworkEntry {
  id: string;
  url: string;
  method: string;
  status: number;
  mime?: string;
  /**
   * 响应到达时的动作序号。
   */
  action_seq: number;
  time: string;
  size?: number;
  truncated?: boolean;
}
export interface ListNetworkRequestsParams {
  /**
   * 工具内标签页 ID（FR-04）。
   */
  pageId: string;
  /**
   * URL 正则过滤。
   */
  url?: string;
  since_action?: number;
}
export interface ListNetworkRequestsResult {
  requests: NetworkEntry[];
}
export interface GetNetworkRequestParams {
  /**
   * 工具内标签页 ID（FR-04）。
   */
  pageId: string;
  id: string;
}
export interface GetNetworkRequestResult {
  entry: NetworkEntry;
  /**
   * 解析后的 JSON 响应体。
   */
  body: {
    [k: string]: unknown | undefined;
  };
}
export interface AskHumanParams {
  /**
   * infeasible：报告任务无法完成（FR-34）。
   */
  kind?: 'question' | 'infeasible';
  message: string;
  options?: string[];
  run_id?: string;
  timeout_ms?: number;
}
export interface AskHumanResult {
  /**
   * 超时或取消为 null。
   */
  answer: string | null;
  option_index?: number;
}
/**
 * 界面（侧边栏、终端）回答 need_human / ask_save（FR-21、FR-34）。PRD 7.1 未列，为接管闭环补充。
 */
export interface HumanReplyParams {
  request_id: string;
  answer?: string;
  option_index?: number;
  action?: 'continue' | 'stop';
  writeback?: 'once' | 'popup_rule' | 'workflow_step';
  save_params?: {
    key: string;
    scope: 'workflow' | 'site' | 'global';
  }[];
}
export interface FileEntry {
  path: string;
  dir: boolean;
  size?: number;
  mtime?: string;
}
export interface FilesListParams {
  /**
   * 相对 workspace/files 的路径；越出工作区报 path_outside_workspace（FR-35）。
   */
  path?: string;
}
export interface FilesListResult {
  files: FileEntry[];
}
export interface FilesReadParams {
  /**
   * 相对 workspace/files 的路径；越出工作区报 path_outside_workspace（FR-35）。
   */
  path: string;
  encoding?: 'utf8' | 'base64';
}
export interface FilesReadResult {
  content: string;
  encoding: 'utf8' | 'base64';
  size: number;
}
export interface FilesWriteParams {
  /**
   * 相对 workspace/files 的路径；越出工作区报 path_outside_workspace（FR-35）。
   */
  path: string;
  content: string;
  encoding?: 'utf8' | 'base64';
  append?: boolean;
}
export interface FilesWriteResult {
  path: string;
  size: number;
}
/**
 * resume：从该运行的检查点续跑。
 */
export interface RunParams {
  workflow: string;
  mode?: 'headed' | 'headless';
  resume?: string;
  /**
   * 初始运行变量。
   */
  vars?: {
    [k: string]: unknown | undefined;
  };
}
export interface StatusResult {
  run_id: string;
  /**
   * SUSPENDED：为切换有头/无头挂起；TRIPPED：熔断（FR-19）。
   */
  state:
    | 'RUNNING'
    | 'PAUSED'
    | 'NEED_HUMAN'
    | 'SUSPENDED'
    | 'STOPPED'
    | 'FAILED'
    | 'TRIPPED'
    | 'DONE';
  step_id?: string;
  loop_index?: {
    [k: string]: number | undefined;
  };
  stats?: RunStats;
  unverified?: number;
}
/**
 * 在检查点边界切换有头/无头（PRD 5.5）。
 */
export interface SwitchModeParams {
  account: string;
  mode: 'headed' | 'headless';
}
export interface SwitchModeResult {
  mode: 'headed' | 'headless';
  suspended_runs: string[];
}
export interface ParamsGetParams {
  key: string;
  workflow?: string;
  site?: string;
}
/**
 * 敏感参数的 value 返回 ***。
 */
export interface ParamsGetResult {
  found: boolean;
  scope: ('workflow' | 'site' | 'global') | null;
  value?: Value;
}
export interface TaskLoadParams {
  /**
   * 任务 ID 或任务文件路径。
   */
  task: string;
}
export interface TaskLoadResult {
  task: Task;
  /**
   * 本次运行在测试应用中的独立数据空间。
   */
  run_space: string;
}
/**
 * 任务集的一个任务（FR-36，PRD 5.8）：初始化 + 指令 + 带权重的评分点（参考 OSWorld 2.0）。评分点（scoring）与续跑用的检查点不是一回事。
 */
export interface Task {
  id: string;
  title?: string;
  instruction: string;
  /**
   * 考察的挑战类型，如 多条目跟踪、视觉精确。
   */
  challenge?: string[];
  lab?: {
    modules?: string[];
    seed?: number;
    /**
     * 开启的故障注入开关。
     */
    faults?: string[];
  };
  /**
   * 初始化步骤。
   */
  setup?: Step[];
  max_steps?: number;
  /**
   * @minItems 1
   */
  scoring: [ScoringItem, ...ScoringItem[]];
}
export interface StepCommon {
  step_id: string;
  /**
   * preamble 为前置可达路径，续跑时重放；默认 main。
   */
  section?: 'preamble' | 'main';
  pre?: Assertion[];
  retry?: {
    max: number;
    delay_ms?: number;
  };
  /**
   * 失败策略；定位失败默认先查弹窗规则再转人工（FR-20）。
   */
  on_fail?: 'stop' | 'skip' | 'human';
  /**
   * 单次提交步骤，永不自动重试（FR-18）。
   */
  once_only?: boolean;
  idempotency_key?: string;
  /**
   * 无法换算为定位器的坐标步骤，标记为易失效（FR-32）。
   */
  volatile?: boolean;
  note?: string;
  target?: Locator;
  from?: Locator | Point;
  to?: Locator | Point;
  elements?: {
    target?: Locator;
  }[];
}
export interface LoopBeginStep {
  op: 'loop_begin';
  /**
   * 数据源：模板（如 {{file:inputs/orders.csv}}、{{var:list}}）或字面数组。
   */
  over: string | unknown[];
  as: string;
  /**
   * 条目主键模板，用于游标与去重。
   */
  key?: string;
  /**
   * 默认 stop（PRD 5.3）。
   */
  on_unverified?: 'stop' | 'skip';
  /**
   * 循环锚点：跳过模式下重置页面后需要满足的状态。
   */
  anchor?: Assertion[];
}
export interface LoopEndStep {
  op: 'loop_end';
}
export interface BreakStep {
  op: 'break';
}
export interface ElseStep {
  op: 'else';
}
export interface EndIfStep {
  op: 'end_if';
}
export interface CallStep {
  op: 'call';
  workflow: string;
  args?: {
    [k: string]: unknown | undefined;
  };
}
export interface SetVarStep {
  op: 'set_var';
  name: string;
  value: unknown;
}
/**
 * 在关键节点额外写一次检查点（FR-17）。
 */
export interface CheckpointStep {
  op: 'checkpoint';
}
export interface ScoringItem {
  id: string;
  desc?: string;
  weight: number;
  check:
    | {
        type: 'lab_state';
        query: string;
        path?: string;
        expect: unknown;
      }
    | {
        type: 'assert';
        /**
         * 工具内标签页 ID（FR-04）。
         */
        pageId?: string;
        /**
         * @minItems 1
         */
        checks: [Assertion, ...Assertion[]];
      }
    | {
        type: 'file';
        path: string;
        expect_rows?: number;
        expect_contains?: string[];
      };
}
export interface TaskEvaluateParams {
  task_id: string;
  run_space: string;
}
export interface TaskEvaluateResult {
  /**
   * 按权重的部分得分。
   */
  score: number;
  /**
   * 评分点全部通过。
   */
  complete: boolean;
  items: {
    id: string;
    weight: number;
    pass: boolean;
    detail?: string;
  }[];
}
/**
 * workspace/params.yaml 的结构（FR-22）：按 工作流 → 网站 → 全局 三级查找。名称含 password、token、secret 的参数在日志、留痕和返回结果中显示为 ***。
 */
export interface ParamsFile {
  global?: Scope;
  sites?: {
    [k: string]: Scope | undefined;
  };
  workflows?: {
    [k: string]: Scope | undefined;
  };
}
export interface Scope {
  [k: string]: Value | undefined;
}
export interface CallObserve {
  method: 'observe';
  params: ObserveParams;
}
export interface CallAct {
  method: 'act';
  params: Action;
}
export interface CallActBatch {
  method: 'act_batch';
  params: ActBatchParams;
}
export interface CallResolveLocator {
  method: 'resolve_locator';
  params: ResolveLocatorParams;
}
export interface CallListNetworkRequests {
  method: 'list_network_requests';
  params: ListNetworkRequestsParams;
}
export interface CallGetNetworkRequest {
  method: 'get_network_request';
  params: GetNetworkRequestParams;
}
export interface CallAskHuman {
  method: 'ask_human';
  params: AskHumanParams;
}
export interface CallHumanReply {
  method: 'human.reply';
  params: HumanReplyParams;
}
export interface CallFilesList {
  method: 'files.list';
  params?: FilesListParams;
}
export interface CallFilesRead {
  method: 'files.read';
  params: FilesReadParams;
}
export interface CallFilesWrite {
  method: 'files.write';
  params: FilesWriteParams;
}
export interface CallRun {
  method: 'run';
  params: RunParams;
}
export interface CallPause {
  method: 'pause';
  params: RunRef;
}
export interface CallResume {
  method: 'resume';
  params: RunRef;
}
export interface CallStop {
  method: 'stop';
  params: RunRef;
}
export interface CallStatus {
  method: 'status';
  params: RunRef;
}
export interface CallSwitchMode {
  method: 'switch_mode';
  params: SwitchModeParams;
}
export interface CallParamsGet {
  method: 'params.get';
  params: ParamsGetParams;
}
export interface CallParamsSet {
  method: 'params.set';
  params: ParamsSetParams;
}
export interface CallTaskLoad {
  method: 'task.load';
  params: TaskLoadParams;
}
export interface CallTaskEvaluate {
  method: 'task.evaluate';
  params: TaskEvaluateParams;
}
export interface RpcError {
  /**
   * JSON-RPC 错误码；工具层错误统一用 -32000，详情在 data。
   */
  code: number;
  message: string;
  data?: ObactError;
}
/**
 * match 为弹窗本体的定位器。
 */
export interface PopupRule {
  id: string;
  match: Locator;
  /**
   * 限定生效的 URL 正则。
   */
  url?: string;
  /**
   * 处理动作，作用于当前标签页。
   *
   * @minItems 1
   */
  actions: [RuleAction, ...RuleAction[]];
  /**
   * 来源运行编号与步骤（写回时记录）。
   */
  created_from?: string;
}
/**
 * runs/<run_id>/side_effects.jsonl 的一行：已确认成功的单次提交；续跑时按幂等键跳过（FR-18）。
 */
export interface SideEffectRecord {
  run_id: string;
  step_id: string;
  idempotency_key: string;
  time: string;
  /**
   * 确认成功所依据的后置检查。
   */
  evidence?: AssertionResult[];
}
/**
 * runs/<run_id>/trajectory.jsonl 的一行：一步的“观察—动作—结果”（FR-26）。敏感参数已脱敏为 ***。
 */
export interface TrajectoryRecord {
  run_id: string;
  seq: number;
  time: string;
  step_id?: string;
  loop_index?: {
    [k: string]: number | undefined;
  };
  observation?: {
    url?: string;
    signature?: string | null;
    snapshot_path?: string;
    screenshot_path?: string;
  };
  action: Action;
  result: ActResult;
  /**
   * 动作来源：工作流回放、人工接管、外部调用（以后的模型）。
   */
  source: 'workflow' | 'human' | 'client';
}
/**
 * runs/<run_id>/unverified.jsonl 的一行：单次提交已发出但结果未确认，绝不自动重试（FR-18，PRD 7.5）。
 */
export interface UnverifiedRecord {
  run_id: string;
  step_id: string;
  idempotency_key: string;
  time: string;
  reason: 'post_timeout' | 'post_failed' | 'crash' | 'stuck' | 'navigation_lost' | 'browser_lost';
  screenshot?: string | null;
  /**
   * 人工核实结果；未核实时省略。
   */
  resolution?: {
    outcome: 'done' | 'not_done';
    time: string;
    note?: string;
  };
}
/**
 * workflows/<名称>/workflow.json：工作流的元信息；步骤在同目录 steps.jsonl（PRD 7.6）。
 */
export interface WorkflowMeta {
  name: string;
  description?: string;
  /**
   * 参数库按站点查找时使用的站点名。
   */
  site?: string;
  /**
   * 使用的账号（决定浏览器配置目录）。
   */
  account?: string;
  mode?: 'headed' | 'headless';
  /**
   * demo 时显示虚拟光标（FR-30）。
   */
  speed?: 'fast' | 'demo';
  /**
   * 只读任务可同账号并行；写操作任务同站点同账号排队（FR-03）。
   */
  access?: 'read' | 'write';
  on_unverified?: 'stop' | 'skip';
  /**
   * 采集输出名 → 主键与导出格式（FR-25）。
   */
  outputs?: {
    [k: string]:
      | {
          key?: string;
          export?: ('csv' | 'xlsx')[];
        }
      | undefined;
  };
  /**
   * 运行时要缓存的接口 URL 正则（PRD 5.6）。
   */
  intercept?: string[];
  /**
   * cron 表达式（FR-28）。
   */
  schedule?: string;
  /**
   * 研究采集模式，默认 false（FR-26）。
   */
  research_capture?: boolean;
}
