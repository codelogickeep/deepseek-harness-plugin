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
| **钉钉桥接器** (dsh-dingtalk-bridge) | 在钉钉里直接和 DSH Agent 对话，含会话管理控制台 | 独立进程 ↔ DSH `/api` |
| **MiniMax 网页搜索** (minimax-search) | 把 MiniMax 搜索注册为 DSH 宿主 Web 搜索 provider，`web_search` 工具直接可用 | DSH 宿主插件 (`cordis.patch.yml`) |

> 以后开发的新插件都放这里（详情见 [插件生态导览](docs/PLUGIN-ECOSYSTEM.md)）。

---

## 插件目录

| # | 插件 | 快速入口 |
| --- | --- | --- |
| 1 | 钉钉桥接器 | [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) 部署 · [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 架构 |
| 2 | MiniMax 搜索 | [docs/MINIMAX-SEARCH.md](docs/MINIMAX-SEARCH.md) 一键接入 |
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

---

## 插件 2：MiniMax 网页搜索（DSH 宿主插件）

把 [MiniMax「coding_plan/search」](https://platform.minimaxi.com) 注册为 DSH 的 `web` 搜索 provider，替代失效的 DeepSeek 官方搜索。接入后用 `web_search` 工具即可获得真实网页结果。

- **源码**：`plugins/minimax-search/minimax-search.mjs`（仓库唯一真相源）
- **安装**：`npm run install:plugins`（脚手架同步到 `~/.dsh/profiles/web/plugins/`）
- **一键接入**：[docs/MINIMAX-SEARCH.md](docs/MINIMAX-SEARCH.md)
- **宿主机制**：`cordis.patch.yml` disable 内置 DeepSeek + `searchProvider: minimax` + 插入插件行
- **key**：`~/.dsh/.env`（DSH 启动自动读取，不入库）

---

## 脚手架：如何往这个项目里加新插件

1. **独立进程类**（如钉钉桥接器）→ 放 `src/`，共享 `/api` 协议。
2. **DSH 宿主插件**（如 MiniMax 搜索）→ 放 `plugins/<name>/` 子目录，源码唯一真相；
   用 `npm run install:plugins` 同步到 DSH 宿主（见 [scripts/install-plugins.mjs](scripts/install-plugins.mjs)）。
3. 新插件务必写**文档**（带 frontmatter）+ **测试** + 更新 README 插件目录。

机制与目录规划详见 [docs/PLUGIN-ECOSYSTEM.md](docs/PLUGIN-ECOSYSTEM.md)。

---

## 项目结构

```
├── src/                     # ① 独立进程类插件（钉钉桥接器等）
│   ├── index.js             # 入口/装配/优雅关闭
│   ├── config.js            # 配置加载（env/.env/config.json + 校验）
│   ├── dsh-client.js        # DSH 外部客户端（RPC + WS 事件流 + 自动重连）
│   ├── dingtalk-client.js   # 钉钉 Stream 客户端
│   ├── sessions.js          # 会话映射持久化
│   └── bridge.js            # 双向转发核心
├── plugins/                 # ② DSH 宿主插件（每个插件一个子目录，源码唯一真相源）
│   └── minimax-search/
│       └── minimax-search.mjs
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
