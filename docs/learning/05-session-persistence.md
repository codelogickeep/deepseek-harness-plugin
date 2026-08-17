---
title: 会话与持久化子系统
description: DSH 本地 docs 精读学习笔记（来源 docs/05-*）——会话与持久化子系统
tags: [session, persistence, projection]
date: 2026-08-17
status: learning-note
---
# 学习笔记 05：会话(Session)、事件追加日志、投影、持久化、查询、fork/恢复、压缩、遥测与标题

> 来源：`deepseek-harness/docs/subsystems/{session, session-projection, session-query, persistence, session-reference, session-telemetry, compaction}.md` 与 `docs/persistence-catalog.md`（英文版，全部读取成功）。

## 1. 核心概念与机制

### 1.1 Session：内存中的事件溯源模型（`@deepseek-ai/dsh-session`）

`Session` 是**仅追加(append-only)的 `SessionEvent` 日志**，是一个 agent 完整交互历史的唯一真相源(sole source of truth)。关键推论：**LLM 消息历史是从日志“派生”的**，从不单独存储；重放(replay)就是对同一组事件重新派生。持久化是它的兄弟关注点（见 session-persistence）。

- **事件类型表 `SessionEventMap`** 是可声明合并(merge-extensible)的：插件通过 `declare module '@deepseek-ai/dsh-session/types'` 声明额外事件类型。核心事件分两类：
  - **log-only**：`turn/start`、`turn/end`、`step/start`、`step/end`、`assistant/chunk`、`tool/call`、`todo/write`、`request/header`、`request/context`、`session/end-seed`，以及插件合并的 `compaction/*`、`hook/*`、`approval/*`、`goal/change`、`session/title` 等——**不携带 `surfaceOp`，不进入派生模型历史**。
  - **`SurfaceEventType`**（唯一消息产生子集）：`user/message`、`assistant/message`、`tool/result`——携带 `surfaceOp` 与可选的 `sourceEventSeqs`，是唯一组成有序 surface（模型可见历史）的事件。
- **`SessionEvent<T>` 信封**：以 `type` 为判别式的真联合类型（`switch(type)` 可直接窄化 `data`）；`seq` 是日志内单调递增位置（**`seq = log.length`，恒连续**）；`time` 是 epoch 毫秒。条件字段仅在 surface 事件上：`surfaceOp`（`'append'` 或 `{op:'replace', start, end}`）与 `sourceEventSeqs`（本事件引用的更早事件 seq 列表）。`ignorable?: true` 标记纯信息性记录：读者遇到不认识但不带此标记的事件**必须拒绝重建会话**（因为不认识的必需事件可能改变其余日志的解释方式）。
- **`Session.append()`**：附加一个事件并同步通知观察者；**热路径不阻塞 I/O**（持久化插件异步缓冲）。接收时会做一次递归的 lossless-JSON 校验（`isJsonValue`）：BigInt/function/symbol/undefined/负零/非有限数字/环形引用/稀疏数组/Map/Set/Date 等都拒绝，坏事件在 append 处就失败，绝不进入日志。surface 事件**必须**传 `SurfaceIntent`（含 `surfaceOp`、`sourceEventSeqs`），log-only 事件编译期禁止。
- **派生历史**：`deriveMessages()` 用 `deriveEventMessage()` 逐 surface 节点折叠（缓存：每个节点只在首次见到时投影一次，`replace` 使缓存重建）。`user/message`→user 消息；`assistant/message`→assistant 消息（**空内容的 assistant/message 被跳过**，仅作 usage/模型标识载体）；`tool/result`→带 tool-result 块的 user 消息。原始 `assistant/chunk`、`turn/*`、`step/*` 等**不投影**。Token 记账读按步的 usage chunk，`assistant/message.usage` 作为无 chunk 时的兜底。
- **事件流式发布**：`session/event`（emit，scope-filtered）是 post-commit、fire-and-forget 的追加流；监听器快照在日志 push 前解析、回调在 push 后执行，观察者失败仅记日志并隔离，不会让已提交 append 失败。
- **fork/恢复**：`SessionStore.fork(source, boundary?, childSessionId?)` 选择到含 `boundary`（默认当前最后事件）的前缀，**拒绝以未闭环的 turn 内结尾**（不静默裁剪），创建带深克隆 seed 事件的子会话（header 记 `parentSession`、`seedLength`、继承 `cwd`）。`ctx.sessions.create(id, {seed, meta})` 是低层 replay/fork 原语。恢复持久化会话为 live agent 用 `ctx.agents.resume({resumeSessionId})`（本文档仅提到此入口）。
- **`session/end-seed`**：构造函数 seed 结束的里程碑事件（持久化的 `firstLiveSeq`）；事件前的 seq 来自 seed（resume/fork/replay），本生命周期未产生。只定位存储里的**最后一个**；空 seed 会在 seq 0 写它（区分空恢复与全新会话），已以它结尾的 seed 不重复标记。它是 standalone 括号（如 `compaction/start`…`compaction/end`）所有者判断“未匹配起始标记是否已死”的依据——该标记若在 `session/end-seed` 之前则属于已结束的生命周期。

### 1.2 `SessionHeader`：日志之外的元数据

格式版本、工作目录、血缘、seed 边界属于**存储关注点而非会话事件**，独立于日志存放并经 `session.header` 访问。字段：`version`（`SESSION_FORMAT_VERSION`，当前=0，后端拒绝其它版本，无迁移）、`id`、`createdAt`、`cwd`、`parentSession`、`seedLength`、`origin?: 'subagent'`、`delegationDepth`、`agentPreset`。持久化 `agentPreset` 是因为恢复时若composition 不同会重放模型已无法行动的历史。

### 1.3 持久化 seam：`ctx.sessionPersistence`（抽象服务）

`session/event` 是**同步**通知；持久化插件把事件拷入每个会话的控制器，不阻塞生产者。**首个待写入事件开启一个固定批处理窗口，后续事件加入但不重置期限**；过期后写出一个 durable 批次，期间新事件各自获得期限形成后续批次。`session/flush`（parallel 事件）取消等待并排空至静止——agent 循环把 `session/flush` 当作下一个普通 turn 开始前的**排序与错误观察检查点**。被拒绝的后台写保留事件并暂停自动重试；新事件重新开窗口；显式 flush 立即重试并通过 `agent/error` 与 logger 报告失败。dispose 做同样的最终排空。

- 统一入口 `ctx.sessions.flush(session): Promise<boolean>`：返回是否有至少一个持久性监听器参与（全部监听器成功 settle 之后）。
- 后端契约方法：`locate(meta)`（返回后端自有 artifacts 的绝对路径，JSONL 返回 transcript 路径、SQLite 因共享单库而返回 undefined）、`create(meta)`、`append(id, events)`（第一批的 `seq` 必须等于存储的 next-seq；拒绝非 JSON 数据）、`prepare(id)`（保留未发布 Session）、`load(id)`（对 live id：等待内存快照 durable 且仅当 balanced 才返回）、`inspect(id)`、`readFrom(id, fromSeq, signal)`（**从 seq 起始的 detached 物理后缀读**，投影缓存读尾巴的原语）、`list`、`listSnapshots`（header + 不透明 `SessionPersistenceRevision`，日志一变即变）、`readRaw`。
- 后端：**JSONL** —— 每个会话一条 append-only 逻辑 JSONL（默认校验和拼接的 Zstandard 帧，可配原始行），崩溃安全原子写、中断 turn 恢复、读/重放路径；**SQLite** —— `node:sqlite`，一行一个 `SessionEvent`，行字段与事件 1:1 映射（无平行 schema 需同步）。
- **崩溃恢复**：后端重载时若发现未闭环 `turn/start`（无 `turn/end`），**不截断**（单个 turn 可能巨大且已 durable 追加），而是追加合成的 `turn/end { reason: {kind:'interrupted'} }` 保持括号平衡。`interrupted` 是唯一 loop 永不发出的 `TurnEndReason`。修复只作用于冷会话；live id 的 open turn 被拒绝而不是合成中断。
- **格式拒绝**：`SessionFormatUnsupportedError`（区别于 `SessionPersistenceCorruptionError`，无损坏）——header `version` 超前于 `SESSION_FORMAT_VERSION` 报“请升级 harness”，滞后则报“本构建无升级路径”；未识别事件类型同样拒绝，除非带 `ignorable: true`。

### 1.4 会话投影 seam：`ctx.sessionProjections`

框架驱动、领域计算：注册表**只订阅一次 `session/event`**，把每个已提交事件 eager 地经每个 unit 折叠；领域插件不持订阅，客户端永远收到的是折叠好的**完整当前值**。每个 key 一个 `ProjectionDefinition`：`init()`、纯同步 `apply(state, event)`（对不关心的事件必须返回同一 state 引用，`Object.is` 相同则零下游工作）、`view(state)` → 线协议值（配 Zod schema 校验）、`stateVersion`（持久化缓存失效版本号）。**whole-value 事件规则**：需要状态的事件携带完整状态快照而非裸 delta，使每次转移都极廉且每个值自描述（last-wins）。注册是 effect（disposer 随 fiber 卸载，key 消失=能力缺失）；重复 key 抛错；同 key 多次注册计数共存。

持久化缓存 `ctx.sessionProjectionCache`：后台节流 write-behind，加两个强制点 `turn/end` 与会话 disposal，加上冷读梯子(缓存行 → `readFrom` 尾巴 → 注册表 `restore` → durable 写回)。`restoreFloor` 的“低一锚点”（低于最低可用水印一个 seq）可检测日志被截断（崩溃修复）而拒绝陈旧行。

### 1.5 会话查询 seam：`ctx.sessionQuery` + 会话引用 `ctx.sessionReferenceResolver`

- 查询是 live 优先逻辑语料（live 与 persisted 并列可用性）：`SessionRecord { header, live, persisted }`。**`ctx.sessionQuery`**：`listSessions`、`filterSessions`（AND 化 filter 数组、子句内 OR，含 id/cwd/created-at/parent/availability）、`filterEvents`（seq/time/type/surface/text——text 是字面 UniCode 不区分大小写、空白灵活的语义文本扫描）、`readSession`（resume 预检用的完整 detached 重放校验日志）、`readSurface`（一次原子 surface 快照）、`readTitle` / `readTitleSnapshot` / `readTitleSnapshots`（折叠最新标题并绑定同一次 header 观察）、`traceSession`（祖先链 + 后代森林，`complete:false` 时给出 `unresolvedParentId`）、`traceEvent`、`readEvent`（目标事件 + 前后窗口）。全文检索 `searchSessions`/`searchEvents` 用不透明游标 `SessionSearchCursor` 分页，SQLite 提供方持有完整索引生命周期；query 作为数据解释、绝不作可执行 FTS 语法。错误为 closed union（17 个 `SESSION_QUERY_*` 码）。
- **布局/分类**：`SessionEventSurface = 'current' | 'shadowed' | 'log-only'`，分类用与模型历史派生相同的 `foldSurface()` 转移。
- **会话引用** `ctx.sessionReferenceResolver`：跨会话“@提及”。`listCandidates(agent, query, limit, signal)` 按 cwd 亲和度排名、用最新标题作 label（过滤只看 id/cwd，不搜正文）；`prepare(agent, content, references, signal)` 入队前快照全部引用并返回**一条聚合的不受信上下文** `additionalContext`（UserMessage）。错误码包括 `SESSION_REFERENCE_SELF_REFERENCE`、`TOO_MANY`、`BUDGET_EXCEEDED` 等。

### 1.6 压缩 seam：`ctx.compaction` + 遥测 `ctx.sessionTelemetry` + 标题

- **compaction** 是可选项、非 agent-loop 骨干的一部分。用声明合并加三个 **log-only** 事件：`compaction/start`（取锁，数字=<自动 turn 内>，`null`=手动 standalone）、`compaction/summary`（安全摘要投影 + `shadowedRange`(位置跨距，非数值区间) + `shadowedSeqs` + `shadowedTokenCount` + summarize 调用信封 provider/model/maxTokens/usage，`llmStreamCall:true` 标记唯一一次 `ctx.llm.stream()` 调用）、`compaction/end`（释放锁，`error` 记失败）。**锁包住整个操作**：start → 摘要 → summary → `user/message` 替换 → end；崩溃留下的未匹配 start 是“孤儿锁”可检测，而非虚假成功。实际表面替换是紧随其后带 `surfaceOp:{op:'replace', start, end}` 的 **`user/message`**——`user/message` 是唯一由 summary compaction 做出的 surface 变更。引擎 API：`compactIfNeeded(agent, trigger('pressure'|'context-overflow'), signal)`、`compactNow(agent, signal, sourceCommandId?)`、`compactRegion(start, end, agent, signal)`。`ManualCompactionErrorCode`（busy/cancelled/changed/summary/commit/persistence）。可选 `ctx.toolResultPruner`（Unicode 码点裁剪，`compaction/prune` 影子计价事件）。
- **遥测**：`ctx.sessionTelemetry`（后端契约）+ OTel 提供方。捕获点：`session/event` 热路径（live capture）或显式规范日志（on-demand capture）。每记录 `SessionTelemetryRecord { channel:'ledger'|'ops', time, severity('info'|'warn'|'error'), attributes, body }`——ledger 镜像 session 日志一一对应；ops 是 `agent-error`/`shutdown` 等无日志归宿的信号，刻意省略事件身份。**边界公理：harness 的职责止于 `emit()`；batching/retry/queue/loss 属于上报 SDK**。`session-telemetry/record` 是 waterfall 脱敏扩展点（seam 自带零规则；无监听器时记录原样出站；脱敏只影响导出副本，从不改写规范日志）。sharing 披露 `'full'|'feedback-only'|'disabled'`。每个 `(turn,step)` 只发第一个 `assistant/chunk`（stream-started 信号），线上 seq 缺口是常态；ledger 记录按 `(session.id, event.seq)` 去重。
- **标题**：catalog 里有 log-only **`session/title`（latest-wins 快照，绝不进模型 surface）** 与 `session/title-llm-request`（模型请求的预派发记录）；查询侧用 `readTitle`/`readTitleSnapshot` 折叠。标题具体生成/更新触发点分散在 session-title 包（见第 4 节）。

## 2. 关键设计决策与原因

1. **日志是唯一真相源，消息历史是派生视图**：重放即重新派生，杜绝双写不一致；同时要求 append 处做严格 lossless-JSON 校验，坏事件在源头失败，保证「`session.events` 恒等于后端可持久化内容」。
2. **`seq = log.length` 连续契约**：为此 `assistant/chunk` 必须整体保留（后端可自选编码压缩，如 JSONL 的 packed rows，但 `load` 必须返回完全相同的追加事件），不能过滤。
3. **热路径不阻塞 I/O + 固定批处理窗口**：`session/event` 同步拷贝事件进缓冲；首事件开窗、后续不重置期限；`session/flush` 是显式 durability 屏障。循环**不在 turn 边界等 flush**——归 `dsh-session-checkpoint-policy` 按请求做检查点，消费存储的读方在 `whenIdle()` 后自行 flush。批窗口上限只限有意的批处理等待，不背事件循环调度或后端持久性延迟。
4. **崩溃不截断、补合成 `interrupted`**：长时任务单 turn 可能巨大且已 durable，截断会丢数据；合成 closer 保持括号平衡且不改动其它事件。
5. **surface replace 而非删除/改写**：压缩用 `{op:'replace'}` 在编译期/校验期要求替代事件覆盖被遮蔽节点（否则拒绝），映射 `shadowedSeqs` 与 `replaceGeneration`，使增量消费者能区分纯尾部增长与重写；日志始终是只读 append。
6. **whole-value snapshot 而非 delta**：几乎每个状态事件都是完整最新快照（todo 整表、request/header 整信封、session/title 快照、plan-mode/approval/policy/sandbox 最后者胜），换一次转移的极廉价与读方自描述。
7. **框架驱动、领域计算的投影分割**：注册表只订阅一次事件流、驱动全部 unit；领域只写纯同步 `apply/view`。全异步会撕裂载体的一致性切面；`state` 须为纯 JSON（持久化缓存前提）。
8. **能力 seam 的都是可选能力**：compaction、telemetry、projection、query 均非 agent-loop 骨干，缺装不影响核心；隔离失败/能力缺失（unload 后 key 消失、`searchSessions` 未部署=disabled）。
9. **遥测边界公理**：harness 止于 `emit()` 非阻塞入队；批处理、重试、丢包策略归 SDK；接收端必须容忍副本并以 `(session.id, seq)` 去重。脱敏瀑布默认零规则，导出数据干净度完全取决于部署者挂的规则。

## 3. 对「钉钉桥接器 + 自研定时任务插件」项目可复用的结论/代码模式

- **自有事件类型用 log-only 声明合并**：`declare module '@deepseek-ai/dsh-session/types' { interface SessionEventMap { 'dingtalk/message': {...}; 'scheduler/tick': {...} } }`。既能持久/可重放，又不进模型 surface、不污染派生历史。跨 multi-turn 执行的功率较强时考虑 `ignorable: true` + 明确注释。
- **读边的三类消费方式**（按需选择）：
  1. 实时流：`ctx.on('session/event', (session, event)=>{...})`，回调必须轻（它跑在 append 热路径上）——**只拷贝叶子数据入缓冲**，用固定批处理窗口写出去或派发异步任务，仿持久化插件的“首事件开窗、后续不重置期限”模式。
  2. 状态投影：注册 `ctx.sessionProjections.register({key, schema, init, apply, view, stateVersion})`，对不关心的事件返回同一 state 引用；`ctx.sessionProjections.snapshot(session)` 同步读一致切面（同一 tick 覆盖页面切片与 `asOfSeq`）。适合做“钉钉桥最后一个处理消息”“定时器上次跑到的 seq”这类派生状态。
  3. 冷读/查询：重开持久化会话用 `ctx.sessionPersistence.readFrom(id, fromSeq)` 只读尾巴增量折叠，或 `listSnapshots()`（header+revision）廉价探测变更；跨会话检索用 `ctx.sessionQuery.filterEvents`/`readTitle`；跨会话“@会话”用 `ctx.sessionReferenceResolver.prepare` 得到一条不受信上下文。
- **外部输入进会话**：桥接器/定时器把外部事件作为 `user/message` 注入是文档明示的 pattern（user/message 的 synthetic 来源明确包括 **cron notifications、skill content、file-change 通知** 等 `agent.inject()` 上下文，`source` 字段区分三者）。注入即产生可重放、可投影的历史；同样可附带 log-only 的桥接记录事件保留原文。
- **显式持久化屏障**：需要“已 durable”保证的时机显式 `await ctx.sessions.flush(session)`（返回是否有人参与）；不要信任 turn 边界会自动 flush。dispose 会做最终排空，因此桥接器的缓冲也要挂 ctx.effect/disposer 里清空。
- **被 model 拒绝的自定义注入源 distinguishability**：`source` 字段是类型标签，用它做展示分支，不要猜（“让客户端无需靠相邻关系或扫描历史猜”是文档对相关事件族的要求——同一族的 start/update/result 必须携带同一稳定业务 id，如 `hook/invoked→hook/result` 用 `handlerId`、`tool/call→tool/result` 用 `callId`；钉钉消息族/定时任务族照做）。
- **定时任务的崩溃恢复思路**：自己拥有 standalone 开/关括号（如 `scheduler/run-start`/`scheduler/run-end`）时，借用 `session/end-seed` 语义判断旧括号是否已死；未匹配的 start 在 seed 前=上一生命周期遗留。不要自己写 `assistant/chunk` 或伪造 `turn/*` 边界——那属于 core invariant，未知输入会被拒绝或破坏重放。
- **遥测/审计**：若把钉钉进出站做成 ledger 镜像，可复制 `SessionTelemetryRecord` 形状（channel 区分 ledger/ops、attributes 极简、body 深拷贝、接收端按 id+seq 去重）；需要脱敏对外暴露时，用自己的 waterfall 事件逐条转换，且**永不改写规范日志**。

## 4. 不确定处（文档未明说）

- `session/title` 事件由谁、在什么触发条件（生成/更新算法、LLM 调用策略）下写入：本批文档只有最新胜出的 snapshot 类型与 `session/title-llm-request` 预派发记录，具体决策点在 `packages/session/session-title*`（未在本批精读范围）。
- 插件如何把外部消息真正送入模型（`agent.inject()` 的精确签名、fiber/inbox 关系）：本批文档只确认它是 `user/message` 的 synthetic `source` 之一，未给接口。
- 多 writer 并发安全的具体机制：文档明说“容忍并发写者需要日志之外的 liveness 信号”，但具体（锁/协调器）实现未展开。
- `session/flush` 的 scope 派发细节、`whenIdle()` 与 checkpoint policy 的精确时序组合只在本批文档出现结论，无源码级细节。
- JSONL 后端的具象行格式（Zstandard 帧的具体校验/分块参数）依赖 source 而非本页。

## 5. 相关联术语/事件名列表

- 核心事件：`turn/start` `turn/end` `step/start` `step/end` `user/message` `assistant/message` `assistant/chunk` `tool/call` `tool/result` `todo/write` `request/header` `request/context` `session/end-seed`
- 插件合并事件：`compaction/start` `compaction/summary` `compaction/end` `compaction/prune`、`hook/invoked` `hook/result`、`approval/asked` `approval/decided` `approval/policy`、`sandbox/mode`、`goal/change`、`command/run` `command/done`、`session/title` `session/title-llm-request`、`schedule/change`、`agent/inbox/spliced`、`agent-preset/selected`、`feedback/record`、`plan/mode`、`permission/preset`、`llm/retry` `llm/retry-started`、`subagent/descriptor`、`tool/code-dispatch(-start)`、`tool-workflow/run-(start|end)` `agent-(start|end)`、`web/deepseek-search-llm-request`
- 类型/API：`SessionEventMap`、`SessionEventType`、`SurfaceEventType`、`SurfaceOp`、`SurfaceIntent`、`sourceEventSeqs`、`ignorable`、`deriveMessages()`、`Session.surface`/`replaceGeneration`、`SessionHeader`、`SESSION_FORMAT_VERSION`、`firstLiveSeq`、`TurnEndReasonMap`(含 `interrupted`)、`ctx.sessions.{create,prepare,enter,announce,fork,get,list,flush}`、`ctx.sessionPersistence.{locate,create,append,prepare,load,inspect,readFrom,list,listSnapshots,readRaw}`、`SessionPersistenceRevision/Snapshot`、`SessionLocation`、`SessionProjectionDefinition`（`key/schema/init/apply/view/stateVersion`）、`ProjectionSnapshot.asOfSeq`、`ctx.sessionProjectionCache.{write,coldSnapshot,cachedSnapshot}`、`ctx.sessionQuery.{filterSessions,filterEvents,readSession,readSurface,readTitle*,traceSession,traceEvent,readEvent,searchSessions,searchEvents}`、`SessionRecord{live,persisted}`、`SessionEventSurface`、`SessionReferenceResolver.{listCandidates,prepare}`、`ctx.compaction.{compactIfNeeded,compactNow,compactRegion}`、`CompactionTrigger`、`ManualCompactionErrorCode`、`SessionTelemetryRecord`、`SessionTelemetrySeverity`、`SessionTelemetrySharingStatus`、`session-telemetry/record`(waterfall)、`foldSurface()`、`foldRequestHeader()`
- 事件/目录：`session/created` `session/disposed` (emit)、`session/event` (emit)、`session/flush` (parallel)、`agent/error`、`agent/pre-step`、`agent/inject`(synthetic 来源)
