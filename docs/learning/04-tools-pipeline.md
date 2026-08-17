---
title: 工具子系统：注册、执行流水线、schema 组装
description: DSH 本地 docs 精读学习笔记（来源 docs/04-*）——工具子系统：注册、执行流水线、schema 组装
tags: [tools, pipeline, schema]
date: 2026-08-17
status: learning-note
---
# DSH 工具子系统学习笔记：注册、执行流水线、schema 组装与 catalog 生成

> 学习来源（英文版）：`docs/subsystems/tools.md`、`docs/tool-execution-pipeline.md`、`docs/tool-catalog.md`
> 核心源码：`packages/core/tools/src/index.ts`、`src/schema.ts`、`src/presentation.ts`
> 本文只记录文档实际内容，未明说处标注「(文档未明说)」。

## 1. 核心概念与机制

### 1.1 工具注册：`ToolDefinition` 与 `ctx.tools` 作用域注册表

工具管线的核心类型是 `ToolDefinition`（文档称它是"pipeline-authoring type"），由三类信息组成：
- 模型可见的 `ToolSchema` 字段（name/description/parameters，wire 类型与模型请求一起在 llm-streaming.md 声明）；
- **强制**的规范输出声明 `output: ToolOutputDefinition`；
- `execute` 执行函数、可选的 `finalizeContent` 回调、宿主侧调度元数据、可选 UI 呈现器。

`output` 结构为 `{ schema: JsonSchemaNode, render(args, value): ContentBlock[], presentationMeta?(args, value): JsonValue }`：`schema` 是对每个成功规范值强制校验的原始 JSON Schema；`render` 是"从已校验参数和值到 Native/model 内容的纯投影"；`presentationMeta` 只对顶层调用计算、纯可回放。

`execute(args: unknown, exec: ToolRunContext): Promise<unknown>` 的契约要点：
- 返回"仅规范的无损 JSON 值"；
- 异步工作**必须观察或转发 `exec.signal`**，且只能在自己的工作达到静默（quiescence）后 settle；
- 注册表通过"around-dispatch 的 signal 替换"保留调用方的取消，但**无法硬杀同进程代码**；
- `args` 是"无损快照、已冻结"的模型参数。

必须实现/可选的字段（全部有明确语义）：
- `finalizeContent?(exec, result): ContentBlock[] | undefined`：同步的"最后一英里"内容变换。在**每次标准化结果上恰好调用一次**，包括绕过 `tools/post-execute` 的流水线失败；发生在无损物化之前。返回 `undefined` 则保留内容，其余结果字段仍归注册表所有。回调必须全函数（total）且不得抛异常。
- `timeoutMs?`：协作式超时预算（毫秒）。由 `@deepseek-ai/dsh-tool-call-timeout-policy`（一个 `tools/execute` wrapper）执行，**绝不发给模型**（`schemas()` 只白名单 name/description/parameters）。声明它即断言本工具会转发 `exec.signal` 给可在 abort 时达静的协作实现。
- `isConcurrencySafe?(args): boolean`：纯同步的"与兄弟调用重叠"分类器，只有精确返回 `true` 才加入并行组；省略/返回非 `true`/抛异常/非法的 `defineTool` 参数一律视为独占。**该元数据永不对模型可见**。并行执行契约见 parallel-tool-call-execution Agent Note。
- `presentCall?(args): ToolCallView | undefined`：呈现某次调用的 PENDING 状态；纯且无副作用（直播流与回放都会调），只能依赖 `args`。
- `presentResult?(args, result): ToolResultView | undefined`：呈现 COMPLETED 状态；参数同样只有同一 `args` 与持久结果投影（content、失败态、可选 meta）。

**白名单投影**：注册表的 `schemas()` 构造模型可见的 `ToolSchema[]`，显式白名单之外的 `output/execute/finalizeContent/timeoutMs/isConcurrencySafe/presentCall/presentResult` 一律不得泄漏进模型请求。执行与呈现共享同一份已解析定义。

### 1.2 统一 JSON 值 schema DSL 与校验

插件作者使用同一套词汇描述类型化参数与类型化输出：`ValueSchemaSpec` 支持 `string/number/integer/boolean/null/array/object`、作者专用的 `json`、以及"恰有一个分支"的 `oneOf`；标量 `enum`/`const` 必须匹配节点类型。显式 object 节点必须声明 `additionalProperties: true | false`。**参数定义是隐含的开放 object 根**，每个必填属性以 `required: true` 注解形式附在属性上（`ParameterSchemaSpec` / `ParameterPropertySpec`）。

类型推断：`InferValue<S>` 精确推断**到 16 层容器**后回退为 `JsonValue`（避免 TypeScript 实例化栈耗尽）；`InferArgs<P>` 把逐属性 required 转成必需/可选字符串键。`defineTool({ name, description, parameters, output, execute, … })` 把参数推断接到 `parameterSchemaSpecToJsonSchema()` 与 `validateArgs()`，把 `execute/render/presentationMeta` 接到 `InferValue<OutputSchema>`。schema 记录只含自有可枚举字符串键、schema 数组是稠密原生数组，保证推断/编译/校验观察同一声明；`valueSchemaSpecToJsonSchema()` 走同一套强制原始子集编译输出声明。

错误路径：参数不匹配抛 `ToolArgsError`（`INVALID_ARGS`）；body 或后置策略值非法抛 `ToolOutputError`（`INVALID_TOOL_OUTPUT`）；两者都走正常工具错误路径。**原始 JSON Schema 默认开放**，不支持的 keyword 直接拒绝而非"接受但不强制"。

注册是受信的进程内契约：注册表只读借用类型化定义，要求 `output` 且校验其原始 schema，并检查语义要求（如 `timeoutMs` 为正有限数）。

### 1.3 作用域与可见性：`ToolRestriction` 与 `ctx.tools`

`ctx.tools` 是 `ToolRuntime`，公开 API（均有确切签名）：
- `register(definition: ToolDefinition): () => void`：全局或当前 agent 作用域注册；作用域注册**遮蔽**全局；同层重复与保留名 `run_code` 会失败；返回精确 disposer。
- `restrict(filter: ToolRestriction): () => void`：对当前作用域**继承来的全局工具**做过滤；空过滤器/未知名/作用域本地名/保留传输名会失败；限制**交集**生效；作用域自有注册仍可见；返回精确 disposer。
- `guard(guard: ToolGuard): () => void`：在可扩展的 `tools/pre-execute` waterfall **之后**注册单调 guard；普通 ctx 注册为全局，经 `agent.ctx` 注册只对该 agent 生效；返回 disposer。
- `get(name, scope?)` / `schemas(scope?)`：按作用域解析定义/投影模型可见 schema（深克隆一份/工具）。
- `executionMode(exec): ToolExecutionMode`：fail-closed 调度分类，只有精确 `true` 为 parallel。
- `execute(exec: ToolExecutionInput): Promise<ToolExecutionResult>`：完整管线入口。
- `presentAs(mode: ToolPresentationMode): () => void`：作用域内改写该主题下 agent 看到的工具呈现模式（scoped-only，每作用域一次声明）。

`ToolRestriction = { allow?: string[], deny?: string[] }`：**只对继承（部署全局层 + 祖先作用域链）的工具**过滤；允许列表与拒绝列表**交集**后，再叠加作用域自有注册（自有注册豁免，以便被授权的子 agent 保留它应答用的工具）。deny-only 过滤器会放行后续未列出的继承工具；allow-list 则排除其余。**不影响 scoped 注册与保留的 Code Mode 传输**。

### 1.4 执行流水线：pre → guard → execute → post → finalize → result

`ctx.tools.execute()` 接受调用方持有的 `ToolExecutionInput`（必含只读 `signal: AbortSignal`），把解析好的 JSON 参数**一次性无损物化**成管线自有的 `ToolExecution`，然后按序经过：

`tools/pre-execute`（可重排的 allow/deny/ask waterfall）→ 已注册的**单调 guard** → `tools/execute`（around-dispatch wrapper，如 timeout/retry/metrics）→ `tools/post-execute`（inspect/replace result）→ 可选的定义自持 `finalizeContent` → `tools/result`（不可变权威结果 `ToolExecutionResult`）。只有 `tools/execute` 这一层可以替换必选 signal。

`ToolExecutionInput` 字段：`callId`、可选 `rootCallId`（根调用省略，嵌套派发传递外层值）、`name`、`arguments`（无损可序列化的解析参数）、可选 `agent`（代理循环设置的"代表谁执行"）、可选 `parent: ToolExecutionToken`、必填 `signal`。`ToolExecutionToken` 是不透明 `Symbol`，仅供身份比较；调用方不选择 token，注册表在策略前分配。`parent` 标记"传输子派发"：Code Mode 下**只允许带 parent 的调用执行原生工具名**，模型直接调用（无 parent）在策略流水线前就以 `UNKNOWN_TOOL` 拒绝。

身份保护：策略执行前 `execute()` 物化并**冻结**参数、拒绝非 JSON 输入、分配 token；身份字段、必填 caller signal、可选 parent token 全部只读。`ToolDispatchExecution` 允许 wrapper 替换但**不能移除** signal，注册表在调用 body 前会把 caller signal 重新融合（re-fuse）。管线结束时冻结整个对象后再让 `tools/result` 观察者运行。

`ToolRunContext extends ToolExecution` 追加两个方法：
- `deferContext(context: UserMessage): void`：把一段 context 挂到"本次执行自己的结果"上——复合工具把嵌套派发的 context 带回外层结果；叶工具也可借此产出插件来源的新指令；agent loop 只在 `tool/result` 之后追加。
- `concludeTurn(): void`：把一次成功的最终结果标记为"当前 agent 回合终结"；标记随本执行的结果（`concludesTurn` 只在 `ToolExecutionSuccess` 上），复合工具会像 `additionalContexts` 一样从嵌套结果转发，因此只有权威嵌套成功才能终结外层回合并终止该回合。

调度：`ToolExecutionMode = { kind: 'parallel' } | { kind: 'exclusive' }`；agent loop 用它形成**独占屏障**与**滚动池并行**。

### 1.5 决策类型：pre/post 的 Decision 习惯、guard 的单调性、错误与取消

三个拦截 waterfall 都返回类型化 **Decision**（与 `agent/*` waterfall 共享的习惯）：
- `PreToolDecision = { kind:'allow' } | { kind:'deny'; reason } | { kind:'ask'; reason? }`。`ask` 只在审批服务返回 `allowed-once` 后放行，否则拒绝；缺审批通道/服务或 agent-less 请求变成拒绝。**输入重写被排除**：参数已被记录与呈现，历史/审计/UI/执行必须一致。
- `tools/post-execute` 的 `PostToolDecision = { kind:'accept'; content?; additionalContexts? } | { kind:'accept'; value; additionalContexts? } | { kind:'block'; feedback; additionalContexts? }`：接受、替换一种投影、附加 context 给下一请求、或 block（把纠正性反馈变成错误结果）。**content 与 value 不能同时替换**：content 替换保留规范值与原元数据；value 替换会**重新校验**并重算 content/meta；block 移除 value、成为含纠正反馈的 `isError`。文档强调 content 替换是"呈现策略而非保密策略"。
- guard：`ToolGuard = (execution: Readonly<ToolExecution>) => string | undefined`，**返回类型刻意没有 allow 结果**——`undefined` 保留 waterfall 决定，返回 reason 只能降低许可，"监听器顺序无法把一个拒绝变回许可"（单调性）。guard 在 pre-execute 之后、tool body 之前评估，是 scope-aware 的最终放行前策略。

结果类型是被区分的联合 `ToolExecutionResult = ToolExecutionSuccess | ToolExecutionFailure`：
- Success：`isError:false` + 执行本地规范 `value: JsonValue` + `content` + 可选 `meta` + 可选 `additionalContexts` + 可选 `concludesTurn`。**`value` 刻意不出现在持久事件中**。
- Failure：`isError:true` + `error: ToolFailure`（人类可读 message，去掉 Native 的 `Error: ` 外壳；可选 `info` 内部错误类/码）+ `content` + 可选 meta/additionalContexts；**失败永不携带成功 value**。

结果只携带 outcome；调用身份留在贯穿所有 hook 的不可变 `ToolExecution` 与持久 `tool/call` / `tool/result` 会话事件上（wrapper 无法另造一个不一致的身份）。`value` 执行本地：loop 只持久化 `content`、`error`、`meta`；回放能再现呈现、却无法重建规范的中间值。

归一化与物化：成功时注册表快照并校验 body 值、冻结、调用纯 renderer 与可选顶层 meta projector，并在 `tools/result` 之前单独物化持久呈现字段；非法值/renderer 失败/非 JSON 呈现 → 变 JSON 安全的 `isError`。在任何最终内容之前物化候选结果；content/结构化错误/附加 context/呈现 meta 的失败都变成仍会到达 `finalizeContent` 的 `isError`。注册表恰好调用一次 `finalizeContent`，然后**立即在 `tools/result` 前物化并冻结**被接受的结果，保证最终实时观察者看到的就是后续持久 `tool/result` append 安全的快照；观察者不能变换结果，观察者失败被容器化（contained）。未知工具与抛异常的工具都变成结构化错误（`ToolNotFoundError` → `UNKNOWN_TOOL`），调用失败而不结束回合。

取消语义：入口后、最终结果物化前到达的取消，会以 `ABORTED_BEFORE_DISPATCH` 跳过尚未启用的 body，或以 `ABORTED` 替换已启动的成功结果；已启动的工作仍被 drain，且可能保留工具自持的结构化错误。缺少 signal、审批与 pre-execute 语义见 events 小节。

### 1.6 Schema 进提示词组装 与 tool-catalog 生成

**组装**：模型在每个请求里从 `ctx.tools.schemas(scope?)` 获得可见工具的白名单 `ToolSchema[]`（name/description/parameters 三项 JSON Schema），经 system-prompt 组装呈现给模型（见 `packages/core/tools` Grot 与 `@deepseek-ai/dsh-systemprompt` 等接缝）。工具可见性由"作用域解析 + restriction"决定；作业"不可见"的调用在执行时以 `UNKNOWN_TOOL` 结构化失败。

**catalog 生成机制**（`docs/tool-catalog.md`，由 `scripts/gen-tool-catalog.ts` 生成，`pnpm run gen-tool-catalog` 再生成、`pnpm run verify-tool-catalog` 属 `doc-sync` 校验）：
- 与 cordis catalog（纯源码 AST 遍历）**不同**，此生成器**在每个真实 context 上 boot 各工具插件并读取运行时的 `ctx.tools.schemas()`**——因为工具 schema **不是静态可知的**：运行时展开的 enum、拼接的 description、配置驱动的名称、MCP 的原始 JSON-Schema 工具。
- 完整性 guard glob `packages/*/tool-*`，任何包缺席生成器 boot manifest 即失败——"新工具不能悄无声息地缺失文档"。
- 范围：`packages/*/tool-*` 下的出厂产品工具，各自用**默认 config** boot；某 Config 字段**必填且无默认**时生成器必须选一个分支并记录。注册名可以是加载期配置（如 `tool-subagent` 的 `toolName`），每个包的注释记录这些备用名。
- "Tool Package Map" 表把模型可见工具名连到插件包与接缝：模型可见名｜Requires｜Writes/affects｜Shipped aliases｜部署注记。

值得注意的既有先例（对钉钉/定时任务插件最有参考价值）：
- `ask_user_question`：**暂停调用**直到活跃 UI provider 返回人工答案（`ctx.userQuestions`），先写 `tool/call`、后写 `tool/result`。
- `@deepseek-ai/dsh-schedule`：只注册在"Schedule 插件加载后创建的活动根 Agent 作用域"内；v1 接受 after_seconds / 绝对 at / 有下界 every_seconds（≥300）；**交付是 session-local**（session 存活才准时，否则转 overdue 待恢复）；管理读/写需要共享的 Session 持久化屏障，变更走 `schedule/change` 事件。
- `bash`/`pwsh`：`run_in_background` 参数受 `enableRunInBackground`（默认 true）控制，禁用时从 schema 整个移除；后台运行注册进通用 `ctx.jobs`，由 `job_*`（`@deepseek-ai/dsh-tool-jobs`）收集/停止。
- `tool-fs`：写/改策略由独立插件 `@deepseek-ai/dsh-fs-observation-policy`（`fs/*` 事件门，无 schema 变更）加入——"部署加载这些工具时预期同时加载该策略"。
- `tool-cordis` 工具组：有意的 opt-in、不在任一出厂树中；运行中的包可**附加注册更多模型可见工具**直到停止/undefine/重启；`toolName` 之类名称可配置。

### 1.7 工具结果封装 / UI 词汇表

`presentCall`/`presentResult` 返回 provider 中立的 **`card`-tagged render intent**（判别联合），UI 桥按 card 切换：
- 调用时：`card:'generic'`（含 `locations: {path,line?}[]` 供编辑器跟随）、`card:'terminal'`（shell 命令→终端）、`card:'diff'`（创建/修改→内联 diff，`diffs:{path,oldText,newText}[]`，`oldText:null` 表示新文件）。
- 完成时：generic / terminal（output+exitCode+signal，UI 可做 exit pill 或 ```console 后备）/ diff（带上下文 hunks）/ `card:'search'`（grep 的 `shape:'matches'` 按文件分组或 glob 的 `shape:'paths'` 扁平路径，`truncated`/`total` 报告内联是否被封顶，视图不带结果文本）/ `card:'read'`（带行号的可选高亮代码视图，`offset` 是 1 基首行）/ `card:'web'`（`kind:'search'|'fetch'`）。完成视图**替换**调用时视图；搜索/网页在 execute 前没有结构化结果，其 pending 态保持 generic card。
- `ToolCallKind = 'read'|'edit'|'delete'|'move'|'search'|'execute'|'fetch'|'other'` 选泛型 icon；共享词汇 `FileLocation`、`FileDiff`、`ReadFileLine`（1 基枚举行）。

## 2. 关键设计决策与原因

1. **模型只见白名单三项**（name/description/parameters）。执行函数、输出 schema、定时、并发判定、呈现回调全部对模型隐藏，避免请求体膨胀与提示注入面；这也是"schema 进提示词组装"与"执行/presentation 定义"分离的立足点。
2. **规范值 `value` 执行本地、不进持久事件**。持久层只记录 `content`/`error`/`meta`，因此回放安全、审计可控，且避免把原生 Error 壳/内部路由信息写入历史。
3. **身份不可变 + 调用方 signal 强制**。callId/token/agent/parent 只读、参数无损快照并冻结，杜绝 wrapper 伪造身份或悄悄改参数；`tools/execute` 可替换 signal 但注册表会把 caller signal 重融合，保证取消无法被 detached。
4. **"允许失败关闭"的策略单调性**。`ToolGuard` 无 allow 结果 → 后续监听器无法撤销已拒绝的决定（顺序无关）；`isConcurrencySafe` 非精确 `true` 一律独占（fail-closed）——安全分类永远偏向保守。
5. **可扩展 waterfall + 不可重排的 guard 分层**。通用 hook（审批、hook、sandbox）放 `tools/pre-execute` 之类可重排层，让 hook 跨工具族复用而不把工具耦合到某个策略服务；"不得被重排的所有者策略"落为 guard。around-dispatch 关注点（timeout/retry/metrics）包在 `tools/execute`；呈现策略放 `tools/post-execute`。参数不可重写，因为历史/审计/UI/执行必须一致。
6. **原始 JSON Schema 支持走强制子集而非静默放行**。不支持 keyword 直接报错（`JsonSchemaError` 报告每条非法 schema 路径），避免"接受了但没强制执行"的危险；`oneOf` 要求 ≥2 分支且恰匹配一个。
7. **catalog 生成器 boot 真实运行时而非 AST**。schema 可能由配置/拼接/MCP 动态生成，静态解析会漏；完整性 guard 保证新工具必有文档，且按默认 config 生成并记录"二义性必填配置选了哪个分支"。
8. **Code Mode 的保留传输**：`run_code` 是注册表自有的保留名，子派发带 parent token 重新进入完整守卫管线，denial 变成 binding rejection，并省略 `additionalContexts` 以保持 call/result 相邻（关联性）。

## 3. 对「钉钉桥接器 + 自研定时任务插件」项目可复用的结论/代码模式

- **注册"自研工具"用 `ctx.tools.register(defineTool({...}))`**，模式：`defineTool` 传入 `name/description/parameters/output/execute/…`；参数 schema 走 `ParameterSchemaSpec`（隐含开放 object，逐属性 `required:true`），输出声明 MUST 提供 `output: { schema, render }`。保存返回的 disposer 到 ctx 生命周期，保证 stop/update/undefine 时注销（HMR/重启一致）。**不要直接手写 `ToolDefinition`**；一等方工具走 `defineTool` 以获得参数窄化与 `InferValue<OutputSchema>` 类型挂钩。
- **工具名冲突规避**：钉钉工具组名（如 `dingtalk_send`/`dingtalk_query`）与定时任务（`schedule_*` 已存在于出厂 `@deepseek-ai/dsh-schedule`！若项目要"自研定时任务插件"，注意该名称空间冲突——可选择自定义前缀如 `schedule2_*` 或 `cron_*`，文档未禁止，但同层重复注册会失败）。保留名 `run_code` 不可用。
- **schema 进提示词**：自研工具无需手工拼系统提示词段；`ctx.tools.register` 后模型自动透过 `schemas()` 白名单可见。若要按 agent 隐藏工具，用 `ctx.tools.restrict({ allow|deny })`（只影响继承来的全局工具）+ 作用域注册遮蔽；钉钉桥接器的"仅某 agent 可用"可全部放 agent.ctx 作用域注册。
- **执行流水线挂点**：钉钉桥接器可把"审批/审计/限额"放 `tools/pre-execute`（`ask` 需 `ctx.approval` 支持）或不可重排的 `ctx.tools.guard()`（如仅允许钉钉消息域名的 URL）；长超时/重试/metrics 放 `tools/execute` wrapper；"发送后的结果改写/追加上下文"放 `tools/post-execute` 的 `accept(value|content)`。自定义策略一律返回 disposer 且观察 `exec.signal`。
- **结果封装**：自研工具 body 只返回规范无损 JSON（不吐原生 Error 壳）；错误用结构化 `isError` 或抛 ToolError；可用 `exec.deferContext()` 把钉钉回执作为 `UserMessage` 追加到本工具结果（loop 在 `tool/result` 后才注入），用 `exec.concludeTurn()` 让"匹配到人的回复"直接终结回合。写入 session 的审计基于 `tool/call`+`tool/result` 持久事件本身。
- **定时/后台执行模式参考**：借鉴 `bash run_in_background`（参数由 config 控制是否出现在 schema、后台任务注册到通用 `ctx.jobs`，再由 `job_*` 收集/停止）与 `@deepseek-ai/dsh-schedule`（作用域注册 + `schedule/change` 变更事件 + session-local/overdue 交付语义 + 管理读写走 Session 持久化屏障）。自研定时插件若需要"机器可查的变更事件"，仿照 `schedule/change`、`goal/change` 自定一个 emit 事件名。
- **catalog 一致性（项目文档约定，非必须）**：若项目有自己的工具提倡用与 dsh 相同约定——运行时 boot 每个工具并读 `ctx.tools.schemas()` 生成文档（记录动态 schema 的分支选择与 `toolName` 备用名），并加"全包扫描、缺一即败"的完整性 guard。该机制是给**出厂工具文档**用的，自研插件通常无此义务，但"以 boot+schemas() 而非硬编码为真源"原则可直接复用。
- **并发/取消纪律**：工具若声明可并发（`isConcurrencySafe` 仅在安全时返回 `true`），不得改动父级状态，共享状态须容忍并发、竞态必须可交换或 fail-closed；异步 body 必须观察 `exec.signal` 并在取消时达静默，否则 `timeoutMs` 之类的协作策略无从生效。

## 4. 不确定处标注（文档未明说）

- 自研插件**究竟如何被要求**做 schema-catalog 生成（这三份文档都是针对出厂 `packages/*/tool-*` 工具的服务机制；自定义部署内的插件若不放 `packages/*/tool-*` 目录则不在 guard 扫描范围，该点文档未言明其覆盖边界）「(文档未明说)」。
- `tools/pre-execute` 与 guard 的**具体执行顺序/能否被 guard 之外的东西绕过**——文档只给先后（pre→guards→execute→post→finalize→result），未给各层线程/异步并发细节（是否串行 await 每个监听器）「(文档未明说)」。
- 审批流 `allowed-once` 由哪个服务具体实现、审批单授权的持久性细节，本文档未展开（只说明缺通道即拒绝），相关内容在别处「(文档未明说)」。
- `ctx.tools` 之外（如 `ctx.shell`、`ctx.jobs`、`ctx.approval`）的服务方法签名本文档未给出「(文档未明说)」。
- 目录/tool-catalog 生成器的**运行环境与 boot 步骤**（如何构造真实 context、默认 config 从哪个文件读）未在此三文展开「(文档未明说)」。

## 5. 相关联术语/事件名列表

**类型/接口**：`ToolDefinition`、`ToolSchema`、`ToolOutputDefinition`、`ToolRunContext`、`ToolExecutionInput`、`ToolExecution`、`ToolDispatchExecution`、`ToolExecutionToken`、`ToolExecutionMode`、`ToolExecutionResult`、`ToolExecutionSuccess`、`ToolExecutionFailure`、`ToolFailure`、`ToolGuard`、`ToolRestriction`、`CodeDispatchLog`、`PreToolDecision`、`PostToolDecision`、`JsonSchemaNode`、`ObjectJsonSchema`、`ValueSchemaSpec`、`ParameterSchemaSpec`。

**DSL/函数**：`defineTool`、`parameterSchemaSpecToJsonSchema()`、`valueSchemaSpecToJsonSchema()`、`validateArgs()`、`InferValue<S>`、`InferArgs<P>`、`assertSupportedJsonSchema()`、`validateJsonSchemaValue()`、`assertObjectJsonSchema()`、`JsonSchemaError`；错误 `ToolArgsError(INVALID_ARGS)`、`ToolOutputError(INVALID_TOOL_OUTPUT)`、`ToolNotFoundError(UNKNOWN_TOOL)`；取消码 `ABORTED_BEFORE_DISPATCH`、`ABORTED`。

**ctx.tools 方法**：`register`、`restrict`、`guard`、`get`、`schemas`、`executionMode`、`execute`、`presentAs`。

**events（Cordis Catalog）**：`tools/change`（emit，UNFILTERED）、`tools/pre-execute`（waterfall）、`tools/execute`（waterfall）、`tools/post-execute`（waterfall）、`tools/code-dispatch-log`（waterfall）、`tools/result`（emit）；会话持久事件 `tool/call`、`tool/result`、`tool/code-dispatch`；相关接缝事件 `fs/write-intent`、`fs/edit-intent`、`fs/observed`、`todo/write`、`hook/invoked`、`hook/result`、`schedule/change`、`goal/change`。

**UI 呈现词汇**：`ToolCallView`、`ToolResultView`、`card:'generic'|'terminal'|'diff'|'search'|'read'|'web'`、`ToolCallKind`、`FileLocation`、`FileDiff`、`ReadFileLine`、`presentCall`、`presentResult`、`presentationMeta`。

**相关文档/包**：`docs/subsystems/core.md`、`llm-streaming.md`（ToolSchema wire/ContentBlock）、`shell.md`、`jobs.md`、`scope.md`、`packages/core/tools/src/{index,schema,presentation}.ts`、Agent Notes：`parallel-tool-call-execution`、`tool-render-intent-union`、`tool-schema-catalog`；策略包 `@deepseek-ai/dsh-tool-call-timeout-policy`、`@deepseek-ai/dsh-fs-observation-policy`、`@deepseek-ai/dsh-scope`（scoped dispatch）。
