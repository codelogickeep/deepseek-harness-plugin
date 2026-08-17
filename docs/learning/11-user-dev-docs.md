---
title: 用户向开发文档导读
description: DSH 本地 docs 精读学习笔记（来源 docs/11-*）——用户向开发文档导读
tags: [user, develop, guide]
date: 2026-08-17
status: learning-note
---
# 学习笔记 11：用户向 DSH 开发文档（基础篇 / 框架篇 / 实践篇 / 指南）

> 主题来源：`docs/user/develop/basic/{index,tool,config,publish}.md`、`docs/user/develop/framework/{index,events,service}.md`、`docs/user/develop/practice/{index,llm-adapter}.md`、`docs/user/guide/{index,providers,python-sdk}.md`、`docs/user/index.md`
> 学习主题：「用户向 DSH 开发文档：基础篇(工具/配置/发布)、框架篇(事件/服务)、实践篇(LLM 适配器)、指南(providers/python-sdk)。」

---

## 1. 核心概念与机制

### 1.1 插件模型（basic/index、framework/index）

- **插件 = 导出 `apply` 函数的 TypeScript 模块**。框架加载插件时调用 `apply` 并传入 `ctx: Context` 上下文对象，插件通过它注册能力。最小完整配置就是 `export const name` + `export function apply(ctx){...}`。
- **三种插件形态**：函数模块（最常见）、对象形式（`export default { name, inject, apply(ctx) }`）、类形式（`extends Service { static inject=[...]; constructor(ctx){ super(ctx, 'serviceName') } }`）。文档明确「函数形式够用大多数场景；当插件要向其他插件**提供服务**时才用类形式」。
- **Fiber 状态机**（framework/index 完整给出）：
  - `PENDING`（已声明但依赖未就绪）→ `LOADING`（依赖就绪、`apply` 正在运行）→ `ACTIVE`（运行中）
  - `LOADING` → `FAILED`（`apply` 抛出错误）
  - `ACTIVE` → `UNLOADING` → `DISPOSED`（完全卸载）
- **依赖驱动的加载**：声明 `inject` 后，框架会等每个必需服务就绪才加载插件；若必需服务消失（如 provider 被替换），插件自动卸载（ACTIVE→DISPOSED），服务回来时重新加载。
- **自动清理**：通过 `ctx` 注册的一切在卸载时自动撤销——`ctx.on(event, handler)` 监听器、`ctx.tools.register(tool)` 工具、`ctx.llm.registerAdapter(names, adapter)` 适配器、`ctx.effect(() => cleanup)` 自定义资源。文档强调**不需手动 removeListener / clearInterval**。
- **`ctx.effect()`**：对需要显式清理的资源（如网络连接），提供 disposer 函数，插件卸载时执行。**卸载时按注册逆序调用 disposer，但多个异步 disposer 并发执行、无串行完成保证**；有顺序依赖的清理必须放进**同一个** `ctx.effect()` 的 disposer 里串行 await。
- **嵌套上下文**：`ctx.plugin(childPlugin)` 创建子 Fiber，继承父上下文但生命周期独立，随父一起卸载。
- **手动 dispose**：`const fiber = ctx.plugin(myPlugin); await fiber.dispose()`，保证 (1) 移除该插件所有注册 (2) 递归卸载子插件 (3) 全部异步清理完成后 promise 才 resolve。
- **HMR**：加载 `@deepseek-ai/cordis-plugin-hmr` 后，编辑插件源文件触发：卸载旧插件并清理注册 → 加载新代码 → 运行新 `apply`。因为注册都是 effect 自清理，热替换不会残留旧注册。
- **配置 HMR**：编辑配置同样热替换插件（卸载旧实例、加载新实例）。

### 1.2 工具定义 DSL（basic/tool、events 示例）

- 使用 `defineTool`（来自 `@deepseek-ai/dsh-tools`），通过 `ctx.tools.register(defineTool({...}))` 注册。结构：`name`、`description`、`parameters`（字段级 `{ type, required, description }`）、`output`（`{ schema, render }`）、`execute(args)`。
- `defineTool` **从 `parameters` 推断并校验 `args`**；`execute` 返回 `output.schema` 声明的规范值；`output.render(_args, value) => [{ type:'text', text: value }]` 把规范值转成模型可见内容。
- 文档示例「逐行日志工具」监听 `tools/result` 事件：`ctx.on('tools/result', (exec, result) => { exec.name, exec.arguments; result.content 为 block 数组，过滤 type==='text' 拼 text })`。
- 深入参考（本批未读但被引用）：cookbook 的 adding-a-tool.md（嵌套 schema、规范值、后台工作、策略钩子、Code Mode、UI 卡片）。

### 1.3 插件配置（basic/config）

- **导出 `Config` 类型 + 同名 Schemastery schema**，默认值直接写在 schema 字段上（`Schema.object({ greeting: Schema.string().default('Hello'), ... })`）；`apply(ctx, config)` 的第二个参数收到用户值或 schema 默认值。
- **不要导出普通对象当 `Config`**——它不实现 Cordis 需要的 Standard Schema 接口。
- 校验：`Schema.string().required()`、`Schema.number().default(30000)`、`Schema.union(['fast','accurate'])`。schema 在插件加载时运行，**无效配置使加载失败并给出可操作的报错**。
- **两条设计原则**：
  1. **不硬编码可调值**——「任何两个部署可能想设成不同的值」都应是配置字段；判据是「cordis.yml 能否不改代码就改这个值」。
  2. **失效即响亮失败**——自包含约束写进 schema，让无效配置在加载期失败；涉及服务/资源的引用走依赖注入（service.md）。

### 1.4 打包与发布（basic/publish）

- **两个概念、两类 manifest**（都叫 package.json，但 `dsh` 键下内容不同）：
  - **bundle（束）**：一个 npm 包，随附配置层；manifest 声明 `dsh.bundle.patch`（指向 `cordis.patch.yml`），回答「这个包贡献什么」。**bundle 是作者编写分发的对象**。
  - **profile（配置档）**：`$DSH_HOME/profiles/<name>/` 描述一个可运行组合；manifest 声明 `dsh.profile.bundles`（有序列表），回答「哪些 bundle、按什么顺序组成」。**profile 是用户 `dsh --profile <name>` 启动的对象**。
  - 「Nothing is both.」——没有既是 bundle 又是 profile 的东西。
- **profile 由 `dsh plugin` 维护**，永不手写；首次使用以 `@deepseek-ai/dsh-base` 为第一个 bundle。
- 安装命令：`dsh plugin --profile demo add ./hello-plugin`（转发给 profile 目录内 pnpm）。`--dump-config` 可分层查验后再启动。`remove` 同时移除依赖与层。
- **有效配置的合成顺序（后层胜出，按行）**：
  1. profile 中 `dsh.profile.bundles` 列表里每个 bundle 的补丁（按列表序，dsh-base 最先）
  2. profile 自己的 `cordis.patch.yml`（用户自有补丁层，应用在所有 bundle 层之后）
  3. **home 级 `$DSH_HOME/cordis.patch.yml`**（机器级偏好，被所有 profile 共享）
  4. 每个 `--patch <path>` 覆盖层（按 argv 顺序）
  - **注意：补丁替换行的整个 `config` 值而非深合并**。后果：要覆盖某行必须重述该行需要的每个键；用户可在自己 profile 的 patch 里覆盖你的行——所以**作者应给用户倾向保留的配置默认值，把其余交给 schema**。
  - App 参数**不是**补丁层；surface bundle 通过 app 自有的 service 解析（见 1.5）。
- **GitHub 安装的 build-script 陷阱**：git 安装拉取的是**源码而非构建产物**，不会跑 `build` 脚本。作者侧要带 `prepare` 脚本（pnpm 在 git 安装后运行）自包含地构建发布入口；用户侧要在 profile 的 `pnpm-workspace.yaml` 写 `allowBuilds: <pkg>: true`（pnpm≥10 默认拒绝）放行 prepare。**该放行 = 安装时在机器上执行包代码的许可**，只信任可信源并 pin commit。不想让用户放行就分发构建产物（发布 npm 带 `lib/`，或 `pnpm pack` 出 tarball）。

### 1.5 surface bundle 自带命令行（basic/publish 末节）

- Bundle 定义可运行 app 时，挂一个**普通 provider 插件**行（如 `- id: hello-startup, name:'dsh-hello-plugin/startup'`），无需 launcher 标记或特殊 kind。
- 该插件 `inject:['cmdlineArgs']`，用 `@deepseek-ai/dsh-cmdline` 的 `parseCmdline` 配自己的 commander program，在 program 的 action 里提供 app 自有服务。**launcher 给所有插件同一份不可变参数**（launcher 标志之后的），所以 app 特定 flag 无需改 launcher，多个插件可解析同一快照。
- 被这些参数配置的行注入该 provider 的服务，并在**自身 `!!js` options 里读取**（如 `config: { port: !!js ctx.myAppStartup.port ?? 8080 }`），部署值作为回退。
- `--help` 时 provider 不发布服务，相关行不激活；Loader **只挂载组合一次、等每行普通注入就绪、然后才对该行 `!!js` 配置在注入的 ctx 上求值**。

### 1.6 服务（framework/service）

- **服务 = 一个插件向其他插件暴露的能力**，以具名能力挂在 `ctx` 上：`ctx.tools`（ToolRuntime）、`ctx.llm`（LLM）、`ctx.agents`（Agent）。任何插件都能提供/消费。
- **消费**：`inject: ['tools']`，`apply` 运行时声明的服务必已就绪；未就绪则等待而非运行。
- **提供**：类 `extends Service { static inject=['llm']; constructor(ctx){ super(ctx, 'metrics') } }`；消费方 `inject:['metrics']` 用 `ctx.metrics.record(...)`。类型用 TS 声明合并：`declare module '@deepseek-ai/cordis' { interface Context { metrics: MetricsService } }`。
- **必需 vs 可选**：必需=放 `inject`（服务缺席时插件不加载）；可选=不写 inject、在使用点 `ctx.get('metrics')` 判空（`metrics?.record(...)`）。
- **服务消失时**：(1) 依赖插件自动 dispose；(2) 服务回来再加载——防止插件调用已不存在的服务。
- **服务隔离**：cordis.yml 可用 `@deepseek-ai/cordis-plugin-group`（`group: true` + `isolate: { shell: true }`）让两个插件组各见同一服务的独立实例（例：a 组 Bash timeout 5s、b 组 60s，互不影响）。
- 内置服务清单以仓库生成的子系统页 + Service TS 接口为准，**不要维护第二份静态清单**。

### 1.7 事件系统（framework/events）

- **`ctx.on('event-name', handler)` 监听 / `ctx.emit('event-name', payload)` 广播**。事件是 Cordis 插件间核心通信机制，Harness 广泛用作松耦合扩展点。
- **四种事件模式**：
  - `emit`（广播）：每个监听器同步跑完，返回值忽略（`ctx.emit('my-plugin/ready', {id})`）。
  - `bail`（短路）：监听器按序跑，**第一个返回非 null/false/undefined 的结果成为最终结果**（`ctx.bail('some-check', input)`；返回 null/false/undefined 继续下一个）。
  - `serial`（有序执行）：按注册顺序跑，**异步结果被 await**；第一个非 null/false/undefined 停止后续执行。
  - `waterfall`（管线）：每个监听器可包裹下游结果形成处理链；**监听器必须调用 `next()` 委托下游**，省略调用=有意短路管线（拦截/网关）。
- **类型安全**：TS 声明合并 `declare module '@deepseek-ai/cordis' { interface Events { 'my-plugin/ready': (payload:{id:string})=>void } }`，之后 `ctx.on/emit` 自动推断。
- **命名与两种"事件"的区别（重要！）**：
  - Harness Cordis 事件用 `namespace/action` 名：`agent/step`、`agent/request`、`agent/request-error`、`tools/result`、`session/event`。
  - `turn/*`、`step/*`、`tool/call`、`tool/result`、`compaction/*` 是**持久会话事件类型（durable session-event types）**，与同名 Cordis 事件**不是一回事**；要观察它们应监听 `session/event` 并检查 `event.type`。
- 监听器是 effect，插件卸载自动移除。

### 1.8 三角色能力设计（practice/index）

- 可替换能力拆三个角色，**放进独立包当需要各自独立演化/替换时**；完整能力是接缝（seam），单个角色不是接缝：
  - **Service Definition**（如 `dsh-shell`）——定义 Cordis 服务和请求/结果类型；
  - **Service Provider**（如 `dsh-bash-local`）——在本地机器执行；
  - **Consumer**（如 `dsh-tool-bash`）——把能力暴露成模型可调工具。
- 依赖关系：Provider→Definition、Consumer→Definition，**Provider 与 Consumer 互不依赖**。
- 收益：换 provider（cordis.yml 换一行）、独立演化（定义契约少变 / provider 独立改进性能安全 / consumer 独立改呈现）、解耦。
- 教程模式：Definition 导出 `abstract class MyCapService extends Service`（`super(ctx,'myCap')` + 抽象 `execute(request)`）+ 类型；Provider `class MyCapLocal extends MyCapService` 后 `ctx.plugin(MyCapLocal)`；Consumer 注入 `['tools','myCap']` 在 `execute` 里 `ctx.myCap.execute(...)`。
- 设计要点：(1) **不要预防性拆分**，简单工具插件不需要；(2) Definition 拥有 Request/Result 类型；(3) **Explicit > implicit**——用显式 `resolve(request): Spec` 步骤解析默认，而不要把 `?? default` 藏进 `run()`。

### 1.9 LLM 适配器（practice/llm-adapter）

- 适配器 = `class MyAdapter extends LlmAdapter`，实现 `async *stream(options: GenerateOptions): AsyncIterable<StreamChunk>`；把 Harness 的 provider-中立请求翻译成 provider 的 API 调用，并把响应翻译回 Harness 块。
- 注册：`inject:['llm']` + `ctx.llm.registerAdapter(config.providers, adapter)`；Config 需 `apiKey`（required）与 `providers`（required 数组）。cordis.yml 里 `apiKey: !!js process.env.MY_API_KEY` 可读环境变量；`GenerateOptions.provider` 选择已注册的适配器，`model` 传适配器自有的模型 id（无需生命周期注册）；重写 `listModels()` 时可向选择器广告模型。
- **StreamChunk 协议**（`@deepseek-ai/dsh-llm` 导出）：
  - 每块内容以 `{type:'block-start', index, blockType:'text'}` 开始，经多条 `{type:'text-delta', index, text}` 流式传输，以 `{type:'block-end', index, block:{type:'text',text:'...'}}` 结束并带完整块。
  - 工具调用块：`block-start(blockType:'tool-call')` → `tool-call-delta { id: CallId('...'), name, argumentsDelta: '{"command":"ls"}' }`（可一次或分块）→ `block-end` 带完整 `arguments`。
  - `usage { inputTokens, outputTokens }` 在 finish 前发；`finish { reason:{kind:'stop'} }` 是最后一块；`{kind:'tool-calls'}` 请求工具执行。
  - 规则：每个 block-start 必有匹配 block-end；`index` 从 0 递增标识内容块次序；`finish` 必须是最后一块。
- **GenerateOptions**：含 model、适配器自有的 reasoning-effort id、对话历史、系统提示、工具 schema、生成参数、停止序列、abort signal——以 `@deepseek-ai/dsh-llm` 导出的 TS 类型为准。**provider 无法兑现的字段：抛 `LlmError` + 稳定 code，不要静默丢弃**。
- **resolveModel(provider, model, signal?)**：一次查找返回精确 provider/model 身份 + 可选 context/reasoning 元数据。reasoning 元数据含有序的**不透明 id + 显示名**、可选配置默认；要保留适配器权威可选项列表（含上游能返回时的 `off`），别把这些值提升进核心 enum；尊重可选 signal 以便取消/释放可达静止。服务在 `stream()` 前校验聚合、拒绝未支持显式 effort；省略 reasoning = 该模型无可选 reasoning-effort 能力。
- **错误处理**：传输/协议失败抛 `LlmError` + 稳定 code，agent loop 保留错误与 code 供诊断和策略（**不自动把普通 Error 转码**）。每个 provider HTTP 请求还必须合并 `attributionHeaders()` 并转发 `options.signal`（示例用 `fetch(endpoint, { headers:{..., ...attributionHeaders()}, ...options.signal?{signal:options.signal}:{} })`，非 ok 抛 `new LlmError(msg, 'PROVIDER_HTTP_ERROR')`）。
- 参考现成实现：`packages/llm/llm-deepseek/`（OpenAI 兼容格式）、`packages/llm/llm-pi-ai/`（不同 API 格式）。

### 1.10 Web UI 与 providers 指南（guide/index、guide/providers）

- Web UI 启动、**Settings → Models** 填 DeepSeek API key 即用、无需重启；先选 workspace（session composer 才可用）。dsh 进程以**调用目录**为默认文件系统位置，但新 UI 在添加 workspace 前无选中工作区。
- **密钥 write-only**：保存后页面只收到 redacted 描述符，绝不回传字面密钥；密钥存 `$DSH_HOME/.credentials.yaml`，settings 只留凭证引用。
- 三种 provider 方式：DeepSeek 卡（单 key）、catalog provider（装好的目录自带 endpoint/protocol/model list）、**custom provider**（公司网关/自托管；填小写 Provider ID、base URL、API protocol、credential、至少一个模型）。**Provider ID 永久**（请求、保存的会话、模型默认值、凭证引用都用它），改名=新建再删旧的。
- 原生认证的 provider 不走 API-key 字段：Bedrock/Vertex/Azure/Codex 分别要 AWS 凭证+region、ADC project、`api-version`、OAuth。
- **模型目录**：手填模型默认被当作**纯文本**模型（没法问端点支持啥模态）；"Fetch available models" 调 OpenAI 兼容 `GET /models`；给不支持该端点的端点要手填模型。**给自定义 provider 的视觉模型**要在 `$DSH_HOME/settings.yaml` 的 model 上加 `input: [text, image]`；`defaultInput` 是**回退而非覆盖**（默认 `[text]`），只对目录未描述的模型生效；目录 provider 用 `modelOverrides` 按 model id 覆盖。个模型 `input: []` 空列表=省略。两者都只是**对端点的声明而非检查**——声明了图片但端点不支持的，由 provider 拒绝请求。
- 模型选择：选中的模型成为新会话默认；已发过请求的会话保留其日志里记录的模型；**已删 provider 的保存默认**会让 composer 显示 Select model 并阻断输入直至选新模型。
- 排错码本源：`MISSING_CREDENTIAL`（凭证缺失）、`UNKNOWN_MODEL`（模型未配置）；401 排查 key；拒绝带图请求时要看是**发送前拒**（模型没声明 image 模态）还是 **provider 拒**（声明了但端点不服务）——后者需在会话日志移除挂图后新建会话。

### 1.11 Python SDK（guide/python-sdk）

- 前置：Python ≥3.10、Linux x64 / Linux arm64 或 macOS≥14 (arm64)、DeepSeek 兼容端点、可改写的隔离 workspace。`pip install deepseek-harness-sdk` 自带同版本捆绑 runtime，**无需系统 Node.js**。
- 环境变量：`DEEPSEEK_API_KEY`；走 OpenAI 兼容代理时设 `DEEPSEEK_BASE_URL`；可选 `DSH_MODEL`、`DSH_SYSTEM_PROMPT`。
- 代码形态：`with DeepSeekHarness(provider=..., model=..., max_tokens=..., cwd=workspace, session_root=sessions, cordis=config) as harness: result = harness.run(prompt, session_id=...)` → `result.final_response`。
- **runtime 惰性启动并复用直到上下文管理器退出**；复用同一 harness + 同一 session id 会保会话持有的 Bash 进程（cwd、导出的变量、shell 函数）。新任务用新 session id；**复用 id 仅当想延续同一可持续会话**。
- 示例组合细节：模型面工具仅常驻 `bash` + `str_replace_editor`、bash 超时 300s、editor 输出上限 16,000 字符、compaction 关闭、裸本地 fs（**绝对编辑路径可寻址运行时进程可见的任何路径**）、会话以未压缩 JSONL 存于 `DSH_SESSION_ROOT`。该组合用 `danger-full-access`，**只应在一次性 checkout/容器里跑**；持久 PTY 后端要 POSIX 终端垫层，不支持 Windows agent。

---

## 2. 关键设计决策与原因

1. **`inject` 声明式依赖 + 自动效果清理（effect 模型）**：把「等待依赖」和「卸载清理」都交给框架，插件代码里没有 removeListener/clearInterval；HMR 和配置热替换因此能干净地换实例而不残留注册。这是整套文档反复出现的统一心智模型。
2. **`Config` 必须走 Schemastery schema（Standard Schema），不能是普通对象**：schema 既做加载期校验（无效即响亮失败）又能填默认值，还把「可调值」收敛成显式配置字段。
3. **补丁按行整体替换 config 而非深合并**：降低合成语义复杂度、可预测（后层整行胜出），但代价是覆盖方必须重述整行——文档以「把默认值调成用户倾向保留的值」来对冲。
4. **bundle 与 profile 严格二分（"Nothing is both."）**：作者分发 bundle、用户启动 profile，分层清晰；profile 由 CLI 维护避免手写出错。
5. **Git 安装拉源码不跑 build、pnpm≥10 默认禁 prepare**：把「安装即执行」当作权限对待，promote `prepare`+`allowBuilds`+pin commit，或干脆分发构建产物/发布 npm。
6. **事件四模式取舍**：emit 广播即忘、bail 短路、serial 有序、waterfall 强制 `next()` 的管线（实现网关/拦截）。用类型命名空间 `namespace/action` 减少冲突。
7. **会话事件与 Cordis 事件分家**：`turn/*` 等是持久会话事件类型，只能经 `session/event` 观察——防止把不同抽象混为一谈。
8. **三角色能力拆分 + "不预防性拆分"**：只有需要独立演化/替换才分包；Definition 拥有契约类型，Provider 与 Consumer 只依赖 Definition，互不依赖。
9. **LLM 适配契约明确化**：`LlmError`+稳定 code（不静默丢弃不支持字段、不自动转普通 Error）、`resolveModel` 一次性返回 provider/model/reasoning 元数据、reasoning 用不透明 id 列表、`off` 保留由上游决定、StreamChunk 协议块级（block-start/delta/end + CallId + usage→finish）。
10. **密钥绝不落 UI**：write-only 凭证、`$DSH_HOME/.credentials.yaml` 存真值、settings 只存引用；`apiKeyEnv`/`!!js process.env.X` 走环境变量——安全边界内嵌在配置体系里。

---

## 3. 对「钉钉桥接器 + 自研定时任务插件」项目可复用的结论/代码模式

- **插件骨架**：函数形式 + `export const name` + `export function apply(ctx, config)`；想被其他插件用服务才上类形式。任何注册都用 `ctx.on/ctx.tools.register/ctx.llm.registerAdapter/ctx.effect`，让 HMR 与停用自动清理。
- **定时器统一走 `ctx.effect()` 并提供 disposer**（`return () => clearInterval(timer)`），且所有顺序依赖的清理集中在同一个 effect 里串行 await——**这是自研定时任务插件最重要的安全点**（框架对异步 disposer 无串行保证）。
- **`Config` 模式**：`export interface Config { ... }` + `export const Config: Schema<Config> = Schema.object({ ... .default / .required / .union ... })`；cordis.yml 里 `config:` 直接覆盖。定时任务的目标时间、重试次数、通知阈值等一切「部署可能需要调」的值都做成字段（判据：cordis.yml 能否不改码改值）。
- **服务定义与消费**：钉钉桥接器作为 provider 包 `extends Service { super(ctx,'dingtalk') }` 提供 `send/execute 等抽象方法`，用声明合并加类型；定时任务插件 `inject:['dingtalk']` 只用 `ctx.dingtalk.*`——二者互不依赖、只依赖 Service Definition，符合三角色模式，未来换 provider 只改一行。可选依赖用 `ctx.get('dingtalk')?.` 判空。
- **事件解耦**：钉钉侧监听 `ctx.on('tools/result')` / `agent/request` / `agent/step` 等 `namespace/action` 事件做通知；定时任务到点后 `ctx.emit('my-plugin/reminder', payload)` 广播给桥接器。**要数据就经 `session/event` 看 `event.type`，不要直接听 `turn/*`/`tool/*`/`step/*` 同名事件**（那批是持久会话事件类型）。
- **四模式选型**：纯通知用 `emit`；「是否放行/拦截」用 `bail`（返回非 null/false/undefined 短路）；「多段前处理必须全跑」用 `serial`；「消息内容逐段加工」用 `waterfall`（**必须 `next()`**，可做网关）。
- **配置加载顺序**：写补丁时记住「后层整行胜出、config 不深合并」——钉钉/定时任务插件的 profile 覆盖必须重述全部所需键；把用户倾向保持的默认值写进 schema。
- **LLM 接入（若项目自研模型适配）**：`class Adapter extends LlmAdapter { async *stream(options) }` + `ctx.llm.registerAdapter(['my-prod'], adapter)`；严格按 StreamChunk 协议（block-start→text/tool-call-delta→block-end→usage→finish）；不支持字段抛 `LlmError(code)` 不静默丢弃；每请求合并 `attributionHeaders()` 并转发 `options.signal`；配置里 `apiKey: !!js process.env.DINGTALK_APP_SECRET` 之类环境变量引用。
- **凭证安全**：token/secret 通过环境变量或 `apiKeyEnv` 引用，不硬编码、不进 settings.yaml 明文；复用 write-only 凭证 + `$DSH_HOME/.credentials.yaml` 的思路。
- **Python/SDK 侧自动化**（如需脚本化发任务）：复用同一 `DeepSeekHarness` + 复用 session id 保持久 shell 状态；新任务用新 id；仅限隔离容器/checkout。

---

## 4. 不确定处（文档未明说）

- `ctx.get()` 与服务被 isolate 时的确切解析规则：service.md 只给了「可选依赖用 get 判空」，isolate 只示范了 `shell`；**未说明同一服务多 provider 并存/优先级、以及 group/isolation 与 `ctx.get` 的组合语义**。(文档未明说)
- bundle 间同名行覆盖的冲突细节：publish.md 说「按 id 覆盖且后层胜出」，但**未说明两个不同 bundle 声明同名 id 时的报错/警告行为**（只举例 bundle 覆盖 dsh-base 直行）。(文档未明说)
- `dsh plugin` 除 add/remove 外的完整动词表与 npm 包发布/`pnpm pack` 的 tarball 精确校验流程未在本批文档展开（指向 CLI reference）。(文档未明说)
- 事件同名的类别判定清单：events.md 只列了一组示例（`agent/step`、`tools/result`、`session/event`… 是否覆盖全部 Cordis 事件），「named `namespace/action`」是否硬性规则、跨包事件命名规范未给全量清单。(文档未明说)
- LLM 适配器的 `resolveModel` 被服务在何时/以何种频率调用、`reasoning` 元数据与核心枚举的精确对接未给出代码级约定。(文档未明说)
- 定时/后台任务的官方生命周期挂钩：本批文档未提 DSH 是否有专门调度 API，只有 `ctx.effect`+HMR 的组合暗示（需查 subsystems/schedule 相关页面）。(文档未明说)
- Web UI 权限策略弹窗与 `danger-full-access` 之外各权限等级对插件运行方式的影响未描述（指向 approval/sandbox 文档）。(文档未明说)
- python-sdk 中 `result.final_response` 以外的结果字段、通知机制细节未在本批给出（指向 python/sdk/README）。(文档未明说)

---

## 5. 相关联术语/事件名列表

- **生命周期/上下文**：Fiber、PENDING、LOADING、ACTIVE、FAILED、UNLOADING、DISPOSED；`apply(ctx)`、`ctx.plugin()`、`fiber.dispose()`、`ctx.effect()`、`inject`、HMR、`cordis-plugin-hmr`、`@deepseek-ai/cordis`（Context、Service、Events、interface）。
- **工具/服务**：`ctx.tools.register`、`defineTool`（`@deepseek-ai/dsh-tools`）、`parameters/output.schema/output.render/execute`；`ctx.tools`、`ctx.llm`、`ctx.agents`；`ctx.get()`、`super(ctx,'name')`、Service Definition / Provider / Consumer、`cordis-plugin-group`、`isolate`。
- **事件**：`ctx.on` / `ctx.emit` / `ctx.bail` / `ctx.serial` / `ctx.waterfall`、`next()`；Cordis 事件：`agent/step`、`agent/request`、`agent/request-error`、`tools/result`、`session/event`；持久会话事件类型：`turn/*`、`step/*`、`tool/call`、`tool/result`、`compaction/*`；namespace/action 命名、`declare module` 声明合并。
- **LLM 适配**：`LlmAdapter`、`GenerateOptions`、`StreamChunk`（block-start / text-delta / tool-call-delta / block-end / usage / finish）、`CallId`、`LlmError`、`attributionHeaders`、`ctx.llm.registerAdapter`、`resolveModel`、`listModels`、`options.signal`。
- **配置/发布/CLI**：`cordis.yml`、`--patch`、`dsh.bundle`、`dsh.profile`、`cordis.patch.yml`、`dsh plugin add/remove`、`--profile`、`--dump-config`、`$DSH_HOME`、`profiles/<name>`、`allowBuilds`、`prepare`、`pnpm-workspace.yaml`、`!!js`、`cmdlineArgs`、`parseCmdline`（`@deepseek-ai/dsh-cmdline`）、Schemastery（`Schema.object/string/number/boolean/union/array/default/required`）、Standard Schema。
- **指南/Providers/SDK**：Settings→Models、`$DSH_HOME/.credentials.yaml`、`apiKeyEnv`、`input` / `defaultInput` / `modelOverrides`、Provider ID、`GET /models`、`MISSING_CREDENTIAL`、`UNKNOWN_MODEL`；Python SDK：`DeepSeekHarness`、`harness.run`、`final_response`、`session_root`、`DSH_SESSION_ROOT`、`DEEPSEEK_API_KEY`、`DEEPSEEK_BASE_URL`、`DSH_MODEL`、`DSH_SYSTEM_PROMPT`、`danger-full-access`、jsonrpc-agent/minimal。
