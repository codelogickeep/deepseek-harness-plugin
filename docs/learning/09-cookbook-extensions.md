---
title: 插件开发实战菜谱与防御
description: DSH 本地 docs 精读学习笔记（来源 docs/09-*）——插件开发实战菜谱与防御
tags: [cookbook, plugin, extensions]
date: 2026-08-17
status: learning-note
---
# 09 插件开发实战菜谱：工具/LLM 适配器/包/会话节点/vendor 包、扩展子系统、Code Runtime、Typert、防御性模式

> 来源：`docs/cookbook/adding-a-tool.md`、`adding-an-llm-adapter.md`、`adding-a-package.md`、`adding-a-conversation-node.md`、`adding-a-vendored-package.md`、`extension-cookbook.md`、`docs/subsystems/extensions.md`、`code-runtime.md`、`typert.md`、`docs/defensive-patterns.md`（均为英文版）
>
> 全部内容只取自上述文档真实机制，未额外编造。

---

## 1. 核心概念与机制

### 1.1 加一个工具（`adding-a-tool.md`）

模型面向工具必须满足的「契约」，生产级三包范例是 `packages/shell/tool-bash`。最小形态：

```ts
export const name = 'my-tool'
export const inject = ['tools']
export function apply(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'read_file', description: '…',          // 模型可见
    parameters: { path: { type: 'string', required: true, description: '…' }, limit: { type: 'number' } },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) { /* args 由 schema 推导类型；exec 带 signal/token */ },
  }))
}
```

关键机制：

- **注册是 effect-based**：dispose 插件 fiber 即注销工具；schema 自动进入 system-prompt 装配。
- **参数由框架验证**：`defineTool` 在 `execute` 之前用统一的 `ParameterSchemaSpec` 校验模型生成的 `arguments`（类型、必填键、literal 约束、exact-one union、嵌套值）。工具内仍需自行检查 DSL 表达不了的约束（非空字符串、正数、跨字段规则）。显式 object 节点可声明 `additionalProperties`，隐式参数根保持开放。直接用 raw JSON-Schema 注册的 `ToolDefinition`（如 MCP 来源）自己拥有输入校验。
- **注册借用只读定义**：同进程类型化贡献不是序列化边界，注册后不得 mutate schema 或替换回调；热替换 = dispose 所属 effect 再注册新工具。
- **执行身份受保护**：registry 把 `arguments` 物化为 detach 的 lossless JSON（一次递归遍历）、freeze、分配不透明 `exec.token`；`callId/name/arguments/agent/token/signal`（signal 必备）+ 可选 `parent` token 在派发全程不可变。`args` 视为只读输入。只有 around-dispatch 包装器拿到可变视图，且只能替换/恢复 `exec.signal`（设 deadline）不能移除。
- **只声明并返回一个 canonical JSON 值**：`output.schema` 用 `ValueSchemaSpec`（根可为 object/array/scalar/null）。`execute` 只返回推断值；registry 快照为 lossless JSON、校验、freeze 后交给 `output.render(args, value)`。不要把 content block 混进返回值，也不要让调用方从 prose 里解析 id/字段。
- **throw 或返回无效值 ⇒ `isError`**：registry 捕获 throw，把 schema/renderer/metadata-projector/lossless-JSON 失败都折叠进 isError（在 observers 之前）。基础设施失败用 throw；成功的领域结果（哪怕 Native renderer 对外解释成非理想状态，如非零退出码）放进 canonical value。
- **尊重 `exec.signal`**：它触发时取消进行中的工作。
- **`presentationMeta`（可选）持久化卡片数据**：`output.presentationMeta(args, value)` 从同一 canonical value 派生可重放 JSON，core 持久化在 `tool/result` 并交给 `presentResult`，使「写/编辑应用的 hunk」这类结果时事实能在 replay 中存活，而不必持久化 canonical value。嵌套 Code 派发无卡片，会跳过 projector。
- **`exec.agent` 用于异步通知**：`agent.inject({ content, source: { kind: 'plugin', plugin: '<name>' } })` 把持久上下文追加给**下一次**模型请求——它不是唤醒（空闲 agent 保持空闲）；对已 dispose 的 agent 要 try/catch。
- **长时工作**：`run_in_background` 由 producer config 门控，通过 `ctx.jobs.start({ kind, label, owner: exec.agent, run })` 注册。registry 在 producer 体之前拒绝预中止调用；运行时在 `run()` 开工前验证所有权与 task-controller 可用性，然后提供 id、session fence、通用控制工具、通知与 owner 清理。成功后台分支返回类型化 canonical handle（如 `{ kind: 'background', jobId }`）；Code Mode 绝不能从 prose 解析 id。producer 提供同步 `cancel`、不 reject 的 `done`（资源清理后 settle）、可选带界输出格式化的 `readOutput`。一旦 `ctx.jobs.start()` 发布 id，就用 task-owned cancellation signal 而非 `exec.signal`：外层取消只停止等待，不杀掉已发布工作；`job_kill`/owner dispose/service teardown 拥有其生命周期。
- **执行策略分层**：尽量别把部署策略写进工具。用 `tools/pre-execute` 做可扩展 allow/deny/ask 策略；`ctx.tools.guard()` 做后期监听器无法撤销的**单调最终拒绝**；`tools/execute` 包装派发加 deadline/retry/metrics；`tools/post-execute` 替换呈现内容或返回值、block 结果、附加 model-facing 上下文；`tools/result` 观察不可变归一化结果。内容替换保留对 `value` 的程序性访问；机密性策略则 block 或替换 value。
- **Code Mode 免费获得工具**：每个可见注册工具都可 `await tools.<name>(args)`，生成的 `ToolArgsMap`/`ToolOutputMap` 从同一 schema 推导精确类型。成功调用 resolve 到策略后的最终 canonical JSON（非渲染 Native 内容）；失败 reject 真 `ToolCallError`，程序只能看 `name/toolName/message`。
- **UI 呈现**：`output.render` 返回 model-facing 内容；**UI 卡片是独立关注点**，通过纯呈现投影和可选 `presentCall`/`presentResult` 声明，返回 `card`-tagged render intent：`generic`（默认，可设 `kind` 图标、`locations`）、`terminal`（本身就是 shell 命令）、`diff`（`diffs: [{path, oldText, newText}]`，新文件 `oldText: null`）、`search`（grouped matches `shape:'matches'` 或 flat paths `shape:'paths'` + `truncated/total`，无 call 视图）、`web`（`kind:'search'|'fetch'`）。**硬规则：纯函数**——它们在 live streaming 和 session-log REPLAY 上都运行，禁止 I/O、读 session 状态、时钟/随机。UI-only 格式化（```console 块、diff、相对路径）禁止进 canonical value 与 Native content。`defineTool` 对显示路径软校验：坏参数返回 `undefined`（generic 兜底）而不是 throw，显示永不 crash replay。

### 1.2 加一个 LLM 适配器（`adding-an-llm-adapter.md`）

参考实现：`packages/llm/llm-deepseek`（直接 HTTP + `eventsource-parser` 框 SSE）、`packages/llm/llm-pi-ai`（包装 LLM 库）；协议约定先读 `StreamChunk` 文档。

形态：

```ts
class MyAdapter extends LlmAdapter {
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> { … }
}
export const name = 'llm-myprovider'
export const inject = ['llm']
export const Config = z.object({ apiKey: z.string(), … })
export function apply(ctx: Context, config: Config) {
  ctx.llm.registerAdapter(['my-provider'], new MyAdapter(…))
}
```

- 注册 effect-based（HMR 安全）；每 provider route 一个 adapter，重复注册 throw，multi-route 注册 all-or-nothing。`options.provider` 选适配器、`options.model` 是 provider 模型 id——动态目录适配器可服务新模型而无需生命周期重配。
- **秘密是 cordis-native**：schemastery Config + env fallback，从 cordis.yml 用 `!!js process.env.MY_KEY` 注入；代码里绝不读临时 key 文件。
- **协议义务**（两个实现共同验证过的契约）：
  - `usage` 在 `finish` **之前**发；`finish` 之后什么都不发。稳妥做法：把 finish/usage 缓冲到 provider 的 end-of-stream 标记再 flush（应对 trailing usage-only chunk）。
  - tool-call `arguments` 端到端是 **RAW JSON string**，流式以 `argumentsDelta` 分片；provider 若给 parsed object，在 `block-end` 重新 stringify。
  - block `index` 按 first-seen 流顺序分配；同一 block 每个 delta 复用该 index。
  - 错误只有两条合法路径：从 `stream()` **throw**（传输/协议失败，用带稳定 code 的 `LlmError`），或以 `finish {kind:'error'|'aborted'}` 结束流（provider in-band 失败）。消费者两种都处理；按失败类别选一并在文档记录。
  - 尊重 `options.signal`（传给 fetch/SDK）。
  - provider 无法兑现的 `GenerateOptions` 字段（如不支持 stop 列表）：throw `LlmError(..., 'UNSUPPORTED')`，别静默丢弃。
  - provider 需要原生元数据（response ids/签名）用于后续调用时，用 `finish.replayState` 发射最小 lossless-JSON 投影；重建历史时校验。`LlmRuntime` 只在历史 provider 路由与目标路由当前由**完全同一适配器实例**拥有时才传它。
  - **`resolveModel()`**：provider-neutral 能力接缝，带 provider/model 身份与可选 `context`/`reasoning` 字段；只有确实存在时才声明 `defaultEffort`；尊重可选 `AbortSignal`。reasoning effort 是有序不透明 id，映射到 provider 请求由适配器负责；保留适配器权威可选列表（含适配器定义的 `off`），不暴露 wire 拼写也不钳制不支持值。
- **实现结构**：wire types / request serialization / transport parsing / chunk translation / adapter class 分离，参考 `llm-deepseek` 布局。

### 1.3 加一个工作区包（`adding-a-package.md`）

新增 `@deepseek-ai/dsh-<name>` 包的文件级清单，模板为 bash 与 adapter 包。

- 结构：`packages/<group>/<pkg>/` 下 `package.json`（抄 `packages/core/tools`）、`tsconfig.json`（extends `tsconfig.base.json`，`rootDir src`、`outDir lib/types`，references 指 `vendor/cosmokit`+`vendor/cordis`，用 Config 加 `vendor/schemastery`，每个 dsh dep 加一条 reference）、`src/index.ts`（service 默认导出或 name/inject/apply/Config 插件）、`README.md`。
- group 复用已有：`core/llm/bash/compact/subagent/todo/session-persistence/ui/util/support`；新 group 是纯容器（无 package.json 无源码，包仍在其下恰好一级）。
- package.json 不变量（`pnpm run constraints`/`check-workspace-constraints.ts` 强制）：`private: true`、version 匹配根、`type: module`、`main:"lib/index.js"`、`types:"lib/types/index.d.ts"`、`exports["."]` 两项、`@deepseek-ai/cordis` 同时进 peerDependencies 和 devDependencies（同 range）、每个 dsh peer 依赖镜像进 devDependencies、`@deepseek-ai/schemastery` 进 dependencies（运行时校验器）、`files` 只含既定产物清单。**包内相对导入用显式 `.ts` 后缀**（如 `export * from './types.ts'`），编译器把运行时导入重写为 `.js`、声明里保留 `.ts`。
- 根配置注册：`tsconfig.base.json`（新 group 加 wildcard candidate）、`tsconfig.host.json` 或 `tsconfig.client.json` references（普通包只属一个 aggregate，绝不两个；不要抄 `api/remotes` 的跨期 split）、`knip.json`（仅当有仓库发现覆盖不到的 entrypoint）。client 包额外 extends `tsconfig.base.client.json`、声明 `dsh.client`、导出 `./client`、用共享 tsdown preset。workspaces/publint-all/tsdown/oxlint/constraints 自动覆盖无需改。
- **拓扑拆分**：可替换能力 → Service Definition / Provider / Consumer 拆包（见 architecture §Capability seams，shell 三件套为模板）；单一职责插件保持一个包。
- 角色命名表（只挑关键）：`Registry`=拥有动态具名注册集合（含查找/重复或优先级/disposal）；`Runtime`=运行现场工作、拥有跨调用派发/取消/生命周期；`Store`=拥有一份数据集且主要是 CRUD/快照/订阅；`Resolver`=纯计算/定位一个答案且不拥有生命周期；`Gateway`=适配进程/网络/RPC/API 边界；`Provider`=能力定义的一个实现（可多个时加机制/vendor 限定词）；`Service`=没有更贴切角色时用，绝不因为 extends `Service` 就叫 Service。**单数 `ctx` key**（engine/runtime/policy/controller/resolver/store/config）vs 复数 key（registry/拥多个具名成员）。`SDK` 专指 JSON-RPC 协议；产品拼写必须是 **Typert**（非 TypeRT/typeRT）。
- README 以固定序列收尾：`## Model Experience`（### Request context and condition → 四个有序 H4：What the model sees / Token effect / KV Cache effect / （定位字段））与 `## Known Limitations and Deferred Work`（消费者可见缺口+后果+维护者约束）。语音标准与 verifier 强制结构。

### 1.4 加一个 Convosation Node（`adding-a-conversation-node.md`）

在 Web Client Chat 视图加一个业务行。核心引擎模型见 Agent Note `2026-08-09-client-conversation-node-assembly.md`。

- **可重放事件族**：先选一个稳定业务 id；每个事件携带该 id 或从自己 payload 推导；客户端绝不把更新指派给「最新未完成」Context。每个 `(kind, id)` 至多一个 start 事件。增量事件受支持，但能便宜发整值检查点时优先（start 在窗口外也有用）；每个 delta 必须带 id、按升序 log `seq` 重放产生确定性 State、不依赖 live-only 内存。start 没加载时，只含更新的窗口保持 pending、不建 State；产品要在 start 加载前就渲染，则 terminal/checkpoint 事件必须携带可独立建结果的整值兜底态。
- **注入与类型合并**：`inject: ['conversationEvents', 'slots']`。用 declaration merging 扩展 `SessionEventMap`（事件用 `@mode emit`）、`ChatNodeDataMap`、`ConversationStepDataMap`（`dsh-client-runtime/client`）。
- **Definition 方法**：
  - `match(event)` 是 **identity extractor 不是 fold**：只收当前事件，返回 Definition 本地 id + lifecycle role（`{id, role:'start'|'update'}`）或 null；assembler 按 `(kind,id)` 定位 Context。
  - `start(context, match)` 建初始 State；`update(context, match)` 用当前 State 返回新 State（返回新不可变值优先，mutate 后返回同一对象语义相同）。
  - `publication`：`immediate`（结构性/终态）、`animation-frame`（高频可见 delta 合并每帧最多一次发布）、`none`（只喂后续发布）；engine 仍然按 log 序应用每个 update，cadence 只合并视图发布。
  - `buildLocationData(context, scope)` 可选发布 Definition 所有数据到 Turn/Step（`scope==='step'`）；另一 Node 可在同一 Location 经 `useTurnData(key)` 消费，不用拿 Session 或扫节点。
  - `target` 与 `buildViewNode(context)` 成对出现；`locationOf` 用 `context.start?.location ?? context.matches[0]?.location ?? {kind:'unresolved'}`；`anchorSeq` 选持久排序证据（`context.start?.event.seq ?? context.matches[0]?.event.seq ?? 0`）；Node 发布后**保持同一 key**，要暂时离开可视流用 `visibility:'hidden'` 而非 `null`。
  - 渲染器经槽注册：`ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({ name:'conversation.chat.node', key:'review-job' }, ReviewNodeView))`。
- **只在前任查询于 start**：`start` 收到 `ConversationContextReader`，调 `reader.previous<State>(kind)` 读当前 start `seq` 之前最近的已启动 Context（只读）；assembler 记录依赖，旧 prepend 若提供更近前任/补窗/修订前任 State，会从 start 重跑并升序重放 updates。
- **三条摄入路径**：① replace（打开/resync/补洞）：重建窗口、每个 event 对每个 Definition match 一次、重放每个已启动 Context 的 start+updates；② prepend 一页旧页：只 match 新鲜旧事件、按 `(kind,id)` 并入 Contexts、保留已有 keyed nodes、只重放受影响 Context 与依赖；③ append 一个 live event：对每个 Definition 调一次 `match`、按键查找、只 update 该 Context。**复杂度不变式**：D 个 Definition 时一个事件 = D 次 match + 命中后常数时间 key 查找；append 路径上**禁止**遍历完整事件窗口/所有 Context/`context.matches`/已渲染 Node 集合。测试结论六条（见文档 §5）。

### 1.5 vendor 包（`adding-a-vendored-package.md`）

Harness 需要另一个上游 Cordis 包（如 `@cordisjs/plugin-http`）时，作为固定源码 **vendored** 到 `vendor/`，而非加 npm 依赖（决策见 `2026-06-11-vendor-cordis-as-source.md`）。

- `vendor/<dir>/`：`package.json`（来自上游，`"private": true`（vendored 永不发布）、rescope name（见 rescope.md）、保留 version/exports/type、declaration metadata 指 `lib/types`、publish `.d.ts`/`.d.ts.map`、cordis deps 列进 peerDependencies）、`tsconfig.json`（extends `tsconfig.base.json`，`rootDir src`/`outDir lib/types` + 上游需要的严格性放宽：`noUncheckedIndexedAccess/exactOptionalPropertyTypes/noImplicitOverride/noUnusedLocals/noUnusedParameters` 均 false，references 指向每个它导入的 vendored 包）、`src/` 原样、`README.md`/`LICENSE`。
- 传递依赖也必须 vendor 或已存在（往往连带整棵依赖树，如 `@cordisjs/plugin-http` 拉 `@cordisjs/fetch-file`）。
- 根配置：`tsconfig.base.json` paths 加 `"<npm-name>": ["./vendor/<dir>/src"]`；`tsconfig.host.json` references 加 `./vendor/<dir>`（**置于 packages/* 之前**，vendored 代码只经 host aggregate 进图）；`vendor/README.md` 加 manifest 表行（dir/npm name/version/upstream repo/commit SHA）并记录本地改动；publint 一般跳过。
- **清单守卫**：`scripts/check-vendor-manifest.sh`（pre-commit 钩子）若 `vendor/*/src` 有 staged 而 `vendor/README.md` 未同时 staged 则失败。
- 隔离边界是 project-reference 图：vendored 源码必须经自己的 `vendor/<dir>/tsconfig.json` 引用，不得被拉进 aggregate 的严格程序。

### 1.6 扩展子系统（`docs/subsystems/extensions.md` + `extension-cookbook.md`）

**扩展子系统**：让 agent 定义版本化 Cordis 包、运行其 host/browser 两半、写码前查询已批准的运行时元数据。两个 Host 服务 + 一组 `cordis/*` emit 事件（见第 5 节列表）。

**扩展插件形态（extension-cookbook）**：
- **工具插件**：`ctx.tools.register`（`defineTool` 是 first-party 类型化 helper；raw JSON-Schema `ToolDefinition` 直接接受，MCP 来源即此路）。
- **钩子插件（权限门示例）**：在 `ctx.on('tools/pre-execute', async (exec, next) => …)` 返回 typed decision `{kind:'deny', reason:'…'}` 或 `next()`。native hook 就是普通 Cordis 插件、无需外部协议。waterfall 是**可重排**的策略层。
- **UI 插件**：从 `session/event` 流渲染（`assistant/chunk` 的 `text-delta` 等），输入经 `agent.followup()`（`createUserMessage` + `source:{kind:'user'}`）/`agent.steer()` 喂回；浏览器插件向内置 Web Client 加业务行则注册 `ConversationNodeDefinition`+keyed Chat renderer。
- **外部协议驱动**：把 wire 对端适配到 `ctx.agents`，可服务 UI 或自动化客户端。stdio driver 拥有 stdout、经 factory 创建/恢复 agent、把协议请求映射到 `followup()`/`cancel()`。低层 prompt 请求返回**持久 enqueue 收据**，不得用 `MessageId` 对 `turn/end` 做相关来取结果——整体 agent 状态另行发布。teardown 用 `AgentHandle.dispose()` 达 quiescence。worked example：`packages/acp/acp`（Agent Client Protocol JSON-RPC stdio）。

**功能→机制映射（微内核主张可检验）**，与本项目最相关的几行：
- Hook 系统：`agent/session-start`、`agent/pre-step`、`agent/request`、`tools/pre-execute`、`tools/post-execute`、`agent/turn-stopping`。
- **Scheduled tasks (cron)**：插件注册 model-callable scheduling tools；timer 触发 → idle 时 `followup(…, {source: {kind:'cron', …}})` 推送 / busy 时 `inject()` 通知。
- Queued + steering：core `Agent.followup()` / `Agent.steer()`。
- 插件热重载：每个注册都是 `ctx.effect` → vendored HMR 直接可用。

### 1.7 Code Runtime / Code Mode SDK（`docs/subsystems/code-runtime.md`）

代码执行接缝（capability seam），Service Definition `dsh-code-runtime`（`ctx.codeRuntime`），运行一个模型写的程序、暴露 host 异步绑定、报告打印与返回。**这是可选能力，不在 agent-loop 主轴上**。

- `CodeRunRequest { program, bindings, signal? }`：请求携带运行时行动的一切。「explicit > implicit at package boundaries」：默认化（时间预算、输出上限）是实现的已验证 config，不是 `run()` 里隐藏 `??`。program 作为 async 函数体运行：顶层 `await`/`return` 可用，完成值成为 `CodeRunResult.value`。
- `CodeRunResult { value?, logs, error? }`：**错误是字段不是 rejection**（`run()` 永不因程序失败 reject，匹配 `ShellExecutor.run` 的 resolve-on-failure 契约）；`value` 只在程序跑完且越过 lossless-JSON 边界时存在，无效或超限完成值判失败而非替换为渲染字符串。
- **Bindings**：`CodeBindingNamespace { global, functions, errorClass? }`——一个全局对象一组异步可调用函数（Code Mode 传一个：`tools`）。`global` 必须匹配语言可移植标识符子集 `[A-Za-z_][A-Za-z0-9_]*` 且不是任何语言保留字（JS-only 拼写如 `$tools` 被有意拒绝）；不能命中 `RESERVED_BINDING_GLOBALS`（如 `console`/`__dsh_main__`）。绑定名视为敌意输入（`__proto__` 是普通自有属性，null-prototype 构造）。`CodeBindingErrorClass`：注入真实错误构造函数使 rejected 成员调用变成其实例，暴露成员名；`memberNameProperty` 排除集 `RESERVED_ERROR_MEMBERS` + dunder 名。`CodeBindingFunction = (args: unknown) => Promise<CodeJsonValue>`，args/解析值必须 lossless JSON（可跨序列化桥），无 seam 级字节上限；lossy/不可克隆值以描述性错误拒绝。
- **失败分类（正交）**：`'exception'`（抛或 parse/transform 失败）/`'timeout'`（实现拥有的预算到期，消息说明哪个）/`'abort'`（signal 触发，in-flight 绑定调用归**调用方**自己 settle，runtime 只是停止请求）/`'worker-exit'`（执行基板死了没 settle，如 OOM）/`'invalid-output'`（完成值非 lossless JSON）/`'output-limit'`（序列化外层日志/值/诊断超配置上限）。预算是显式失败，不是带内值替换。
- **服务描述符**：`language`：`'typescript'`/`'python'`（well-known；只有 TS 有已发布 backend；消费者据此切换呈现、无法呈现则 loud-fail）；`isolation`：`'worker-thread'`/`'process'`/`'container'`（**诊断标签，不是安全声明**）。实现必须 keep runs 相互隔离（无跨 run 状态）且 dispose 达 quiescence（teardown 完成前终止并 await 进行中 run）。

### 1.8 Typert（`docs/subsystems/typert.md`）

Host Gateway 与消费方 API 装配共享的类型；架构/传输决策见 `2026-08-02-typert-remote-method-calls.md`；字面公共契约在 `dsh-typert-protocol` 与 `dsh-api-gateway`。

- **查找与 Context 声明**：业务对象包经 declaration merging 扩展空 map `TypertLookupMap`（Host 对象类型→wire 身份）与 `TypertContextMap`（scoped Context kind→wire 身份）；generated descriptors 命名 key，运行时 providers 提供解析。lookup 的 wire 声明在 resolver 卸载后仍保留（`TypertLookupDefinition { key, parameter, wire, hostTypeSymbol, wireTypeSymbol }`）。
- **两种 codec**：`strict`（携带 typeSymbol + `TypertSchema`）与 `src-json`（强制 JSON-safe 值、无结构类型恢复）。
- **`InvocationDescriptor` 是本地反射不是 wire message**：请求只发 endpoint + 命名 `args`；cancellation 是业务参数之后注入的 **out-of-band carrier signal**，绝不进 `args`（`cancellation: { parameter: 'signal' }`）。`source: 'json' | 'lookup'`；`acceptsUndefined` 只对显式 `T | undefined` 生效。
- **`ctx.typert` 注册表**：`local`/`remotes`/`lookups`/`contexts` 四仓分离；注册是 Cordis-owned effects、返回 awaitable disposer；`register/get/resolve/list/toJSONSchema` 等，重复身份整批拒绝（apply 逐包检查才会知道批次粒度）。**`ctx.typertGateway.invoke(request)`** 为 Host dispatcher：`InvokeRemoteRequest { namespace, method, args, signal? }`；错误走 `TypertGatewayErrorCode` 枚举（`ambiguous-endpoint/arguments-invalid/binding-invalid/context-failed/context-not-found/context-unavailable/definition-unavailable/input-invalid/invocation-unavailable/lookup-failed/lookup-not-found/lookup-unavailable/method-unavailable/provider-mismatch/result-invalid/service-unavailable/signature-invalid`）；lookup 策略错误与业务错误经 `TypertLookupFailure` 保留身份原样返回。**`ctx.remote`**：只暴露 `/remote` 贡献的 namespace；`$mount()` 一次性安装 descriptors+具体方法（fiber-owned）；每个 namespace 是 traced `remote.<namespace>` Cordis child Service；`$on(event, listener)` 订阅转发 Host 事件（单向、按注册序、孤立抛错监听器）；`$dispatch` 是 wire 边界（无人订阅的广播静默丢弃）。**`ctx.apiProxy.respond`** 是 server→client 请求的响应入口（非领域方法）。

---

## 2. 关键设计决策与原因

1. **effect-based 注册（HMR 安全）**：所有机制——工具、LLM 适配器、Typert contribution、会话 Node——都挂在 fiber 生命周期上，dispose 即反注册；这是 vendored 热重载能「直接可用」的原因（扩展子系统）。任何插件侧效果都必须属于当前 Fiber。
2. **canonical lossless JSON 单向通道 + 三层呈现分离**：执行路径只产出一个 lossless JSON 值；model-facing prose 在 `output.render`，replayable UI 状态在 `presentationMeta`+card presenters，真正 UI 视图由 host/client 各自映射。「UI-only 格式化不进模型结果」保证同一工具在 Native 与 Code Mode 语义一致（Code Mode 拿 canonical 值、极宽只读中间态无字节上限）。这是避免双维护的关键。
3. **显式优于隐式（package 边界）**：`CodeRunRequest` 携带运行时行动的一切、无隐藏 `??` 默认；错误尽量以结果字段（`CodeRunResult.error`、`finish {kind:…}`）而非异常面暴露，且**正交结果独立报告**——预算到期≠异常、abort≠timeout、substrate 死亡两者都不是。原因：调用方才能把「截断的 run」读作失败而非干净成功。
4. **身份与不可变**：工具调用的 `args`/`token`/`signal` 在派发全程不可变、「注册借用只读定义」，把并发、策略、重放中的变异面封死；Conversation Node 用稳定业务 id `(kind,id)` 定位（绝不「最新未完成」）、`anchorSeq` 取持久排序证据、Node key 恒定，使增量事件在升序重放下确定性收敛。
5. **策略层与业务层分离**：部署策略（权限门/sandbox/plan mode）放在 `tools/*` 拦截点与独立 `ctx.sandbox`/`ctx.approval` 轴，而非写进工具自身；守卫是**单调**终局（`guard()`）防后监听器撤销；微内核主张下**没有任何一行修改 loop**，每个特性都是某扩展点上的监听器。
6. **vendor 而非 npm 依赖**：上游 Cordis 包固定源码入库、依赖树整体 vendor、rescope + private，避免 npm 版本漂移并保持 graph 隔离（vendored 只经自己的 tsconfig 被 host aggregate 引用）。守护清单钩子防止未经登记的上游源码混入。
7. **秘密注入 cordis-native**：schemastery Config + `cordis.yml` 的 `!!js process.env.X`，绝不在代码里读临时 key 文件——与防御性模式「不把环境/可预测路径交给不受信任输出」同源。
8. **LLM 适配器错误双通道 + replayState + UNSUPPORTED**：传输/协议 throw `LlmError`（稳定 code）、provider in-band 用 `finish error/aborted`；无法兑现的字段显式 `UNSUPPORTED` 而非静默降级；原生元数据以最小 lossless 投影走 `replayState` 且仅同实例才恢复。这让消费者从不猜错异常来源。

---

## 3. 对「钉钉桥接器 + 自研定时任务插件」项目可复用的结论/代码模式

结合扩展子系统与 Cookbook，两件事都是「扩展插件」而非修改 loop：

1. **定时任务推送的正确姿势（文档原话语义）**：Scheduled tasks (cron) = 插件注册 model-callable scheduling tools；timer 触发 → **空闲时 `followup(…, {source: {kind: 'cron', …}})` 推送、忙碌时 `inject()` 通知**。可复用要点：
   - timer 需挂 fiber（`ctx.effect`/官方 timer API 返回 disposer），随插件停止而撤销。
   - 由文档「异步状态不是同步状态」：`agent.followup()` 无 per-message 完成/结果；`agent/status`/`whenIdle()` 不能当作某一次 follow-up 的结果（多条排队、steering、inject 可共享一个 `running` 区间；取消/dispose 会丢弃未启动项）。若定时任务要确认某轮真正结束，必须显式定义区间（例如从自己消息的持久收据到下一次 whole-agent `idle`），并处理「没有可等的东西」分支防挂死。
   - 忙碌时的 `inject()` 只是追加给下一请求的持久上下文、不是唤醒——不要把「一定会立刻响应」写进假设。
2. **钉钉桥接器 = 外部协议驱动（protocol driver）形态**：适配 wire 对端到 `ctx.agents`；`inject: ['agents', 'sessions', 'sessionPersistence']`（按 ACP 驱动样板）。模式：①监听 `session/event` 里的 `assistant/chunk`（尤其 `text-delta`）把 assistant 文本/推理流推给钉钉（sending 用 web 工具/HTTP binding 自接）；②入口「prompt」经 factory 创建/恢复 agent、`followup(createUserMessage({content, source:{kind:'user'}}))` 喂入并返回 enqueue 收据；③低层 prompt **不要**用 `MessageId↔turn/end` 相关性去取结果——whole-agent 状态另发；④teardown 达 quiescence（`AgentHandle.dispose()` = stop + await exit）。若走双向互动 UI，也可用 `agent.steer()`。
3. **工具侧复用**：
   - 钉钉发送/查询可封装为 `ctx.tools.register(defineTool({…}))` 的 first-party 工具，遵守 execute 契约：参数靠框架验证、返回单一 canonical lossless JSON、throw 即 isError、`exec.signal` 挂到 HTTP 请求、长时同步用 `ctx.jobs.start` + `{kind:'background', jobId}` handle、异步结果用 `exec.agent.inject({content, source:{kind:'plugin', plugin:'<name>'}})`（不是唤醒）。
   - 若要在钉钉侧渲染卡片/进度，别塞进 canonical value：`output.render` 管模型 prose，`presentationMeta`+`presentCall/presentResult` 管可重放 UI 态，且保持纯函数（无 I/O、无 session 读取、无时钟/随机——replay 也跑）。
   - 消息进/出用 `session/event`（用户→`createUserMessage`+`followup`；assistant→听 `assistant/chunk`）。会话重放：`sessions.create(id, { seed })` + `session/event`→JSONL 是官方 replay 路径。
4. **安全/合规清单**（防御性模式直接适用）：给钉钉发的内容/命令子进程 env 要 scrub（`*KEY*/*SECRET*/*TOKEN*/*PASSWORD*`）；临时/spill 文件用私有 0700 目录、随机名、`'wx'`/`0o600` 独占创建；可能为链接的路径先 `lstatSync().isSymbolicLink()` 再 `unlinkSync`，别对目录用递归 `rmSync`；用户监听器回调必须 try/catch 隔离，一个坏订阅者不能打死核心生命周期；错误面：正交结果独立上报（超时与 exit 0 各自成字段）、公共契约双边一致。
5. **若把钉钉连接做成可配置且多 provider**：套 LLM 适配器模式不适用（那是模型 provider），但可借用其结构纪律（注册 effect-based、配置 schemastery + `!!js process.env.DINGTALK_APP_KEY/…` 注入、`UNSUPPORTED` 显式报错、模块内责任分离）。
6. **若要在 Web Client Chat 里为具体业务（如钉钉消息任务）加一行状态**：按 `ConversationNodeDefinition` 走——先定稳定事件族与 branded id、事件 `@mode emit` 进 `SessionEventMap`，`match`=identity extractor，`publication` 高频用 `animation-frame`、终态 `immediate`，`buildViewNode` 保 key 恒定，append 路径保持 D 次 match + 常数查找、**禁止扫窗口/Contexts/nodes**。同样可给定时任务状态做 Chat Node。

---

## 4. 不确定处（文档未明说）

- Code Mode 具体如何映射 `ctx.jobs.start` 的 run_in_background 类型化 handle 到 `ToolOutputMap` 的细节：文档断言「成功后台分支返回 typed canonical handle」但未给出 handle 的完整 wire schema；「外层 `run_code` 的 logs/result 跨配置输出上限与 model-facing spill 管线」的具体阈值未在本页给出。
- `ctx.tools.guard()` 的精确签名（返回 type/参数）在 cookbook 只给语义描述（monotonic final deny、后监听器不可撤销），未给出方法签名；`ctx.tools.restrict()` 同理（「keep presentation, lookup, and execution aligned」、可替换 visible set，无签名）。
- `ctx.typert.register()` 的「整批拒绝」行为文档说原子化、重复身份整批拒绝，但「apply 逐包检查才知道批次粒度」的边界细节未展开。
- `code-runtime` 的 `language`/`isolation` 完整枚举：文档说 well-known 值 `'typescript'`/`'python'`、`'worker-thread'`/`'process'`/`'container'`，但未断言这就是穷举。
- Conversation Node 中 `useTurnData(key)` 的精确 hook 签名/约束（「constrained slot hook」）未给签名；`ConversationContextReader.previous()` 的返回形状（「nearest started Context … as read-only data」）未给类型。
- 定时任务行的 `{source: {kind:'cron', …}}`：只此一处出现，`…` 的具体字段未说明。
- 工具 UI `search`/`web` 之外还有无其它 card kind、`presentResult` 的 `meta?` 与 `presentationMeta` 的对应关系细节：文档描述了行为与归属，但未给出完整联合类型定义。

---

## 5. 相关联术语/事件名列表

**服务/注册点**：`ctx.tools.register` / `ctx.tools.guard` / `ctx.tools.restrict` / `ctx.jobs.start` / `ctx.llm.registerAdapter` / `ctx.conversationEvents.register` / `ctx.slots.inject('conversation.chat.node')` / `ctx.cordisInspect`（register/syncClientManifest/list/query/resolveClientQuery）/ `ctx.dynamicCordisRunner`（define/undefine/run/runHostHalf/getClientCode/resolveRequestRun/settleUserRun/stop/inventory/snapshot/reference/listPlugins/inspectPlugin/inspectPackage/reportRenderFailure/reportClientGuardFailure/invoke）/ `ctx.codeRuntime.run` / `ctx.typert`（get/resolve/list/toJSONSchema/register）/ `ctx.typertGateway.invoke` / `ctx.apiProxy.respond` / `ctx.remote`（$mount/$on/$dispatch）/ `ctx.agents.get(...).followup()/steer()/cancel()` / `AgentHandle.dispose()` / `ctx.approval` / `ctx.sandbox` / `ctx.goals` / `ctx.workflowEngine` / `ctx.compaction` / `ctx.systemPrompt.section()`。

**关键类型**：`defineTool`、`ParameterSchemaSpec`、`ValueSchemaSpec`、`ToolCallError`、`ToolArgsMap`/`ToolOutputMap`、`LlmAdapter`、`GenerateOptions`、`StreamChunk`、`LlmError`、`ConversationNodeDefinition`、`ConversationNodeContext`、`ConversationLocation`、`ChatNodeViewProps`、`ConversationContextReader`、`CodeRunRequest`/`CodeRunResult`/`CodeRunFailure`、`CodeBindingNamespace`/`CodeBindingFunction`/`CodeBindingErrorClass`/`CodeJsonValue`、`TypertLookupMap`/`TypertContextMap`/`TypertCodec`/`InvocationDescriptor`/`TypertGatewayErrorCode`/`TypertLookupDefinition`（另有 InvokeRemoteRequest/TypertRegistryContract）。

**事件名**：`tools/pre-execute`、`tools/execute`、`tools/post-execute`、`tools/result`、`session/event`（内含 `assistant/chunk` 的 `text-delta`、turn/step 边界、tool 活动）、`agent/session-start`、`agent/pre-step`、`agent/request`、`agent/request-error`、`agent/turn-stopping`（可 steer 另一 step）、`turn/end`（`/loop` 在此 followup）、`system-prompt/assemble`、`cordis/dynamic-package`、`cordis/dynamic-retract`、`cordis/inspect-query`、`cordis/inspect-query-resolved`、`cordis/request-run`、`cordis/request-run-resolved`（后六个均 `@mode emit`）；业务自定事件进 `SessionEventMap`（`review/start`/`review/progress`/`review/end` 为教程示例，`@mode emit`）。

**执行/失败 enum**：`tool/result`（含 `result.meta` 持久化）、`finish {kind:'error'|'aborted'}`、`finish.replayState`、CodeRunFailure kinds `exception|timeout|abort|worker-exit|invalid-output|output-limit`、`PreToolDecision`（`{kind:'deny', reason}` | `next()`）、`ToolExecution.concludeTurn()`、cordis event dispatch modes（emit 等，见 cordis-primer）。
