---
title: 部署指南：钉钉 ↔ DSH 桥接器
description: 从零创建钉钉企业内部应用、配置机器人、安装与启动桥接器、支持指令与常见问题。
tags: [deployment, dingtalk, setup, guide]
date: 2026-08-17
status: stable
---
# 部署指南：钉钉 ↔ DSH 桥接器

本指南覆盖从零开始：**创建钉钉企业内部应用 → 配置机器人 → 启动桥接器** 的全过程。

---

## 一、准备工作

| 依赖 | 版本要求 | 说明 |
| --- | --- | --- |
| Node.js | ≥ 22 | 本机实测 v24 |
| DSH Web | 运行中 | 默认 `http://127.0.0.1:3080`（`dsh web`） |
| 钉钉开放平台账号 | 管理员权限 | open.dingtalk.com |
| 公网 | **不需要** | Stream 模式主动连钉钉网关，无需公网域名/固定 IP |

---

## 二、创建钉钉企业内部应用

### 1. 进入开放平台
打开 [open.dingtalk.com](https://open.dingtalk.com/) → 登录管理员账号 → **开发者后台**。

### 2. 创建应用
- 「应用开发」→「企业内部应用」→「创建应用」
- 填写应用名称（如 `DSH助手`）、Logo、描述
- 确定后进入「凭证与基础信息」，记录：
  - **AppKey**
  - **AppSecret**

### 3. 创建机器人
- 左侧「消息推送」→「机器人」→「创建机器人」
- 选择消息接收模式：**Stream 模式**
  （这是关键：Stream 模式由我们的程序主动连钉钉网关，不需要公网回调 URL）
- 设置机器人名称、头像
- 机器人能力可只勾选「接收消息」

> ⚠️ 不同页面的按钮文案可能有差异，但核心是：**选 Stream 模式 / Webhook 模式** 时务必选
> Stream。若你的页面只有「HTTP 回调」模式，则需要公网域名，此时参考文末「附录 B」。

### 4. 记录机器人编码
机器人创建后会有一个机器人编码（RobotCode）。企业内部应用场景下 RobotCode 通常与
AppKey 相同；若页面明确展示独立 RobotCode，以页面为准填入 `DINGTALK_ROBOT_CODE`。

### 5. 权限与范围
- 在「权限管理」中按需添加机器人发送消息相关权限（Stream 模式 + sessionWebhook 回复
  通常已够用）
- 「版本管理与发布」→ 发布应用版本，并在「可用范围」中选择可使用该机器人的成员/部门

---

## 三、安装与配置桥接器

### 1. 安装依赖

```bash
cd deepseek-harness-plugin
npm install
```

### 2. 填写配置

复制模板：

```bash
cp .env.example .env
```

编辑 `.env`，填入上一步获取的凭证：

```bash
DSH_BASE_URL=http://127.0.0.1:3080
DINGTALK_APP_KEY=xxxxxxxx  # AppKey
DINGTALK_APP_SECRET=xxxxxxxx  # AppSecret
DINGTALK_ROBOT_CODE=xxxxxxxx  # RobotCode（通常=AppKey）
```

### 3. 校验配置

```bash
npm run check:config
# 输出 "✅ 配置完整，可以直接启动" 即通过
```

---

## 四、启动桥接器

```bash
npm start
```

正常启动日志类似：

```
[timestamp dsh] WS connect ws://127.0.0.1:3080/api/events.mux
[timestamp dsh] WS open
[timestamp dingtalk] Stream connected
[timestamp bridge] bridge started
```

### 后台运行（生产）

```bash
# 使用 nohup
nohup npm start >> bridge.log 2>&1 &

# 或 pm2（推荐）
npm i -g pm2
pm2 start src/index.js --name dsh-dingtalk-bridge
pm2 save && pm2 startup
```

---

## 五、安装宿主插件（可选：网页搜索）

桥接器之外，仓库还兼作 **DSH 插件集合**。可选安装 MiniMax 网页搜索（让 `web_search` 工具可用）：

```bash
npm run install:plugins     # 同步 plugins/ → ~/.dsh/profiles/web/plugins/
```

并按 [docs/MINIMAX-SEARCH.md](MINIMAX-SEARCH.md) 配置宿主 patch 与 `~/.dsh/.env` 的 `MINIMAX_API_KEY`。

---

## 六、在钉钉里使用

1. 在钉钉里搜索你的机器人（或把它拉进群聊）。
2. 单聊：直接发消息即可对话。
3. 群聊：**@机器人** 后发送消息。

### 支持指令

| 指令 | 说明 |
| --- | --- |
| `/new` | 为当前钉钉会话开启全新 DSH 会话（清空上下文） |
| `/help` | 显示帮助 |

---

## 七、常见问题

### Q1: 启动时报「配置缺失」
按上面步骤填好 `.env`，运行 `npm run check:config`。

### Q2: 钉钉里发消息没反应
- 确认桥接器日志出现 `Stream connected`（钉钉侧）与 `WS open`（DSH 侧）。
- 确认机器人在钉钉里的「可用范围」包含了你的账号。
- 群聊需 @ 机器人。

### Q3: 机器人回复了但内容空白/被截断
DSH 的 assistant 消息可能包含多个文本块，桥接器会拼接。若来源是超长代码块，
钉钉对单条消息有长度限制（约 2 万字符），可考虑在 `bridge.replyPrefix` 提示或后续加分片。

### Q4: 想让多个钉钉群各保持独立上下文
默认 `MAPPING_PER_CONVERSATION=true` 就是每个钉钉会话独立 DSH 会话。

### Q5: 想让所有人共享同一个 DSH 会话
设 `MAPPING_PER_CONVERSATION=false`，并可选填 `MAPPING_FIXED_SESSION_ID`。

---

## 附录 A：Stream 模式原理简述

钉钉 Stream 模式是钉钉官方为无公网服务端场景提供的机制：

1. 应用服务器（我们的桥接器）主动向钉钉开放平台发起**长连接（WebSocket）**。
2. 钉钉把机器人收到的消息通过该长连接推给应用。
3. SDK（`dingtalk-stream`）内部处理连接、注册、心跳与自动重连。

因此**不需要公网 IP / 域名 / 反向代理**，本地开发机上即可完整运行。

> ⚠️ **SDK 版本要求 ≥ 2.1.5**
> `dingtalk-stream@2.1.0` 曾把 gateway 连接地址硬编码为预发布域名
> `pre-api.dingtalk.com`（部分网络不可达），会导致 `connect()` 挂起/超时、
> 日志只出现 `Stream connect error: connect ETIMEDOUT`。
> `2.1.5` 起已改用正式域名 `api.dingtalk.com`。本项目已锁定 `^2.1.5`，
> 如自行升级请勿回退到 2.1.0～2.1.2。

---

## 附录 B：如果你必须使用 HTTP 回调模式

若受组织策略限制只能使用 HTTP 回调：

1. 需要一个公网 HTTPS 地址（可用内网穿透如 ngrok / frp / cloudflared）。
2. 在钉钉应用「消息推送」→ 机器人 → 选择「HTTP 回调」→ 填入你的回调 URL
   （如 `https://xxxx.ngrok.app/webhook`）。
3. 桥接器未来版本可扩展一个 HTTP 服务接受回调；当前版本专注于 Stream 模式。

---

## 附录 C：安全性提醒

- `.env` 含 AppSecret，勿提交到 Git（已加入 `.gitignore`）。
- DSH `/api` 目前是回环信任模型：桥接器部署在本机或局域网，不要暴露到公网。
- 群聊机器人默认只在被 @ 时响应，可在 `src/bridge.js` 的 `_shouldIgnore` 调整策略。
