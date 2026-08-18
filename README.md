---
title: deepseek-harness-plugin — DSH 插件集合与安装脚手架
description: DeepSeek Harness (DSH) 插件集合仓库：钉钉桥接器、MiniMax 网页搜索等插件统一沉淀，并提供 DSH 插件开发/安装的脚手架。
tags: [dsh, deepseek-harness, plugins, scaffold, dingtalk, minimax, ai-agent]
date: 2026-08-17
status: active
---
# deepseek-harness-plugin

**DSH（DeepSeek Harness）插件集合仓库 + 安装脚手架**：把你有用的 DSH 插件统一沉淀在这里，并提供开发/安装插件的脚手架。

当前已收录插件：

| 插件 | 说明 | 形态 |
| --- | --- | --- |
| **钉钉桥接器** (dsh-dingtalk-bridge) | 在钉钉里直接和 DSH Agent 对话，含会话管理控制台、**主动推送**（定时提醒→钉钉） | 独立进程 ↔ DSH `/api` |
| **MiniMax 网页搜索** (minimax-search) | 把 MiniMax 搜索注册为 DSH 宿主 Web 搜索 provider，`web_search` 工具直接可用 | DSH 宿主插件 (`cordis.patch.yml`) |
| **自研定时调度** (cron-scheduler) | 标准 **5 字段 cron 表达式**定时任务（`0 10 * * *`），配置文件驱动、跨重启防重复，到点唤醒指定 Agent 会话 | DSH 宿主插件 (`cordis.patch.yml`) |

> 另启用 DSH **官方** `dsh-schedule`（`schedule_create`/`list`/`delete`，after/at/every）
> 作为补充：临时/会话内定时用官方，固定 cron 节奏用自研 cron-scheduler。区别见 [插件 3](#插件-3自研定时调度-cron-scheduler)。

> 以后开发的新插件都放这里（详情见 [插件生态导览](docs/PLUGIN-ECOSYSTEM.md)）。

---

## 插件目录

| # | 插件 | 快速入口 |
| --- | --- | --- |
| 1 | 钉钉桥接器 | [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) 部署 · [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 架构 |
| 2 | MiniMax 搜索 | [docs/MINIMAX-SEARCH.md](docs/MINIMAX-SEARCH.md) 一键接入 |
| 3 | 自研定时调度 | [插件 3](#插件-3自研定时调度-cron-scheduler) · 事故复盘 [docs/CRON-SCHEDULER-INCIDENT.md](docs/CRON-SCHEDULER-INCIDENT.md) |
| — | 脚手架/方法论 | [docs/PLUGIN-ECOSYSTEM.md](docs/PLUGIN-ECOSYSTEM.md) · [docs/DSH-NOTES.md](docs/DSH-NOTES.md) |

---

## 插件 1：钉钉 ↔ DSH 桥接器

让你**在钉钉里直接和 DSH 中的 Agent 对话**。采用钉钉**企业内部应用 + Stream 模式**，无需公网域名/固定 IP/反向代理，本地即可运行。

### 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 填写配置（复制模板，填入钉钉应用凭证）
cp .env.example .env

# 3. 校验配置
npm run check:config

# 4. 启动
npm start
```

> 前提：
> - Node.js ≥ 22
> - DSH Web 正在运行（默认 `http://127.0.0.1:3080`）
> - 已按 [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) 在钉钉开放平台创建企业内部应用并启用机器人

### 架构

```
┌──────────┐   Stream WS    ┌──────────────────┐   HTTP POST /api/session.*   ┌──────────────┐
│  钉钉客户端  │ ───────────► │  dsh-dingtalk-   │ ──────────────────────────► │   DSH Host    │
│ (企业内部App│               │  bridge (daemon) │                               │  (Agent 会话)  │
│   机器人)   │ ◄─────────── │                  │ ◄────────────────────────── │              │
└──────────┘   消息应答Webhook└──────────────────┘   WS /api/events.mux        └──────────────┘
```

- **钉钉侧**：官方 `dingtalk-stream` SDK 连接钉钉 Stream 网关，订阅 `TOPIC_ROBOT` 接收机器人消息；用消息携带的 `sessionWebhook` 回发回复。
- **DSH 侧**：复用浏览器同款 `/api` 协议 —— `POST /api/session.prompt` 发消息，`WS /api/events.mux` 收 Agent 回复事件流。
- **映射**：每个钉钉会话（单聊/群聊）稳定映射到一个 DSH 会话，上下文连续，重启不丢。

详见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

### 钉钉内指令（会话管理控制台）

| 指令 | 说明 |
| --- | --- |
| `/status` | 查看当前投递目标（会话、项目、标题、状态） |
| `/list` | 按 DSH 工作区分组列出会话（▶=当前目标；`/list all` 平铺含未挂载） |
| `/use <序号\|关键词\|会话ID>` | 切换投递目标到某个会话（**历史保留，切回可续聊**） |
| `/new [路径]` | 新建一个 DSH 会话并设为当前目标（可选指定项目路径） |
| `/help` | 显示帮助 |

- 每个钉钉会话（单聊/群聊）对应一个「投递目标」DSH 会话，映射持久化到 `data/session-mapping.json`（**不入库**）。
- `/use` 切换后原会话保留，切回可续聊；新会话默认独立上下文。

### 主动推送（定时提醒 → 钉钉）

DSH 会话产生**非用户触发的消息**（自研 `cron-scheduler` 或官方 `dsh-schedule` 定时提醒到期、Agent 主动输出）时，
桥接器会把它推到将该会话设为投递目标的钉钉会话（`📨 Agent 主动消息` 前缀）。

- 前提：该钉钉用户**先给机器人发过消息**（持久化其 `sessionWebhook`）。
- **只推最终结果**：中间输出（思考/工具过程）不推，静默 `ACTIVE_PUSH_QUIET_MS`（默认 2.5s）后仅推最终结论。
- 配置：`ENABLE_ACTIVE_PUSH=true`（默认开）· `ACTIVE_PUSH_PREFIX=📨 Agent 主动消息` · `ACTIVE_PUSH_QUIET_MS=2500`。
- 链路：`定时到期 → Agent 输出 → 事件流捕获 → 去抖只取最终 → 持久 webhook → 钉钉`。
- 端到端已实测：`docs/LESSONS.md`「番外：定时任务 + 主动推送」。

---

## 插件 2：MiniMax 网页搜索（DSH 宿主插件）

把 [MiniMax「coding_plan/search」](https://platform.minimaxi.com) 注册为 DSH 的 `web` 搜索 provider，替代失效的 DeepSeek 官方搜索。接入后用 `web_search` 工具即可获得真实网页结果。

- **源码**：`plugins/minimax-search/minimax-search.mjs`（仓库唯一真相源）
- **安装**：`npm run install:plugins`（脚手架同步到 `~/.dsh/profiles/web/plugins/`）
- **一键接入**：[docs/MINIMAX-SEARCH.md](docs/MINIMAX-SEARCH.md)
- **宿主机制**：`cordis.patch.yml` disable 内置 DeepSeek + `searchProvider: minimax` + 插入插件行
- **key**：`~/.dsh/.env`（DSH 启动自动读取，不入库）

---

## 插件 3：自研定时调度（cron-scheduler）

**DSH 宿主插件**，把「标准 5 字段 cron 表达式 + 人类可读配置文件」带到 DSH 本体：
到点唤醒目标 Agent 会话处理提醒（Agent 的回复经桥接器推送到钉钉）。

### 与官方 dsh-schedule 的区别

| 维度 | 自研 cron-scheduler | 官方 dsh-schedule |
| --- | --- | --- |
| 触发方式 | **标准 cron 表达式**（`0 10 * * *`、`*/5 * * * *`） | 工具 `schedule_create/list/delete`（after/at/every，every≥5min） |
| 配置入口 | 配置文件 `cron-schedules.json`（版本化、可 review） | 会话内工具调用（Agent 创建，写 session 日志） |
| 粒度 | 分钟级（30s tick） | 分钟级（after/at）或周期（every≥5min） |
| 目标会话 | 每条可指定 `session`（或回退活动会话） | session-local（原会话且存活） |
| 适合场景 | 固定节奏巡检/日报（JIRA、例行） | 临时提醒、会话内一次性/周期任务 |

两者共存互补：**固定 cron 节奏用自研，临时/会话内用官方**。官方 `dsh-schedule`
通过 `cordis.patch.yml` 同目录启用（Agent 有 `schedule_*` 工具）。

### 配置

```json
// 默认 ~/.dsh/cron-schedules.json（config.schedulesPath 可覆盖）
{
  "timezone": "Asia/Shanghai",
  "schedules": [
    {
      "id": "jira-daily",
      "cron": "0 10 * * *",
      "timezone": "Asia/Shanghai",
      "session": "session-xxx",      // 可选：目标 DSH 会话
      "message": "查看 JIRA 支持网缺陷", // 必填：提醒正文
      "title": "每日 JIRA 巡检",       // 可选：钉钉标题
      "enabled": true
    }
  ]
}
```

### 设计要点（可维护性优先）

- **核心算法单一事实源**：cron 解析/调度逻辑在项目 `src/cron.js` + `src/scheduler.js`，
  插件经 `config.coreDir` 动态 import，部署与测试同源（避免两处漂移）。
- **跨重启防重复**：触发后 `lastFiredAt` 回写；主配置若在 DSH 沙箱外不可写时，
  自动落到 workspace 内 `config/cron-scheduler-state.json`（根治重复触发死循环）。
- **不再写自定义 session 事件**：审计走 logger，绝不 `session.append` 自定义类型
  （DSH 白名单外事件会导致历史无法加载——详见 [事故复盘](docs/CRON-SCHEDULER-INCIDENT.md)）。
- 测试：`test/cron.test.js`、`test/scheduler.test.js`、`test/cron-scheduler.integration.test.js`（43+ 用例）。

### 安装与源码

- **源码**：`src/cron-scheduler.mjs`（项目唯一真相源；核心算法依赖 `src/cron.js` + `src/scheduler.js`）
- **部署**：复制到 DSH 宿主插件目录 `~/.dsh/profiles/web/plugins/cron-scheduler.mjs`（
  现有部署即手动 COPY，非 `install:plugins` 管理；改源码后需同步并重启 DSH）
- **宿主机制**：`cordis.patch.yml` 插入 `cron-scheduler` 行（已启用）

---

## 脚手架：如何往这个项目里加新插件

1. **独立进程类**（如钉钉桥接器）→ 放 `src/`，共享 `/api` 协议。
2. **DSH 宿主插件**（如 MiniMax 搜索）→ 放 `plugins/<name>/` 子目录，源码唯一真相；
   用 `npm run install:plugins` 同步到 DSH 宿主（见 [scripts/install-plugins.mjs](scripts/install-plugins.mjs)）。
   > 例外：自研 cron-scheduler 的源码放在 `src/`（它复用 repo 内 `cron.js`/`scheduler.js` 核心算法，
   > 部署靠手动 COPY 到宿主 plugins/）。
3. 新插件务必写**文档**（带 frontmatter）+ **测试** + 更新 README 插件目录。

机制与目录规划详见 [docs/PLUGIN-ECOSYSTEM.md](docs/PLUGIN-ECOSYSTEM.md)。

---

## 项目结构

```
├── src/                     # ① 独立进程类插件（钉钉桥接器等）
│   ├── index.js             # 入口/装配/优雅关闭
│   ├── config.js            # 配置加载（env/.env/config.json + 校验）
│   ├── dsh-client.js        # DSH 外部客户端（RPC + WS 事件流 + 自动重连）
│   ├── dingtalk-client.js   # 钉钉 Stream 客户端（含连接守护）
│   ├── sessions.js          # 会话映射持久化
│   ├── bridge.js            # 双向转发核心
│   ├── cron-scheduler.mjs   # ② DSH 宿主插件：自研 cron 定时调度（源码在此，手动 COPY 部署）
│   ├── cron.js              #   cron 解析/下一命中（核心算法）
│   └── scheduler.js         #   调度状态机/防重复（核心算法）
├── plugins/                 # ② DSH 宿主插件（每个插件一个子目录，源码唯一真相源）
│   └── minimax-search/
│       └── minimax-search.mjs
├── tools/
│   └── restart-dsh-and-verify.mjs # launchd 重启 DSH 并自动验证
├── scripts/
│   └── install-plugins.mjs  # 脚手架：同步 plugins/ → ~/.dsh/profiles/<profile>/plugins/
├── test/                    # 集成测试（需要 DSH 在线）
├── config/config.example.json
├── docs/
│   ├── ARCHITECTURE.md      # 架构与协议说明
│   ├── DEPLOYMENT.md        # 钉钉开放平台配置 + 部署指南
│   ├── LESSONS.md           # 研发复盘与踩坑记录
│   ├── PLUGIN-ECOSYSTEM.md  # 插件生态导览（两类插件 + 目录规划）
│   ├── DSH-NOTES.md         # DSH 知识沉淀（官方动态 + 插件机制）
│   ├── CRON-SCHEDULER-INCIDENT.md # 定时任务事故复盘 + 插件开发法则
│   └── MINIMAX-SEARCH.md    # MiniMax 搜索接入指南
└── .env.example
```

## 指南

- [部署指南（钉钉桥接器 · 含钉钉开放平台从零配置）](docs/DEPLOYMENT.md)
- [架构与协议说明](docs/ARCHITECTURE.md)
- [研发复盘与踩坑记录](docs/LESSONS.md)（含外部 IM/机器人对接方法论）
- [插件生态导览](docs/PLUGIN-ECOSYSTEM.md)（两类插件区别、目录规划、如何扩展）
- [DSH 知识沉淀](docs/DSH-NOTES.md)（官方动态 + 宿主插件机制实战）
- [MiniMax 搜索接入指南](docs/MINIMAX-SEARCH.md)（一键接入 DSH 宿主 Web 搜索）

## 测试

```bash
npm test
```

测试包含 **DSH 真实协议集成测试**（需要 DSH Web 在线）与**桥接端到端测试**（用 Mock 钉钉模拟 Stream 消息，验证 钉钉→DSH→回复→钉钉 全链路）。

## 安全提醒

- `.env` 含 AppSecret 等凭证，勿提交（已在 `.gitignore`）。
- `data/`（会话映射）含会话标识符，不入库。
- DSH `/api` 是回环信任模型；外部接入请部署在本机/内网，勿暴露公网。
- 群聊默认仅在被 @ 时响应（可在 `src/bridge.js` 的 `_shouldIgnore` 调整）。

## License

MIT
