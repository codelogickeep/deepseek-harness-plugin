---
title: 能力 seam 与端口子系统
description: DSH 本地 docs 精读学习笔记（来源 docs/07-*）——能力 seam 与端口子系统
tags: [seam, llm, shell, filesystem]
date: 2026-08-17
status: learning-note
---
# 07 Seams & Ports 学习笔记：seam 三角色模型、能力图与 shell/terminal/subprocess/filesystem/web 接线

> 来源：DSH 本地文档英文版 `docs/capability-seams.md`、`docs/graph-atlas.md`、`docs/module-graph.md`、`docs/subsystems/{llm-streaming,shell,terminal,subprocess,filesystem,web}.md`。全部内容为文档实际事实，无编造；拿不准处标注「(文档未明说)」。

---

## 1. 核心概念与机制

### 1.1 seam 三角色模型（定义 / 提供方 / 消费方）

`capability-seams.md` 明确：一个服务可以是「核心主干服务（core spine service）、可替换能力缝（swappable capability seam）、或捆绑/组合点（bundle/composition point）」。文档为每个服务维护一张表（来自 `scripts/gen-doc-graphs.ts` 的混合生成），列为：`ctx key`、`Role`（`core` / `seam` / `bundle`）、`Owner`（声明该服务的包）、`Implementations`（已知实现包）、`Direct consumers`（直接消费该服务的包）、`Companion plugins`、`Note`。

三角色模型的具体分工（文档反复出现同一句式，可概括为三条规律）：

- **定义方（Owner / Service Definition）**：如 `dsh-shell` 声明 `ctx.shell`、`dsh-subprocess` 声明 `ctx.subprocess`、`dsh-web` 声明 `ctx.web`、`dsh-fs` 声明 `ctx.fs`。该包持有抽象类契约和类型词汇，并**不实现底层能力**。
- **提供方（Implementations / Service Providers）**：各自以插件加载后向 `ctx` 注册为同名服务，**同一上下文只允许一份实现，加载第二份即抛错**（文档原话："one implementation per context; loading a second throws, which is cordis' standard duplicate-service behavior"）。如 `bash-local` / `bash-sandbox` / `pwsh-local` 都挂到 `ctx.shell`；`subprocess-local` 挂 `ctx.subprocess`；`web-search-exa` / `web-search-perplexity` / `web-search-deepseek` / `web-fetch-http` 都注册进 `ctx.web`；`fs-local` / `fs-sandbox` / `fs-e2b` 挂 `ctx.fs`。
- **消费方（Consumers）**：即模型对外的 tool + 内部桥。如 `tool-bash` / `tool-pwsh` 走 `ctx.shell`；`tool-fs` 走 `ctx.fs`；`tool-web` 走 `ctx.web`（它"owns the stable model-facing names"，即 `web_search`/`web_fetch` 的 schema、提示词与呈现）。关键原则：**换提供方不改动消费方的对外语义**——"A search-provider swap does not change how the model asks for a query"。

### 1.2 能力图（capability seams 图）

`capability-seams.md` 正文是一张 `mermaid flowchart LR` 图，节点分两类：
- `pkg_*`（包节点）与 `svc_*`（服务/`ctx.x` 节点）；
- 边 `a --> b` 表示：**包 --> 服务** 即该包声明/注册该服务；**服务 --> 包** 即该服务被该包直接消费；`..` 虚线边标了 `event gate`（如 `svc_fs -. event gate .-> pkg_fs_observation_policy`，表示策略插件不消费服务、而通过 fs/* 事件介入）。

`module-graph.md` 则给出**包间依赖图**：边 `a --> b` 表示包 a 依赖包 b，依据是各包 `peerDependencies`（文档称其为 canonical runtime-dependency signal）。注意区分：module-graph 反映编译期/运行时包依赖，capability-seams 反映运行时服务注册-消费关系。

值得强调的几个 seam 实例（文档原句/API）：

- `ctx.llm`（Role: seam，Owner `llm`）："Adapters register provider implementations; the loop and compaction call the provider-neutral stream service." 消费者只有 `agent-loop` 与 `compaction-basic`——**没有任何 tool 直接消费 llm**，模型调用全部经 agent-loop。
- `ctx.subprocess`（seam）：bash 执行器族、PTY 后端、LSP host、以及 out-of-process ACP/Codex/Claude Code 子代理后端全部通过它 spawn；"the service owns process coordinates, tree/session lifetime, stdio dispositions, terminal mechanics, and kill escalation"。
- `ctx.shell`（seam）与 `ctx.shellEnv`（core）分离：shellEnv 是"managed bash environment registry"，每个 shell 工具执行时收集一份可信 `DSH_*` 快照。
- `ctx.terminals`（seam）：注册表持有"exact-Agent session identity and cleanup"；backend 拥有终端机制；`tool-terminal` 暴露 owner 限定模型工具。
- `ctx.fs`（seam）带 Companion plugin `fs-observation-policy`——通过 `fs/*` 事件门（event gate）而非服务介入。
- `ctx.web`（seam）：search 与 fetch 两类 provider 注册到同一个 `ctx.web`；模型的稳定命名在 `tool-web`。
- `ctx.jobs`（seam）：producers（后台 bash、PTY 发送、子代理委托）注册运行中的工作；`tool-jobs` 是模型侧读取/列出/kill 的控制器；`jobs-local` 是进程内注册表。
- `ctx.workflowEngine`（seam）："One engine per context, as in bash, with no named-provider registry"——通用 workflow 与固定 Ralph 消费者起点 run，其 agent() 调用经 `ctx.subagents` 扇出。

### 1.3 模型适配器（ctx.llm / LlmRuntime）

`llm-streaming.md` 是极完整的适配器契约页。要点：

- **消息与内容块**：会话是 `Message[]`，Message 是"one identified, immutable role/source/content value"，字段 `id: MessageId`、`role: 'system'|'user'|'assistant'`、`content: ContentBlock[]`、`source: MessageSource`。ContentBlock 是**合并可扩展（merge-extensible）联合** `TextBlock|ReasoningBlock|ImageBlock|ToolCallBlock|ToolResultBlock`，按 `type` 键索引，新增模态必须同时落地 adapter/UI/compaction/durable replay 四条路径。来源也是合并可扩展总和 `MessageSourceMap`（`user`/`plugin`/`model`/`tool`）；产生方身份与呈现形式独立：`kind` 回答"谁产生的"，`form` 回答"这是什么信息"，取值 instructions/catalog/snapshot/notice/relay/recall，且**语义化、非视觉化**（颜色图标排序是消费者的业务）。
- **StreamChunk 裸协议**：`block-start`/`text-delta`/`reasoning-delta`/`tool-call-delta`/`block-end`/`usage`/`finish` 组成的**封闭判别联合**（`switch` 以 `assertNever` 结尾，加变体会在每个消费者处编译报错）。`block-end` 携带已组装的完整 ContentBlock，消费者无需自己重拼增量。
- **适配器契约（Adapter contract）**六条硬性规则：①`usage` 必须出现在 `finish` 前、`finish` 后什么都没有；②tool-call 的 `arguments` 全程保持 raw JSON 字符串（增量经 `argumentsDelta`，完整对象在 `block-end` 重字符串化）；③两种错误路径归一为一种 `LlmFailure`（可 throw 或 `finish {kind:'error'|'aborted', failure}`），agent 循环消费 `agent/request-error`，监听者可返回 `{kind:'retry'}`；④一次适配器调用 = 一次 provider attempt（适配器禁用库级重试，代理级恢复开启另一个 durable turn）；⑤provider 停滞在传输层有界（`streamIdleTimeoutMs` 默认 5 分钟，只在实际 `next()` 未决时 arm，映射到 `TIMEOUT`，早前的调用方 abort 保持 `ABORTED`）；⑥上下文溢出统一归一到 `CONTEXT_WINDOW_EXCEEDED` 代码（经 `isContextWindowExceededError()`），路由按 code 而非 provider 文本。另有：空补全是可重试错误（`EMPTY_RESPONSE`，`dsh-llm-retry` 默认重试）；每次 provider HTTP 请求必须带应用归属头（`attributionHeaders()` → User-Agent，`AppIdentity` 字段必须是公开产品事实、无密钥/路径/会话 id）；replay state 是 adapter 独有的，只有当历史 provider 与目标 provider 当前注册到同一个 adapter 实例时才传递。
- **LlmAdapter 抽象类**：`providerInfo(provider)`、`providerRetryPolicy(provider)`、`listModels(provider)`、`resolveModel(provider, model, signal)`，以及**唯一抽象方法 `stream(options: GenerateOptions): AsyncIterable<StreamChunk>`**。"subclass, implement stream(), and register one adapter instance with `ctx.llm.registerAdapter(providers, adapter)`"；`GenerateOptions.provider` 选择注册的 adapter，`GenerateOptions.model` 只传给 adapter、不必在生命周期开始时注册。重复 provider route 原子失败（`DUPLICATE_ADAPTER`）。
- **ctx.llm（LlmRuntime）**关键方法：`registerAdapter(providers, adapter): AdapterRegistrationHandle`（handle 带 `replace(providers)` 原子替换路由与 `()` 释放）、`listProviders()`、`registerConfigurableProviders(entries)`、`listModels(provider)`、`resolveModelInfo(provider, model, signal)`、`resolveCallConfig(config, signal)`、`prepareCall(config, signal): Promise<PreparedLlmCall>`（把配置解析与适配器注册绑到一次 dispatch，防 HMR 拼错 adapter 的 capability 结果）、`stream(options)`。
- **事件**：`llm/adapters-updated`（**emit**；载荷为空，provider 拓扑变化后消费者 re-read list*）、`llm/stream`（**waterfall**；包围每个流式模型调用，监听者可短接 `next()` 或自己产出 chunks；loop 构造的请求带 `markAgentLoopRequest` 标记且深冻结、内容只是会话日志的纯函数，监听者只能读不能改写）。
- **GenerateOptions**：`provider`/`model`/`reasoningEffort?`/`messages: Message[]`/`system?`/`tools?: ToolSchema[]`/`temperature?`/`maxTokens?`/`stop?`/`signal?`/`sessionId?`/`purpose?: 'compaction'|'session-title'`。`ToolSchema`（name/description/parameters JSON Schema）声明在 dsh-llm 而非 dsh-tools，因为它是循环每步都会组装的请求的一部分。
- **BlockAssembler**：唯一共享的增量组装实现 `push(chunk)` → `blocks()`/`usage`/`finish`/`replayState`/`message(source)`，容忍纯 delta 协议（无 block-start/end）、忽略已关闭 index 的 delta（防畸形适配器撑爆内存）。loop 一边把原始 chunk 记日志一边喂同一个 assembler。

### 1.4 shell 执行（ctx.shell）

`shell.md` 的拆分结构：Service Definition `dsh-shell`（`ctx.shell`）+ Providers `bash-local`/`bash-sandbox` (+pwsh) + Consumer `tool-bash`（`bash` schema）。**请求/规格分离（resolve 拆分）**：`ShellExecRequest`（command 必有；workdir/timeoutMs/stdoutMaxBytes 可选，由实现填充默认）与 `ShellExecSpec`（必填已解析值）。`ctx.shell.resolve(request)` 位于 tool 层与 executor 之间；文档称"Called between them (the repo's 'explicit > implicit at package boundaries' rule)"。`stdin` 与 `env` 是**受信任的进程内插件输入，tool-bash 不暴露**（hooks 桥用它把 JSON payload 写进 stdin）；`stdoutMaxBytes` 同样仅受信任插件可用，用于前台消费方在有限预算内解析完整 stdout。

- 前台 `run(spec): Promise<ShellRunResult>`：正交结果独立报告——`timedOut`/`aborted`/`signal`/`exitCode` 各是各自字段（进程可能同时超时且 exit 0，因为捕获了信号）；绝不把被截断的运行误读为成功。每个流是 `CollectedOutput`（截断时 `text` 是**尾部**，完整流 spill 到私有文件）。
- 后台 `start(spec): ShellProcess`：`start()` 返回无 id 无 owner 的句柄，由 `tool-bash` 适配成 `ctx.jobs.start()` 钩子、通用运行时再持有 job 身份与生命周期；`done` 在进程关闭时 resolve、永不 reject，`readOutput()` 是增量消费（连续读取不重发、丢了标 `lossy` 并给出 spill 路径），`kill()` 杀进程组、幂等。
- 沙箱事实 `ShellSandboxInfo`：`mode`/`denied`/`enforcement`/`runnerFailed`，与退出状态独立报告，从而区分命令失败、策略拒绝、runner 失败。runner 在命令运行前失败时前台抛 `SANDBOX_UNAVAILABLE`；模型收到的 denial/runner 事实在结果里；一次性更宽的 `sandbox_permissions`+`justification` 重试须 `ctx.approval` 先批准该确切调用。
- `ctx.shell` 三个抽象方法：`resolve(request): ShellExecSpec`、`run(spec): Promise<ShellRunResult>`、`start(spec): ShellProcess`。**实现语义约束**：run 只对基础设施失败 reject（非零退出/超时杀/abort 杀都以描述性结果 resolve）；start 立即返回、后台进程无 executor 超时。

### 1.5 persistent PTY（ctx.terminals）与 terminal / subprocess 关系

`terminal.md`：`TerminalSessionId` 是服务铸造的 branded id，授权比较**精确 owner Agent**，不按名字或猜 id（"authorization compares the exact owning Agent, not a name or guessed id"）。`TerminalWaitReason`: `stdin_read|inferred_idle|timeout|session_exit`，与 `TerminalSessionStatus`（running / exited）相互独立——静默或超时返回时顶层 shell 可能仍活着。

- `TerminalBackend`：稳定 `type` + `spawn(spec)`；`TerminalBackendSession` 持有 motd/pid/`startSend`/`read`/`signal`/`status`/`close(reason)`。
- `TerminalSessionService`（`ctx.terminals` API）：`registerBackend(backend)`、`listBackends()`、`spawn(owner, request, signal)`、`hasOwnerActivity(owner)`、`startSend(owner, id, request)`、`read(owner, id, request)`、`signal(owner, id, signal)`、`kill(owner, id, reason='model request')`、`list(owner)`。注意：**每个会话同一时刻只有一个活跃 send**（one active send per PTY session）。
- 持久化策略：PTY 状态与 raw 字节保持进程内（process-local）；模型输入与有界返回输出通过既有 `tool/call`、`tool/result`、task-result 路径持久化，**不复制一套 PTY 会话事件**。会话在 backend 或 tool 插件 reload 后保持存活。

`subprocess.md` 提供原始进程组机制（shell 文档明说"Raw process-group mechanics live behind the subprocess seam"）。`SubprocessRuntime`（`ctx.subprocess`）抽象方法三件套：`resolveExecutable(command, env, signal): Promise<string>`（绝对路径校验；裸名字走 scrubbed PATH+显式 env；含分隔符的相对路径被拒，因为解析基址未定义，provider 大声失败而非猜测）、`spawn(spec): SubprocessHandle`（**该 seam 不加默认值**——每个 disposition/limit/目录都显式；`argv` 永不 shell 解释）、`spawnTerminal(spec)`（唯一非管道进程原语：provider 分配控制终端、拥有 UTF-8 文本传输、前台进程组检查/发信号、一次等待的 TERM→KILL 到全会话静默）。`SubprocessHandle.terminate()` 是唯一终止动词：SIGTERM→grace→SIGKILL 全树升级（Windows 立即强杀）；`waitForExit()` 观察整棵树。`SubprocessOutcome` 只带 Node close 语义的 exit facts，**不做超时/取消分类**（调用者读自己持有的 deadline signal），不带输出（collected 流在 settle 后仍可读）。collect 模式 reader 是**基于全流字节偏移、非消费式**（`readFrom(fromByte)`），独立 reader 互不偷读；`CollectedOutput.text` 截断时为尾部。

**层级关系（文档关键结论）**：bash executor 族用 collected 批量输出 → subprocess；LSP 用 raw 协议管道；PTY backend 用 terminal 原语；ACP 子代理 backend 用 piped ndjson + 继承 stderr。`ctx.sandbox` seam 则让消费者把正要 spawn 的确切 argv 交给 same-world backend 包一层 per-call 策略并回报 enforcement。

### 1.6 filesystem（ctx.fs）与 fs/* 事件门

`filesystem.md`：四件套 = `dsh-fs`（`ctx.fs` + 原子文本操作 + 可选守卫）+ `dsh-fs-local`（本地盘）+ `dsh-fs-observation-policy`（通过**事件**而非服务记录 observed 状态）+ `dsh-tool-fs`（直接执行模型可读/写/编辑调用并渲染）。

- **目标身份**：`resolve(path) → FsTarget`（`targetKey` 是 branded 不透明明文——消费方必须不 parse 不假设本地绝对路径；`displayPath` 供模型/UI 展示）。跨能力坐标通过 provider 给出：`processPath(target)`（子进程可打开的规范绝对路径）、`fileUrl(target)`（provider 平台的 `file:` URI）、`contains(parent, child)`。
- **保鲜守卫**：`FsVersion` 是 backend 所有的不透明文件版本 token。写/编辑都接受**可选** `expected` 守卫：`FsWriteIntent = {kind:'createIfAbsent'}|{kind:'replaceIfVersion'; version}`，省略 = 无条件 create-or-overwrite（"no guard is expressed by omission"，不是第三个联合臂）。权限规则见下错误码段。`editText` 是**provider 级原子变更**而非 read+write 组合，守卫版本在校对文字前先查（stale → `FS_STALE_VERSION` 而非匹配失败）。
- **fs/* 事件门（政策词汇）**：`dsh-fs` 拥有三个事件，tool 是发射器、policy 插件是监听器，**发射器不依赖政策插件**因此共享词汇。`fs/write-intent` 与 `fs/edit-intent` 是**单槽（single-slot）决策 waterfall**：tool 以返回 `undefined` 的默认 thunk 发射，监听器不调 `next()` 自己完整决定；槽位 first-wins（policy 插件占位是约定而非强制不变量）。`fs/observed` 是 fire-and-forget 记录事件（`{kind:'present',version}` 或 `{kind:'absent'}`），**监听器必须同步且只做副作用**——tool 不守卫 emit，抛错的 listener 可能顶掉 read 错误或在变更成功后表现为 tool 的 isError。
- **observed 状态**：`WeakMap<owner, Map<targetKey, FsObservation>>` 存在 policy 插件内部；owner 通过把事件携带的不透明 `object` actor 收窄成 `FsObservationActor` 得到（通常 `exec.agent.session`，只用 WeakMap 键、从不读字段）。写决策：unseen/absent → `createIfAbsent`，present → `replaceIfVersion`；编辑决策：unseen → `FS_NOT_OBSERVED`、absent → `FS_NOT_FOUND`、present → 版本守卫。Disposal 丢弃一切（HMR 安全），policy 不做任何 IO。
- **错误分类**：`FsErrorCode` 稳定字符串（`FS_NOT_FOUND`/`FS_STALE_VERSION`/`FS_NOT_OBSERVED`/`FS_SANDBOX_DENIED`/`FS_TOO_LARGE` 等 13 个），`FsError` 继承 `HarnessError`/tool 注册表保留 `{name, code}` 供 retry/permission/UI 分支不用解析文本。`FS_SANDBOX_DENIED`（sandbox-enforcing backend 的策略拒绝）与 `FS_PERMISSION_DENIED`（宿主内核拒绝）区分开。
- **文件 IO 无超时**：read/write/edit **没有** `timeoutMs`，provider 契约不 arm deadline——这是刻意设计（见 2 节理由）。
- `ctx.fs`（FileSystem 抽象 seam）方法：`resolve`/`processPath`/`fileUrl`/`contains`/`stat(target)`（返回元数据非内容，absent → undefined）/`lstat(path)`（路径级 no-follow，可报 symlink）/`readText`/`streamText`/`readBytes(target, signal, maxBytes)`（必须完整内容上限，超限 `FS_TOO_LARGE` 而非截断）/`listDir`（稳定名字序、不读内容）/`writeText`/`editText`（都带可选版本守卫与 sandboxPolicy）。

### 1.7 web 服务（ctx.web，含搜索 provider）

`web.md`：一个 seam 横跨**两个操作**（search 与 fetch），在一个 `ctx.web` 上；两者共享请求 schema 但零共享业务逻辑。"one provider-selection policy owner, one abort/error vocabulary, one product-facing config API"。provider 注册的是**能力**（`WebSearchProvider`/`WebFetchProvider`），不是 tool；`dsh-tool-web` 拥有模型侧命名（`web_search`/`web_fetch`）、schema、提示词与呈现。

- `WebSearchRequest`：模型参数只有 `query`；`maxResults` 是消费方（`tool-web.searchMaxResults`，默认 8）传入的边界，seam 在返回时强制——provider 超发则截断 `sources[]` 并设 `truncated`。`WebSearchResult`：`content?`（provider 生成的答案文本；Perplexity 有、Exa/DeepSeek 无）、`sources[]`（便携引文形状：`url` 必有，`title`/`snippet`/`publishedAt` 可选——强制适配器编造会让 seam 说谎）、`truncated`。
- `WebFetchRequest`：只有 `url`。HTTP status 是**取到资源的状态而非自动失败**——成功网络抓取 404/500 返回带 statusCode 与有界 body 的 result；`WebError` 只留给无法安全取得/表示资源的情况。`WebFetchBody` 是**封闭判别联合**（html|text），消费者 `switch` 结尾 `assertNever`，加 kind 会在所有消费者处编译报错——这是刻意的协调性变更而非插件扩展。
- **Provider availability 规则**：`available(): boolean` 是廉价本地检查（凭证存在、配置可解析），**禁止网络调用**；是执行期选择输入而非健康系统。选择永不依赖注册/配置/HMR 顺序：显式 id（配置 `searchProvider`/`fetchProvider` 或同字段 env var）→ 该 provider；无 id 且恰一个可用 provider → 自动选；多可用无 id → `WEB_PROVIDER_AMBIGUOUS`（不是 first-wins）。错误码 split by owner：seam 中立码（`WEB_PROVIDER_UNAVAILABLE`/`WEB_PROVIDER_CONFIGURED_MISSING`/`WEB_PROVIDER_CONFIGURED_UNAVAILABLE`/`WEB_PROVIDER_AMBIGUOUS`/`WEB_DUPLICATE_PROVIDER`/`WEB_ABORTED`/`WEB_PROVIDER_ERROR`）由共享 `WebRuntime` 契约抛；fetch 传输码（`WEB_INVALID_URL`/`WEB_BLOCKED_URL`/`WEB_REDIRECT_BLOCKED`/`WEB_FETCH_TOO_LARGE`/`WEB_FETCH_TIMEOUT`/`WEB_UNSUPPORTED_CONTENT_TYPE`）由 `dsh-web-fetch-http` 实现拥有、别的 fetch backend 不必抛。`WebError` 的 `code` 是**开放字符串**（同 `LlmError`/`SubagentError`），provider 可自增码。
- API：`registerSearchProvider(provider)` / `registerFetchProvider(provider)`（重复 id 抛 `WEB_DUPLICATE_PROVIDER`，返回随 fiber 释放的 disposer）、`search(request, signal)`、`fetch(request, signal)`（非 2xx 是描述性结果不是 throw）。`dsh-web-fetch-http` 本地 fetch backend：只收 HTTP(S)、拒绝在 URL 中携带凭证、限制重定向/字节/字符/时间、每次同源重定向跳都重新校验、解码 body；**不阻断私网目标**（文档警告：别在能触达敏感内网的部署启用 `web_fetch`）。
- module-graph 佐证：`web-search-deepseek` 还依赖 `credentials`/`settings`/`agent`/`session`（凭证刮擦与用户配置）；`web-fetch-http` 依赖 `web`+`timeout`。

---

## 2. 关键设计决策与原因

1. **seam 化替代直接依赖，消费者面向稳定接口与稳定模型名**：换 bash 后端、换 fs 后端、换搜索 provider 都不触动 tool schema 与提示词。原因：稳定模型表面 + 可替换实现，是「单向扇出一个 provider 集」的股市价值核心。`tool-web` 甚至独立拥有 `web_search`/`web_fetch` 两个稳定名。
2. **"explicit > implicit at package boundaries"**：`ctx.shell.resolve()` 在包边界把可选字段显式化；`SubprocessSpawnSpec` 更极端——"This seam applies no defaults"，每个 disposition/limit/目录都在 spec 上显式，调用者自己的配置而非隐藏服务默认值决定一切。原因：隐藏默认值会让行为随 backend 漂移、难以审计。
3. **正交结果独立上报**：`ShellRunResult.timedOut/aborted/signal/exitCode` 各自独立（可能同时超时且 exit 0）；`SubprocessOutcome` 明确"carries NO timeout or cancellation classification (the caller reads the signal it owns)"。原因：进程层事实与服务层的意图分类分离——killed 是事实，为何被杀是调用者从自己 deadline 信号读出的判断。
4. **错误即数据、machine-routable code**：`LlmFailure.code`、`FsErrorCode`、`WebError.code` 都是稳定字符串，路由按 code 不按 provider 文本（如 `CONTEXT_WINDOW_EXCEEDED`、`FS_STALE_VERSION`、`WEB_PROVIDER_AMBIGUOUS`）；同时这些 code 是**开放枚举**（token 不写死在契约里），provider 可自增——但封闭联合（StreamChunk、WebFetchBody、FinishReasonMap）则刻意封闭以便 `assertNever` 编译器守卫。判据：**共享词汇用封闭联合、错误码/上下文表单用开放/合并扩展联合**。
5. **一次性适配器调用 = 一次 provider attempt**：适配器禁用库级重试；重试/回放/路由都在 `llm/stream` waterfall 或 agent 级 recover（`agent/request-error` → `{kind:'retry'}`）。`generateOptions` 回溯性从日志可重建（reconstructable requests）支撑回放。
6. **水的方向：决策在 listener、非在 emitter**：fs/write-intent、fs/edit-intent 是单槽 first-wins waterfall，policy 通过事件门介入而**不注册任何服务**、也不被 tool import。原因（文档原文）："so the emitter (dsh-tool-fs) and the listener (dsh-fs-observation-policy) share a vocabulary without the emitter depending on the policy plugin"——策略可卸载、裸 provider 契约不受污染。同理 `fs-observation-policy` 在 capability 图上只是 event-gate 虚线连接。
7. **文件 IO 刻意无超时**：syscall 最好情况也只能请求级 best-effort abort，`timeoutMs` 在写/编辑上会成为**无法强制的承诺**（不能强停进行中的 fsync/rename）；且隐式默认正好落在 explicit-over-implicit 禁区。只有进程后端（bash/web/subprocess 支撑的 glob/grep）才有真能杀工作的 deadline。
8. **持久化/状态边界**：PTY raw 字节进程内、模型输入与有界输出走既有 tool/call 路径，不重复造事件；fs observed 状态用 WeakMap<opaque owner>、从不读 owner 字段、HMR disposal 即弃。原则：状态与服务/会话生命周期绑定，进程内快速丢弃，可重建者（会话日志）才是持久真相源。
9. **尽力不诚信便说谎原则**：WebSearchSource 可选字段不强填、WebFetchBody 封闭、FsVersion/Sandbox 事实独立上报——宁可缺字段/标 truncated/标 lossy，也不假装完整准确。

---

## 3. 对「钉钉桥接器 + 自研定时任务插件」可复用的结论/代码模式

（本项目为 DSH/Cordis 动态插件方向，重点取可移植的 seam 写作模式。）

1. **给自己接 seam 的三段式文件组织**：定义方 = 抽象服务（新 seam 时；本项目大多消费现成 seam）+ 一个或多个提供方 = 具体执行插件 + 消费方 = 模型 tool / 内部桥。新插件若新增能力，仿 `dsh-web`：多个 backend（如钉钉的 open.api / stream 两种协议）注册成 provider 集，消费者只依赖服务接口与稳定命名。
2. **消费现有 seam 的推荐姿势**：
   - 要跑命令/脚本（定时任务的 `curl`、`sqlite3`、`node` 拉取）→ **绝不直 exec**，走 `ctx.subprocess.spawn(spec)`（显式 stdio、`{data}` stdin 批量形状、collect 输出、`signal` abort、`terminate()` 树级停）+ `resolveExecutable`（避免裸名路径歧义与注入）。
   - 要交互式/长期会话（钉钉长连接、tty 调试）→ `ctx.terminals`（owner 限定鉴权 + 单活跃 send + `kill(owner,id,reason)` 幂等清理）或 `ctx.subprocess.spawnTerminal`。
   - 要读/写/编辑文件 → `ctx.fs`（`resolve`→`stat`/`readText`/`writeText`/`editText`），并使用其**事件门词汇做自己的策略层**：想加"读前必观察"之类守卫时，注册 `fs/write-intent`/`fs/edit-intent` 单槽 waterfall 监听、`fs/observed` 同步记录，不依赖 tool、不注册服务。
   - 要搜网/抓网页 → `ctx.web.search({query, maxResults})` / `ctx.web.fetch({url})`，不要把 provider 细节带进业务层；错误按 code 分支（容忍未知 code）。
   - 要给模型回调用 → `ctx.llm`（`registerAdapter` + 抽象 `stream()`；若只是借用现成 provider，则 `ctx.llm.prepareCall`/`stream` 并处理 raw `StreamChunk`，用 `BlockAssembler` 组装，遵循 usage-before-finish 与 error-normalize 约定）。
3. **CSS 级可移植模式（强烈推荐照抄）**：
   - **request/spec 拆分**：对外方法收"人/模型友好"参数（全可选+默认），首个内部步骤 `resolve()` 返回全必填 spec。
   - **错误即数据**：插件抛 `HarnessError` 子类 + 稳定 `code`（若文档项目已有 `LlmError`/`FsError`/`WebError` 套路），UI/重试按 code 分支。
   - **正交结果独立字段**：超时/abort/信号/退出码分开报，绝不把一个被杀的任务当成功。
   - **封闭 vs 开放判别**：关键 wire 联合封闭（`switch`+`assertNever`），错误码与可扩展词汇开放（merge-extensible interface）。
   - **一次调用=一次尝试**：拉取逻辑禁库级重试；在插件层做显式指数退避 + `agent/request-error`（或自身错误事件）恢复。
   - **生命周期镜像**：所有注册（backend/provider/adapter/contributor）随 fiber 释放，返回 disposer；长任务注册进 `ctx.jobs`（或自建 registry 学 `jobs-local`），teardown 停并 await。
   - **状态取值最小化**：只读所需叶子字段、构造无 Host 引用的小对象（`Sessions` 等 live 对象不序列化），与文档"Data: do not serialize live data"一致。
4. **对"定时任务"的注意点**：文档未描述本仓库的自研定时 seam，但理论表明：调度器应作为**核心/捆绑点**（无 provider 注册表、一份实现、类似 `plugin-schedule` 依赖 `agent/session/session-persistence/tools` 的 kernel 形状），把"到点执行什么"与"如何执行"（走 subprocess/shell/terminals）解耦；每个到点的模型或脚本执行都通过上面 2 里的 seam 接线，而不是插件里裸 `child_process`——否则会与 DSH 的 sandbox/subprocess 生命周期/DSH_* 环境隔离脱节。

---

## 4. 不确定处（文档未明说）

- seam 表中 Role=`bundle`/`core` 的确切自动分类算法（capability-seams.md 只说"interface/implementation/consumer roles are classified in `scripts/gen-doc-graphs.ts` with a completeness guard"，未给规则明细）。
- `ShellExecRequest` 之外，Provider 是"一个实现 per context"——但**同一 ctx key 下多个同名 provider（如 `ctx.shell` 与 `ctx.fs`）是否允许共存/如何选择**未明说（各 seam 页只说 dup 会抛、类型不同时消费者如何路由未展开）。
- `llm/stream` waterfall 中 retry/replay 的具体实现包（`llm-*` 之外的 retry/ replay 逻辑归属）未被这两份文档给出文件名级说明（只说"retry, replay, routing"是 waterfall 的用途）。
- 后台 shell 进程的复杂收集缓冲区默认上限、spill 文件的保留策略（多久清理）文档未给数字。
- `dsh-terminal-bash` 与 `dsh-tool-bash-persistent`、`tool-bash-persistent` 的职责边界在本系列文档中仅间接可见（persistent PTY 靠 `terminal` seam）——确切交互未展开。
- `web-fetch-http` 的"allowed redirects"上限与私网保护是否可配、是否回环/局域网缺省即放行，文档只提醒部署方别暴露内网，未给配置项。
- 定时任务的属性归属（哪些事件驱动、是否与 goal/schedule/jobs 复用同一种 durable trigger）——文档未涉及，需查 `packages/schedule` 源码。

---

## 5. 相关联术语 / 事件名列表

- **术语**：capability seam、core spine service、bundle/composition point、Service Definition / Service Provider / Consumer、Owner package、Implementations、Direct consumers、Companion plugin、Adapters (LLM)、provider route、adapter registration handle、context window、reasoning effort、block assembler、request/spec split (resolve)、foreground run / background process、process tree、SIGTERM→grace→SIGKILL escalation、task-free handle、CollectedOutput / spill file、Exact-Agent authorization、PTY session、terminal wait reason、single-slot decision waterfall、event gate、FsTarget/targetKey/displayPath、FsVersion、observed state、provider availability(`available()`)、closed vs open discriminated union、merge-extensible interface、Branded opaque id。
- **ctx keys**：`ctx.llm`(LlmRuntime) · `ctx.subprocess`(SubprocessRuntime) · `ctx.shell`(ShellExecutor) · `ctx.shellEnv`(ShellEnvRegistry) · `ctx.terminals`(TerminalSessionService) · `ctx.sandbox`/`ctx.sandboxPolicy` · `ctx.fs`(FileSystem) · `ctx.web`(WebRuntime) · `ctx.jobs` · `ctx.subagents` · `ctx.workflowEngine` · `ctx.credentials` · `ctx.settings` · `ctx.approval`。
- **事件**：`llm/stream`(waterfall)、`llm/adapters-updated`(emit)、`fs/write-intent`(waterfall)、`fs/edit-intent`(waterfall)、`fs/observed`(emit)、`agent/request-error`(handling 可返回 `{kind:'retry'}`)、`approval/request`(waterfall)、`permission/preset`、`tech approval 相关`(tool-bash / tools 消费 approval)。
- **工具 schema 名**：`bash`、`pwsh`、`web_search`、`web_fetch`、`terminal` 相关 tool、`fs` 相关 tool（read/write/edit 各自在一层消费 `ctx.fs`）。文档中的工具 schema 名（文档未明说的确切字符串如 `fs.write` 全名）；注明于 tool-catalog。— 补注：文档直接使用了 `bash`、`web_search`/`web_fetch` 作为 schema/文件组织；fs 系列为 `dsh-tool-fs` 里的 read/write/edit。
- **包（前缀 `@deepseek-ai/dsh-`）**：llm / llm-deepseek / llm-pi-ai / llm-retry / llm-replay、agent-loop、shell / bash-local / bash-sandbox / pwsh-local / shell-env、tool-bash / tool-pwsh / tool-bash-persistent、terminal / terminal-bash / tool-terminal / tool-bash-persistent、subprocess / subprocess-local / subprocess-e2b / timeout、fs / fs-local / fs-sandbox / fs-e2b / fs-observation-policy / tool-fs / tool-fs-search / tool-str-replace-editor、web / web-search-exa / web-search-perplexity / web-search-deepseek / web-fetch-http / tool-web、sandbox / sandbox-local / sandbox-policy、jobs / jobs-local / tool-jobs、workflow / workflow-worker-thread / tool-workflow / tool-ralph、e2b / fs-e2b / subprocess-e2b、credentials / credentials-local、settings / settings-file、approval/acp、code-runtime、storage / storage-json / storage-sqlite / storage-domain、session-telemetry(-otel)、session-persistence(-jsonl/-sqlite)、plugin-schedule(? 见包 `schedule`) —— schedule 位于 module-graph 但 capability-seams 未列，为(文档未明说)。

---

*字数约 4200+。全部按文档实际内容转述；标"(文档未明说)"处为文档确未给出的细节。*
