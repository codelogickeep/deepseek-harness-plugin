---
title: 项目全面 Code Review（2026-08-18）
description: 对 deepseek-harness-plugin 全项目（源码/插件/测试/脚本/配置/文档）的严格审查结论，按严重程度分级，作为后续修复的暂存清单。
tags: [review, code-review, todo]
date: 2026-08-18
status: fixed
---

# 项目全面 Code Review（2026-08-18）

> 范围：4200 行代码 + 7 个测试文件 + 脚本/工具 + 配置/文档。
> 方法：本人审核心源码（bridge/dingtalk/dsh/sessions/config/index），两个子代理并行审插件与测试，
> 关键结论（时区 bug）已独立复现验证。
> 状态：**已修复（核心项）**。2026-08-18 已修复 #1/#2/#3/#4 与 #9（原子写），并补齐时区与并发多会话测试；其余中等/轻微项待排期。

---

## 🔴 严重（4 个功能 bug，建议优先修复）

### 1. cron 定时任务「时区从未生效」—— 触发时刻静默偏差 8 小时 ⚠️最严重 —— ✅ 已修复
- **位置**：`plugins/cron-scheduler/cron.js:136`（nextOccurrence）+ `scheduler.js:112/194`
- **现象**：`scheduler.js` 把 `timezone`（默认 `Asia/Shanghai`）存进 task 对象，但调 `nextOccurrence(spec, now)` 时**从未传 timezone**；`nextOccurrence` 内部全用 `Date.UTC`/`getUTC*`。
- **已复现**：`cron "0 10 * * *"` + `timezone=Asia/Shanghai` → 实际在 **UTC 10:00（北京 18:00）** 触发，而非期望的北京 10:00（UTC 02:00）。偏差 +8h，无告警。
- **影响**：`jira-daily`（`0 10 * * *`）等所有定时任务触发时刻错 8 小时。
- **修法**：让 `nextOccurrence` 接受 timezone，把 cron 时/分按目标时区映射到 UTC 轴（用当天目标时区 offset），并补"上海 vs UTC"时差单测。

### 2. bridge 回复去重键跨会话冲突 —— 丢消息 —— ✅ 已修复
- **位置**：`src/bridge.js:566-567`（`_sentSeq.has/add(event.seq)`）+ `:699`（`_sentSeq = new Set()`）
- **现象**：`_sentSeq` 是全局 Set，只存 `event.seq`。但 seq 是**每个会话独立递增**的——会话 A 的 seq=100 会误吞会话 B 的 seq=100。
- **修法**：改成 `Map<sessionId, Set<seq>>` 或 `${sessionId}:${seq}` 键。

### 3. bridge 回复候选是单例 —— 多会话并发互相覆盖 —— ✅ 已修复
- **位置**：`src/bridge.js:37-38`（`_replyCandidate`/`_replyTimeout`）
- **现象**：两个钉钉会话同时触发 Agent 回复时，后到候选覆盖先到，先到那条丢失。
- **修法**：改为 per-session 的 Map。

### 4. dingtalk 连接守护存在重连竞态 —— ✅ 已修复
- **位置**：`src/dingtalk-client.js:120-127`（`_rebuild`）
- **现象**：`_rebuild()` 调 `_doConnect()` 时**不置 `_connecting=true`**（只有 `connect()` 置）。connect 卡满 30s 超时期间，哨兵 timer 会再次进入 `_rebuild`，导致并发双连接 + 日志风暴。
- **修法**：`_doConnect` 开头自管 `_connecting`（幂等置位），或 `_rebuild` 前置位。

---

## 🟡 中等（8 项）

| # | 位置 | 问题 | 建议 |
|---|---|---|---|
| 5 | `plugins/cron-scheduler/cron.js:226-246` | `nextLocalTime` 换算错误（混入本地系统时区 offset），且是无人调用的 dead code | 删除或重写为只用 targetOffset 的公式 |
| 6 | `scheduler.js:151-166` + `cron-scheduler.mjs:238-244` | lastFired 跨源混用：升级/回滚/手动编辑配置时可能补触发一次 | 统一语义 + `_buildState` 合并取 max |
| 7 | `src/bridge.js:439-446` | `/sched` 对每个会话串行拉 6 页历史，100+ 会话极慢 | 缓存或按需查询 |
| 8 | `src/dingtalk-client.js:180-186` | `_rebuild` 重建 client 后，`onEvent()` 注册的监听器丢失 | 重建后重新挂载 |
| 9 | `src/sessions.js:69-77` | `_save` 非原子写（直接 writeFileSync 覆盖），崩溃可能损坏 mapping JSON | 先写临时文件再 rename —— ✅ 已修复 |
| 10 | `src/config.js` + README | 配置僵尸 + 文档过时：`activePushQuietMs` 无消费者（代码已改 turn/end），`replyFallbackMs` 代码在用但 config 未定义，README 仍描述旧"2.5s 静默去抖" | 清理死配置，更新文档 |
| 11 | `.env.example` + `config/config.example.json` | 硬编码个人绝对路径 `/Users/zhengyd/OpenProject/...` | 改占位符/相对路径 |
| 12 | `scripts/install-plugins.mjs:76` | `rmSync(destDir, recursive)` 无路径校验，DSH_HOME 配错可能误删 | 校验 destDir 在预期前缀内 |

---

## 🟢 轻微（9 项）

- `plugins/minimax-search/minimax-search.mjs:94` `slice(0, undefined)` 无上限 → `Math.min(maxResults ?? 5, 20)`
- `minimax-search.mjs:114` `apply()` 未包 `ctx.effect`（热替换残留）
- `src/config.js:88` `maxBlankLines` 硬编码，不走配置
- `src/bridge.js:145` 群聊 @ 判定：robotCode 为空时 `content.includes('@')` 误判为 at
- `package.json` 顶层 `ws` 依赖冗余（代码用全局 WebSocket）
- README 指令表缺 `/sched` 一行
- `cron-scheduler.mjs:108` 兜底硬编码 `/Users/zhengyd`；`:381` `setInterval` 未 `.unref()`
- `scheduler.js:58` `enabled: "false"`（字符串）被当成 true——缺类型校验
- `test/dsh-client.integration.test.js:33` 模块顶层 `assert.ok(online)`，DSH 离线时整个测试文件加载失败

---

## 测试质量

- 多项**恒真断言**：`test/bridge.e2e.test.js:142-157` 在测正则字面量（`/^\/(status|状态)/.test('/status')` 恒 true），未进 Bridge 代码。
- `/use` 切换测试只测了 SessionMapper，没测 `_handleUse`。
- 多处 `setTimeout(20)×N` 猜时序，flaky 风险。
- **覆盖缺口**：时区、DST、跨会话去重、并发回复、lastFired 回拨等关键分支无负向测试。→ 已补：时区（上海/纽约）单测 + 并发多会话回复测试（`test/bridge-concurrency.test.js`）。

---

## 总体评价

**架构清晰、可维护性中上**：分层合理（cron 解析/状态机/IO 粘合），零依赖纯 ESM，mock 注入可测性好。此前修复的事故（cron/dispatch 污染、lastFired 死循环、半开连接、归档过滤）方向都正确、主流程可靠。

**但存在 4 个真实功能 bug**，最要紧的是 #1 时区（定时任务静默错 8h），现有 70 项测试完全没覆盖（"上海恰好=本机时区"掩盖了）。

---

## 修复优先级建议

1. **#1 时区**（影响实际触发时刻，必修）
2. **#2/#3 丢消息**（跨会话去重冲突 + 回复候选单例）
3. **#4 守护竞态**（重连风暴）
4. #5 dead code 清理 + #6 lastFired 语义统一（随修）
5. #7-12 中等问题分批

---

## 修复记录（2026-08-18）

已修复并通过全量测试（76 项，0 失败）：
- **#1 时区**：`cron.js` `nextOccurrence(spec, after, timezone)` 按目标时区解释 cron 字段；`scheduler.js` 全链路传递 `task.timezone`。补上海/纽约时差单测。
- **#2 去重键**：`bridge.js` `_sentSeq` 改为 `Map<sessionId, Set<seq>>`，跨会话不再误吞。
- **#3 回复候选**：`bridge.js` `_replyCandidates`/`_replyTimeouts` 改为 per-session Map，并发回复不再互相覆盖。
- **#4 守护竞态**：`dingtalk-client.js` `_doConnect` 开头幂等置位 `_connecting`，connect 超时期间哨兵不再并发重建。
- **#9 原子写**：`sessions.js` `_save` 先写临时文件再 rename。
- **测试**：新增 `test/bridge-concurrency.test.js`（两个会话同 seq 并发回复），并扩展 `cron.test.js` 时区用例。
