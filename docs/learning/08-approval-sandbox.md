---
title: 审批、沙箱、权限与凭据
description: DSH 本地 docs 精读学习笔记（来源 docs/08-*）——审批、沙箱、权限与凭据
tags: [approval, sandbox, security]
date: 2026-08-17
status: learning-note
---
# DSH 学习笔记 08：审批流水线、沙箱后端、权限预设、凭据存储、设置子系统

> 来源：`deepseek-harness/docs/subsystems/{approval,sandbox,permission-presets,credentials,settings}.md`（英文版）
> 对应源码包：`dsh-user-approval`、`dsh-sandbox`/`dsh-sandbox-local`/`dsh-sandbox-policy`、`dsh-permission-presets`、`dsh-credentials`、`dsh-settings`

## 1. 核心概念与机制

### 1.1 审批流水线（`ctx.approval`，`ApprovalService`）

审批接缝回答的唯一问题是：**这一个具体动作是否允许继续**（"may this specific action proceed?"）。它拥有共享的请求/结果词汇表、`ctx.approval` 分发服务、`approval/request` 应答者 waterfall、log-only 审计事件对，以及每会话 `ask`/`never` 策略。

- **身份与结果**：每次 `ApprovalService.request()` 调用签发一个全新的 `ApprovalRequestId = Branded<'ApprovalRequestId'>`，用于把 `approval/asked` 与 `approval/decided` 两个审计事件配对，且不与 tool-call / agent / session id 互换。
- **结果类型（封闭、默认失败关闭）**：`type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'`。`allowed-once` 只授予被问的那个动作（一次性）；调用方在 `rejected`/`cancelled`/`unavailable` 上必须拒绝动作。一个缺失、非所有者、抛错或不符合同汇表的应答者都会落成 `unavailable`，而不是打开闸门。
- **每会话策略**：`type ApprovalPolicy = 'ask' | 'never'`。`ask`（默认）委托给组合成的应答者链，无应答者时链落入 fail-closed 的 `unavailable`；`never` 不触发任何应答者、确定性返回 `rejected`（无头场景如 CI、无人值守运行的严格姿态）。生效值是会话日志里**最后一条** `approval/policy` 事件，回退到服务配置。`setApprovalPolicy(session, policy)` 是唯一写路径，replay 可据此重建覆盖。
- **请求结构** `interface ApprovalRequest`：`agent`（为谁提问，路由+审计归属）、`toolName`、可选 `callId`（链接已流式展示的 tool call，实参不在此重复）、可选 `reason`、可选 `signal`（中止即撤回，请求立即落成 `cancelled`，迟到的应答被丢弃）。
- **分发与审计**：`ctx.approval.request(req)` 要求请求会话处于**开放的 turn 内**（审计对必须被持久日志的 commit/replay 边界包住；idle ask 在追加任何东西前就 reject）。先追加 `approval/asked`，得到一个结果，再追加匹配的 `approval/decided`，最后 resolve。`never` 策略在 waterfall 分发**之前**由服务内部强制，即使之后用 `prepend` 注册的应答者也无法绕过。应答者返回一个结果即占有唯一决策位，或调用 `next()` 委托。
- **方法签名**：
  - `setPolicy(agent: Agent, policy: ApprovalPolicy): void`（切换活的 agent 策略并为其下一次模型步排队转换；会话初始化直接用 `setApprovalPolicy`，因为没有先前可见的策略可改）
  - `async request(req: ApprovalRequest): Promise<ApprovalOutcome>`（`allowed-once` 是唯一授予）
  - `overrideOf(session: Session): ApprovalPolicy | undefined`（读会话覆盖，不应用配置默认）
- **事件**：`approval/request` 是 **waterfall** 模式，签名 `(this: Scoped<ApprovalService>, req, next: () => Promise<ApprovalOutcome>)`，支持 `@deepseek-ai/dsh-scope` 按 agent 作用域过滤分发。
- 模型可见性：审计事件是 log-only 的，不进模型 transcript；模型看到的是「调用方派生的工具结果 + 当前 runtime-context 快照」。策略状态以全量快照形式贡献给 runtime-context 快照，model 可读。

### 1.2 沙箱后端（`ctx.sandbox`/`ctx.sandboxPolicy`）

把同世界的子进程 argv 包装进文件效应策略，不把消费者耦合到某个平台 runner。`dsh-sandbox-local` 提供 Linux bwrap/Landlock、macOS Seatbelt、Windows ACL restricted-token 三族后端；`dsh-bash-sandbox`/`dsh-pwsh-sandbox` 是消费者。容器/microVM/远程执行是另一类整体能力接缝的兄弟实现，**不提供** `ctx.sandbox`。

- **模式**：`type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'`。**只管辖文件效应**，不涉及网络和进程可见性。`read-only` 请后端拒绝写——POSIX runner 额外授予其 shell 需要的 `/dev/null` sink；Windows ACL runner 不授予显式可写根，并如实上报 ambient ACL 空档为 partial。`workspace-write` 允许在 workspace 根和后端承诺的临时区写。`danger-full-access` 绕过禁锢。
- 只有前两个模式能发给 provider：`type ConfinedSandboxMode = Exclude<SandboxMode, 'danger-full-access'>`。一个 `danger-full-access` 消费者直接 spawn 原始 argv，**不调用** `ctx.sandbox`。
- **强制完整性**：`type SandboxEnforcement = 'full' | 'partial'`。`full` 表示后端管理该模式承诺的每个文件效应；`partial` 表示活动后端或旧内核 ABI 只管辖子集（当前实例：旧 Landlock ABI、Windows ACL 的 Everyone/hard-link 边界）。要求绝对边界者不得把 partial 当 full。
- **每调用策略** `interface SandboxExecutionPolicy { mode; workspaceRoot; sessionId? }`：完整策略每次能力调用都解析并随调用携带（含 `danger-full-access`，好让消费者一次解析再决定是否绕过）。正常工具调用从调用会话的**不可变 cwd** 派生 `workspaceRoot`；部署配置是无 agent 调用的回退。根先用文件系统语义 canonicalize，再做词法归一——含 `symlink/..` 的 cwd 也会定位到被 spawn 进程真正运行的目录。`sessionId` 是 branded `dsh-session` SessionId，后端按其键存每会话状态（如 windows-acl 给每个会话/workspace 对随机私有临时目录和 SID），缺省时（agentless）回退为每调用后端状态。
- **解析**：`ctx.sandboxPolicy.resolve(request: SandboxPolicyRequest = {}): SandboxExecutionPolicy`，其中 `SandboxPolicyRequest { session?; mode? }`——显式已批准 mode 覆盖 > 会话最后 `sandbox/mode` 事件 > 部署默认。`overrideOf(session)` 读会话覆盖。**只有禁锢执行才到达 `ctx.sandbox`**，其 provider 策略在保留相同根的前提下收窄 mode——这使并发会话/消费者/一次性提升重试能用同一个 provider 问不同边界而不改 provider 状态。
- **核心 API**：`abstract confine(argv: readonly string[], policy: SandboxPolicy): ConfinedArgv`。`argv` 是**精确的 argv**（程序+参数，不是 shell 字符串），shell 形消费者传 `['bash', '-c', command]`；空闲 ask 之外的失败以 `SandboxUnavailableError`（code `SANDBOX_UNAVAILABLE`) 抛出，无可用后端时。**对禁锢策略而言，静默的非禁锢直通永远非法**——confine 必须返回有强制力的 argv，或在包装/runner 执行时 fail closed。
- **包装 argv 与分类方言** `interface ConfinedArgv { argv; enforcement; denialSignatures; runnerFailureRules }`：
  - `argv`：包装后的 argv（runner、profile、分隔符、然后是调用方 argv）。
  - `denialSignatures`：**所选后端**的拒绝方言——bwrap 只读 bind 的 EROFS 文本、Landlock 的 EACCES、Seatbelt 的 EPERM。消费者匹配 stderr 时必须用**该后端这一份**，不能跨后端做并集（并集声称某后端从不产生的拒绝）。
  - `runnerFailureRules`：结构化 `RunnerFailureRule[]`。判定「runner 在命令执行前失败」：先用可选 `allowedExitCodes` 门控，再按大小写不敏感**整行相等**剔除 `informationalLines`，然后在剩余每行 stderr 内做**大小写不敏感子串**匹配 `fatalSignatures`。**退出状态本身永远不足以证明 runner 失败**。runner 失败=命令根本没跑（基础设施故障）；denial=禁锢工作正常并拦截了命令。消费者先查 runner failure，再查 denial signatures。
- 后端一端的运行配置/探测/缓存/强制上报属于 `dsh-sandbox-local`（README）；spawn 与结果归因属于 bash 消费者（README）。

### 1.3 权限预设（`ctx.permissionPresets`，`PermissionPresetService`）

把两个独立旋钮——沙箱模式（`sandbox/mode`）与审批策略（`approval/policy`）——捆成命名预设，客户端把它作为一个 Permissions 选择器。它是**可选能力**，不是 agent-loop 主干；**不拥有任何强制**——执行、prompt 叙述、replay 照旧读各自的旋钮折，预设切换只记录意愿并穿透各旋钮的规范 setter 写入。

- **预设表** `interface PresetSpec { sandbox: SandboxMode; approval: ApprovalPolicy; name?; description? }`；`Config.presets?: Record<string, PresetSpec>`。默认表只有两个：`workspace-write`（workspace-write + ask）与 `danger-full-access`（danger-full-access + never）。名字 `custom` 被保留给**派生的非预设状态**：表里叫 `custom` 会在插件加载时抛错；对不禁锢（无 `sandboxMode` 能力事实）的 bash executor 组合预设也会在加载时抛错（因为预设捆绑了沙箱模式）。`defaultPreset` 缺省时取与服务组成默认值匹配的预设。
- **当前预设与派生 `custom`**：`current(events: readonly SessionEvent[]): string` 从旋钮而非自身事件派生——折起会话有效沙箱模式（回退到 executor 配置模式）和有效审批策略（回退到 approval 服务配置、再 `ask`），优先选一个仍匹配的记录选择，否则按声明序第一个匹配的表项，否则返回 `CUSTOM_PRESET`（`'custom'`)。`custom` 只能被显示，永不作切换目标或事件载荷。
- **切换**：`set(session, name)` 解析预设（未知名抛错）；除非 `name` 已是有效预设，否则追加一条 log-only `permission/preset` 事件；然后仅对那些**有效值已变**的旋钮调用其自身 setter——`setSandboxMode`（来自 dsh-sandbox-policy）与 `setApprovalPolicy`（来自 dsh-user-approval）。选择事件在同 turn 内先于旋钮事件；**重选已有预设则什么都不追加**。
- `permission/preset` 是 durable、log-only 的用户意愿：不进模型 transcript（旋钮事件通过各自消费者拥有模型可见后果），存在它是为了让 `current()` 在两个预设共享同一 bundle 时仍能还原**用户选的是哪个**。`effectivePermissionPreset(events)` 折最后一条，replay 无需 catch-up 状态。
- 其它方法：`selectFor(state: KnobState): PermissionSelect`、`resolve(name: string): PresetSpec`（未知名抛错）、`optionOf(name): PresetOption`（表键或缺省 key 的 `custom`，其它名字抛错）。

### 1.4 凭据存储（`ctx.credentials`，`CredentialProvider` 抽象接缝）

把秘密从配置里挪走：settings 节与 `cordis.yml` 条目只携带**引用**（环境变量名），provider（如 `dsh-credentials-local`）拥有值，消费者**每次操作**解析一次。LLM 适配器每次模型请求解析一次，所以轮换的凭据无需重启就到下一次请求。贯穿全接缝的一条规则：**空存储值处处视为缺失**——`resolve` 跳过它、`describe` 报未配置，空白永不冒充已配置的秘密。

- **身份**：`type CredentialRef = Branded<'CredentialRef'>`，POSIX 风格环境变量名，构造时校验 shell 标识符语法。
- **解析**：`abstract resolve(ref): Promise<ResolvedCredential | undefined>`；`interface ResolvedCredential { value: string; source: string }`——`value` 是**非空**秘密值，`source` 是 provider 定义的层 id（本地 provider 用 `env`、`file`、`project-env`、`user-env`）。**逐操作重解析、绝不跨操作缓存**——每次操作读一次就是这个热更新机制。
- **描述（不泄密）**：`abstract describe(ref): Promise<CredentialInfo>`；`interface CredentialInfo { configured: boolean; source?; writable: boolean }`。本地 provider 对由活进程环境供给的引用报 `writable: false`——因为写了看似成功但解析仍返回遮蔽值，接缝直接拒绝，UI 可提前把该引用渲染成只读。
- **写**：`abstract set(ref, value): Promise<void>` 持久存到 provider 管理的可写源；只读源遮蔽引用时拒绝；空值拒绝（用 `unset`）。`abstract unset(ref): Promise<void>` 移除；移除不存在的引用是 no-op；被只读源遮蔽时同样拒绝。
- **事件**：`credentials/updated (ref)` —— `emit` 模式，在**已提交**的对 provider 管理源的变更（`set`/`unset`/存储内观察到的外部编辑）后触发；环境变量自身的环境级变化不可观察、永不触发。监听器失败被容纳并记日志（同步抛与异步拒绝一视同仁），不改变已提交操作的结果，除非是 `INVARIANT` 编码的失败——它在所有监听器跑完后 rethrow，而 rethrow 只能从**同步**监听器到达 emitter，所以该事件上的不变式检查不能是 async 函数。消费者不需要该事件（本就逐操作重解析），它服务于配置面刷新 "configured" 徽章。

### 1.5 设置子系统（`ctx.settings`，`SettingsProvider` 抽象接缝）

持有**一个用户所有的文档**，按每命名空间分节；每个已注册命名空间按「schema 默认 → 注册者组合 `base` → 用户节」解析。provider（如 `dsh-settings-file`）存原始文档并把外部编辑推进来；消费者插件注册 schema 并读/观察解析值。组件配置留在 `cordis.yml`——命名空间只携带用户可编辑子集。

- **身份**：`type SettingsNamespace = Branded<'SettingsNamespace'>`，构造校验 **lowercase-kebab-case** 语法。
- **注册**：`abstract register<T>(ns, schema: z<T>, options?): SettingsScope<T>`，把 schemastery schema 绑定到调用插件 fiber 上——**dispose 该 fiber 就移除命名空间及其观察者**。重复注册 fail loud。
  - `interface SettingsRegisterOptions<T> { base?: Partial<T>; applies?: SettingsApplies; validate?: (value: T) => void }`：
    - `base`：组合层值（entry-config 子集），解析在用户层之下。
    - `applies: 'live' | 'restart'`：UI 提示而非机制——`restart` 所有者从不 watch，构造时读一次，配置面可给它打"待生效"徽章；默认 `live`。
    - `validate`：schema 无法表达的约束（跨字段要求、字段间有效性依赖）。`validate` 抛错会**拒绝产生该值的写**，调用方在 `update/replace/mutate` 处立即得知，而不是存一个会静默禁用 owner 的值。owner 注册后，存储的节若 fail validate，与 schema 失败一样：**保留命名空间最后一个好的值并告警**（外部编辑的文档不能拖垮运行中的 owner）；**注册时**若已存的节就 fail，注册本身被拒（此时尚无 last-good）。dsh-llm-pi-ai 用它拒绝无法服务的 provider profile。
- **Owner 作用域** `interface SettingsScope<T>`：
  - `get(): T`（schema 默认 → `base` → 用户层）。
  - `watch(cb: (next: T, prev: T) => void | Promise<void>): () => void`：每次提交后调用；同回调的多次调用**异步、一次一个、按提交序**；rejection 被容纳记日志；disposer 返回后不再启动新调用（已排队者跳过；已开始的让它 settle，服务 disposal 等它）。
  - `update(patch)`：稀疏补丁**只合并进用户层**（绝不进 `base`）。
  - `replace(section)`：整体替换用户节，是**删除/重置路径**——替换中缺失的键重新继承 `base` 和 schema 默认（`replace({})` 全部重置）。两者都只收 JSON 兼容数据（非 JSON 值在持久化前以路径报错）。
  - 同命名空间写按调用序串行化；解析值是对外 **deep-frozen 快照**。
- **描述符与脱敏**：`abstract describe(options?): SettingsDescriptor[]`。`interface SettingsDescriptor { ns; schema（schema.toJSON()）; value; revision; base?; user?; applies; secrets? }`。`revision` 是原始用户节的单调版号——写时作为 `expectedRevision` 回传可拒绝过期写（`SettingsConflictError`）。`{ redactSecrets: true }` **在每个 wire 表面都是强制的**：从三层（value/base/user）剥掉 `role('secret')` 字段并枚举其 `{path, set}` 槽位，页面可渲染只写输入而永不收到秘密。
  - 持只有脱敏描述符的调用方**无法安全重建整个节**，所以删除以**路径操作**传输：`type SettingsPathOp = { op: 'set'; path: readonly string[]; value } | { op: 'unset'; path }`。`mutate(ns, ops, expectedRevision?)` 按队列到达时的节应用（后 op 观察前 op），调用方既不必复述未触碰的字段、也**不能删除它从没见过（被脱敏）的字段**；`replace` 仍是整体重置路径。
- **提供方**：provider 实现 `load`/`persist`（原始文档）并通过 `Settings.publish` 推送外部变更；基类拥有命名空间注册、解析、校验、变更检测与 `settings/updated` 提交事件。`prepareDocument(): Promise<string | undefined>` 为原生编辑器准备用户文档（文件类 provider 可先物化缺失文档再返回路径；非文件存储返回 undefined）。
- **变更提交事件**（都是 emit）：
  - `settings/updated (ns, next, prev, source)`：**解析值**已提交变化的消费者事件；`type SettingsUpdateSource = 'update' | 'provider'` 区分两个入口；**解析值 deep-equal 时永不触发**。监听器失败容纳记日志，`INVARIANT` 例外同凭据事件（不变式检查不能 async）。
  - `settings/document-updated (ns, revision)`：原始用户节变了（无论解析值是否变化），供配置面得知"字段从继承变覆盖"以及持有的 revision 过期。监容纳同一套。

## 2. 关键设计决策与原因

1. **封闭 + 默认失败关闭的结果集**：`allowed-once | rejected | cancelled | unavailable`。任何异常（缺解法、非所有者、抛错、非词汇返回值）都归拢到 `unavailable`，调用方除 `allowed-once` 外必须拒绝。理由：审批的默认立场是「没被明确允许就不该发生」；一个宽松的默认会造成越权执行的静默通道。
2. **`never` 策略在 waterfall 之前强制**：服务内部在分发前短路，即便后来 `prepend` 更高优先级的交互应答者也无法把决定权重新打开。理由：主观意愿（如 CI/无人值守）应该是决定性的，不受应答者组合顺序影响。
3. **`ApprovalRequestId` branded 且每次请求新签**：把审计对配对起来，又拒绝把审批 id 与 tool-call/agent/session id 互换。Branded type 贯穿五个文档，是 DSH 防止「字符串跨包/跨进程混用」的统一手法。
4. **请求不含实参，用 `callId` 关联已流式展示的 tool call**：避免第二份可能漂移的参数副本；答案是**闭式（closed）**的同一进程只读问题。
5. **审计事件 log-only、不进模型 transcript**：审计归审计、模型可见归模型可见（派生工具结果 + runtime-context 快照）。让重放/回滚可从持久日志重建全部覆盖状态。
6. **沙箱只封文件效应，模式语义最小化**：网络、进程可见性在词汇表之外；`danger-full-access` 直接从消费者绕开（连 `ctx.sandbox` 都不调用），保证"全放行"路径零包装开销。不同沙箱消费层用**同一 provider 问不同边界**是靠「每调用携带完整策略、provider 只收窄模式不持状态」实现的。
7. **强制完整性如实上报（full/partial）而非假装全管**：旧 Landlock ABI、Windows ACL 的 Everyone/hard-link 做不到绝对边界就标 `partial`，要求绝对承诺者必须拒绝/呈现这一差异。这是对安全边界诚实的一种实现。
8. **permission-presets 只是「写下意图 + 穿透 setter」，不拥有强制**：旋钮事件照旧承担模型可见后果与执行；`permission/preset` 事件纯为在共享 bundle 时还原用户选择了哪个预设。两旋钮一预设的捆扎是 **UI 便利**，不是又一个强制层。
9. **凭据「引用进配置、值留 provider、逐操作解析」**：旋转凭据无需重启即生效，天然与持久化/日志分层；空值处处视为缺失，堵住"空白冒充已配置"的坑；`describe` 永不泄值、并如实报只读/遮蔽拒绝写。
10. **设置「确定性合并顺序 + validate 后置校验 + revision 乐观并发 + wire 强制脱敏 + 路径操作防删未见字段」**：合并序保证解析可重放；`validate` 在 schema 之后跑、因而能看到 defaults 与 base 与 owner 完全相同的视图，写时失败早而准；脱敏/路径操作保证了配置 UI 即使持不完整视图也不会误删秘密字段。

## 3. 对「钉钉桥接器 + 自研定时任务插件」项目的可复用结论/代码模式

1. **敏感值采用「引用-解析-逐操作」的凭据模式**：钉钉 app_secret、access_token、webhook 等一律不进 `cordis.yml`，存成 `CredentialRef`（环境变量名），每次发消息/刷 token 前 `resolve()` 一次，绝不跨操作缓存——token 旋转当天生效，无需重启。写代码时用 `ctx.get('credentials')` 读可选服务并处理 undefined（可选依赖模式）。
2. **配置面「三层解析 + 脱敏 + revision」可直接照搬**：定时任务的调度参数（cron、开关、目标会话）用一个 `settings` 命名空间管理，schema 默认 → 注册者 `base` → 用户节。`watch(next, prev)` 观察实时变更；`applies` 设为 `restart` 或 `live` 取决于调度器能否热重载。任何暴露给 Web 配置面的输出都必须 `describe({ redactSecrets: true })`，删除/覆盖用户节用 `mutate` 的路径操作或 `replace`，绝不从脱敏视图重建整节。
3. **工具执行的关键路径用 `ctx.sandboxPolicy.resolve()` + `ctx.sandbox.confine()`**：定时任务若拉起 shell/子进程，先一次解析 `SandboxPolicyRequest{ session, mode }`（显式已批准覆盖 > 会话 `sandbox/mode` > 部署默认），`danger-full-access` 时直接 spawn 原始 argv 不调 confine；只对 `read-only`/`workspace-write` 调 `confine(argv, policy)` 拿 `ConfinedArgv`。**绝不允许静默非禁锢直通**。stderr 判定必须先 runner failure rules（engine 没跑起来=基础设施故障，按 `allowedExitCodes`+剔除 `informationalLines`+大小写不敏感 `fatalSignatures`），再按**当前后端自己的** `denialSignatures`（EROFS/EACCES/EPERM 方言）归因"命令被拦截"，不要跨后端并集。
4. **审批的「封闭结果、允许的工具才 action」模式**：桥接器里的钉钉指令（如 "执行 X 命令"）若走审批，用 `catch (outcome)` 只认 `allowed-once`，其它一律拒绝并显式向钉钉回"已拒绝/不可用"；把一次性的"用户确认"观察为 `user/message` 后的结果，别把未获批状态当成已授权。
5. **事件驱动 + effect 生命周期**：所有 watch/observer/listener 注册在插件 fiber 上，dispose 后自动清理（settings 命名空间随 fiber 移除、credential/settings 监听器独立 effect-bound）。`settings/updated`、`credentials/updated`、`approval/request`(waterfall)、`approval/asked|decided`、`sandbox/mode`、`approval/policy`、`permission/preset` 是现成的事件词汇，新插件应复用而非另造。
6. **组合预设模式（如果钉钉端要做"权限选择器"）**：预设=一个 `sandbox` 装订一个 `approval`，只记录意图并穿透各自 setter；两旋钮共享 bundle 时靠 `permission/preset` 事件还原用户选择。小型项目可直接在 UI 里并行展示两个旋钮，把预设当纯展示层。
7. **可重放的「最后一条事件决定当前值」模式**：策略/模式的覆盖都以「会话日志最后一条对应事件」为真相并用 `overrideOf` 读取——定时任务若要在特定会话临时降权/升权，应写 `approval/policy`、`sandbox/mode` 事件并依赖 replay 还原，而不是另开一份带外状态（replay 需要为真相）。

## 4. 不确定处（文档未明说）

- **`(文档未明说)`** `approval/asked` / `approval/decided` 两个审计事件各自的确切载荷字段与数据结构，本页只承诺"配对关系"，未给出二者 `emit` 签名。
- **`(文档未明说)`** 多应答者组成的确切顺序语义（`next()` 链的组织方式、`prepend` 的注册次序如何映射），只说明"第一个占有唯一决策位"。
- **`(文档未明说)`** 各 `sandbox/mode`、`approval/policy`、`permission/preset` 事件的确切载荷与"会话日志"的持久化格式，需要到 `persistence-catalog.md` / 各 `cordis.yml` 查证。
- **`(文档未明说)`** `SandboxUnavailableError` 之外，confine 包装期失败是否还有其它错误码/类型；本页只列了 `SANDBOX_UNAVAILABLE`。
- **`(文档未明说)`** `KnobState`、`PermissionSelect`、`SessionEvent` 的完整字段；`current()` 用它们但本页仅给签名。
- **`(文档未明说)`** settings-file provider 物化/持久化的缺省行为与 `cordis.yml` 中 settings 命名空间的具体占位写法（文档只承诺"组件配置留在 cordis.yml"）。
- **`(文档未明说)`** Windows ACL 后端之外，是否还有 macOS/Linux 上的 `partial` 实例演变（文档只点名旧 Landlock ABI 与 Windows ACL）。

## 5. 相关联术语/事件名列表

- 术语：`ApprovalService`、`ApprovalRequestId`、`ApprovalOutcome('allowed-once'|'rejected'|'cancelled'|'unavailable')`、`ApprovalPolicy('ask'|'never')`、`ApprovalRequest{agent,toolName,callId?,reason?,signal?}`、waterfall、Scoped
- 事件（approval）：`approval/request`(waterfall)、`approval/asked`、`approval/decided`、`approval/policy`
- 术语（sandbox）：`SandboxMode('read-only'|'workspace-write'|'danger-full-access')`、`ConfinedSandboxMode`、`SandboxEnforcement('full'|'partial')`、`SandboxExecutionPolicy{mode,workspaceRoot,sessionId?}`、`SandboxPolicyRequest{session?,mode?}`、`SandboxPolicy`、`ConfinedArgv{argv,enforcement,denialSignatures,runnerFailureRules}`、`RunnerFailureRule{allowedExitCodes?,fatalSignatures,informationalLines?}`、`SandboxUnavailableError`（code `SANDBOX_UNAVAILABLE`）、EROFS/EACCES/EPERM（后端拒绝方言）
- 事件（sandbox）：`sandbox/mode`；服务 `ctx.sandbox`（abstract `confine` ）、`ctx.sandboxPolicy`（`resolve`/`overrideOf`）
- 术语（presets）：`PermissionPresetService`、`PresetSpec{sandbox,approval,name?,description?}`、`Config{presets?,defaultPreset?}`、`CUSTOM_PRESET('custom')`、`PresetOption{value,name,description?}`、`KnobState`、`PermissionSelect`
- 事件（presets）：`permission/preset`
- 术语（credentials）：`CredentialProvider`、`CredentialRef`、`ResolvedCredential{value,source}`、`CredentialInfo{configured,source?,writable}`、层 `env|file|project-env|user-env`（本地 provider）
- 事件（credentials）：`credentials/updated (ref)`（emit）
- 术语（settings）：`SettingsProvider`、`SettingsNamespace`、`SettingsScope{get,watch,update,replace}`、`SettingsRegisterOptions{base?,applies?,validate?}`、`SettingsApplies('live'|'restart')`、`SettingsDescriptor{ns,schema,value,revision,base?,user?,applies,secrets?}`、`SettingsPathOp(op:'set'|'unset',path)`、`SettingsDescribeOptions{redactSecrets?}`、`SettingsUpdateSource('update'|'provider')`、`SettingsConflictError`、schemastery、`role('secret')`
- 事件（settings）：`settings/updated (ns,next,prev,source)`、`settings/document-updated (ns,revision)`（均 emit）
