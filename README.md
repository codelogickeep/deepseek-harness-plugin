---
title: dsh-dingtalk-bridge — 钉钉 ↔ DSH 桥接器
description: 钉钉与 DeepSeek Harness 双向通信桥接器：在钉钉里直接与 DSH Agent 对话，含会话管理控制台。
tags: [dingtalk, dsh, bridge, agent, stream]
date: 2026-08-17
status: active
---
# dsh-dingtalk-bridge

钉钉 ↔ DeepSeek Harness (DSH) 双向通信桥接器：让你**在钉钉里直接和 DSH 中的 Agent 对话**。

采用钉钉**企业内部应用 + Stream 模式**，无需公网域名/固定 IP/反向代理，本地即可运行。

## 快速开始

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

## 架构总览

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

## 项目结构

```
├── src/
│   ├── index.js            # 入口/装配/优雅关闭
│   ├── config.js           # 配置加载（env/.env/config.json + 校验）
│   ├── dsh-client.js       # DSH 外部客户端（RPC + WS 事件流 + 自动重连）
│   ├── dingtalk-client.js  # 钉钉 Stream 客户端
│   ├── sessions.js         # 会话映射持久化
│   └── bridge.js           # 双向转发核心
├── test/                   # 集成测试（需要 DSH 在线）
├── config/config.example.json
├── docs/
│   ├── ARCHITECTURE.md     # 架构与协议说明
│   ├── DEPLOYMENT.md       # 钉钉开放平台配置 + 部署指南
│   ├── LESSONS.md          # 研发复盘与踩坑记录
│   ├── PLUGIN-ECOSYSTEM.md # 插件生态导览
│   ├── DSH-NOTES.md        # DSH 知识沉淀（官方动态 + 插件机制）
│   └── MINIMAX-SEARCH.md   # MiniMax 搜索接入指南
└── .env.example
```

## 指南

- [部署指南（含钉钉开放平台从零配置）](docs/DEPLOYMENT.md)
- [架构与协议说明](docs/ARCHITECTURE.md)
- [研发复盘与踩坑记录](docs/LESSONS.md)（含外部 IM/机器人对接方法论）
- [插件生态导览](docs/PLUGIN-ECOSYSTEM.md)（两类插件区别、换机部署、如何扩展）
- [DSH 知识沉淀](docs/DSH-NOTES.md)（官方动态 + 宿主插件机制实战 + MiniMax 搜索接入模板）
- [MiniMax 搜索接入指南](docs/MINIMAX-SEARCH.md)（一键接入 DSH 宿主 Web 搜索）

## 测试

```bash
npm test
```

测试包含 **DSH 真实协议集成测试**（需要 DSH Web 在线）与**桥接端到端测试**（用 Mock 钉钉
模拟 Stream 消息，验证 钉钉→DSH→回复→钉钉 全链路）。

## 指令

在钉钉里向机器人发送：

| 指令 | 说明 |
| --- | --- |
| `/status` | 查看当前投递目标（会话、项目、标题、状态） |
| `/list` | 列出最近 N 个 DSH 会话（含项目路径、标题、运行状态、当前目标标记） |
| `/use <序号\|关键词\|会话ID>` | 切换投递目标到某个会话（**历史保留，切回可续聊**） |
| `/new [路径]` | 新建一个 DSH 会话并设为当前目标（可选指定项目路径） |
| `/help` | 显示帮助 |

### 会话切换与续聊

- 每个钉钉会话（单聊/群聊）对应一个「投递目标」DSH 会话，映射持久化到
  `data/session-mapping.json`，重启不丢。
- 用 `/use` 切换目标后，之前的会话**保留在历史中**（DSH 持久化对话历史），
  再 `/use` 切回即可**继续之前的对话**。
- 新钉钉会话默认自动创建独立 DSH 会话（上下文隔离）。
- 可选：设 `MAPPING_MODE=auto-follow` 让无映射时自动跟随当前运行中最新会话。

## 安全提醒

- `.env` 含 AppSecret，勿提交（已在 `.gitignore`）。
- DSH `/api` 是回环信任模型；桥接器请部署在本机/内网，勿暴露公网。
- 群聊默认仅在被 @ 时响应（可在 `src/bridge.js` 的 `_shouldIgnore` 调整）。

## License

MIT
