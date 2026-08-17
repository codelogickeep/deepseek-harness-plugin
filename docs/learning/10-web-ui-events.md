---
title: Web 服务器、客户端模块与事件图
description: DSH 本地 docs 精读学习笔记（来源 docs/10-*）——Web 服务器、客户端模块与事件图
tags: [web, ui, events]
date: 2026-08-17
status: learning-note
---
# 10. Web 服务器・客户端模块(Client UI)・样式 token・附件・事件全图・反馈/用户提问/溢出

> 主题文档：`docs/subsystems/web-server.md`、`docs/subsystems/client-modules.md`、`docs/web-styling.md`、`docs/subsystems/attachment.md`、`docs/event-producer-consumer.md`、`docs/subsystems/feedback.md`、`docs/subsystems/user-questions.md`、`docs/subsystems/spill.md`（均取英文版）。
> 学习主题：「Web 服务器、客户端模块(Client Slots/UI)、样式 token、附件、事件生产消费全图、反馈/用户提问/溢出(spill)等交互子系统」。

## 1. 核心概念与机制

### 1.1 HTTP 服务器（`ctx.webServer`，dsh-host-webserver）

- 定位：GUI host 的浏览器 HTTP 载体，是**单个 `node:http` 插件**。提供四样东西：`ctx.webServer` 服务、**命名路由注册表**、**index.html 变换回调**、以及**可被某个插件认领的唯一 fallback 处理器**。它"不属于代理循环、不是能力接缝、不懂任何 harness 概念"——包括 `/api` 桥、插件 bundle、HMR 事件流在内的**每个功能路由都由别的插件注册**。只服务浏览器：Electron 用 `file://` 加载构建产物，经 IPC 桥发 fetch，不走此服务器。
- 路由类型：`WebRouteKind = 'exact' | 'prefix'`；`WebRoute { kind, path(绝对路径、无尾斜杠), handler(req,res) }`，handler **拥有完整响应生命周期**（可长时间持有响应，如 SSE）。
- 匹配顺序固定：**exact 表 → 最长 prefix 匹配 → fallback**。注册顺序对请求无语义；已命名路由须互不相交；fallback **只有一个 seat，第二个注册即 throw**。出厂 Web 组合由 `dsh-host-frontend-static` 认领该 seat（SPA dist 服务器）：非 GET/HEAD 返回 405、越过 dist 根目录的遍历返回 403、任何 miss 回退 `index.html` 且 HTTP 200（SPA 路由）、未知扩展名按 octet-stream 发送。
- 配置：`Config { host: '127.0.0.1' | '0.0.0.0', port: number }`。默认仅回环；`0.0.0.0` 是刻意的网络暴露。**无 TLS、无鉴权、无源站策略**，非回环绑定即暴露给该网络。
- 服务行为：激活即监听；监听失败（EADDRINUSE…）**reject 初始化**，启动过程报告失败 fiber。`register(route)` 注册命名路由并返回**清理器**；重复 `(kind,path)` throw（路由模式是组合级契约，冲突即配置错误）。`registerUpgrade` 注册 HTTP upgrade（如 WS），重复路径 throw（一个 socket 只能有一个协议属主）。`registerFallback(handler)` 认领 fallback（仅一个属主）。`tapIndex(transform)` 加一个纯 html→html 变换，作用于每次 index 响应，按注册顺序执行（`dsh-client-modules` 用它注入启动清单）；`applyIndexTaps(html)` 由 fallback 属主对每个 index 响应调用。`port` 可读实际监听端口（含 `config.port=0` 时 OS 分配的端口）。
- 容错与清理：处理中抛错（畸形 %-escape 命中 `decodeURIComponent`、客户端中途断连）→ 记 warning + 答 400，或 headers 已发出则销毁 socket，**绝不导致进程退出**。卸载时把 `close()` 与 `closeAllConnections()` 配对——因为 SSE 这类 handler 会长期持有连接、不会自行结束，不强关清理会挂死。

### 1.2 客户端模块（`ctx.clientModules`，dsh-client-modules 的 Node 半）

- 四个面相（同一服务）：扫描 host Loader 中声明了 `dsh.client` 的包、组合 `window.__DSH_BOOT__` 入口图、为每个 bundle 提供 `/plugins/<id>/client.js` 路由、以 index tap 注入启动清单。属 Web GUI 栈的**可选能力**、非代理循环主干；是 `dsh-host-webserver` 的消费者（注册 prefix 路由 + index tap）。
- 连线（wire）：Node 侧组合 `WebBootEntry` 行，作为 `<head>` 中**第一个 script** 注入（`<` 被转义，防止插件可控字符串逃出 script 元素），shell 引导前先解析。**缺清单/畸形清单 → 浏览器侧解析器 loud throw，页面无法启动**。
- `WebBootEntry { id(==包名), url('/plugins/<id>/client.js?rev=<rev>'), rev(bundle 内容哈希=缓存失效锚点), inject?(依赖边，仅信息性), immediately?(第一段预取标记) }`；`WebBootGraph { rev(整图一致性锚点), entries(顺序无语义) }`。每行 `rev` 是 bundle 内容哈希并作为查询串做缓存失效；任一行变化 → 图上 `rev` 变化。`immediately` 行在 module-face boot 时预取并注册；非 immediately 行首次 import 才拉取。
- 扫描：包声明 `dsh.client`（`platform:'web'`、可选 `inject` 边、可选 `immediately`）并从 `exports["./client"]` 导出 bundle 即入表。解析锚点 = 配置树的 `ctx.baseUrl`（cordis.yml 目录）。**扫描按包增量进行，无全量重扫路径**；每次 cordis `internal/plugin` 发射（fiber 构建/销毁）把该入口名标脏，微任务 flush 逐名对账。激活 pass 用全部当前条目播种脏集并**同步 flush**——首扫与稳态共用一套实现，但失败姿态相反：激活期畸形声明/缺 bundle 聚合成一个 loud `AggregateError`（列出每个坏包），fiber FAIL、启动 fail-loud 上报；稳态下坏包只打 warning、不得毒化他人。包元数据（含"非客户端包"的否定结论）按名缓存**永不过期**：插件集变更需重启生效；fiber 重启复用行与 rev。
- Bundle 路由与 tap：`GET/HEAD /plugins/<id>/client.js` 从磁盘服务、`no-cache`（一致性靠 rev 查询串而非 HTTP 缓存）；其他方法 405；未知 id 或 bundle 未构建而不可读 → **loud 404**（绝不让载体的 SPA fallback 把 HTML 当 JS 发出）。index tap 每次渲染注入当前图，刷新即对活组合启动。
- 服务 API：`graph()` 返回稳定的当前组合图；`clientPath(id)` 返回 bundle 绝对路径（未知 id→undefined）；`rebuilt(id)` 是 **bundle 内容变化的唯一入口**（重新哈希文件，只有 rev **真的变了**才重组合图并通知）；`onRebuilt((id,rev)=>void)` 每次实际变化的 bundle 触发；`onGraphChanged(()=>void)` 任何使图重组合的 flush 后触发，**pull 模型**（监听者自行重读 `graph()`）。两条通知路径都**隔离监听者异常**——一个 throw 的订阅者不会跳过后续订阅者、也不会杀死触发 flush 的动作。
- 开发态 HMR：`dsh-client-hmr` 是注册表的 watch 驱动——Node 半基于**同步捕获的基线** stat 轮询每个图行 bundle，变了就调 `rebuilt(id)`，经 `onGraphChanged` 重同步 watch 集，并经 **SSE** 把 rev 变化广播给浏览器半。生产图完全不含 HMR 行；module host 本身从不 watch 文件。

### 1.3 样式 token（web-styling.md）

- 所有权：`ui-theme` 拥有 `--dsw-*` 静态刻度、**语义别名**、排版、动效、渐变、阴影、滚动条样式、明暗偏好；`ui-layout` 把解析后的主题快照应用到 document；功能包只消费语义别名、**不另定义全局主题**。
- 全局样式表归 `ui-theme/src/styles/`；组件样式以 **CSS Modules** 与组件同置。组件可定义"布局/呈现契约"内的本地自定义属性，但共享色、排版、阴影、动效归主题包。
- 组件规则：用 CSS Modules + `clsx`，**不引入组件库/Tailwind**；功能组件只用 `--dsw-alias-*` 语义 token，**不复制静态调色板、不写字面颜色**；主题选择器不进功能组件 CSS（明暗覆盖归主题属主）；字号与行高配对、角色匹配时用主题排版变量；源码/终端/ diff 按契约保留列不折行、用共享滚动条样式；呈现放进 CSS（内联 React 样式只可传组件本地自定义属性值、不得编码主题分支）；加过渡/悬停控件时保留键盘焦点可见性与 reduced-motion。
- 改系统：共享 token 只在属主 `ui-theme` 样式表改，功能包消费语义别名；公共样式契约变化要更新属主包引用。

### 1.4 持久图片附件（`ctx.attachments`，`AttachmentStore` 抽象接缝）

- 接缝把二进制图片所有权与 Session 日志分离：生产者把**已验证编码字节**交给服务；服务**仅在对象持久化后**才发布不可变、内容寻址的引用。Session 事件与模型可见的 `ImageBlock` 含该引用与元数据，**绝不携带**浏览器 object URL、host 临时路径、provider URL 或 base64。
- 未发送的浏览器草稿可留在内存、原生客户端可暂存 OS 临时区；**host 接受用户消息后**、在用户事件追加前，图片移入 `<DSH_HOME>/attachments/v1`。结构化模型图片输出遵循同样的**先持久化再发事件**规则。
- 身份与元数据：`AttachmentId` 是 branded 不透明串；本地后端现发出 `sha256:<digest>`，但消费者**不得解析该表示、不得由其推导文件路径**。`ImageMediaType = 'image/png'|'image/jpeg'|'image/webp'|'image/gif'`。`ImageAttachmentRef { attachmentId, mediaType(按存储字节验证), bytes(编码字节精确长度), width, height, name?(去掉本地路径信息的显示名) }`。`ImageAttachmentLimits { maxImageBytes, maxImagesPerMessage, maxMessageImageBytes, maxImagePixels, mediaTypes }`。引用记录固有尺寸与编码长度，客户端**无需解码即可排版历史**；每次权威读仍重验 digest、媒体签名、尺寸与元数据。
- 提交与施密读取：`saveImage()` 先验证并**原子提交单个对象**再返回引用；`validateImage()` 做同样的准入检查但**不持久化**（批量调用先对每个成员跑一遍再保存任何成员，校验失败不留半成品对象）；`readImage()` 从授权会话路径接受引用，仅在**完整性验证通过**后返回字节。服务刻意"保留中立"：续接/复制的会话可能共享对象，引用感知的 GC 被推迟、不与任何单个会话的删除绑定。抽象三方法：`validateImage(input): Promise<void>`、`saveImage(input): Promise<ImageAttachmentRef>`、`readImage(ref, signal?): Promise<StoredImageAttachment>`（中止时抛 signal 原因、验证失败抛存储错误）。

### 1.5 事件生产-消费矩阵（event-producer-consumer.md）

- 生成产物：逐行列出每个"harness 自有事件"由哪些包分发、哪些包监听。**事件是多对多**；表中还覆盖故意绕过 `ctx.emit` 的受控分发点（如 subagent 生命周期收容）。
- 分发模式有四类：`emit` / `waterfall` / `serial` / `parallel`（例如 `agent/pre-step`、`agent/request`、`tools/pre-execute`、`tools/execute`、`tools/post-execute`、`llm/stream`、`approval/request` 是 `waterfall`；`session/flush` 是 `parallel`；`agent/turn-stopping` 是 `serial`；多数生命周期事件是 `emit`）。
- 与"定时任务/会话联动"直接相关：`agent/created`（监听 `agent-presets`、`goal-round-driver`、`schedule`）、`agent/status`（监听 `agent`、`apiproxy`、`compaction-basic`、`goal-round-driver`、`schedule`、`server`）、`agent/disposed`、`agent/session-start`、`agent/error`、`session/created`、`session/event`、`session/flush`、`session/disposed`、`subagent/start|end`、`workflow/*`、`goal/changed`。溢出消费：`tools/post-execute`（waterfall，监听含 `spill-policy`）与 `tools/code-dispatch-log`（waterfall，监听 `spill-policy`）。非 harness 声明的事件串另有 `internal/dispatch`、`internal/plugin`（监听含 `webserver`、`loader`）、`internal/service`、`internal/status`。

### 1.6 消息反馈（`ctx.messageFeedback`，dsh-message-feedback）

- 定位：单条 assistant 消息的可编辑反馈。**故意与不可变的 Session 级 `feedback/record` 事件分离**：是本地 storage-domain 旁车（sidecar），不是 Session-log 内容或投影，也不做遥测交接。
- 类型与乐观并发：`MessageFeedbackVersion` 是 branded 只供相等的 CAS token；`MessageFeedbackRating = 'positive'|'negative'`；`MessageFeedbackItem { messageId, rating, note?, version, createdAt, updatedAt }`（时间戳由 Host 赋 Unix epoch ms）。`put` 使用**严格乐观并发**：对已存在项的每个请求（**含 no-op**）都必须匹配当前 `ifVersion`（`null` 表示要求项不存在）；冲突返回权威当前项（或 null），调用方可就地调和而**不必再读一次**；删除已不存在的项视为成功。每个 Session 一个队列包住"检查→读→冲突判定→整行写"，单 Host 进程内并发调用得到保证。失败码：`session-not-found` / `target-not-found` / `version-conflict` / `note-blank` / `note-too-large`；统一 `{ ok:true, value } | { ok:false, error }` 结算。
- 目标与生命周期权威：经 `SessionPersistence.inspect()` 提供目标 Session 观察（不发布/不续接 Agent、不提交冷修复）；冷 `listSnapshots()` 预检判"确定不存在"。`put` 只接受**非空、append 来源的 `assistant/message`** 且 `MessageId` 匹配；replacement 来源、仅用量空消息、非 assistant 记录都不是反馈目标。存储的 `{createdAt, cwd}` 身份必须与检视到的 header 一致，不一致视为不存在；**fork 用新 Session 身份、不继承旁车副本**。
- 持久化：整 Session 行存入 `message_feedback` store domain（`ctx.storageDomain`）。`put` 提交引用目标消息的行前，匹配的活目标要过规范的 `ctx.sessions.flush` checkpoint；活/冷两路径都从 sequence 0 经 `SessionPersistence.readFrom` 物理重读，写旁车前重验证——**持久的 target 日志恒先于其旁车提交**。`maxNoteBytes` 必填、按 UTF-8 字节限 note；Web Host 组合设为 **8192**。卸载：关变更受理 → 排干已接收的每-Session 队列 → 关 storage domain。
- Web 表面与 Remote：浏览器消费者 `@deepseek-ai/dsh-client-ui-message-feedback`；`@deepseek-ai/dsh-api-remotes` 挂载生成的 `messageFeedback` 贡献，插件直接 `ctx.remote.messageFeedback`、**不碰传输层**。控件挂在 `conversation.chat.assistant-actions` list slot 的 `feedback` 项（order 10，`ui-conversation` 声明），渲染在最终 assistant 消息的 IconActions 行；为此 `AssistantMessageNode` 增补了可选的 `messageId`（来自 `assistant/message` 事件，中断冻结的部分消息上缺席则跳过渲染）。每 Session 一个 `MessageFeedbackController`：整体转录由**单一 `list` 读播种、延迟到首次 hover/focus 而非挂载**；每次变更发送控制器最近观察的 `ifVersion`，`version-conflict` 回包含权威项、就地调和不重取；变更按 Session 串行。
- 边界（照实记录）：变更队列进程本地、store domain 无跨进程条件写 → 多 writer 无 CAS/丢更新保证；持久化无持久删除 API，服务**不把 `session/disposed` 或 `host/session-removed` 当删除**、不做伪级联，孤儿行可能残留；live detach 后、目录物化前窗口可能得 `session-not-found`（重试）；冷请求全量扫快照目录（无按 id 查）；单行无条目数/聚合字节上限；Host 契约无 actor/审计身份（假定可信调用方）；控件只在 chat 视图（trajectory/waterfall 无）；旁车**不发活帧**，第二 tab 的评分要到重连或下次冲突回包才可见；note 编辑器不预检上限，超限在保存时报 `note-too-large`。

### 1.7 用户提问（`ctx.userQuestions`，dsh-user-questions）

- 定位：**provider 无关的词汇**——工具或权限插件需要人类回答以继续时使用。UI 表面提供活跃的 `UserQuestionProvider`；host 运行时把请求**转发给其已连接客户端**。
- 类型：`AskUserQuestionOption { label(用户可见标签==模型侧被选值), description? }`；`AskUserQuestionItem { id(调用方稳定 id、随答回显), question, detail?, header?, options?, multiSelect?(默认单选), intent? }`；`AskUserQuestionRequest { questions[], agent?(确切存活的调用方), signal? }`。`AskUserQuestionIntent` 目前 `kind:'plan-review'` + `approve`（指定"批准"选项的 label，**按名而非按位置**，UI 不得从选项顺序推断裁决）；intent **只改呈现、绝不改协议**——不识别的 UI 渲染通用选项表，且答案编码恒同。`ask()` 拒绝两种类型带不出的断言：`approve` 没指本题任何选项、给无 `detail` 的问题加 intent。答案：`AskUserQuestionAnswerItem { id, selected:[label...], custom?(自由输入"Other") }`——单选时 `custom` 覆盖被选项（selected 为空），多选时 `custom` 可补充；空 selected 且无 custom 用于在已完成批次中保留跳过的题目。
- Provider 与错误：**一个上下文只允许一个活跃 provider**，注册 effect 绑定，HMR/disposal 即移除。`UserQuestionError extends HarnessError`，`ctx.tools.execute()` 保留 `{ name, code }` 供模型面对，如 `EMPTY_QUESTIONS`、`NO_PROVIDER`、`ASK_ABORTED`、UI 侧取消。`registerProvider(provider)` 返回 disposer；`ask(request)` 在传入 agent 不是注册表**确切存活实例**时抛 `CALLER_NOT_LIVE`，传入的存活 agent 被其他 agent 拥有时抛 `DELEGATED_CALLER`。边界判定靠 **运行时属主而非持久会话谱系**：被拥有的子体没有人类应答者、会永久阻塞；带谱系但以新运行时根续接的会话可正常问。

### 1.8 溢出存储（`ctx.spillStore`，dsh-spill 接缝）

- 三段拆分：Service Definition `dsh-spill`（`ctx.spillStore`）、Provider `dsh-spill-local`（host 文件系统上**私有、会话作用域**文件）、Consumer `dsh-spill-policy`（`tools/post-execute` 策略）。可选能力、非代理循环主干；接缝只保存策略交给它的最终文本，预览机制在 output-retention。
- `saveText` 是**唯一**服务操作：逐字持久化 `content`，返回**不透明 locator**、后端给的检索提示、精确字节数。`SaveTextSpill { owner:SpillOwner, source:SpillSource, suggestedName(后端清洗为单个安全路径段——是提示、绝不是路径), content }`。`SpillOwner.sessionId` 是保存时存储命名空间；fork 的会话继承种子日志中已有的 locator（**不复制、不重属主**），fork 后新产的 spill 用子会话 id；保留期清理可连带过期旧 locator，接缝**不定义**每会话清理。`SpillSource { toolName, callId, label }` 纯描述性（命名/检视用），**从不作访问控制**。`SpillRef { locator, bytes, retrievalHint }`；`SpillLocator = Branded<'SpillLocator'>`——本地后端渲染为文件系统路径，远程/数据库后端可用 URI/键/命令 token；消费者当**不透明**处理、按 `retrievalHint` 呈现。
- 语义：`saveText` 持久化**完整** content、在真实存储失败（权限、ENOSPC、后端不可用）时 **REJECT**；接缝只拥有存储——无保留策略、无工具结果替换、无检索/搜索 API。本地后端写 `<root>/session-<hash>/<random>-<safeName>`：配置或懒建私有(0700)根、`sha256(sessionId)` 会话子目录、`open(path,'wx',0o600)` 独占属主写放植 symlink；locator=本地路径、retrievalHint 指示模型对该路径用 `read`/`grep`。策略消费者把超过 `maxInlineBytes` 的纯文本最终结果替换为"保留库 head/tail 预览 + spill 引用"，**best-effort**：保存失败就保留原始内联结果，绝不把一次成功调用变成 `isError`。

## 2. 关键设计决策与原因

- **WebServer 是"载体"而非"能力缝"**：它不懂 harness 概念，所有功能路由（/api 桥、bundle、HMR 流）由别的插件注册——解耦了传输与业务、让路由天然按插件组合式声明。
- **fallback seat 单属主 + 命名路由须不相交 + 重复即 throw**：路由模式是组合级契约，冲突是配置错误而非运行时兜底，编译/启动期即 loud。
- **固定匹配序（exact→最长 prefix→fallback）**：SPA 需求下把未匹配一律交 fallback 回退 `index.html` 200；重命名路由注册顺序无语义，防组合顺序影响请求结果。
- **无 TLS/鉴权/源站的单机 GUI 服务器**：默认只回环；`0.0.0.0` 是显式选择。安全性交给外部（且这是文档反复警告的点）。
- **`window.__DSH_BOOT__` 作为连线单源**：Node 半与浏览器半共享同一图形状；`rev` 全网作一致性锚点、`<` 转义防脚本逃逸、缺图即 loud 拒启——"宁可失败不可静默错"。
- **增量扫描 + 首扫/稳态两套失败姿态**（激活 AggregateError FAIL vs 稳态 warning 不毒化）：把配置错误的成本放在启动期、把运行期韧性放在稳态。
- **`rebuilt(id)` 是 bundle 内容进图的唯一入口**、两通知路径隔离监听者异常：入侵面小、一个坏订阅者不拖垮系统。
- **附件持久化先于事件、批量先验证后保存、内容寻址不可变引用、保留中立 GC**：保证日志内永远是"已落盘且可验证"的引用，防半成品与悬挂；不捆绑单一会话生命期以便 fork/续接共享。
- **反馈"旁车"与日志"旁置"并置 + 严格 ifVersion 乐观并发 + JSON Remote 结算**：反馈可随意编辑而不污染不可变日志；以 CAS 避免丢更新；以结构化 `ok/error` 结算承载业务错误到 Browser/Remote。
- **提问意图只改呈现不改协议、approve 按名不按位置、运行时属主决定能否问**：协议层保持通用，UI 可渐进识别；防止子体无人应答而永久阻塞。
- **spill 三分离 + best-effort 降级**：存储(接缝)/落盘(provider，私有+独占写)/消费(policy)解耦；大输出失败也不把成功调用变 isError，同时用 0700/`wx` 防 symlink 与越权。

## 3. 对「钉钉桥接器 + 自研定时任务插件」可复用的结论/代码模式

- **HTTP 接入（DingTalk 回调、机器人 webhook、状态页）**：不要碰 fallback seat（已被 frontend-static 认领）；用 `ctx.webServer.register({ kind:'exact'|'prefix', path, handler })` 注册自有命名路由，`register`/`registerUpgrade` 均返回 disposer，交给 `ctx.effect()/ctx.on()` 以便 stop/update 时自动移除。回调 handler 抛错会由 webserver 记 warning + 400——但在自己的 handler 内仍应 try/catch 并返回业务错误体。做 SSE/长连接（推送定时任务结果到浏览器）时 handler 可持有响应，webserver 卸载已含 `closeAllConnections()`，插件侧无需担心 teardown 挂起。**注意无 TLS/鉴权**：DingTalk 回调的签名校验等必须在插件自己的 handler 内实现。
- **事件驱动定时任务**：优先监听 `agent/created`、`agent/status`、`agent/session-start`、`session/created`、`session/event`、`session/flush`（参考 `schedule` 包的监听面）；用 `ctx.on(eventName, handler)` 并在同一 fiber 内注册。注意模式语义：`emit` 一次性通知、`waterfall` 可链式改负载（如 `tools/post-execute`）、`serial` 串行、`parallel` 并发；需要"工具执行后"挂钩时用 `waterfall` 型事件并返回既有值以保持兼容。
- **大文本/长报告溢出**：定时任务产出超长文本（如长日报）时，调 `ctx.spillStore.saveText({ owner:{sessionId}, source:{toolName, callId, label}, suggestedName, content })` 拿 `{locator, bytes, retrievalHint}`，把 locator + 提示返回模型侧，而不是把全文塞进上下文；`saveText` 会 REJECT 真实存储失败，自己按 best-effort 处理（保留原文并告警）。
- **需要人类确认/审批（如每日巡检需钉钉确认）**：插件可用 `ctx.userQuestions` 的 `ask()` 向 UI 要答案。钉钉桥接器若想把人机问题路由到钉钉会话，应 `ctx.userQuestions.registerProvider({ ask })` 实现自己的 provider——**注意一个上下文仅一个 provider**，且 `ask({agent})` 在 agent 不是存活运行根时抛 `CALLER_NOT_LIVE`/`DELEGATED_CALLER` 并按 `{name, code}` 面对模型。回调内不要在此阻塞（需异步流）。
- **图片/附件（DingTalk 图片消息）**：遵循"**先持久化再发事件**"与"批量先 `validateImage` 全过再逐个 `saveImage`"；日志/事件里只放 `ImageAttachmentRef`，绝不自己嵌入 base64/临时路径；DingTalk 侧下游 URL 由引用另行映射。
- **UI 样式约定（若为桥接器做 Web 设置/状态面板）**：功能包只用 `--dsw-alias-*` 语义 token + CSS Modules + `clsx`；不写字面色、不动主题选择器、不引组件库/Tailwind；明暗与动效交给 `ui-theme`。
- **跨包自研插件的通用纪律**：服务都尽量 `ctx.get('name')` 并判 undefined；显式需要的硬依赖才 `inject`；注册表/树/日志相关"无路径泄漏、不透传宿主对象"；所有同步副作用都放进 `ctx.effect()/ctx.on()`，事件通知路径自带头异常隔离。

## 4. 不确定处（文档未明说）

- client-modules.md 只讲 Node 半（manifest/bundle/扫描）；浏览器半 `ctx.modules`(lazy-CJS 表)、**Client Slot 注册的具体 API 与 theme token 明细**、`window.__DSH_BOOT__` 浏览器侧解析器的完整字段归各包 README/Inspect，本文档未给出 (文档未明说)。
- spill 的清理/保留策略、"spill-policy"触发阈值 `maxInlineBytes` 的具体取值、output-retention 预览算法细节不在本 seam 文档内 (文档未明说)。
- message-feedback 的"整行写"是否含独立 WAL、`MessageId` 的精确形态、Sidecar 落盘目录路径，文档未明说。
- user-questions 的"互通 provider 与 `ask` 的无 UI 场景"、`connection/reset`(feedback) 与提问 UI 的具体 RPC 帧协议，文档未明说。
- event 矩阵中 `schedule`/`server` 等仅列监测端；具体事件 payload 字段、分发时序（如 `agent/status` 的触发频率）不在本页。
- attachment "authorized session path" 的具体授权判定规则、`attachments/v1` 内部布局/清理策略未明说。

## 5. 相关联术语/事件名列表

- 服务/对象：`ctx.webServer`(WebServer/WebRoute/WebRouteKind/register/registerUpgrade/registerFallback/tapIndex/applyIndexTaps/port)、`ctx.clientModules`(ClientModuleRegistry/graph/clientPath/rebuilt/onRebuilt/onGraphChanged)、`window.__DSH_BOOT__`/WebBootEntry/WebBootGraph/`dsh.client`、`ctx.attachments`(AttachmentStore/AttachmentId/SaveImageAttachment/ImageAttachmentRef/StoredImageAttachment/ImageAttachmentLimits)、`ctx.messageFeedback`(MessageFeedbackService/MessageFeedbackItem/PutRequest/DeleteRequest/Version/MessageFeedback*Result)、`ctx.userQuestions`(UserQuestionService/AskUserQuestion*/UserQuestionProvider/UserQuestionError)、`ctx.spillStore`(SpillStore/SaveTextSpill/SpillRef/SpillLocator/SpillOwner/SpillSource)、`ui-theme`/`ui-layout`/`--dsw-*`/CSS Modules。
- 事件（DingTalk/定时任务高相关）：`agent/created`、`agent/disposed`、`agent/status`、`agent/error`、`agent/session-start`、`agent/pre-step`、`agent/request`、`session/created`、`session/event`、`session/flush`、`session/disposed`、`tools/pre-execute`、`tools/execute`、`tools/post-execute`、`tools/result`、`tools/code-dispatch-log`、`llm/stream`、`approval/request`、`subagent/start`、`subagent/end`、`workflow/*`、`goal/changed`、`internal/plugin`、`internal/dispatch`、`feedback/record`(Session 级不可变反馈事件，与 message-feedback 旁车相对)。
- 错误码：`EMPTY_QUESTIONS`/`NO_PROVIDER`/`ASK_ABORTED`/`CALLER_NOT_LIVE`/`DELEGATED_CALLER`；`session-not-found`/`target-not-found`/`version-conflict`/`note-blank`/`note-too-large`。
- 机制词：fallback seat、named-route registry、index tap/`tapIndex`、rev 缓存失效、stage-one 预取(`immediately`)、module-face boot、incremental scan、fail-loud、strict optimistic concurrency(CAS/`ifVersion`)、per-Session 队列、`ctx.sessions.flush` checkpoint、content-addressed 不可变引用、persist-before-event、storage domain sidecar、branded id、retrievalHint、(0700)/(0o600)/`open(...,'wx')`、best-effort 降级。
