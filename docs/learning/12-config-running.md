---
title: 配置目录、开发测试与运行
description: DSH 本地 docs 精读学习笔记（来源 docs/12-*）——配置目录、开发测试与运行
tags: [config, testing, running]
date: 2026-08-17
status: learning-note
---
# 学习笔记 12：配置目录 / 开发环境 / 测试 / rescope / API Gateway / 术语表

> 来源精读（英文版）：
> - `docs/config-catalog.md`（3151 行，生成文件）
> - `docs/development.md`（171 行）
> - `docs/testing.md`（49 行）
> - `docs/rescope.md`（53 行）
> - `docs/api-gateway.md`（164 行）
> - `docs/glossary.md`（45 行）

---

## 1. 核心概念与机制

### 1.1 Config Catalog：`cordis.yml` 的全部可配置字段

`config-catalog.md` 是**由脚本生成的"deployment 轴"参考**（`scripts/gen-config-catalog.ts`，改源码后跑 `pnpm run gen-config-catalog` 重新生成；不得手改；`verify-config-catalog` 属于 `doc-sync`）。它列出每个可加载 harness 包 `config:` 块能设置的**逐字配置声明（含 JSDoc）**——即其 `apply` 函数或服务构造函数实际收到的类型。要点：

- **`Requires:` 行**列出该插件 `inject` 的服务键：其 `cordis.yml` 树**必须同时加载这些服务的 Provider**，否则挂载失败。
- 生成器会交叉校验 schemastery 运行期 schema 与粘贴的声明：任何 schema 可校验的键（嵌套键同理）都必须能在声明的 config 类型上定位到，防拼接遗漏 loader 可接受的字段。
- **scope 维度**：子系统页是作者看到的 Cordis API 区，`tool-catalog.md` 是模型面对的工具 schema，config-catalog 是部署接线参考——三者是不同轴，别混用。
- 文件末尾分三类：**无 config 插件**（`@deepseek-ai/dsh-schedule` 在内，requires `agents·sessions·tools·sessionPersistence`；`dsh-api-gateway`、`dsh-api-remotes`、`dsh-users`…）、**Seam 包**（抽象服务类如 `dsh-shell`→抽象 `ShellExecutor`，不可直接加载，须加载具体实现）、**Library 库包**（无插件入口，`cordis.yml` 不能加载，如 `dsh-typert-generator`、`dsh-sdk-protocol`）。

与「定时任务」最相关的字段：

- **`dsh-tool-jobs`**：`waitTimeoutMs`（默认 30s）、`maxWaitTimeoutMs`（上限 10min，更大模型值被夹住）、`completionDelivery: 'wakeup' | 'quiet'`（完成后是否唤醒空闲 owner 开新回合）、`maxConsecutiveWakes`（默认 3，约束"被唤醒回合又启动作业又唤醒自己"的自激链）。
- **`dsh-jobs-local`**：`maxConcurrentJobsPerOwner`（每 owner 或共享未归桶内 running+stopping 作业数，默认 10）。
- **`dsh-sessions` 持久化**：`session-persistence-jsonl` 的 `root` **必填无默认**（理由：`process.cwd()` 会随 cwd 变化散落文件）；`packChunks` 默认 `true`（把连续 `assistant/chunk` 增量事件打包成 `text-chunks` 等行，无损、实测日志约小 60%）；`compression: 'zstd' | 'none'`（默认校验和的 Zstandard 帧）。`session-persistence-sqlite` 的 `journalMode` 默认 `wal`（`delete/truncate/persist` 用于网络挂载；`memory/off` 被排除，因违背持久性承诺）。
- **`dsh-storage-domain`**：`backend` **必填**（"没有放之四海皆准的介质"）、`routes: Record<domain, backend>` 按域路由到未注册后端会在 `open` 报 `backend-not-found`。`storage-json` 的 `root` 同样**无默认**。
- **`dsh-sandbox-policy`**：`mode` 默认 **`read-only`**（fail-safe 默认），`workspaceRoot` 默认 `process.cwd()`；runner 选择不在它身上（在 `ctx.sandbox` provider 的 config）。
- **`dsh-permission-presets`**：内置默认两个预设 `workspace-write`（workspace-write + ask）与 `danger-full-access`（danger-full-access + never）；`custom` 是保留的"非预设"派生态。
- **`dsh-user-approval`**：`policy: 'ask' | 'never'`——'ask' 委托给组合的 answerers（无则 fail-closed `unavailable`）；'never' 确定性拒绝一切（CI/无人值守）。
- **`dsh-system-prompt`**：`toolOrder` 需含 `TOOL_ORDER_REST` **恰好一次**，未知名 assembly 时失败，省略则字典序。
- **`dsh-llm-deepseek`**：API key 走 `apiKeyEnv`（默认 `DEEPSEEK_API_KEY`）**每请求解析**，缺钥失败码 `MISSING_CREDENTIAL`（不在插件加载时失败）；`thinking/reasoningEffort/maxTokens` 等。
- **`dsh-agent-tool-presentation`** 的 `mode` 是**必填而非默认**——因为省略等于"组合了什么都不做"。

### 1.2 开发环境搭建（development.md）

- **前置**：Node 支持 22.19+ 与 24+（CI 覆盖 22.19/24/26）；Corepack 启用的 pnpm（仓库钉 `pnpm@11.7.0`，`corepack enable` 可修复版本解析）；Git 2.26+；可选 DeepSeek API key。
- **首次**：根目录 `pnpm install`（同时经 `scripts/install-lefthook.mjs` 装 worktree-local Lefthook 钩子与 `dsh-translation-pairing` Git merge driver）；`pnpm run typecheck` 跑通即完成。
- **TS 双聚合布局**：Host 包进 `tsconfig.host.json`、Client 包进 `tsconfig.client.json`，因为**两侧都在相同键下对 cordis `Context` 做声明合并、服务不同**，一个 program 同时见两侧会报冲突。`tsconfig.base.json` 永不加 `include/files`；`api/remotes` 是唯一拆 Host/Client 双 tsconfig 的包。
- **构建顺序**：`tsc -b tsconfig.host.json` → `tsdown --env.DSH_BUILD_FACE host`（**Typert 只在此处运行**）→ `tsc -b tsconfig.client.json` → `tsdown --env.DSH_BUILD_FACE client` → `pnpm run build:web`。
- **环境变量**：`DEEPSEEK_API_KEY`、可选 `DEEPSEEK_BASE_URL`（默认公共 API）；真实凭据永不提交；真实 API e2e 无 key 自动 self-skip。
- **TODO 标记**：`FIXME`（阻塞发布）> `TODO`（尽快修）> `XXX`（将来再说）。
- **文档保持类型逐字同步**：用 ` ```ts type-equiv ` fenced code 并在 `scripts/type-equiv.manifest.json` 登记符号，`verify-type-equiv` 断言粘贴块与源码声明+JSDoc 一致。

### 1.3 测试分层（testing.md）

- **分层**：Unit（`pnpm run test`，vitest，每个 registry 都要有 HMR-safety 测试——dispose 贡献的 fiber 后断言清理）→ Coverage（`test:coverage` 对 `packages/*/*/src` **逐文件 100% 行覆盖**——漏一行常意味着该删的 dead code）→ Real-API e2e（`test:e2e` 有 key，按 key 自跳过：`EXA_API_KEY`、`PERPLEXITY_API_KEY`…）→ Snapshot（`test:snapshot`，keyless 期望输出）→ Web browser snapshot（`test:web`，Linux PR 必过，Chromium 对比 `apps/web/tests/snapshots/`）。
- **关键纪律**：
  - **with-key 政策**："我们是 DeepSeek,推理很便宜——不吝啬真实 API 测试"。无 key 测试只证明管道，with-key 证明确实能对真实模型工作；最高价值是 boot 真实 example、发一条 prompt、检查外部世界的 **smoke**。
  - **优先真实实现而非 mock**：只 mock 昂贵/不确定边界（LLM 适配器、网络、时钟）；桥接测试 `makeBridgeHarness({ withBash: true })` 用脚本 mock 模型 + 真实工具执行器。
  - **验证世界，而非自报**：e2e 断言要重跑命令/重读文件；测试自持资源（`afterEach` dispose）。
  - **测试真实入口路径**：产品可见插件需要非 unit 的 REAL-composition 测试——手工 `ctx.plugin(...)` 不够，要经 Loader 启 test-only `cordis.yml`；package `bin` 应跑构建产物 `lib/bin.js`（tsx 会掩盖问题）；集成 gate 走真实产物而非 `src`。

### 1.4 rescope：供应商包改名（rescope.md）

Cordis 框架与其基础库被 **vendor 在 `vendor/` 下并以 `@deepseek-ai` scope 发布**，因为每个 harness 包都把它声明为 peer dependency：用上游名字发布会"占座"注册表。映射表（节选）：

| 目录 | 上游名 | 发布名 | 版本 | 角色 |
|---|---|---|---|---|
| `vendor/cordis/` | `cordis` | `@deepseek-ai/cordis` | 4.0.0-rc.7 | Context/Service/Fiber/events |
| `vendor/cosmokit/` | `cosmokit` | `@deepseek-ai/cosmokit` | 1.8.1 | 共享工具 |
| `vendor/schemastery/` | `schemastery` | `@deepseek-ai/schemastery` | 3.18.0 | `Schema` 声明 config |
| `vendor/timer/` | `@cordisjs/plugin-timer` | `@deepseek-ai/cordis-plugin-timer` | 1.1.2 | **ctx 上的 disposal-aware 定时器** |
| `vendor/hmr/` | `@cordisjs/plugin-hmr` | `@deepseek-ai/cordis-plugin-hmr` | 1.0.15 | 插件/配置 HMR |

- 子路径导出路径不变（`@cordisjs/plugin-loader/repository` → `@deepseek-ai/cordis-plugin-loader/repository`）。
- **改名不触动的**：目录名/版本、依赖的**范围**（只改 key 不改 range）、Loader 的 `cordis:` 内置前缀（`cordis:include`/`cordis:group` 是协议前缀非包名）、`cordis.yml` 配置族（含 `*.cordis.snapshot.yml`、`cordis.patch.yml`）、名字含词 harness 包、上游运行期标识（`Symbol.for('schemastery')`）。
- 代码改动点：`import 'cordis'` → `import '@deepseek-ai/cordis'`；`declare module 'cordis'` → `declare module '@deepseek-ai/cordis'`；依赖 key 改名；`cordis.yml` 的 `name:` 改名。
- 脚本 `scripts/rescope-vendor.ts`：`pnpm run rescope-vendor`（报告）/ `--apply`（改名）/ `rescope-vendor:check`（hygiene 门）/ `--apply --reverse`（还原）；改名后要跟 `pnpm install`（锁文件）、`gen-third-party-notices`、`verify-translation-pairing --write`。

### 1.5 API Gateway 协议（api-gateway.md）

- **编程模型**：业务服务用 `@Remote` 或 `@RemoteScope` 选择暴露给 Client 的方法；未标记者不进生成类型、不能经 `ctx.remote` 调用。`@Remote` 指调用注册在根 Host Context 的 Cordis 服务；复杂 Host 对象不能直接过线，须经 `TypertLookupMap` 声明线身份、运行时在 `ctx.typert.lookups` 注册默认解析 provider（如签名参数 `agent: Agent` → 线上字段 `agentId`），Host 组合可用 `ctx.typert.lookups.configure()` 覆盖解析策略。`@RemoteScope(key)` 先经 `ctx.typert.contexts` 把身份解析到 scoped Context 再取服务。
- **基类**：服务通常继承 `TypertRemoteService`（构造器显式绑服务 key+默认 Remote 命名空间）；已有别的基类时用 `readonly typertRemote = bindTypertRemote(this, serviceKey)`。
- **取消**：协作取消要求 Host 签名末参为全局 `signal: AbortSignal`（进描述符而不进 `args`），生成的 Client 方法收可选尾部 `AbortSignal`。
- **Client 侧**：用普通对象上的**具体函数**而非 Proxy，出现在 `ctx.remote.<namespace>` 与 `agentCtx.remote.<namespace>`；命名空间是 `remote.<namespace>` 的 Cordis 子 Service；依赖声明归实际调用方（读它才 `inject: ['remote', 'remote.goals']`）。装配只由 `@deepseek-ai/dsh-api-remotes` 负责：导入所选业务包的 `/remote` 子路径、经 `ctx.remote.$mount()` 挂载。
- **层序**：`remotes → gateway → connection → webserver`。运行时调用 `connection.rpc.call('/api', '<namespace>/<method>', { args }, signal)` → HTTP 载体现 `POST /api/<namespace>/<method>`，payload 只有一个具名 `args` 对象；Connection 做 `/api` 统一信任检查，Gateway 只认"两段式+严格描述符（或活跃 SRC 标记）"的端点，其余回落到 API Proxy。
- **严格生成约束**：Remote 必须是 public 非静态实例方法、有具体实现、不能泛型、参数必填具名简单标识符、禁析构/默认值/rest/可选；普通 JSON 可表示类型生成严格 schema，复杂对象须唯一 `TypertLookupMap`。
- **生成件**：`typert.host.js/.d.ts`（Host 面）、`typert.remote-client.js/.d.ts/.d.ts.map`（Client 面）；包经 `./typert` 与 `./remote` 两个入口暴露。**SRC 开发回退**：`node --import tsx/esm` 运行源时代码不跑 Typert 编译器插件，装饰器初始化器在模块私有 `WeakMap` 记录；SRC 只做 dispatch 弱描述符，Client 永不从运行中的 Host 发现装饰器、拒绝无严格 codec 的 SRC 描述符——类型/codec 一律来自最新生成的 `lib/typert.remote-client.*`。
- **开发模式**：`pnpm run build` 后两个终端分别 `pnpm dsh web`（tsx 跑源 Host，可用 SRC 回退）与 `pnpm run dev:web`（只 watch 有 `dsh.client` 声明的 Client 插件、重写 `lib/client.js`）。改契约须重跑 `pnpm run build:lib`（Host 先生成严格契约，Client 再编译打包）。
- **边界**：Remote 只处理 unary 调用；session 事件流、分页、增量 reduce 是另一套协议,不得伪装成 Remote 方法进描述符。

### 1.6 术语表（glossary.md）

- **capability-seam（能力缝）**：可换能力的三角色：**Service Definition**（拥有 `ctx.<key>` 与词汇类型的 Cordis Service——抽象类如 `ShellExecutor` 或具体注册表如 `WebRuntime`，**绝不可是 TS interface**）+ 一个或多个 **Service Providers** + 一个或多个 **Consumers**。例：`dsh-shell`（定义）/ `dsh-bash-local`·`dsh-bash-sandbox`（providers）/ `dsh-tool-bash`（consumer）。
- **agent-scope**：作用域注册单位——global 或 scoped（恰属一个 scope key，按**对象同一性**比较；惯例：live agent 就是自身 scope 的 key）。`agent.ctx` 注册对 scope 可见**且** scope 生命周期；**scoped dispatch**：某 agent 活动的相关事件用该 agent 的 carrier 派发；易注册表本身的事件保持不滤波。**shadowing**：最具体者胜出——scoped 工具/段/变量对所在 scope 替换同名 global。**restriction**：`tools.restrict` 对单个 scope 过滤全局工具集（交集组合），被过滤工具同时从 prompt 消失且拒绝执行。**setup window**：`CreateAgentOptions.setup`——scope 与 agent 对象已存在但未发布/未发 `agent/session-start`/未拼首个 prompt 时的创建槽。**lineage**：父子事实以数据承载（`parentSession`、持久 `delegationDepth`、运行期 `subagentDepth`），不影响可见性。
- **goal**：附着于既有 session 的一个持久完成目标，带 revision 化的 `active/paused/blocked/complete` 阶段与 goal-round 上限；**goal round** 由同会话驱动者物化为一个 goal-sourced turn；**activation** 是进程内许可（`armed`/`disarmed`），**刻意不进持久化重放**，因此 resume/fork 必须经 `/goal` 或模型工具由人类后续授权。
- **human command**：斜杠前缀指令，经 `ctx.commands` 执行，**不成为模型消息**；`/goal` 命令由 `dsh-command-goal` 贡献。
- **loop 层级**：**turn**（session 内一次已准入输入的排空）、**step**（一次模型请求+其响应引起的工具执行）、**round**（外层策略迭代含一个 turn，如 goal round 或一次 Ralph 尝试）。
- **Ralph**：一次对不可变目标的前台 fresh-agent 工作流运行；Ralph round 是每次全新 child 会话（无父会话/前 child 种子）；Ralph handoff 是有界的标准化结构报告（状态/摘要/证据/下一步/阻塞文本），**补充而非取代**共享 workspace。

---

## 2. 关键设计决策与原因

1. **Config Catalog 由脚本生成并比对 schemastery schema** —— 声明必须能逐键定位到 loader 可接受字段，杜绝"拼接一个偷偷多收字段"的漂移；文档与运行期 schema 互锁。
2. **必填无默认是醒目模式**：`session-persistence-jsonl.root`、`storage-domain.backend`、`agent-tool-presentation.mode`、`tool-todo.allowParallelInProgress` 全"无默认"。原因各异：`process.cwd()` 会随进程 cwd 漂移散落文件；存储介质没有通用正确答案；省略等于组合了无用的行。反模式是"给了默认但没人知道"。
3. **`Requires:` 是硬契约**：`cordis.yml` 树若缺对应 Provider，插件挂载即失败（fails loud），而不是运行期悄悄 undefined。
4. **sandbox 策略、runner、执行器三分离**：策略在 `ctx.sandboxPolicy`、runner 在 `ctx.sandbox` provider、执行器 knob 在自己 config——一处改不影响另一处；默认 `read-only` 是 fail-safe。
5. **Host/Client 双 tsconfig 聚合**：因两侧对相同 `Context` 键做声明合并会冲突；因此 Typert 只在 Host tsdown 跑一次，Client 消费生成的 `lib/typert.remote-client.*`。
6. **with-key 测试文化 + self-skip**：真实模型验证是最高价值信号；无 key 自动跳过保持 CI/无 key 开发者绿色，而不是节流信号。
7. **vendor rescope 保 range、保协议前缀**：只改包名 key 不改依赖范围，靠 `linkWorkspacePackages` 解析到 pinned workspaces；`cordis:` 前缀与 `cordis.yml` 族不受影响——说明"协议/格式"与"包名"是两个正交层。
8. **API Gateway 严格生成 + 运行期按描述符校验 + SRC 只做 dispatch**：错误在进/出业务代码前拦截；热卸载不降级为 SRC 推断，防悄悄弱化校验。

---

## 3. 对「钉钉桥接器 + 自研定时任务插件」项目的可复用结论

1. **定时任务插件不要重造调度持久化**：把到期项建模为"回到原始 live Session 的后续回合"（参考 `dsh-schedule` 的 `schedule/change` log-only 权威与 goal round 的模式），用 `@deepseek-ai/cordis-plugin-timer`（disposal-aware，随 fiber 清理——不会泄漏定时器）+ `ctx.effect()`/disposer 保证卸载可逆。
2. **后台长任务用 exposed Jobs 生态而非裸 Promise**：`dsh-jobs-local` 设 `maxConcurrentJobsPerOwner`；`dsh-tool-jobs` 配 `waitTimeoutMs`/`maxWaitTimeoutMs`/`completionDelivery`，并设 `maxConsecutiveWakes` 防"作业完成→唤醒→再启动作业"自激链。
3. **钉钉入站/出站桥接的接线要点**：
   - 若部署在非 loopback（`0.0.0.0`），`dsh-client-connection` 必须声明 `trustedHosts`（`/api` 信任围栏拒绝未列名 Host）；`maxRequestBodyBytes` 限 JSON 体。
   - 出站 HTTP 用 `dsh-web-fetch-http` 的 `maxUrlLength`/`maxResponseBytes`/`maxBodyChars`/`timeoutMs`/`maxRedirects` 做防护网；大文本把 `dsh-spill-policy.maxInlineBytes` 设为阈值，超限结果落盘并预览。
   - 模型侧**统一表现**经 `dsh-tools.mode`（native/code/both）与 `dsh-system-prompt.toolOrder`（`TOOL_ORDER_REST` 恰好一次）；给桥接工具取名遵守 `mcp__<serverName>__<rawName>`（`[A-Za-z0-9_-]{1,32}` 且全局唯一）的命名纪律。
4. **对外暴露业务方法走 API Gateway 而非裸 HTTP**：用 `@Remote('xxx')` 声明 unary 方法、末参 `signal: AbortSignal` 协作取消、`TypertRemoteService`/`bindTypertRemote()` 绑定服务键；Client 用具体函数 `ctx.remote.<ns>.xxx`（非 Proxy），装配只经 `dsh-api-remotes` + `ctx.remote.$mount()`。流式/增量数据**不要**伪装成 Remote——另走 Connection 的数据协议。
5. **测试遵循 testing.md 纪律**：桥接器逻辑用 `makeBridgeHarness` 式组合（mock 仅 LLM 边界，真实工具+执行器）；给产品可见插件加"经 Loader 启 test-only `cordis.yml`"的非 unit REAL-composition 测试；有真实网关可跑时用 with-key smoke（boot example、发一 prompt、验证外部世界）验证真实产物 `lib/bin.js`（tsx 掩盖问题）。
6. **配置设计模仿"无默认 + fails loud + 正交拆分"**：自定义插件 config 里凡有"没有通用正确答案"的值就必填并在加载时校验（参考 repeat-tool-reminder 在 `apply` 抛错、不静默回退）；把策略（sandbox/approval）、执行器、持久化介质拆成独立 config 概念。

---

## 4. 不确定处（文档未明说）

- **钉钉特定（webhook 签名/加解密、`payload` 回传协议、出站卡片消息）**：这六份文档完全没有提到，属于业务层，需自行按钉钉开放平台甲定。
- config-catalog 未说明：`dsh-schedule` 的调度记录能否被任意插件直接复用/注入其领域（sibling 笔记 06 已覆盖 schedule 主体，这里仅确认其 "无 config + Requires 四服务"）；此处不再重复其实现细节。
- API Gateway 文档未明说：Gateway 对 `POST /api/<namespace>/<method>` 之外的方法（如 DELETE/自定义动词）是否支持——只描述了两段式 POST 调用形态（文档未明说）。
- SRC 回退未说明：`@RemoteScope` 的 scoped Context provider 在 SRC 下如何注册（仅说"直接用已注册 Host Context provider 的 wire field"）——(文档未明说)。
- rescope 未说明：`@deepseek-ai/cordis-plugin-timer` 的定时器是否仍接受上游 `ctx.setTimeout` 全家 API 或换了名字——只标注"disposal-aware timers on `ctx`"——(文档未明说)。
- `config-catalog` 生成器未说明其对 schema 与声明"一一对应"的精确判断规则（"every schema-validated key must be locatable"），反方向（声明有而 schema 无）是否报错不明——(文档未明说)。

---

## 5. 相关联术语/事件名列表

- **config/接线**：`config:` block、`Requires:`、schemastery `Schema`、`cordis.yml`/`*.cordis.snapshot.yml`/`cordis.patch.yml`、`inject`、Service Definition / Provider / Consumer、Seam 包、Library 包
- **服务/事件**：`sessionPersistence`、`sessionQuery`、`storageDomain`、`storage`、`jobs`、`goals`、`tools`、`sandbox`、`sandboxPolicy`、`approval`、`sessions`、`agents`、`llm`、`tokenMeter`、`systemPrompt`、`subagents`、`workflowEngine`、`terminal`、`lsp`、`credentials`、`loader`、`webServer`、`web`、`client-connection`（`/api` 信任围栏、`connection.rpc.call`）
- **API Gateway**：`@Remote`、`@RemoteScope`、`TypertRemoteService`、`bindTypertRemote`、`TypertLookupMap`、`ctx.typert.lookups`（`register()`/`configure()`）、`ctx.typert.contexts`、`ctx.typertGateway`、`ctx.remote`、`ctx.remote.$mount()`、`typert.host.*`、`typert.remote-client.*`、`agentId`/`sessionId` wire 字段、API Proxy
- **定时/任务/目标**：`dsh-schedule`、`schedule/change`、goal round / goal activation（armed·disarmed）、`/goal`、Ralph round / Ralph handoff
- **测试**：`test`/`test:coverage`/`test:e2e`/`test:snapshot`/`test:web`、`makeBridgeHarness`、self-skip、HMR-safety test、REAL-composition test、`lib/bin.js` built smokes
- **工具链**：`pnpm run gen-config-catalog`、`verify-config-catalog`、`doc-sync`、`verify-type-equiv`、`rescope-vendor`、`install-lefthook`、`pnpm dsh --profile headless`、`demo:cordis`、`demo:acp`、`DSH_BUILD_FACE`
- **术语表**：seam、scope / scope key、shadowing、restriction、setup window、lineage、turn / step / round、human command、command plane、capability-seam
