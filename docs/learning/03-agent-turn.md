---
title: Agent 接口、agent/* 事件与轮次/步骤生命周期
description: DSH 本地 docs 精读学习笔记（来源 docs/03-*）——Agent 接口、agent/* 事件与轮次/步骤生命周期
tags: [agent, turn, step, lifecycle]
date: 2026-08-17
status: learning-note
---
# Agent 接口、agent/* 事件、turn/step 生命周期、inbox 与 inject、agent-loop、per-agent scope、subagent 提供方

> 学习来源（DSH 本地英文文档源码，均已用 read 精读）：
> `docs/agent-lifecycle.md`、`docs/subsystems/core.md`、`docs/subsystems/system-prompt.md`、`docs/subsystems/scope.md`、`docs/subsystems/subagent.md`
> 本笔记只记录文档实际内容，不臆造。

## 1. 核心概念与机制

### 1.1 整体脊柱（`packages/core`）

core 子系统是每个组合都会启动的包集合，把一次 turn 串成一个循环：`session/`（append-only 的 `SessionEvent` 日志与内存存储，单一事实源 `ctx.sessions`）→ `system-prompt/`（prompt section 与工具 schema 组装 `ctx.systemPrompt`）→ `tools/`（带作用域的工具注册表与受控执行管线 `ctx.tools`）→ `agent/`（`Agent` 接口、live 注册表、initiator scope、`agent/*` 事件词汇 `ctx.agents`）→ `agent-loop/`（实现公共 `Agent` 契约的具体 driver `ctx.agentLoop`）→ `scope/`（per-agent 作用域注册的库原语）。

关键架构约束：
- `scope/` 是**唯一非服务包**，是一个零依赖库（`createScope`/`scopeOf`/`scopeTarget`），在模块图中位于 `session/` 与 `system-prompt/` 之下，让它们消费它而不产生环。
- `agent-loop/` 是公共 `Agent` 契约的**唯一具体实现**（harness 的默认产品 loop）。扩展插件依赖 `agent` 包（包括需要取得 initiator Agent 时）、**绝不允许直接依赖 `agent-loop`**，从而保证 loop 可整体替换。默认接线可运行示例在 `examples/agent-spine-demo`。

### 1.2 创建与所有权

消费者通过 `ctx.agents` 创建 Agent：`create()`（用调用方提供的 `SessionId` 建立全新 session + agent）或 `resume()`（先加载持久化 session）；也可通过 loop 的 config 条目声明式创建。编程式创建返回 owner 持有的句柄：

```ts
interface AgentHandle {
  agent: Agent
  dispose(): Promise<void>   // CAPABILITY：只有持有者能拆卸
}
```

- `dispose()` 语义（按文档）：停止 loop → await 退出 → 注销 agent → 从 store 移除其 session → 最后 unwind 其 scoped world。注册的 factory provider 是**结构性 owner**（因为 scoped agent 依赖其 service API），provider 卸载会停止并 drain 它创建的每个 live handle。
- `ctx.agents.get(id)` 只返回 bare `Agent`；`AgentHandle` 只暴露给创建它的 consumer owner；config 创建的 agent 由 loop fiber 拥有、无需 handle。

选项类型：
- `CreateAgentOptions`：共享身份 + 新 agent 发布前的一切——session 元数据 `meta`（校验过的 `cwd`、fork 谱系、seed 边界、来源分类、委托深度）、可选的 fork seed 重放前缀 `seed`、每 agent 的 `AgentOptions`、**仅创建期有效**的取消 `signal`、`setup`。
- `ResumeAgentOptions`：`resumeSessionId`、`agentOptions`、`signal`、`setup`。

`setup`（`AgentSetup`）是关键机制：**在两个 id（agent id / session id）都尚未发布时**就组合该 agent 的 scoped world——所有通过 `agentCtx` 注册的东西在 `agent/created` 和首次 prompt assembly 之前就已存在。setup 可返回一个同步 commit，在发布前即刻调用。setup 被拒绝、commit 抛错、或 owner 被 dispose，都会**回滚整个事务且不发布任何 id**（不会产生半组合的 session）。

`AgentFactory` 是注册表背后的创建接口：loop 通过 `ctx.agents.setFactory()` 注册其 factory，于是消费者用 `ctx.agents` 而不依赖具体 loop 包。

### 1.3 Agent 句柄与核心方法

```ts
interface Agent {
  readonly id: SessionId
  readonly options: AgentOptions   // provider / model / maxTokens
  readonly session: Session
  readonly inbox: Inbox            // agent 拥有的 durable pending work 投影
  readonly status: AgentStatus     // 'idle' | 'running'
  readonly ctx: Context            // agent-scoped context
  cancel(cause: AgentCancelCause, options?: CancelOptions): void
  whenIdle(): Promise<void>
  runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T>
  send(message: UserMessage, target: InboxTarget, wakeup: boolean): void
  followup(message: UserMessage): void
  steer(message: UserMessage): void
  inject(message: UserMessage): void
}
```

- **`status`（`AgentStatus = 'idle' | 'running'`）**：`running` 描述 driver 整体的 drain 区间、可横跨连续排队的多个 turn，**并不证明某个 turn 仍开着**。Dispose 会把 agent 移出注册表并发出 `agent/disposed`，但它不是第三个可观察的 status 值。
- **`followup()`**：排一个普通后续 turn 并唤醒 driver，该条消息成为这个 turn 的**唯一普通消息**。它不返回句柄：其 `MessageId` 标识 durable inbox 插入/claim/discard 事实，而非后续 assistant 输出或 turn 结束。
- **`steer()`**：为最近的 step 提交 steering——idle driver 会开一个 turn；running driver 在下一个 step 边界消费它。被拒绝的 step 会把 steering 暂存在 inbox 直到下次唤醒。
- **`inject()`**：为下一个 pre-step 排队 model-facing context **但不唤醒 driver**。running driver 在最近的下一个 step 边界 claim；idle driver 保持 pending 直到 followup/steering 唤醒它。它可能错过一个其 pre-step 已经 claim 过批次的请求。取消或 disposal 可能丢弃 pending context。
- **`send()`**：统一的底层方法，把已识别输入路由到 inbox 边界并可选唤醒 driver（`target: 'next-turn' | 'next-step'`，`wakeup: boolean`）。取消收敛后有一个 wake-latch：idle 后提交的唤醒输入总是开启它自己的 turn 边界，即使消息在 driver claim 前被清除。
- **`cancel()`**：清除 queued 与 steering 工作（除非 `keepInbox`）并 abort 当前活动；"第一个 cause 胜出"。`AgentCancelCause = {kind:'user'|'parent'|'hook',reason|'disposed'}`。cause 被持有者拷贝进 runtime-only 的 `AbortSignal.reason`，信号不给协作 listener 任何分类权。durable `turn/end` 只保留粗粒度的 `{ kind: 'aborted' }` 结果。
- **`whenIdle()`**：当前整 agent 活动达 quiescence 后 resolve，跟随被观察 driver 退休前启动的替换工作，但不标识特定消息的结算。
- **`runMaintenance()`**：从 true idle phase 运行一个非 turn 维护任务，任务期间状态保持 `idle`。

### 1.4 Inbox：投递词汇

Agent 拥有两个有序 pending 消息列表：`InboxTarget = 'next-turn' | 'next-step'`。每条 pending 都是其 `UserMessage`，以 `MessageId` 为唯一身份。

- 变异方法：`append` / `prepend` / `replace` / `remove` / `clear` / `splice` / `claim`，都记录 **durable 的 `agent/inbox/spliced` 变异**并拒绝重复 pending id。`replace(messageId, newMessage)` 与 `remove(messageId)` 跨两个列表定位。普通移除和 `clear()` 是取消。
- **`claim(target)`**：移除"提议 step 的批次"——全部 `next-step` 输入 +（在 turn 边界时）**一个** `next-turn` 消息——通过**纯删除** splice，不发出 discarded 通知；loop 再分别对每条消息发出 claimed 通知。
- 全队列消费者（如 UI 投影）从 durable splices 重建 `nextTurn`/`nextStep`；跟随单条消息的消费者用精确的 `agent/inbox/inserted`、`claimed`、`discarded` 通知。

### 1.5 turn/step 生命周期状态机（agent-lifecycle 时序）

文档给出的完整时序（Mermaid）是权威描述。要点：

1. **User→Agent `followup(content)`** → SDK 收到 `agent/inbox/spliced` + `agent/inbox/inserted { message }` → 排队工作唤醒 driver → `agent/status running`。
2. **Driver→Session `turn/start`** → claim "pending next-step 输入 + 一个 queued prompt" → SDK `agent/inbox/spliced`（纯删除）+ 每条 `agent/inbox/claimed { message, turn }`。
3. **`agent/pre-step` waterfall** → 返回权威的 `PreStepDecision`：`{kind:'reject'}` 直接不开 step，本次 turn 不花费任何 step；或 `{kind:'enter', messages}` 进入 step。
4. 进入 step 后：`step/start` → 每条进入的消息 `user/message` → `system-prompt/assemble` waterfall → `agent/request` waterfall → `llm/stream` → `assistant/chunk`*（streaming）→ `assistant/message` → 按 `executionMode` 分类 pending tool call，用 barrier 和有界轮转池执行——call 开始时 `tool/call`（ordered pre + 并发 execute），下一张模型序结果就绪时 `tool/result`（ordered post）→ `step/end`。
5. **自然停止且 next-step inbox 为空**时：`agent/turn-stopping` serial 终局检查点。
6. **next-step 输入 pending**时：再次 claim → `agent/pre-step`（此时可提交**空的** claimed batch 进入工具续接后的 step）。
7. 最终 `turn/end` → `agent/status idle`。

关键语义：
- **分层持久性**：durable replay facts 放在 `session/event`（`turn/start|end`、`step/start|end`、`user/message`、`assistant/chunk`、`assistant/message`、`tool/call`、`tool/result`、`steering/message`、`todo/write`、`request/header` 共十二个事件变体）；**live control/status 放 `agent/*`**。`assistant/message` 记录每次成功的 provider 调用（含无内容与 `max-tokens` 结束），空内容留在 derived history 之外，而 durable 事件保留 usage 与 `sourceEventSeqs`（列出精确的 `assistant/chunk` 事件，含显式空列表）。
- `agent/*` 是 live 协调 API（队列/状态/prompt 拦截/请求构造/steering/续接/错误）；需要可重放 transcript 的 SDK 用户应消费 `session/event`。

### 1.6 agent/* 事件目录（含签名）

所有事件 `this: Scoped<Agent>`（scope 过滤：agent-scoped listener 只收到该 agent），`agent` 是显式 subject。

| 事件 | 模式 | payload |
|---|---|---|
| `agent/created` | emit `{ agent }` | 完全配置好的 agent+session 已发布；同步 listener 失败可否决发布 |
| `agent/disposed` | emit `{ agent }` | AgentLoop 在 driver quiescence 与 scoped-registration unwind 之后、session detach 之前发出 |
| `agent/error` | emit `{ agent, turn, step, error }` | step/turn 报错；即使错误没有 durable 的 in-turn 位置也上报 |
| `agent/session-start` | emit `{ agent, source }` | 每 session 生命周期开一次（首 turn 前）；`source: 'startup'\|'resume'\|'clear'\|'compact'`；是通知非否决 |
| `agent/status` | emit `{ agent, status }` | `idle ⇄ running`；唤醒投递在预留取消后**同步**进入 running |
| `agent/inbox/inserted` | emit `{ agent, message }` | 一条消息进入 live inbox |
| `agent/inbox/claimed` | emit `{ agent, message, turn }` | 一条消息在其开着的 turn 内离开 inbox；若提议的 step 被拒，claimed 消息在此终结——既不被 discard 也不重发为 user/message，turn 无 step 关闭 |
| `agent/inbox/discarded` | emit `{ agent, message }` | 一条消息从 live inbox 被丢弃 |
| `agent/pre-step` | **waterfall** `{ agent, messages, turn, step, signal }` → `Promise<PreStepDecision>` | 请求派生前**唯一的 serial listener 链**；reject 或 enter(messages)；`next()` 保留当前消息 |
| `agent/request` | **waterfall** `{ agent, turn, step, signal }` → `Promise<LlmCallConfig>` | 替换冻结的调用配置；`await next()` 得到机器将用的配置（首请求是 agent options，后续是已记录 header）；此 waterfall 不能改消息 |
| `agent/request-error` | **waterfall** `{ agent, turn, step, provider, failure, retryPolicy, signal }` → `Promise<RequestErrorAction>` | 处理一次失败的模型请求；返回 `{kind:'retry'}`（不调 `next()`）即拥有恢复；默认 `undefined` 令失败终结 |
| `agent/turn-stopping` | **serial** `{ agent, turn, signal }` | turn 即将关闭时（模型无欠响应）await 于边界提交前；反对的 listener 调 `agent.steer(...)` 触发另一 step |

另外两个非 `agent/*` 但相邻的事件：`agent-loop/config-start-failed`（emit，声明式条目发布失败信号，`{ sessionId, error }`）与 `agent-preset/selected`（session 提交新 preset，`(sessionId, agentPreset)`）。turn/step 边界是 durable session 事件而非 agent 发出，事件 taxonomy 由 architecture.md#events 统管。

补偿/恢复事实：`dsh-compaction-basic` 用 `agent/pre-step` 做请求派生前的压力钩子、只用 `agent/request-error` 处理 canonical context overflow；恢复发生在"已闭合的失败 step 与失败 turn 关闭之间"，只有剪枝或摘要推进了替换代（generation）才开新的 retry turn，否则保留原请求错误为权威。

### 1.7 Initiator scope（`ctx.agents`）

- `currentInitiator()`：读取继承的异步 driver 链对应的 `Agent`，链外或无 initiator 返回 `undefined`。
- `requireInitiator()`：无 initiator 时抛错，用于契约上必须在 driver 之下的私有助手。
- `withInitiator(agent, operation)`：以精确 Agent 为 process-local initiator 运行 operation，返回原值（自定义 driver / 测试用完整前台生命周期包裹）。
- `withoutInitiator(operation)`：在隐藏继承 initiator 的边界内运行（如惰性共享定时器、队列泵、池维护、watcher、exporter），只清 initiator 归属不清显式字段。
- **initiator 只是进程内因果归属**：在场既非活性证明也非授权；subject 与 owner 始终显式，跨 worker/process/persistence/wire 的身份也是显式的。`setup` 报告因果 parent，而 `agentCtx.agent` 标识 child。
- 服务还含：`setFactory(factory)`（抛重注册错、返回 disposer）、`register(agent)`（发 `agent/created`/`agent/disposed`，subject 是 scoped carrier `scopeTarget(agent, agent)`）、`enter/announce`（异步工厂的有序生命周期原语）、`get/isOwnedBy/list/roots`。

### 1.8 per-agent scope（`scope/` 与 `ctx.systemPrompt` 的 scoped shadow）

- **`ScopeKey = object`**：不透明、以同一性比较的 key。**shipped loop 直接用 live `Agent` 对象作为其自身 key**，但该原语从不检查对象内部。
- **`Scoped<T>`**：`scopeTarget(base, key)` 返回的路由专用 receiver 上的编译期 brand；scope 过滤事件声明用它做 `this` 类型，真实 subject 仍是显式参数。
- **`Scope { ctx, rawDispose, dispose() }`**：`ctx` 是 scope 内注册用的 Context；`rawDispose` 保留精确 Cordis disposer 身份（供有序组合 effect 嵌套）；`dispose()` 是公共共享 quiescence 边界（并发调用 await 同一完成）。**一个注册上下文同时表达两件事：per-agent 可见性与共享生命周期所有权。**
- `ScopedLayers` 拥有 eager 全局层 + 惰性精确 scope 层；`peek(undefined)` 表示无覆盖，`merge()` 物化插入序全局命名条目 + scoped shadows。
- **system-prompt 的 scoped shadow**：`ctx.systemPrompt` 是每模型 step 前 prompt 输入的注册表服务。scoped section/context/variable 以同名 shadow 全局。`PromptSection { name（唯一，重复注册抛错）, order, text, complete? }`，节按 order 升序拼接（约定 `-100`=harness 身份，`0`=deployment persona，工具指引 100–199）；text 可为静态字符串或按 assembly context 求值、可含 `{{variable}}` 占位。`complete: true` 的 section 使 assembly 仍跑 cooperative waterfall（解析工具/上下文/变量）后**恢复该节为唯一 prompt section**——多个 effective complete section 使 assembly 失败。`PromptContext` 是 cache-safe 的动态模型上下文物化为 durable user-role snapshot。
- `ctx.agents` 的 `agent/created`/`agent/disposed` 用作用域 carrier `scopeTarget(agent, agent)` 分发，因此无论哪个 context 调 `register`，发出都被 scope 过滤。子代理通过 `agentPresets.mount(agentCtx, id)` / `composeFrom(agentCtx, parentCtx)` 得到其作用域组合（composeFrom 是 bind 而非 mount：子代继承父代**完全相同的** standing 组合实例）。

## 2. 关键设计决策与原因

1. **单一事实源 = append-only session 日志；LLM 历史是派生的**。`SessionEvent` 日志是不可变 replay 事实；`deriveMessages()` 生成模型历史，而非另存一份。这让持久化、崩溃恢复、SDK 重放统一，且 assistant 每次成功调用都被记录（含空内容）不破坏历史派生。
2. **`agent/*` 只管 live 协调，`session/event` 只管 durable replay**——清晰的分层让 UI/SDK 分别消费，也让 pre-step 拦截/steering 等控制操作不影响可重放性。
3. **pre-step 返回是权威的；`next()` 包住下游以保留消息**。`agent/pre-step` 是请求派生前唯一的 serial 链，规避了多处拦截的竞态；它一次拿到独占的 `claimed batch` 并携带 turn/step/signal。
4. **inbox 的 claim 采用"纯删除 splice + 每条已 claim 通知"**：被拒绝的 step 中消息不会变成"丢弃"或"用户消息"，保证 UI 投影能从 durable splices 精确重建两个队列。
5. **setup 在发布前组合 scoped world**：任何注册失败整体回滚、不产生半组合 session；`agent/created` 是发布后第一个扩展点，`agent/session-start` 才是第一个驱动启动的扩展点（文档强调 setup 只是 compose）。
6. **`agent-loop` 可替换**：扩展只依赖 `agent` 服务与事件，factory 通过 `setFactory` 注入，保持产品 loop 与契约解耦。initiator（`withInitiator`）明确"在场 ≠ liveness 证明 ≠ 授权"，防被滥用为鉴权。
7. **每次取消 cause 只进 AbortSignal.reason，durable turn/end 只记 `{kind:'aborted'}`**：粗粒度以免回声"谁请求取消"，需要精确归属则须另建 durable 事件。
8. **`window` 语义 / `whenIdle` 观测整 agent**：followup 无结果句柄、`MessageId` 只标识 inbox 事实；是否把 receipt-to-idle 区间称为"一次 run"由调用方显式拥有。
9. **subagent 是命名 provider 的多实现 seam**（对照 bash 单 executor，参照 LLM adapter registry），支持 spawn/fork/acp/codex/claude-code/dsh-sdk 并存；"fail loud, no silent degradation"——`start()` 前按 `SubagentCapabilities` 校验，缺能力直接 `SubagentError('UNSUPPORTED_CAPABILITY')`。
10. **continuable 子代理用"一个 durable Session + 至多一个 Activation"**：所有续接消息经 agent 自身的 inbox 作为唯一 FIFO 队列（每条 = 一次 `Agent.followup()` turn），Activation 状态从 agent quiescence + owned-child 集合派生，**不维护第二套执行状态机**；followup 后 caller 取消不再影响已接受的 turn——边界是 inbox 接受。
11. **报告是 child 自己的选择，runtime 结算是独立 kind**：`subagent-report`（子代选择的内容，quiet=inject / wakeup=followup）与 `subagent-settled`（runtime 对子代如何结束的账目，仅 notice）用不同 `MessageSource.kind`，绝不让 transcript 把 runtime 的记叙冒充成 child 写的话。
12. **scope key 用对象同一性而非字符串**：让每个 Agent 天然拥有一层，子代注册继承同层或 join 父层组合。

## 3. 对「钉钉桥接器 + 自研定时任务插件」项目的可复用结论与代码模式

- **双向事件消费模式**：bridge/定时任务作为插件注册在宿主组合，用 `agent/inbox/inserted` 感知外部消息入队、`agent/status` 感知忙碌/空闲、`agent/pre-step` 做 per-step 干预（如钉钉消息注入上下文），而把可重放记录留在 `session/event` 下游消费——**不要**把业务状态挂在 `agent/*` 上。
- **投递入口分层**：`agent.steer()`（打断当前 step 的操控/即时指令）与 `agent.followup()`（排队新 turn 并唤醒）、`agent.inject()`（预备 model-facing 上下文给下一个 pre-step，不唤醒）。定时任务想"静默塞上下文给下一次对话步骤"用 `inject`；想"唤起 agent 立刻处理一条新消息"用 `followup`；钉钉管理员手动中断当前轮用 `steer`。
- **文案/桥接映射到 PreStepDecision**：在 `agent/pre-step` waterfall 里，把钉钉消息批量包成 `{kind:'enter', messages:[...]}` 或 `{kind:'reject'}`；记住 claim 过就被移除的批次——拒绝意味着这批消息**终结于此**（不丢弃不重发为 user/message），如有需要须自行在 durable 层处置。
- **inbox 是 agent 的唯一队列**：自研定时任务如需"给某 agent 派活同时保留并发队列语义"，不必自建队列——`agent.followup()` 天然 FIFO、唤醒驱动、一条消息一个 turn；取消用 `agent.cancel(cause, {keepInbox:true})` 可保留未开始的 pending 工作。
- **scope 隔离**：bridge 与定时任务各自的 prompt section / tool / variable 用 `ctx.systemPrompt.section()/tools()/variable()` 注册在调用 context 的 scope；同名 scoped 条目 shadow 全局，天然 per-preset 隔离。每 agent 一个 scope 层，注册与取消都走 effect disposer。
- **subagent 提供方集成**：若钉钉要把任务委派给子 agent，用 `ctx.subagents.start(name, SubagentStartRequest)` 一次性前台委托（等一份 `SubagentResult`，`stopReason` 非 `completed` 即按 `isError` 处理）；要长期可续接的对话则 `startContinuable` + `followup`（以 `{childId, messageId}` 为准，不等 turn 开始），用 `interrupt(childId, {kind:'user', parentSessionId})` 打断、`listChildren` 枚举（不加载不 resume Agent）。注册自定义 provider 时实现 `SubagentProvider`（`name/capabilities/inheritsParentContext/start` 必填，`prepareContinuable` 可选=续接能力本身）。
- **定时任务做维护工作**：实现为 Agent 上的 `runMaintenance(task)`（true idle phase 中的非 turn 任务，状态保持 idle，`whenIdle()` 会跟随它）；避免在懒初始化的共享定时器/池/导出器里继承第一个碰巧的 initiator——外层包 `ctx.agents.withoutInitiator(...)`，需要归属时用 `currentInitiator()`（容错）/`requireInitiator()`。
- **LlmCallConfig 拦截至上**：定时常量如最大 token / provider 路由可用 `agent/request` waterfall 统一改写;报告/重试策略在 `agent/request-error` 里 return `{kind:'retry'}`。

## 4. 不确定处（文档未明说）

- (文档未明说) `cwl` 与 `maxTokens` 之外的 `AgentOptions` 扩展字段有哪些——文档只列了 `provider/model/maxTokens`，其余按 merge-extensible。
- (文档未明说) `agent/inbox/spliced` 事件本身的确切 payload schema——五个源文档只在语义上描述它（durable splices），没有给 `spliced` 的 cordis-catalog 签名（它由 Inbox 变异方法记录，未在 core.md 的生成目录中单列）。
- (文档未明说) `AgentRegistry.create/resume` 在 `ctx.agentLoop` 之外是否还有默认 factory 兜底——文档只描述 `setFactory` 必须被 loop 注册，未描述缺 factory 时的运行时行为（只讲 `create()`/`resume()` 在无 factory 时 reject）。
- (文档未明说) pre-step 被拒后，这批 claimed 消息的"终结"是否在别处有可观测事件——文档只说明它们既不被 discard 也不重发为 user/message，未明说是否存在某个专门的 rejection 事件。
- (文档未明说) subagent 的 `unsubscribed` 诊断与 `SubagentStopReason` 中 `refusal` 之外的扩展 variant 全集——枚举 `completed/aborted/error/max-tokens/refusal` 是文档给出的 known cases，仍是 merge-extensible。
- (文档未明说) `system-prompt/assemble` 与 `agent/pre-step` 之外的其它可挂链；文档只说了这两个 + `agent/request`/`agent/request-error`/`agent/turn-stopping`，未承诺完整生命周期扩展点清单。

## 5. 相关联术语 / 事件名列表

- 服务：`ctx.agents`(AgentRegistry)、`ctx.agentLoop`(AgentLoop)、`ctx.systemPrompt`(SystemPrompt)、`ctx.sessions`、`ctx.tools`、`ctx.subagents`(SubagentRuntime)、`ctx.agentPresets` / `ctx.agentDefaultModel`。
- 事件：`agent/created`、`agent/disposed`、`agent/error`、`agent/inbox/spliced`、`agent/inbox/inserted`、`agent/inbox/claimed`、`agent/inbox/discarded`、`agent/pre-step`、`agent/request`、`agent/request-error`、`agent/session-start`、`agent/status`、`agent/turn-stopping`、`agent-loop/config-start-failed`、`agent-preset/selected`、`system-prompt/assemble`、`system-prompt/change`、`subagent/start`、`subagent/end`、`subagent/provider-added`、`subagent/provider-removed`。
- session 事件（durable）：`turn/start`、`turn/end`、`step/start`、`step/end`、`user/message`、`assistant/chunk`、`assistant/message`、`tool/call`、`tool/result`、`steering/message`、`todo/write`、`request/header`。
- 术语：`AgentHandle`、`AgentOptions`、`CreateAgentOptions`/`ResumeAgentOptions`/`AgentSetup`、`AgentFactory`、`AgentStatus`、`InboxTarget`、`Inbox`、`MessageId`、`PreStepDecision`、`RequestErrorAction`、`SessionStartSource`、`AgentCancelCause`、`CancelOptions`、`AbortSignal`、`scopeTarget`/`ScopeKey`/`Scoped<T>`/`Scope`/`ScopeLayer`/`ScopedLayers`、`PromptSection`/`PromptContext`/`AssembleContext`/`ToolProviderResult`、`LlmCallConfig`、`SubagentProvider`/`SubagentCapabilities`/`SubagentStartRequest`/`ResolvedSubagentStartRequest`、`Activation`、`SubagentInterruptAuthority`、`SubagentReportDelivery`、`SubagentResult`/`SubagentStopReason`、`SubagentRun`、`ContinuableStart`/`ContinuableCreateSpec`、`SubagentListEntry`/`SubagentDescendantListEntry`、`MessageSource`（`subagent-report`/`subagent-settled`/`coordinator`）、`SessionHeader.parentSession/delegationDepth`。
