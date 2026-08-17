---
title: 架构说明：钉钉 ↔ DSH 桥接器
description: 桥接器两端协议（钉钉 Stream 回调 + DSH HTTP RPC / 事件流）、消息流转、会话映射与会话管理控制台设计。
tags: [architecture, protocol, dingtalk, dsh]
date: 2026-08-17
status: stable
---
# dsh-dingtalk-bridge 架构说明

钉钉 ↔ DeepSeek Harness (DSH) 双向通信桥接器：让你可以在钉钉里直接和 DSH 中的
Agent（例如当前正在运行的会话）对话。

## 为什么需要这个桥接器

DSH 本身是一个本地运行的 Harness（Web UI 在 `http://127.0.0.1:3080`），它提供浏览器
用的 `/api` 通道。没有对外暴露 IM 接入。本桥接器充当「钉钉 ↔ DSH」之间的翻译层：

```
┌──────────┐   Stream WebSocket    ┌──────────────────┐   HTTP POST /api/session.*   ┌──────────────┐
│  钉钉客户端  │ ───────────────────► │  dsh-dingtalk-   │ ──────────────────────────► │   DSH Host    │
│ (企业内部App│                       │  bridge (daemon) │                              │  (Agent 会话)  │
│   机器人)   │ ◄─────────────────── │                  │ ◄────────────────────────── │              │
└──────────┘   消息应答 Webhook      └──────────────────┘     WS /api/events.mux       └──────────────┘
```

## 两端协议

### 钉钉侧（Stream 模式）

- 使用官方 SDK `dingtalk-stream`，以 `DWClient` 连接钉钉的 Stream 网关。
- 订阅 `TOPIC_ROBOT = /v1.0/im/bot/messages/get` 接收机器人消息回调。
- 每条消息回调都携带：
  - `conversationId` —— 会话唯一标识（单聊/群聊都适用）
  - `sessionWebhook` —— 该会话专属的回传地址（直接把回复 POST 过去即可，无需 access_token）
  - `msgtype` / `text.content` —— 消息内容
- 回复：`POST sessionWebhook`，body 为 `{ msgtype:'text', text:{ content } }`。

### DSH 侧（浏览器同款线上协议）

复用 `@deepseek-ai/dsh-client-connection` 的线上协议，外部程序与浏览器走同一套通道：

- **上行 unary RPC**：`POST http://<host>:<port>/api/<method>`
  ```json
  { "type": "client-request", "rpcId": "<uuid>", "method": "session.prompt", "payload": { ... } }
  ```
  响应为 ServerResponse 信封，`result.ok` 表示成功。
- **下行事件流**：`WS ws://<host>:<port>/api/events.mux`
  - 只下行；客户端不在该 socket 上发业务数据
  - 每条消息是 ServerRequest 信封，`payload` 为 MuxFrame
  - 关心的帧：`session/subscribed`（订阅基线）、`session/event`（含 `assistant/message`）

使用的关键方法：

| 方法 | 用途 | 关键字段 |
| --- | --- | --- |
| `session.create` | 创建会话 | `sessionId`(可预分配幂等), `cwd`, `agentPreset` |
| `session.prompt` | 发消息给 Agent | `sessionId`, `mode:'queue'`, `content:[{type:'text',text}]` |
| `session.list` | 列出会话 | `running`, `cwd`, `projections.values.title` |
| `session.rename` | 给会话命名 | `sessionId`, `title` |

## 消息流转

### 钉钉 → DSH

1. 钉钉机器人收到消息 → `DingTalkClient` 解析负载 → `Bridge._handleDingMessage`
2. 先识别会话管理指令（`/status` `/list` `/use` `/new`），命中则直接返回不投递给 Agent
3. 普通消息：`_resolveTarget` 解析「当前投递目标」：
   - 有 `activeSessionId`（曾被 `/use`/`/new` 设置）→ 用该会话
   - 无映射 → 创建独立 DSH 会话（上下文隔离），或 `MAPPING_MODE=auto-follow` 时跟随运行中最新会话
4. `session.prompt` 以 `mode:'queue'` 入队文本
5. Agent 处理该消息

### DSH → 钉钉

1. `events.mux` WS 推送 `session/event`（`assistant/message`）
2. `Bridge._handleSessionEvent` 提取 assistant 文本
3. 通过记录在 `replyTargets` 的钉钉 `sessionWebhook` 回发

## 会话映射与会话管理控制台

- `SessionMapper` 维护 `conversationId → { activeSessionId, sessions: {sid: {lastUsedAt}} }`，
  持久化到 `data/session-mapping.json`（重启恢复）。
- `activeSessionId` 是该钉钉会话的「当前投递目标」；`sessions` 记录它用过的所有 DSH
  会话历史——这是 `/use` 切回续聊的基础（DSH 本身持久化对话历史，切回即恢复上下文）。
- 兼容旧格式 `{ dshSessionId, createdAt }`，加载时自动迁移。
- 默认 `perConversation=true`：每个钉钉会话首次消息时自动创建独立 DSH 会话，
  上下文互不干扰；也可用 `/use` 显式切换到任意会话。
- 钉钉内会话管理指令：

| 指令 | 功能 |
| --- | --- |
| `/status` | 查看当前投递目标（会话/项目/标题/状态） |
| `/list [N]` | 列出最近 N 个 DSH 会话（▶=当前目标） |
| `/use <序号\|关键词\|会话ID>` | 切换投递目标（历史保留，切回可续聊） |
| `/new [路径]` | 新建 DSH 会话并设为当前目标（可指定项目路径） |

## 可靠性设计

- **WS 自动重连**：`DSHClient` 维护心跳，断线后按 `reconnectDelayMs` 重连；
  事件流基于 seq 去重，重连后 `session/subscribed` 提供基线。
- **幂等创建**：`session.create` 固定 `sessionId` 重试返回同一会话。
- **回复防抖**：`Bridge` 以事件 seq 去重，避免重复回发。
- **优雅关闭**：SIGINT/SIGTERM 时停止事件流、断开钉钉。

## 目录结构

```
├── src/
│   ├── index.js            # 入口/装配/优雅关闭
│   ├── config.js           # 配置加载（env/.env/config.json + 校验）
│   ├── dsh-client.js       # DSH 外部客户端（RPC + WS 事件流 + 重连）
│   ├── dingtalk-client.js  # 钉钉 Stream 客户端
│   ├── sessions.js         # 会话映射持久化
│   └── bridge.js           # 双向转发核心
├── config/config.example.json
├── docs/DEPLOYMENT.md      # 部署/钉钉开放平台配置指南
└── .env.example
```

## 配置项

全部配置见 `config/config.example.json` 与 `.env.example`。环境变量优先于 JSON。

| 环境变量 | 说明 |
| --- | --- |
| `DSH_BASE_URL` | DSH Web 地址，默认 `http://127.0.0.1:3080` |
| `DINGTALK_APP_KEY` | 钉钉企业内部应用 AppKey |
| `DINGTALK_APP_SECRET` | 钉钉企业内部应用 AppSecret |
| `DINGTALK_ROBOT_CODE` | 机器人编码（通常=AppKey） |
| `MAPPING_PER_CONVERSATION` | 每会话独立 DSH 会话（默认 true） |
| `MAPPING_MODE` | `independent`（默认，每钉钉会话独立）或 `auto-follow`（无映射时跟随运行中最新会话） |
| `MAPPING_AGENT_PRESET` | 新建 DSH 会话用的 agent preset（默认 code） |
| `MAPPING_SESSION_CWD` | 新建 DSH 会话的工作目录 |
