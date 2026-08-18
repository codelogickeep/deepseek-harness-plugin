---
title: 定时任务插件事故复盘：会话日志污染 + 死循环
description: cron-scheduler 插件向会话日志写自定义事件导致历史无法加载、以及 lastFiredAt 回写失败导致定时任务死循环的完整根因、修复与沉淀的插件开发实战法则。
tags: [lessons, dsh, plugin, cron, sandbox, session-log, debugging]
date: 2026-08-18
status: stable
---

# 定时任务插件事故复盘：会话日志污染 + 死循环

> 本文件是 `cron-scheduler` 插件（自研定时调度）一次真实事故的完整复盘：
> 两个现象（历史加载失败 + 定时任务死循环）共享一条根因链——**插件直接向 DSH
> 会话日志写入了 DSH 不认识的自定义事件**，且 **`lastFiredAt` 回写因沙箱被拒**。
> 读者将获得 DSH 插件开发中最容易踩的三个坑的权威认知：
> **① SessionEvent 白名单与 `ignorable` 信封约束；② ctx.fs 沙箱可写根白名单；
> ③ 「跨 tick 状态」必须落到可写持久层才能防重复触发。**

---

## 一、事故现象

| 现象 | 表现 | 影响 |
| --- | --- | --- |
| A. 历史加载失败 | `history unavailable for session "...": SessionFormatUnsupportedError: ... contains event type "cron/dispatch" (seq 74006) unknown to this harness` | 该会话历史在 GUI 无法回看，Agent 也无法 resume |
| B. 定时任务死循环 | 每分钟命中点每次触发**两次**（间隔 30s），连续数小时不停 | 钉钉被轰炸、会话日志被写满 |

当时两个现象同时出现，看起来像是 DSH 的 bug，实际都是我们插件设计导致的。

---

## 二、根因链（一条链解释两现象）

```
cron-scheduler 插件
   │
   ├─ 每次 tick 触发任务后 ──► agent.session.append('cron/dispatch', {...})
   │                              ▲ 现象 A：DSH 读路径拒绝整个日志
   │
   └─ lastFiredAt 回写 ──► ctx.fs.writeText(主配置 ~/.dsh/cron-schedules.json)
                              ▲ 现象 B：沙箱拒绝 → 回写失败 → 死循环
```

### 根因 A：SessionEvent 白名单 + `ignorable` 信封

DSH 的会话日志是**事件溯源**：`Session.append(type, data)` 产生一条事件记录，持久化后
重建会话完全靠重放这些事件。因此 DSH 对事件类型有**严格格式保护**：

- 白名单：`KNOWN_SESSION_EVENT_TYPES`（`@deepseek-ai/dsh-session`），只含 DSH 官方事件
  （如 `turn/start`、`user/message`、`schedule/change`、`sandbox/mode` 等）。
- 读路径 `assertEventsSupported()`：遇到**白名单之外**且**未标记 `ignorable: true`**
  的事件类型 → 抛 `SessionFormatUnsupportedError`，**拒绝解释整份日志**。
- 设计意图（源码注释）："一个未被识别的必需事件可能改变对日志其余部分的解释，
  静默跳过会重建出错误的会话；标记 ignorable 说明删除它不影响重建。"

**你痛在哪里**：`cron/dispatch` 是插件自己发明的自定义类型——它既不在白名单里，
插件也**无法**通过 `Session.append()` 写入 `ignorable` 标记（append 的 options 只支持
surface 相关字段，不支持信封级的 `ignorable`）。所以**只要插件写一次这种事件，
该会话的历史就永久无法加载**（需离线修日志才能恢复）。

### 根因 B：ctx.fs 沙箱可写根白名单

插件要把 `lastFiredAt` 回写到主配置文件 `~/.dsh/cron-schedules.json`，用的是
`ctx.fs.writeText(target, text)`。但 DSH 默认部署在 `workspace-write` 沙箱模式下：

- `writableRoots()`（`@deepseek-ai/dsh-sandbox`）只放行三个根：
  **`policy.workspaceRoot`**（= session 的 `header.cwd`）、`/tmp`、`tmpdir()`。
- `~/.dsh/cron-schedules.json` 在 workspace 之外 → `checkedTarget()` 抛
  `FS_SANDBOX_DENIED`。
- 插件 `_persistLastFired` catch 到错误只 `_warn`，**没有别的持久化路径** → 相当于"写失败但继续跑"。

**死循环的形成**：每次 `tick()` 都从配置文件**重建全新 `TriggerState`**（内存态不跨
tick 保留）。由于 `lastFiredAt` 从未写进文件：

```
tick A (无 lastFired) → lookback 2min → 找到命中点 12:00 → markFired(内存) → 回写失败
tick B (30s 后, 又从文件重建) → lastFired 依然无 → 又找到 12:00 → 触发 again
→ 每 30s 一次，永不停歇（死循环）
```

而 `cron/dispatch` 审计事件反而能写进会话日志（`session.append` 走的是 session 内存 +
flush 通道，不走 fs 沙箱），所以表现为**"日志在涨、lastFired 没在写"**的诡异组合。

---

## 三、修复方案（已实施）

### 修复 1：不再向会话日志写自定义事件

`src/cron-scheduler.mjs`：删除 `agent.session.append('cron/dispatch', ...)`，
审计改走 `this._info(...)`（logger/console）。

```js
// 之前（污染日志）
agent.session?.append?.('cron/dispatch', { id, at, message })
// 之后（安全）
this._info(`已触发任务 ${task.id} @ ${at.toISOString()} -> agent ${agent.id}`)
```

### 修复 2：lastFired 状态落到 workspace 内可写文件（防死循环根治）

新状态文件 `config/cron-scheduler-state.json`（`config.coreDir` 的父级 `config/`，
落在 workspace 内 → workspace-write 可写）：

- `_buildState()`：从「主配置 lastFiredAt」+「状态文件 lastFired」合并恢复
  `TriggerState`（状态文件优先，因为它总是最新且可写）。
- `_persistLastFired()`：**总是**先写状态文件（防重复触发的关键），再尝试回写主配置；
  主配置被沙箱拒时明确告警（`FS_SANDBOX_DENIED`），但不再致命。
- 新增集成测试：主配置不可写（模拟 `FS_SANDBOX_DENIED`）时，跨 tick、跨实例重启
  均不重复触发；推进到新命中点才触发一次。

### 修复 3：离线修复已污染的历史日志

给既有会话日志中所有 `cron/dispatch` 事件**补上合法的 `ignorable: true` 信封字段**
（读路径认可的安全跳过标记），恢复加载。只重编码包含该事件的 zstd 帧，其余帧原字节
保留；修改前备份（`session.jsonl.zstd.bak-<ts>`）。

- 受影响会话：`session-12367081...`（5 个事件）、`session-f8605eda...`（163 个事件）→ 全部修复。
- 验证：`session.history` API 对两个会话均返回 `ok:true`，帧 5223/725 全部解码正常。

---

## 四、沉淀的插件开发实战法则（给所有 DSH 插件作者）

### 法则 1：绝不向 session 日志写自定义事件类型

- `Session.append()` 只用于 DSH **官方已知类型**（尤其 `schedule/change`、`user/message`、
  `assistant/message`、`tool/result` 等）。
- 插件自己的业务记录/审计，用 `ctx.logger`、`console`、独立 state 文件，**不要进日志**。
- 若确实需要可重放的插件级事件，DSH 要求扩展 `SessionEventMap`（TypeScript 层
  module augmentation）并确保能写 `ignorable:true`——但当前版本 `append()` 不支持
  写 ignorable 信封字段，所以**等价结论：插件在 rc.6 里无法合法地写自定义持久事件**。

### 法则 2：状态持久化必须落在沙箱可写根内

- `workspace-write` 模式只允许写：
  - session 的 `header.cwd`（workspace）子树
  - `/tmp` 与平台临时目录
- 任何需要**跨重启保留**的状态（lastFired、cursor、去重键）都要落在 workspace 内
  （如项目 `config/`、`data/`），而不是 `~/.dsh/` 之类沙箱外路径。
- 判断"我的路径可写吗"的最快方法：看 session 的 `sandbox/mode`（`session.list` 的
  `projections.settings.permissions.currentValue` 或日志里的 `sandbox/mode` 事件），
  然后对照 `writableRoots`。**沙箱拒绝是结构性的，与"文件权限"无关**。
- 例外：调用方主动提升为 `danger-full-access` 才可写任意路径（如本事故中我手工修
  日志时当前 session 是 `danger-full-access`）。

### 法则 3：跨 tick 的防重复状态不要依赖"回写失败不报错"的路径

- 任何"先触发，再回写 dedup 标记"的流程，都必须保证**回写成功**才算触发完成；
  若回写可能失败，应先把标记写到可靠位置（可写状态文件），再释放触发。
- 多一层：`TriggerState` 之类内存态每次 tick 重建时，要**显式合并持久态**，
  不要假设内存态跨 tick 存在。

### 法则 4：写入错误不要静默吞

- `catch` 里至少 `_warn`（本项目插件已有告警节流）；对结构性错误（`FS_SANDBOX_DENIED`、
  `SessionFormatUnsupportedError`）要能一眼识别：它们是配置/设计问题，不是偶发 IO。

### 法则 5：修 DSH 会话日志文件的注意点（离线修复）

- 文件是**多 zstd 帧拼接**（每批次一个独立帧，带 checksum），不是单一压缩流。
- 只改动目标帧并**重新压缩该帧**（`zstdCompressSync` + `ZSTD_c_checksumFlag`），
  其余帧原字节拷贝，避免全文件重写引入损坏。
- 首帧必须是**恰好一行 header**（`assertZstdHeaderFrame`），永远不要动它。
- 事件 seq 必须连续、header 只出现一次；信封字段白名单：
  `type/seq/time/data/surfaceOp/sourceEventSeqs/ignorable`。
- 压缩存储行（`text-chunks`/`tool-call-chunks` 等）是后端编码，不是 SessionEvent，
  校验信封时不要误判它们。

---

## 五、验证结果（修复后）

| 检查项 | 结果 |
| --- | --- |
| `session.history`（session-12367081…） | `ok:true`，3353 events |
| `session.history`（session-f8605eda…） | `ok:true`，1622 events |
| 两个日志帧完整性 | 全部解码正常、无坏帧、无重复 seq |
| `cron/dispatch` 新写入 | 已停止（诊断任务禁用 + 插件不再写） |
| 插件测试套件 | 43 项全部通过（含新增状态文件兜底测试） |

---

## 六、相关文件

- 插件：`src/cron-scheduler.mjs`（修复后）
- 测试：`test/cron-scheduler.integration.test.js`（含「lastFired 状态文件兜底」用例）
- 调度核心：`src/scheduler.js`、`src/cron.js`
- 部署：`~/.dsh/profiles/web/plugins/cron-scheduler.mjs`
- 相关阅读：
  - [LESSONS.md](./LESSONS.md)（桥接器搭建复盘）
  - [PLUGIN-ECOSYSTEM.md](./PLUGIN-ECOSYSTEM.md)（插件生态）
  - [DSH-DOCS-INDEX.md](./DSH-DOCS-INDEX.md)（DSH 完整学习索引：会话/持久化、沙箱、插件开发章节）
