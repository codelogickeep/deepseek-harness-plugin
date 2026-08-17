---
title: DSH / Cordis 原理总纲（论文级）
description: 基于 Cordis 论文（~/openproject/paper）+ 官方 reference + cordis-tutorial 的系统性原理沉淀：时空可组合性、可逆效应、反应式共效应、DSH 架构、轮次流程、会话日志、能力 seam、宿主/预设、定时任务真相。
tags: [dsh, cordis, principles, architecture, reference]
date: 2026-08-17
status: active
---

# DSH / Cordis 原理总纲（论文级）

> 本文是系统学习后的权威沉淀，来源三份：
> 1. **Cordis 论文**：`~/openproject/paper/paper.pdf`（88 页，2026-08-13 草稿）——「A Programming Paradigm for Spatiotemporal Composability」
> 2. **官方 reference**：<https://deepseek-harness.github.io/deepseek-harness/reference/>（DSH 架构总纲）
> 3. **官方 cordis-tutorial**：<https://deepseek-harness.github.io/deepseek-harness/develop/cordis-tutorial/>
>
> 目的：把 Cordis/DSH 的**准确原理**讲透，并**修正此前文档中的认知偏差**
> （如「插件只能动态定义」「code 无 schedule 工具」「定时任务应读配置」等）。

---

## 一、一句话总览

- **DSH（DeepSeek Harness）** = 让「模型 + 工具 + 环境」协作的 Agent 框架，**所有能力都是插件**，无特权内核。
- **Cordis** = DSH 底层的**元框架（meta-framework）**：一个**插件加载器 + 依赖注入 + 可逆副作用**运行时。核心承诺是**时空可组合性**（spatiotemporal composability）：
  - **时间可组合**：任何插件加载/卸载，其副作用**可被完整逆回**（temporal composability）。
  - **空间可组合**：插件间依赖**声明式 + 响应式**解析，依赖消失/出现自动激活/停用（spatial composability）。

---

## 二、理论地基：效应与共效应（论文 1–3 章）

### 2.1 两个正交维度

| 维度 | 问的问题 | 对应关系 |
| --- | --- | --- |
| **时间可组合性（Temporal）** | 组件卸载时，它对共享环境的修改能否**安全逆回**？ | 由**效应**（effects）刻画：程序对环境**做了什么** |
| **空间可组合性（Spatial）** | 组件之间的依赖能否**声明 + 响应式解析**？ | 由**共效应**（coeffects）刻画：程序**需要环境提供什么** |

- 静态设定下，时间可组合 ≈ 词法作用域（RAII），空间可组合 ≈ 模块 import。
- **动态设定**（插件运行时到达/离开）下，两者都难：效应作用域不固定、依赖会消失/改变身份。

### 2.2 可逆效应（Revertible Effects，论文 3.1）

核心思想：**每个对上下文的变换都携带显式逆变换**，运行时跟踪并组合，卸载时按 **LIFO** 回放。

- 效应建模为 `f : Γ → Γ × (Γ → Γ)`：应用后得到**新上下文 + 逆函数**。
- **效应上下文** `∂Γ = Γ × (Γ → Γ)`：`(当前状态, 逆累加器 φ)`。初始 `(γ₀, id)`。
- `track(f, g)` 把 `f` 应用到状态、把 `g` 组合进逆累加器。
- `recover` 用 `φ` 恢复初始状态并重置累加器为 `id`。
- **扭曲组合** `(f₁,g₁)∘(f₂,g₂) = (f₁∘f₂, g₂∘g₁)`：逆按相反顺序累积。

### 2.3 反应式共效应（Reactive Coeffects，论文 3.2）

- **共效应** = 组件声明的「我需要的环境依赖」（资源、权限、服务）。
- 每次上下文变化 → **通知**声明了相关键的组件，按规范分类为 activating / deactivating / neutral。
- **隔离（isolate）**：键 → 领域符号（realm symbol）间接层，不同领域同键 → 独立绑定。
- **拦截（intercept）**：键上的元数据，**读取时**才生效（如「该依赖只允许读某路径」），不触发重载。

### 2.4 统一上下文范式（论文 3.3）

- 效应上下文 + 共效应上下文统一为**单一 Context 类型** `Γ∞` —— 这是 Cordis 的编程范式。
- 共效应上的**观测等价**反过来给效应提供独立性（independence）。

> **本章核心结论**：Cordis 不是又一种 DI 容器。它把 effect/coeffect 从**编译期类型工具**提升为**运行时机制**，
> 让「动态加载/卸载且副作用逆回」成为**结构保证**而非作者纪律。

---

## 三、Cordis 运行时（论文 5.1，理论与实现对照）

论文 Table 2 给出理论与实现的精确对应——是理解 DSH 源码的钥匙：

| 理论概念 | Cordis 运行时 |
| --- | --- |
| 上下文 `Γ∞` | `ctx`（一等上下文，含当前系统一切已触碰状态） |
| `effect(𝑒)` / `effect_iter(𝑒)` | `ctx.effect(callback)` |
| 存储/隔离/拦截 | `ctx[@@store]`、`ctx[@@isolate]`、`ctx[@@intercept]` |
| `get/set` | `ctx.get(key)` / `ctx.set(key, value)` |
| `isolate(key, realm)` | `ctx.isolate(key, realm)`（派生子上下文，丢弃即恢复） |
| `intercept(key, metadata)` | `ctx.intercept(key, metadata)` |
| 组件实例化（fiber） | 组件 = `{ inject, apply }`，实例化为 **fiber** |
| 逆累加器 | `fiber.dispose` |
| 生命周期状态机 | `fiber.state`：ACTIVE / LOADING / UNLOADING / INACTIVE / FAILED |
| 依赖解析视图 | `fiber.committed`（提交视图）、`fiber.target` |

### 关键机制（必须掌握）

1. **`ctx.effect` 是唯一的副作用原语**。所有上下文变更（共效应设置、组件实例化、……）都归约为 `ctx.effect`，所以**一切副作用都有逆、都可逆**。返回的 `dispose()` 即逆函数，且**至多触发一次**。

2. **fiber 生命周期算法**（`refresh` → `reload` / `unload`）：
   - `refresh`：从共效应存储重算 `target`；若与服务中状态不一致 → 进入 reload（target≠⊥）或 unload（target=⊥）。
   - `reload`：提交依赖视图 committed → 执行 `apply(ctx, config)`（LIFO 收集逆）→ 若 target 仍是同一组 provider → ACTIVE；已变 → 链式 unload。
   - `unload`：**先等所有依赖方撤离完毕** → LIFO 执行全部逆 → INACTIVE；若期间 target 恢复 → 链式 reload（**热替换**）。
   - 支持「惯性（inertial）」：一次转变进行时不会被新转变打断；迭代边界还有部分回滚检查。

3. **`ctx.use(component, config)` = 组件实例化**，同时它自己也是一个 `ctx.effect`（父 fiber 的子），所以**卸载父组件会级联卸载所有子 fiber**。

4. **Proxy 属性访问**（`ctx[key]`）：沿 fiber 链向上找 committed 视图。声明了但未提交 → `INACTIVE_ACCESS`；到根都没有 → `UNDECLARED_ACCESS`。这构成**基于能力的访问控制**。

5. **声明式加载器**（论文 5.2）：
   - 配置树的每一项（entry）= `{ id, url, isolate, intercept, config, disabled }`，**一个 entry 声明一个 fiber**。
   - 加载器把「配置变化」翻译成 fiber 操作，**增量对账**（不整树重建）：id/url 变了→重建；isolate 变了→重挂 realm；intercept→原地更新；config→交给组件 diff；disabled→卸载/重载。
   - **HMR（热替换）**：源代码变更 → 分类 changed 模块 → 找出受影响 entry → 卸载旧 fiber（逆回全部副作用）→ 从新模块实例化新 fiber。**无需开发者标注接受边界**（对比 Webpack/Vite）。

---

## 四、DSH 架构（官方 reference 权威版）

### 4.1 核心命题

> **Cordis 是 dsh 底层的框架**：插件向共享上下文贡献服务、类型化事件和**可逆副作用**。
> 产品的每一部分都是插件，包括模型适配器、工具注册表、会话日志，以及 **agent loop 本身**。
> **不存在需要打补丁的特权内核**：扩展 dsh = 把插件挂载到其他插件旁边，各项注册都是副作用，插件卸载即撤销。

### 4.2 Profile 与组合包（Config，非「运行时注入」）

- 运行中的 dsh 是**一棵插件树**，由启动时按序叠加的各层组合而成。
- **profile** = 存放于 Harness home 的具名组装（如 `web`、`headless`），列出组合包、存放树外插件、保存用户 `cordis.patch.yml`。
- **组合包（bundle）** = Cordis 配置项 + 挂载代码的分发格式（`dsh-base` 第一层：模型/工具/持久化/沙箱/审批/设置/凭据/遥测；`dsh-web-app` 加浏览器；`dsh-headless` 加一次性运行器）。
- **层按序应用**：profile 列出的 bundle → 用户 `cordis.patch.yml` → home 级 patch → 任意 `--patch` overlay。patch 按 **id** 定位条目替换 config，或 insert 新条目。
- 本机查看实际配置树：`dsh --profile web --dump-config`。

### 4.3 核心包与 ctx 键

| 包 | 职责 | ctx 键 |
| --- | --- | --- |
| core/session | 仅追加的 SessionEvent 日志和内存存储 | `ctx.sessions` |
| core/system-prompt | 提示词片段与工具 schema 组装 | `ctx.systemPrompt` |
| core/tools | 作用域化工具注册表 + 带把关的执行流水线 | `ctx.tools` |
| core/agent | Agent 接口、活跃 agent 注册表、`agent/*` 事件 | `ctx.agents` |
| core/agent-loop | 实现 agent 接口的默认驱动器 | `ctx.agentLoop` |
| core/scope | 按 agent 划分作用域的注册原语 | （无 ctx 键）|
| llm/llm | 消息与流式词汇表 + 适配器 seam | `ctx.llm` |

### 4.4 事件三域（选对事件域是改动的第一个决定）

| 域 | 特点 | 用途 |
| --- | --- | --- |
| **会话事件** | 追加到日志、通过 `session/event` 广播的**持久事实** | 重载后仍需存在的状态（如 schedule/change） |
| **Agent 事件**（`agent/*`） | 携带活跃 Agent：inbox、步骤、状态、请求、验证、续跑 | 观察/拦截进行中的工作 |
| **能力事件** | 无需导入循环即可向 seam 附加策略/适配器（`fs/*`、`tools/*`、`telemetry/*`） | 横切能力 |

> 注意区分：`turn/*`、`step/*`、`user/message`、`assistant/*`、`tool/*` 是**持久会话事件**；
> `agent/pre-step`、`agent/request`、`llm/stream`、三个 `tools/*` 是 **waterfall 事件**（必须 `next()` 委托）；
> `agent/turn-stopping` 是 **serial 事件**（无 next()）。

### 4.5 轮次流程（精确事件时序 —— 我们已经实测验证）

> 一个**步骤（step）** = 一次模型请求 + 它调用的工具。一个**轮次（turn）** = 零个或多个步骤；
> 它在领取首条输入之前打开，在不再欠下任何工作时关闭。

```
turn/start
  claim next-step input plus one queued message
  assemble prompt sections + tool schemas
  → agent/pre-step              reject | enter(messages)
  (reject 或首次 enter 改写为空 → 关闭不含步骤的轮次)
step/start
  append entered messages as user/message
  derive model history from the log
  agent/request → llm/stream → assistant/chunk* → assistant/message
  tool/call* → tools/pre-execute → tools/execute → tools/post-execute → tool/result*
step/end
  (tools 欠另一请求，或 next-step input 到达 → claim → 下一 step)
  → agent/turn-stopping
turn/end
```

**对我们项目最关键的启发**：
- **`turn/end` = 一个轮次真正结束**（不再欠任何工作）。桥接器此前用「2.5s 去抖」判断回复完成是错的；
  用 `turn/end` 才是对的（已在钉钉 `/sched` 修复中实证）。
- `assistant/message` 可能在同一轮次出现**多次**（每 step 一次），只有最后一个 step 的才是最终回复。

### 4.6 会话日志（Answers「为什么要会话日志」）

> **会话日志是模型所见上下文的来源**。`deriveMessages()` 从中投影模型历史，原始 `assistant/chunk` 事件保证回放与 UI 保真。
> fork、恢复、transcript、遥测、持久化**全部派生自该事件流**。
> **模型可见即已记录**：抵达模型请求的一切都必须能从日志重建，并由运行时不变量断言。

这正是 `dsh-schedule` 采用「事件日志」作为状态真相的原因——**它是 DSH 唯一的持久事实源**。

### 4.7 能力 seam（seam）

- **seam** = 一项可替换能力，三角色：**Service Definition**（接口）、**Service Provider**（实现）、**Consumer**（消费方，通常是面向模型的工具）。
- 替换提供方 = 改变整个产品：文件系统/进程提供方共享同一执行世界，指向远程沙箱 = Bash/PTY/LSP 一起搬走；subagent 提供方在同一接口后从「新建子 agent」到「把轮次委派给另一产品」各不相同。

### 4.8 新行为归属（官方推荐动作 → 机制映射）

| 目标 | 机制 |
| --- | --- |
| 添加模型提供方 | `ctx.llm` 注册适配器 |
| 添加面向模型的能力 | `ctx.tools` 注册；schema 进提示词组装 |
| 让会话拥有不同能力集合 | **组装 agent preset**；服务行需 `isolate` realm |
| 添加 shell 执行 | 注册 `ctx.shell` 后端；本地经 `ctx.subprocess` |
| 添加持久化终端执行 | 注册 `ctx.terminals` 后端 + `dsh-tool-terminal` |
| 添加用户命令 | `ctx.commands` 注册；无需模型轮次即可分派 |
| 添加后台工作 | `ctx.jobs` 注册；`job_*` 工具收集/停止 |
| 添加文件系统访问/策略 | `ctx.fs` 提供方，或监听 `fs/*` |
| 限制启动的进程 | `ctx.sandbox` 后端；消费方启动前包装 argv |
| 拦截请求/工具/轮次 | `agent/*` 或 `tools/*`；`agent/turn-stopping` 停轮次 |
| 添加模型可见上下文 | `agent.inject()` → 落下一次获准请求 |
| 添加 UI/编辑器集成 | 驱动 `ctx.agents` 并从 `session/event` 渲染 |
| 添加持久会话状态 | **扩展 SessionEventMap；从日志渲染和回放** |
| 生成会话标题 | 唯一的 `ctx.sessionTitle` 提供方 |
| 管理同会话目标 | `ctx.goals`；经 `agent/*` 续跑 |
| fork 活跃会话 | `ctx.sessions.fork(source, boundary?, childSessionId?)` |
| 将注册项限定到单个 agent | 使用该 agent 的 `agent.ctx` |

---

## 五、Agent Preset 与「两类插件」的真相（修正过往认知）

### 5.1 预设（preset）就是「agent 层的组合包」

- 每个 agent preset（`code`/`cordis`/`standard`/`minimal`）是一份 **agent 平面组合** `agent.cordis.yml`，挂载在一个 agent 的 scope 下。
- 每个 preset 的 agent **都是 Cordis agent**（有 `agent.ctx`），只是**能力集合不同**：
  - `code` = standard + Code Mode SDK（模型写 TS 程序一步多操作）。
  - `cordis` = standard + **自指 Cordis 工具集**（能读写/作者化运行时）——它是「让 Agent 改 DSH 自己」的 preset。
  - 两者都是 root agent，插件（含 dsh-schedule）**都会安装**。

### 5.2 修正：插件 API 不是「运行时注入」专属

- DSH 插件的**正规落地方式**是 **host composition / agent preset 里的插件行**（`cordis.yml`/`cordis.patch.yml`，或 preset 的 `agent.cordis.yml`），**随启动加载、持久存在**。
- 「动态插件」（本会话的 `cordis_define` + `cordis_run`）只是**当前进程内的临时实验机制**，重启即失，不是 DSH 插件的主体形态。
- 因此上一版 `PLUGIN-ECOSYSTEM.md` 把「B 类 = 运行时动态插件、无实体文件」的表述**是错的**：B 类的正确定位是**配置树里的插件行**（有源码、可 patch、HMR 生效）。

### 5.3 修正：本机 profile 结构

```
~/.dsh/profiles/web/
  cordis.yml / cordis.patch.yml     ← 用户 profile 组合（我们在此 insert minimax/schedule）
  plugins/                          ← 树外插件（name: ./plugins/xxx.mjs）
~/.dsh/.env                          ← 用户层环境（launchEnvironment 快照）
```

---

## 六、定时任务机制的真相关（dsh-schedule）

### 6.1 为什么不读「配置文件」

官方程式的准确表述（论文/README/官方 reference 交叉验证）：

> **The Session event log owns reminder state; timers, tool values, and model follow-ups are disposable projections of that log.**
> （**会话事件日志拥有提醒状态**；定时器、工具值、模型后续动作都是该日志的**可丢弃投影**。）

原因链：
1. DSH 的「持久事实」模型 = 会话事件日志（4.6）。定时任务是需要**跨重启存在**的状态 → 按官方指南（4.8「添加持久会话状态 → 扩展 SessionEventMap；从日志渲染和回放」）应当进日志，而不是另建配置文件。
2. 定时任务是**状态机**（create → dispatch → delete / 推进），不是静态表。事件日志天然表达「创建、触发、删除」的时序；配置文件快照会和运行状态漂移。
3. 日志保证**可审计、崩溃可重放**；配置文件没有这种保证。
4. `schedule_list` 工具本身也是**现算折叠**日志得出的（不是读配置）——「配置化 = 快照投影」，官方把「真相」固定在日志里。

### 6.2 运行机制（已验证源码）

- `schedule_create/list/delete` 是**会话作用域工具**，`agent/created` 后装在 root agent 的 `agent.ctx` 上。
- 三条规则：`after_seconds`（正安全整数延时）、`at`（绝对时刻，禁止过去）、`every_seconds`（≥5 分钟固定速率，满足 `MIN_EVERY_INTERVAL_SECONDS`）。
- 每次操作：preflight → 折叠日志 → append 事件（create/delete/dispatch）→ checkpoint（`ctx.sessions.flush`）；持久化不确定返回 `persistence_uncertain`，绝不把未确认的 live 后缀当结果。
- 触发引擎（`ScheduleRuntime`）：每个 root agent 一个 timer 投影；折叠日志算出**最近到期目标**，arm timer；唤醒后重读墙钟（时钟回拨不提前触发、前跳标记 overdue）。
- 到期时（agent idle）：构造 `user/message`（`source.kind='plugin'`、`plugin='schedule'`，文本带 `[SCHEDULE REMINDER]` 前缀），`agent.followup()` 入队 → Agent 开启一轮新处理。
- 一次性任务 dispatch 后移除；`every` 任务 dispatch 后推进到下一锚点（**无跨会话共享、无 cron 语法**——这是它的已知局限）。

### 6.3 官方 Schedule 子系统页的关键补充

> 官方还有一个专门页面：`/reference/subsystems/schedule`（「仅限 Session 内的 Schedule」）。

- **定位**：持久提醒是「作为普通后续对话轮次返回原 live Session」；**不存在外部通知渠道或 cold Session scheduler**，交付模式固定 `session-local`。
- **三种规则**：`after`（正安全整数秒）、`at`（显式绝对目标：严格 RFC3339 UTC 字符串或本地日历对象 + 显式 IANA 时区）、`every`（≥300 秒固定速率；**无 Cron/日历规则**）。每个目标归一化为四位年份 RFC3339 UTC `scheduledAt`。
- **持久化**：v1 `schedule/change` 事件是**唯一持久权威**；严格 decoder/fold 拒绝未知版本、空字段、复用 id。一次性 dispatch 终结记录；every dispatch 携带墙钟判断时刻、**跳过错过的间隔**、超出四位数年份范围则终结；批量到期按目标+创建顺序排成单批次。
- **交付语义**：到期先等 Agent 完全 idle、认领 maintenance phase，再入队 `followup()`（**绝不调用 steer()、不中断当前轮次**）；只经普通 transcript 呈现，无独立 Web 回执；语义为「尽力而为的至少一次交付」，崩溃窗口外可能重复。

### 6.4 对我们项目的启示（为什么之前「读日志折叠」是对的）

- 桥接器的 `/sched` 直接 `session.history` 折叠 `schedule/change` → 与官方 `schedule_list` 同一抽象层，是**受官方模型支持的正确做法**。
- 误解修复：**code 模式的 root agent 也有 schedule 工具**（实测调用成功）。之前「code 会话没有」是错的；
  真正原因曾是**会话隔离**（每个会话只见自己日志里的任务）+ **时序**（fork/子 agent 无）。
- 若仍想要「配置文件」形态，正确做法是**在桥接器维护一份 schedules.json 快照**（= 日志的投影缓存），
  而不是绕过日志——因为触发与持久化仍应以日志为准。

---

## 七、对「自研定时任务」的架构建议（更新版）

回到你之前的需求（想要配置文件 + cron + 周期任务），在**完整理解 DSH 之后**，正确的落点：

- **不要让自研定时器脱离 DSH 的持久/触发体系**（否则失去可审计、可重放）。
- **推荐**：在 **host composition 里插入一个自研 cron 插件**（一个 plugin row，跑在本体的 Cordis 树里），它：
  1. 维护一份**人类可读的配置文件**（如 `schedules.json` / cron 表达式）作为**投影**；
  2. 用 DSH 的 **会话事件**作为追加事实（或至少把「已触发」记入日志）；
  3. 到点通过 `agent.inject()` / `agent.followup()` 唤醒目标会话；
  4. 桥接器的事件流捕获该会话输出 → 钉钉推送（现有链路）。
- 这样既有你要的「配置文件直观性」，又留在 DSH 的可靠模型内。
- 具体实现待你确认后再开工（当前任务已暂停插件开发）。

---

## 八、关键认知修正对照表（旧 → 新）

| 旧认知（本项目早期文档） | 新认知（论文 + 官方） |
| --- | --- |
| 「DSH 本体插件 = 运行时动态定义、重启丢失」 | 插件正规形态是**配置树插件行**（`cordis.yml`/patch/preset），启动即加载、可 HMR；动态 `cordis_define` 只是临时实验 |
| 「code 模式没有 schedule 工具」 | **code 也是 Cordis root agent，有 schedule 工具**（实测）；之前问题是**会话隔离** |
| 「B 类插件无实体文件」 | B 类是**有源码的插件模块**（如 `minimax-search.mjs`），经 patch 挂进配置树 |
| 「定时任务应该用配置文件读」 | DSH 的持久真相 = **会话事件日志**；配置文件只能是日志的投影 |
| 「去抖 2.5s = 回复完成」 | 正确完成信号 = **`turn/end`**（官方轮次流程明确定义） |

---

## 九、学习来源与延伸阅读

1. Cordis 论文 PDF（本机）：`~/openproject/paper/paper.pdf`；仓库（.git 目录）。
2. 官方 reference（架构总纲）：<https://deepseek-harness.github.io/deepseek-harness/reference/>
3. 官方 cordis-tutorial（动手实践，章节：第一个插件 → 生命周期与 effect → 服务 → 事件 → 配置 → 组合与 HMR → 进入 harness）：<https://deepseek-harness.github.io/deepseek-harness/develop/cordis-tutorial/>
4. 官方入门（概念精简参考），见 reference 站内「Cordis 入门」链接。
5. 社区拆解（辅助）：DeepSeek Harness 架构拆解（CSDN）、「微内核时刻」一文（腾讯云开发者社区）。
