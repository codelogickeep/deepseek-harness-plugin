---
title: DSH 完整学习索引：原理 + 插件开发 + 对项目指导
description: 系统精读本地 DSH 全部 105+ 文档后的总导航与快速参考——文档地图、核心原理解读、插件开发要点、对本项目（钉钉桥接器+定时任务）的指导。
tags: [dsh, index, learning, plugins, guide]
date: 2026-08-17
status: active
---

# DSH 完整学习索引

> 系统的完整学习已完成：精读本地 `deepseek-harness/docs` 全部 105+ 篇文档
> （去重后），产出 12 篇结构化学习笔记（见 [docs/learning/](./learning/)），
> 本文是**总导航 + 提炼**。
>
> 权威原理总纲另有 [DSH-CORDIS-PRINCIPLES.md](./DSH-CORDIS-PRINCIPLES.md)（论文 + 官方 reference）。
> 本文聚焦「读了全部文档之后」的**完整地图**与**插件开发实战提炼**。

---

## 一、文档地图（docs/ 全貌）

| 类别 | 对应文件 | 学什么 |
| --- | --- | --- |
| 架构总纲 | `architecture.md` | profile/组合包、核心包、事件三域、轮次流程、能力 seam、新行为归属表 |
| Cordis 概念 | `cordis-primer.md` | 插件模型、context、inject、事件、可逆副作用（五个核心想法） |
| Cordis API | `cordis-api/*.md`（6 篇） | Context 完整 API、事件模式、fiber、registry、service、inherited |
| 教程 | `cordis-tutorial/*.md`（7 章） | 从零写插件到接入 harness 的动手实践 |
| Agent 机制 | `agent-lifecycle.md`、`subsystems/core.md`、`system-prompt.md`、`scope.md`、`subagent.md` | Agent 接口、turn/step、inbox、per-agent scope |
| 工具 | `subsystems/tools.md`、`tool-execution-pipeline.md`、`tool-catalog.md` | 工具注册、执行流水线、schema、catalog |
| 会话/持久化 | `subsystems/session*.md`（含 projection/query/reference/telemetry）、`compaction.md`、`persistence-catalog.md` | SessionEvent 日志、投影、fork、压缩、持久化 |
| 定时/后台/目标 | `subsystems/schedule.md`、`jobs.md`、`goal.md` | 提醒、后台任务、目标管理 |
| 能力 seam 与端口 | `capability-seams.md`、`graph-atlas.md`、`module-graph.md`、`subsystems/llm-streaming.md`、`shell.md`、`terminal.md`、`subprocess.md`、`filesystem.md`、`web.md` | seam 三角色、各端口 |
| 安全 | `subsystems/approval.md`、`sandbox.md`、`permission-presets.md`、`credentials.md`、`settings.md` | 审批、沙箱、权限、凭据 |
| 插件开发实战 | `cookbook/*.md`（7 篇）、`subsystems/extensions.md`、`code-runtime.md`、`typert.md`、`defensive-patterns.md` | 加工具/LLM/包/节点、Code Mode、防御 |
| 定时任务事故复盘 | `CRON-SCHEDULER-INCIDENT.md` | 会话日志白名单 + fs 沙箱可写根 → 「历史加载失败 + 死循环」一条根因链（含 5 条插件实战法则） |
| 工具 schema 事故 + 铁律 | `LESSONS.md`「3.4」 | `output.schema` 用对象级 required、`parameters` 才用字段级 required；`--dump-config` 验不出 schema 错，须跑 `scripts/check-plugin.mjs` |
| 第三方插件容错研究 | `PLUGIN-RESILIENCE.md` | 为什么第三方插件能搞崩 DSH（fail-loud 是设计）、`cordis:group` 隔离不了崩溃（源码+实验证据）、落地「部署前自检」防线 |
| 浏览器阅读插件 | `BROWSER-READER.md` | Playwright 驱动真实浏览器，web_read 系列确定性读 JS 渲染页面 |
| UI/事件图 | `subsystems/web-server.md`、`client-modules.md`、`web-styling.md`、`attachment.md`、`event-producer-consumer.md`、`feedback.md`、`user-questions.md`、`spill.md` | Web 服务器、客户端模块、事件产销图 |
| 用户向开发 | `user/develop/**`、`user/guide/**` | 基础/框架/实践/指南 |
| 配置/运行 | `config-catalog.md`、`development.md`、`testing.md`、`rescope.md`、`api-gateway.md`、`glossary.md` | 配置目录、开发、测试、API 协议、术语 |

---

## 二、核心原理速览（读完文档的关键提炼）

### 2.1 一句话模型

> DSH = Cordis（可逆副作用 + 依赖注入 + 事件）+ 一组能力 seam。
> 所有注册都是 `ctx.effect`，卸载自动逆回；依赖经 `inject` 声明；事件即协议（`@mode` 标注）。

### 2.2 事件是核心扩展点（选对域）

- **持久会话事件**：`turn/* step/* user/message assistant/* tool/*` + 自定义（须扩展 `SessionEventMap`），进日志、跨重载存活。
- **实时 agent 事件**：`agent/*`（inbox/step/status/request/validation/continuation）。
- **waterfall 事件**：`agent/pre-step`、`agent/request`、`llm/stream`、三个 `tools/*`——必须 `next()` 委托。
- **serial 事件**：`agent/turn-stopping`（无 next，可停轮次）。

### 2.3 轮次流程（实测已验证）

```
turn/start
  claim input → assemble prompt → agent/pre-step (可拒绝/改写)
  step/start → append user/message → derive history
  agent/request → llm/stream → assistant/chunk* → assistant/message
  tool/call → tools/pre-execute → tools/execute → tools/post-execute → tool/result
  step/end → (欠工作则下一 step) → agent/turn-stopping
turn/end
```

### 2.4 能力 seam 三角色

`Service Definition`（接口）+ `Service Provider`（实现）+ `Consumer`（面向模型的工具）。
替换 provider 即改变全产品（如 fs 指向远程沙箱 = Bash/PTY/LSP 一起搬走）。

### 2.5 会话日志 = 唯一持久真相

> 模型可见即已记录。`deriveMessages()` 从日志投影模型历史。
> 新增持久状态 → 扩展 `SessionEventMap`，从日志渲染和回放（schedule 即此模型）。

---

## 三、插件开发要点（浓缩自 12 份笔记）

见各笔记详版；这里是最重要的「能直接上手」的骨架与坑：

### 工具插件最小形态

```ts
export const name = 'my-tool'
export const inject = ['tools']
export function apply(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'read_file', description: '…',
    parameters: { path: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_a, v) => ({ type: 'text', text: v }) },
    async execute(args, exec) { /* args 已校验；exec 带 signal/token */ },
  }))
}
```

要点：
- 注册即 effect → dispose 即注销；schema 自动进 system-prompt。
- `exec.signal` 必须尊重（取消）；长任务用 `ctx.jobs.start` + task-owned signal（不是 exec.signal）。
- 只返回 canonical JSON；throw ⇒ `isError`；UI 卡片是独立关注点（`presentCall/presentResult`）。
- 策略不要写进工具：用 `tools/pre-execute`（allow/deny/ask）、`ctx.tools.guard()`（单调最终拒绝）、`tools/execute`（deadline/retry）、`tools/post-execute`（替换/block 呈现）。
- 异步通知 Agent：`exec.agent.inject({ content, source: { kind: 'plugin', plugin: '<name>' } })`（不唤醒空闲 agent）。

### LLM 适配器（protocol driver 模式）

- seam：`ctx.llm` 上注册 MessageVocabulary + Adapter。
- 生产范式是「protocol driver」：把适配器搬进独立子进程 agent，通过协议与消费者协作，OS 进程边界提供隔离。
- service seam = `create_service_driver` + service type + service key + capability registration。

### Code Mode（PTC）

- `code-runtime` 提供 `run_code`/`tools.schedule_list` 等：模型写 TS 程序，生成的 SDK 经同一 schema 推导精确类型，一步多操作。
- Code 程序只读 `name`/`toolName`/`message`（错误是 `ToolCallError`），不能从 prose 解析 id。
- 工具 `output.render` 返回 model-facing 内容；UI 卡片经纯呈现投影声明。

### 防御性模式（写 DSH 插件必读）

- 插件执行环境受限：宿主插件无 `process`，用 `launchEnvironmentOf(ctx)` 取环境；有全局 `fetch`。
- 注册后不得 mutate schema/替换回调（只读定义）。
- 别把部署策略写进工具本体。
- 错误用稳定机器可读 code；配置错误用 `ValidationError`。

### 官方事故复盘里的已知坑（postmortem，写插件必避）

- **postmortem 0001**：命名空间插件（`export const name/inject/Config/apply`）里**多写一行 `export default apply` 会把插件的 `inject` 丢掉**，导致运行时崩溃。写法：要么只用命名导出，要么只用 default——别混。
- **postmortem 0001-b**：可选服务若通过**可追踪 shadow 代理**访问，可能误触发 `inject` 守卫 → `cannot get property "X" without inject`。如需可选服务，确保从自己的 fiber 直接 `ctx.get('x')`（strict 读），不要经别的 fiber 转手。
- **postmortem 0002**：Loader 配置里 **`!!js` 只作用于 `entry.options.config`（经 `_resolveConfig` 插值），不作用于 `entry.disabled`**——`disabled` 直接测原始值。想用 JS 表达式控制 disabled 是无效的，也不会报错（YAML 语法合法）。
- **postmortem 0003**：Web agent（智能体）验收了「替代服务器」而不是「当前 GUI」——**验证要指向当前真实目标**，不要因环境便利验了错误对象。
- **postmortem 0004**：Landlock 部分强制执行通知把子进程真实失败误归类为「部分启用」——**沙箱部分启用 ≠ 子进程成功**，错误分类会掩盖真实问题。

---

## 四、对本项目（钉钉桥接器 + 自研定时任务）的指导

（详情见 [06-schedule-jobs-goals.md](./learning/06-schedule-jobs-goals.md) 与 [DSH-CORDIS-PRINCIPLES.md](./DSH-CORDIS-PRINCIPLES.md)）

1. **定时任务的正确定位**（权威确认）：
   - `ctx.sessions` 的 `schedule/change` Session 事件是唯一持久权威（log-only），`session-local` 交付，无外部通知、无 cron。
   - 因此「自研定时任务」若想留在 DSH 可靠模型内：**折叠 log**（官方 validate）+ **把已触发记入日志**；配置文件的形态只能是**投影/快照**，不是真相源。
2. **定时器写法**（如果未来在 Cordis 插件里跑）必须用 `ctx.timer` 系列（interval/timeout/throttle/debounce，disposable、随 fiber 回卷），杜绝僵尸定时器。
3. **桥接器与 DSH 的边界**保持清晰：桥接器 = Consumer 外部集成（独立进程 ↔ `/api`）；DSH 本体扩展 = 配置树插件行。
4. **回复完成信号 = `turn/end`**（官方轮次流程确认，桥接器已按此实现）。
5. 钉钉消息发送可建模成 waterfall：真正发送在 built-in，审批/脱敏/重试/限流作为 listener 注入。
6. **自研定时任务实战铁律（2026-08-18 事故后新增，详 [CRON-SCHEDULER-INCIDENT.md](./CRON-SCHEDULER-INCIDENT.md)）**：
   - 绝不向 session 日志写自定义事件类型（`cron/dispatch` 会触发 `SessionFormatUnsupportedError`，导致整个会话历史无法加载；当前 rc.6 `append()` 也无法写 `ignorable` 信封）。
   - 跨 tick/跨重启的状态（如 `lastFiredAt`）必须落在 workspace 内可写文件（`workspace-write` 只放行 `header.cwd` 子树 + `/tmp`），不能依赖 `~/.dsh/` 等沙箱外路径——否则回写失败 → 每次 tick 重建状态 → 死循环重复触发。
7. **钉钉 Stream 入站可靠性铁律（2026-08-18 静默断连后新增）**：第三方 IM SDK 的 `autoReconnect` 只响应明确 close/error，**不治半开连接**（网络静默断、socket 无事件、connected 仍 true）；生产可靠性必须自加「健康哨兵 + 兜底强制重建 + connect 超时」三层守护（实现与细节见 [LESSONS.md](./LESSONS.md) Root Cause 2b）。
8. **已归档会话显示铁律（2026-08-18 新增）**：DSH 的 `workspace.list` 会在 `archivedSessionIds` 里通告已归档会话，但**工作区的 `sessionIds` 仍包含它们**（归档不从工作区摘除）；对外展示/投递（如 `/list`、`/use`）必须用 `archivedSessionIds` 手动过滤，否则会看到"history unavailable"的归档会话死尸。

---

## 五、12 份学习笔记导航

| 笔记 | 覆盖文档 | 亮点 |
| --- | --- | --- |
| [01-cordis-core-api](./learning/01-cordis-core-api.md) | primer + cordis-api×6 | Cordis 全部 API、fiber、事件模式、registry |
| [02-cordis-tutorial](./learning/02-cordis-tutorial.md) | tutorial×7 | 从零到 harness 的整套代码模式 |
| [03-agent-turn](./learning/03-agent-turn.md) | agent-lifecycle + core/system-prompt/scope/subagent | Agent 生命周期、turn/step 状态机、inbox |
| [04-tools-pipeline](./learning/04-tools-pipeline.md) | tools/tool-execution-pipeline/tool-catalog | 工具注册、流水线、schema DSL |
| [05-session-persistence](./learning/05-session-persistence.md) | session* + compaction + persistence | 会话日志、投影、fork、持久化 |
| [06-schedule-jobs-goals](./learning/06-schedule-jobs-goals.md) | schedule/jobs/goal | 定时任务权威机制 |
| [07-seams-ports](./learning/07-seams-ports.md) | seams + graph + llm/shell/terminal/subprocess/fs/web | 能力 seam 全景 |
| [08-approval-sandbox](./learning/08-approval-sandbox.md) | approval/sandbox/permission/credentials/settings | 安全体系 |
| [09-cookbook-extensions](./learning/09-cookbook-extensions.md) | cookbook×7 + extensions/code-runtime/typert/defensive | 插件实战菜谱 |
| [10-web-ui-events](./learning/10-web-ui-events.md) | web-server/client-modules/styling/attachment/events/feedback/user-questions/spill | 前端与事件图 |
| [11-user-dev-docs](./learning/11-user-dev-docs.md) | user/develop×9 + user/guide×3 | 用户向开发文档 |
| [12-config-running](./learning/12-config-running.md) | config-catalog/development/testing/rescope/api-gateway/glossary | 配置、测试、协议 |

---

## 六、来源

- 本地源码文档：`/Users/zhengyd/OpenProject/deepseek-harness/docs`（105+ 篇，含中英版）
- 官方文档站：<https://deepseek-harness.github.io/deepseek-harness/>
- Cordis 论文：`~/openproject/paper/paper.pdf`
