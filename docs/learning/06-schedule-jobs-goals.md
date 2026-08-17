---
title: Schedule 定时 / Jobs 后台 / Goals 目标
description: DSH 本地 docs 精读学习笔记（来源 docs/06-*）——Schedule 定时 / Jobs 后台 / Goals 目标
tags: [schedule, jobs, goals]
date: 2026-08-17
status: learning-note
---
# 学习笔记 06：Schedule 定时 / Jobs 后台任务 / Goals 目标管理

> 来源精读（英文版）：
> - `docs/subsystems/schedule.md`（186 行）
> - `docs/subsystems/jobs.md`（290 行）
> - `docs/subsystems/goal.md`（277 行）
> 类型定义源：`packages/schedule/schedule/src/types.ts`、`packages/jobs/jobs/src/types.ts`、`packages/goal/goal/src/types.ts`。

---

## 1. 核心概念与机制

### 1.1 Schedule：Session 本地的可持久化提醒

**本质**：Schedule 拥有"可持久化的提醒"，提醒到期后以普通后续对话回合的形式回到原始 live Session。没有外部通知通道、没有冷 Session 调度器。

**Schema（v1 记录联合）**：`ScheduleRecord = OneShotScheduleRecord | EveryScheduleRecord`，其中 `OneShotScheduleRecord = AfterScheduleRecord | AtScheduleRecord`。

- `AfterScheduleRecord`：`{ id: ScheduleId; kind: 'after'; prompt: string; afterSeconds: number; scheduledAt: string }` —— 由正数秒延迟创建的一次性提醒，保留提交时的延迟值。
- `AtScheduleRecord`：`{ id; kind: 'at'; prompt; scheduledAt }` —— 由绝对时刻创建，只存结果瞬间。
- `EveryScheduleRecord`：`{ id; kind: 'every'; prompt; everySeconds: number; scheduledAt }` —— 固定频率循环提醒，`everySeconds` 最小 300 秒（5 分钟），且**锚定到创建时刻**（creation-anchor-aligned）。

**身份/规范**：`ScheduleId` 是 branded id，Session 内唯一永不复用。创建时会把**每个首个目标**规范化成"四位数字年份的 RFC 3339 UTC `scheduledAt`"。

**绝对时间输入**：`AtInput = string | LocalAtInput`。
- string 形式必须**带 offset** 的 RFC 3339；
- `LocalAtInput = { date; time; time_zone }`，其中 `time_zone` 必须是显式 UTC 或 IANA Area/Location 区域。

**时区边界（关键）**：官方 Web overlay 为每次提示采样浏览器的 IANA 时区；time-context 提示模型在唯一无歧义浏览器时区下解释自然语言时间，混合或缺失来源则要求模型询问。但**这不是持久化 Session 默认值**：模型仍必须在 string 形式带 offset、local 形式带 `time_zone`。**Schedule 本身从不读取浏览器、Session、进程或模型上下文**——时区解释完全发生在工具边界之外。

**输入校验拒绝**：非法 offset、非法 zone、无 offset 的字符串、非未来目标、夏令时(DST)空洞内的本地时间；DST 重叠期选**第一个更早**的时刻。成功后只存规范 UTC `scheduledAt`，因此**重放(replay)不依赖任何环境时区状态**。

**固定频率与追赶（catch-up）**：
- `every_seconds` 是**逐条记录**的固定频率，协议里**没有日历/Cron 表达式、无循环时区、无共享冷却、无跨记录准入门**。
- 若 Session 在多个目标之间处于冷/忙状态，一条 Every 记录**只贡献其最新一期**到期项：派发时直接推进到"决策时刻之后第一个与创建锚点对齐的目标"，**不枚举、不持久化、不重放错过的区间**。若下一目标无法放进四位数字 UTC 年份，则最后一次派发终止该记录。
- 多条 Every 记录同时过期且无一次性提醒到期时，**每条贡献一次**进入同一个 follow-up 批次，按"目标时刻 + 创建顺序"排序；各 Every 记录保持独立状态，但**同批次所有派发使用同一个决策时刻**。批处理限制模型回合数，5 分钟下限限制每记录定时器频率。

**持久化变更与重放**：v1 的 `schedule/change` Session 事件是**唯一的持久化权威**（"log-only"）。
- create：存完整记录；
- delete：**终态、仅 id** 转移；
- 一次性 dispatch：也是**终态、仅 id**；
- Every dispatch：携带墙钟决策时间 `acceptedAt`，通常**推进**活动记录而非终止它。
- "派发"仅表示 follow-up 已**同步入队**，不代表模型回答成功或用户读过。
- **严格解码器与 fold**：拒绝未知版本、多余字段、复用 id、一次性/Every 派发形状不匹配、对非活动记录的 delete/dispatch。
- **Fork 边界**：fork 只 fold `SessionHeader.seedLength` 之后的事件——保留历史但不继承父 Session 的活动提醒（子 fork 无父提醒）。

**活动视图与管理**：
- `ScheduleState = 'scheduled' | 'overdue'`；`ScheduleDeliveryMode = 'session-local'`（固定 v1 边界：原 Session 必须 live）。
- `ScheduleView = ScheduleRecord & { state; deliveryMode }`，工具值 = 持久化记录 ⊕ 基于当前墙钟的派送状态。
- 工具：`schedule_create` / `schedule_list` / `schedule_delete`（schema 在 tool-catalog）。
- 管理调用与到期工作**在同一 Agent 作用域队列中串行化**；每次读/决策先等共享 Session 持久化屏障，create 与真实 delete 在追加后**再等一次**。
- 屏障失败报 `persistence_uncertain`（不猜测 eager 写是否提交）。完整错误码：`invalid_prompt`、`invalid_selector`、`invalid_rule`、`invalid_time_zone`、`not_future`、`time_out_of_range`、`frequency_too_high`、`corrupt_schedule_log`、`internal_error`。

**live 派发**：
- 进程本地 owner 从持久化 fold 推导**最早定时器**，每次有界等待后**重新读墙钟**。
- 冷 Session 不做任何工作；重新打开时重建定时器并把已过目标置为 overdue。
- **到期一次性提醒优先，一次进入一个后续回合**；无一次性到期时，全部 overdue 的 Every 组成上述单一批次。
- 到期工作等待 Agent **完全空闲**并**认领 maintenance 阶段**后：重 fold 状态 → 采样决策 → 排队一个 `followup()` → 追加相应 dispatch change。**从不调用 `steer()`，从不打断当前回合**。
- 通过普通会话转写(transcript)呈现，Schedule 本身**没有**独立持久化 Web receipt 或浏览器渲染器。
- 若 framing/同步入队失败，则**不记录派发**、提醒保持活动。入队到持久化派发之间的**窄崩溃窗口**可能重复提醒内容 → 语义是**best-effort at-least-once（至少一次，尽力而为），而非 exactly-once**。

### 1.2 Jobs：后台任务运行时

**身份与状态**：`JobId` 是 branded id，格式 `<kind>-N`；**访问控制靠 owner 授权而非 id 保密**。`JobKindMap` 通过声明合并扩展，registry 把 kind 当**不透明 id 命名空间**（内置 `bash`、`subagent`）。`JobStatus = 'running' | 'stopping' | 'completed' | 'killed' | 'failed'`；生产者特有事实放 `JobSnapshot.detail`。

**生产者契约**：
- `JobStart = { kind; label; outputLimitBytes?; owner?: Agent; run(): JobHooks }`。运行时在调用 `run()` 前**完成 preflight**，之后提交且**无后续可失败步骤**；`run()` 同步返回 hooks，只调用一次，抛错则不留注册，生产者必须清理部分启动的资源。
- 职责划分：**生产者拥有执行资源，运行时拥有身份、访问与生命周期状态**。
- `JobHooks = { cancel(reason?): void; done: Promise<JobOutcome>; readOutput?(): string }`。
  - `cancel` 必须同步、幂等、最终 settle `done`；reason 逐字转发。
  - `done` 在**生产者释放资源后**解析（而非仅"工作结束"），不许 reject（运行时把 reject 转 `failed`）。
  - `readOutput` 缺省 = 纯最终输出型任务；每个任务一个消费游标。
- `JobOutcome = { status: 'completed' | 'killed' | 'failed'; detail?; output? }`。

**消费者视图**：`JobSnapshot` 是**每次调用全新的只读投影**（绝不泄漏 live registry 状态），字段 `{ id; kind; label; outputLimitBytes?; ownerSession?; status; detail?; startedAt; finishedAt?; reported }`。
- `ownerSession` 携带授权用共享 `SessionId`；完成监听器**单独**收到精确 owner 对象（用于生命周期清理）。
- `reported`：某 kill/read/wait/teardown 已报告或承诺报告终态后置真，抑制其他完成报告者的冗余通知。teardown 会认领它（被销毁的 owner 没有读者，否则每个 teardown 层都烧一次模型请求）。
- `JobRead = { text; snapshot }`：流式任务返回自上次读取的**消费性增量**；最终输出型任务在运行期间为空、settle 后给幂等终态输出（永不被消费）。

**Service 行为（`ctx.jobs` → `JobRegistry` 抽象接缝）**：
- 方法：`start(spec): JobId`、`list(caller?): JobSnapshot[]`、`get(id, caller?): JobSnapshot`、`read(id, caller?): JobRead`、`kill(id, caller?, reason?): 'requested' | 'already-finished'`、`wait(id, timeoutMs, caller?, signal?): Promise<JobSnapshot>`、`onJobDone(listener): disposer`、`onJobsChanged(listener): disposer`、`attachController(name): disposer`。`LocalJobRegistry` 是进程本地 Provider。
- 语义要点：
  - 注册**存活于生产者与控制器 fiber 之外**；owner/service 销毁会 cancel 存活工作并 await 合规生产者；抛异常的 teardown cancel 只 force-fail 记录；teardown 也把记录标记 reported。
  - 有主任务访问按 owner session id**围栏**；id 可预测，故授权（非保密）才是边界。
  - **结算为 first-wins**：一个终态记录、释放所有等待者、一轮含内监听通知；**完成通知最后宣布**（在记录提交且所有其他观察者看到之后），因为报告者可能同步开模型回合。
  - `start` 在**无附加控制器服务该 owner** 时拒绝开始——生产者不能开始 owner 无法收集/停止的工作。一个 registry 服务进程内所有 composition；从无作用域上下文注册的监听/控制器服务**所有** owner，从 agent composition 作用域注册的只服务该作用域下组成的 agent。
  - `onJobsChanged` 不是 `onJobDone` 的超集：前者不做终态通知、不标记 reported、无交付含义。
  - 队列/准入：`maxConcurrentJobsPerOwner` 默认 **10**，按**精确 owner** 计数 `running + stopping`，无主任务共享一个桶；终态生产者结算释放容量。

### 1.3 Goals：同 Session 目标管理

**身份**：`GoalId` 是 branded id；`GoalRef = { id; revision }` 是**比较并交换(CAS)** 身份，每次被接受的持久化变更都递增 revision。

**两分法（关键）**：**持久化 phase** 回答"目标发生了什么"；**进程本地 activation** 单独回答"续作消费者是否可开始下一轮"。`GoalPhase = 'active' | 'paused' | 'blocked' | 'complete'`。
- `blockedReason = { code; message }`：`code` 是策略选定的稳定 lower-kebab-case 代码（供路由），`message` 非空说明（给人/模型）。
- `GoalSnapshot = GoalRef & { objective; phase; blockedReason?; maxGoalRounds }`。
- `GoalView = GoalSnapshot & { roundsStarted; createdAt; updatedAt; activation }`——**前三个来自 session log 派生**，`activation` 是**永不持久化**的进程本地续作资格。

**持久化变更**：每个变更都是持久化的 `goal/change` Session 事件，payload 是**完整快照**或 **clear 墓碑(tombstone)**。
- `GoalSnapshotChangeMeta = { kind:'goal/change'; version:1; operation: 除 clear 外全部; goal; roundsStarted; createdAt; updatedAt }`。
- `GoalClearChangeMeta = { kind:'goal/change'; version:1; operation:'clear'; cleared: GoalRef; clearedAt }`。
- 严格 fold 与持久化投影**只从这些事件**派生生命周期；**inbox 变更不影响目标状态**。
- 续作消费者给每个被准入的 `user/message` 回合打上**正数顺序 round 号 + 当前 revision**（`GoalMessageSource = { kind:'goal'; goalId; revision; round }`）；**只有这些被准入的 `user/message` 事件推动 `roundsStarted`**。重放拒绝：非正数 round、缺口、陈旧 revision、停止态 phase、cap 溢出。

**请求与通知**：
- `CreateGoalRequest = { objective; maxGoalRounds? }`——省略的 cap 由服务配置内部解析（区分调用者省略与部署选择）。
- `EditGoalRequest = { objective?; maxGoalRounds? }`——至少一个字段（运行时验证）。
- `GoalChanged = { operation; ref; goal? }`——每次通知带被接受的操作与精确 revision；clear 省略 `goal`。

**Service 行为（`ctx.goals` → `GoalService`，仅由 owner Session log 支撑）**：
- `get(agent)` 读当前目标；`disarm(agent)` 只撤销**进程本地续作权**、不改持久化 phase/revision（生命周期 owner 卸载 driver 前调用，之后人工授权 `resume` 记录新 activation 边）；`create(agent, request)`——已完成目标可替换，其余当前 phase 必须先 clear 或 resume；`edit/pause/resume/complete/clear(agent, ref, ...)`（`@Remote` 标注，均校验 CAS revision）；`block(agent, ref, reason)`；`remoteExportCreate`（跨线远程边界）。
- `clear` 返回墓碑 ref，revision = 被清快照 revision +1。
- 事件：`goal/changed`（emit 模式），payload `{ agent; change }`，**匹配的 `goal/change` session 事件已先提交**；后台监听失败被包含；**作用域过滤派发**（`@deepseek-ai/dsh-scope`）——agent 作用域监听者只收到该 agent。

---

## 2. 关键设计决策与原因

1. **为何是事件日志而非配置**：Schedule/Goal 的全部权威状态都落在持久化 Session 事件流（`schedule/change`、`goal/change`）上，再通过严格 fold 重建活动视图。原因：a) **重放无副作用**——进程重启/冷 Session 唤醒后只需重 fold 事件即可精确重建定时器与目标，无需额外状态文件；b) **fork 语义可推算**——fork 从 `seedLength` 起 fold，天然获得"历史 + 空提醒/空目标"而不复制父的活状态；c) "工具调用"只是写入事件的入口，崩溃后事件日志本身仍可审计；d) 持久化屏障失败可报告 `persistence_uncertain` 而不会留下幻影状态。
2. **为何无 cron**：`every` 被刻意设计为**仅固定频率、创建锚定的重复**，且门槛为 ≥300 秒。决策意图明确——没有日历表达式、没有循环时区、没有共享冷却。这显著缩小了状态机（无"下次该哪天"的日历计算），配合"only latest due occurrence"的追赶策略，从根上避免了错过日程的累积枚举；`frequency_too_high` 错误码顺带防滥用。
3. **时区显式边界**：Schedule 绝不读取任何环境上下文决定时区，string 必须带 offset / local 必须带 `time_zone`，DST 空洞拒绝、重叠取更早。这使 "创建时刻"与 "派发时刻"完全可复现（只存规范 UTC）。
4. **会话本地交付即"交付"**：`session-local` 意味着"原 Session 必须 live"，提醒以普通转写回合到达、无独立 receipt。这是有意的 no-receipt 边界，权衡是交付语义只能做到 **at-least-once**（入队后才持久化派发的窄窗口风险）。代价与收益都写死了：不打断/不 `steer()` 当前回合在协作性上是硬约束。
5. **Jobs 的组合理念**：运行时拥有身份/访问/生命周期，生产者和控制器都是可插拔 fiber——`onJobDone`/`onJobsChanged`/`attachController` 都**按注册作用域**限定到 owner 集合。first-wins 结算 + 完成通知最后宣布，都是为了**每个终态只产生一次模型回合**（含 teardown 认领 `reported` 以避免每销毁层烧 token）。
6. **Goals 的 phase/activation 分离 + CAS**：持久 phase 与进程本地 activation 分离，配合 `GoalRef.revision` 的 CAS，使"会话恢复/driver 卸载后再 `resume`"成为显式、可记录重放的事件，杜绝竞态与陈旧覆盖。

---

## 3. 对「钉钉桥接器 + 自研定时任务插件」可复用的结论/代码模式

1. **用 Session 事件日志做定时任务状态源（不做配置文件）**：仿照 `schedule/change`/`goal/change` 模式，自定义任务的状态（创建/删除/已触发/推进）写成持久化 Session 事件，用严格 fold 重建活动任务视图。收益：重启后 cold Session 打开即可重 fold 恢复定时器；崩溃后不会出现"配置说有时它没了"。
2. **"只派发最新一期"的公倍数追赶策略**：若自研插件支持循环任务，直接抄 `every` 语义——锚定创建时刻、最小间隔、错过多个目标时**只贡献最新一期**并把下一目标跳到"决策时刻后第一个锚点对齐点"，绝不枚举/重放漏掉的间隔。这天然限制模型回合数。
3. **批量派发同一决策时刻 + 队列串行化**：多条到期任务在**同一 Admission batch** 内、用**同一决策时刻**入队一个 `followup()` 批次；管理操作（列表/删除）与到期派发在同一 Agent 作用域队列串行，简单的持久化屏障失败上报 `persistence_uncertain` 语义。
4. **"派发"="完成同步入队"，而不是"投递成功"**：先入队再记 dispatch 事件，接受 **at-least-once** 语义并在文档中标明窄崩溃窗口可能重复。对钉钉发送这类"宁重不漏"的业务非常合适；若需求是"不可重"，需自己引入幂等 key（读钉钉回执或本地去重）——文档明确承认框架只保证 at-least-once。
5. **Jobs 模式复用**：把"钉钉发送"做成 `JobKind`（扩展 `JobKindMap` 命名空间）生产者：`run()` 同步返回 hooks、`done` 在资源释放后 resolve、`readOutput` 消费流、owner 绑定 Agent 获得 session 围栏授权；容量用 `maxConcurrentJobsPerOwner` 控制。宿主侧用 `ctx.jobs` 的 owner-relative 语义时，注意**从与 owner 相同作用域注册监听/控制器**，否则会服务全部 owner。
6. **Todo/任务管理可借鉴 GoalService 的 CAS + phase/activation 分离**：用 `GoalRef.revision` 做原子更新，持久 phase（active/paused/blocked/complete）与"是否允许下一轮"分开存——重启不丢目标，续跑需显式 `resume` 记录 activation 边。
7. **严格解码与错误编码**：所有持久化变更加 version 字段，fold 时拒绝未知版本/多余字段/复用 id/对非活动记录的操作；对外暴露稳定错误码（如 `invalid_rule`、`not_future`、`corrupt_schedule_log`）供桥接层路由。

---

## 4. 不确定处标注（文档未明说）

- (文档未明说) `schedule` 工具与持久化屏障在**具体实现**中的等待/超时参数（文档只描述"wait for the shared Session persistence barrier"，未给超时值或可配置项）。
- (文档未明说) `EveryScheduleRecord` 创建时如果 `everySeconds` 被规范化（如非整锚点对齐）的具体取整/舍入规则（文档只说"creation-anchor-aligned"与"at least 300 seconds"）。
- (文档未明说) fork 后**新建**的 `user/message` 回合是否会被父 Session 事件影响（文档只交代 fold 边界 `seedLength`，未详述 fork 自身如何记录新事件）。
- (文档未明说) `onJobsChanged` 的触发时序与 `list` 下一次调用之间是否保证可见性（只提"只读重新读取而非累积增量"）。
- (文档未明说) `goal/change` 严格 fold 对 `roundsStarted` 的持久化到快照的一致性细节（快照里带 `roundsStarted` 又在事件里独立携带，文档未说明两者冲突时以谁为准）。
- (文档未明说) 挂起(unowned job)的 `wait`/`read` 实际如何被"任何调用者"授权（文档仅说开放给任意调用者直到 service 销毁）。

---

## 5. 相关联术语/事件名列表

**Schedule**
- `schedule/change`（持久化 Session 事件，log-only）、`ScheduleId`、`ScheduleRecord`、`AfterScheduleRecord`/`AtScheduleRecord`/`EveryScheduleRecord`、`OneShotScheduleRecord`、`ScheduleState`('scheduled'|'overdue')、`ScheduleDeliveryMode`('session-local')、`ScheduleView`、`LocalAtInput`(`date`/`time`/`time_zone`)、`ScheduleCreateChange`/`ScheduleDeleteChange`/`OneShotScheduleDispatchChange`/`EveryScheduleDispatchChange`(含 `acceptedAt`)、`session-local`、`followup()`、`steer()`、`persistence_uncertain`、`SessionHeader.seedLength`、工具 `schedule_create`/`schedule_list`/`schedule_delete`。

**Jobs**
- `ctx.jobs`（`JobRegistry`）、`LocalJobRegistry`、`JobId`(`<kind>-N`)、`JobKindMap`(bash|subagent)、`JobStatus`、`JobStart`、`JobHooks`(cancel/done/readOutput)、`JobOutcome`、`JobSnapshot`(`ownerSession`/`reported`)、`JobRead`、`onJobDone`/`onJobsChanged`/`attachController`、`maxConcurrentJobsPerOwner`、`start`/`list`/`get`/`read`/`kill`/`wait`、`first-wins`。

**Goals**
- `ctx.goals`（`GoalService`）、`GoalId`、`GoalRef`(`id`/`revision`)、`GoalPhase`(active|paused|blocked|complete)、`GoalBlockReason`(`code`/`message`)、`GoalSnapshot`、`GoalView`(`roundsStarted`/`createdAt`/`updatedAt`/`activation`)、`goal/change`（持久化 Session 事件）、`goal/changed`（emit 事件，作用域过滤）、`GoalSnapshotChangeMeta`/`GoalClearChangeMeta`、`GoalMessageSource`(含 `round`)、`CreateGoalRequest`/`EditGoalRequest`、`GoalChanged`、方法 `get`/`disarm`/`create`/`edit`/`pause`/`resume`/`complete`/`block`/`clear`/`remoteExportCreate`。
