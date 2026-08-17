---
title: 插件生态导览：两类「插件」的区别与开发
description: DSH 语境下两类插件（外部集成 vs Cordis 本体）区别、主动推送机制、目录规划与如何扩展。
tags: [plugins, dsh, ecosystem, guide]
date: 2026-08-17
status: active
---
# 插件生态导览：两类「插件」的区别与开发

> DSH（DeepSeek Harness）语境下有两个完全不同的「插件」概念，初学者极易混淆。
> 本文用一个表讲清全部，并回答「源码在哪」「换机器怎么启动」「能不能都放一个项目」。

---

## 一、两类插件一览

| | **A. 外部集成插件**（本仓库的钉钉桥接器） | **B. DSH 本体插件**（Cordis 插件） |
| --- | --- | --- |
| 是什么 | 独立运行的 Node 进程，通过 DSH 的 `/api` 通道交互 | 注册在 DSH 进程内部的扩展（工具/服务/事件/界面） |
| 代码放哪 | **本仓库** `src/`（有实体文件） | 无实体文件，运行时动态定义；或 DSH 宿主配置目录 |
| 怎么运行 | `npm start`（独立 daemon） | `cordis_define` + `cordis_run` 注入当前 DSH 进程 |
| 生命周期 | 独立于 DSH；**机器关了就停**，需手动/自启拉起 | 跟随 DSH 进程；DSH 重启后动态定义的会丢 |
| 给谁用 | 钉钉用户 ↔ DSH（外部世界进来的入口） | 给 DSH Agent 本身加能力（模型步骤里能调的工具等） |
| 典型例子 | 钉钉收发、会话管理、`/status` `/list` `/use` | web 搜索工具、文件工具、新 Service、主题/UI |
| 依赖什么 | 目标机器上**必须运行着 DSH** | 本身就是 DSH 的一部分 |

**一句话**：
- **A** 是「给 DSH 装一个对外的门」——你要的钉钉、未来飞书/企微/Telegram 都是这类。
- **B** 是「给 DSH 自己加器官」——让它能搜索、能操作文件、能跑命令。

---

## 二、本仓库（A 类）的运行机制与源码

源码就在本仓库，结构：

```
src/
  index.js           入口/装配/优雅关闭
  config.js          配置加载（.env / config.json）
  dingtalk-client.js 钉钉 Stream 客户端（CALLBACK 收消息 + webhook 回发）
  dsh-client.js      DSH 客户端（HTTP RPC + WS 事件流 + 重连）
  bridge.js          双向转发核心 + 会话管理指令（/status /list /use /new）
  sessions.js        会话映射持久化（activeSessionId + 历史，重启恢复）
config/              配置样例
docs/                ARCHITECTURE / DEPLOYMENT / LESSONS / 本文
test/                自动化测试
```

**运行链路**：

```
钉钉 ←Stream WS→ dingtalk-client ←→ bridge ←→ dsh-client ←HTTP/WS→ DSH /api
                                   └─ sessions.js（会话映射落盘）
```

---

## 三、关机 / 换机器怎么启动

### 本机（Mac 关机/重启后）
桥接器是普通进程，**没有配置开机自启**。开机后手动：

```bash
cd /Users/zhengyd/OpenProject/deepseek-harness-plugin
npm start                # 前台
# 或后台：
nohup npm start > /tmp/bridge.log 2>&1 &
```

> 可选：配置 macOS `launchd` 开机自启（见下文「自启配置」）。

### 换到另一台机器
1. 拷贝整个项目（或 `git clone`）。
2. `npm install`（装 `dingtalk-stream`、`ws`）。
3. 复制 `.env.example` 为 `.env`，修改：
   - `DSH_BASE_URL` → **目标机器上 DSH 的地址**
   - 钉钉 `DINGTALK_APP_KEY / APP_SECRET` → **同一套企业应用的凭证**（钉钉消息只发给这套凭证的机器人）
   - `DINGTALK_STREAM_ENABLED=true`
4. `npm start`。

**两个前提**：
- 目标机器上**必须有正在运行的 DSH**（桥接器是客户端，DSH 才是 Agent 本体）。
- 钉钉 Stream 模式**不需要公网域名**，内网/本机即可（企业应用凭证能访问 `api.dingtalk.com` 即可）。

### 自启配置（可选）
用 macOS `launchd` 把 `npm start` 做成开机自启+崩溃重启守护。需要我提供时再说，一两分钟内可配好。

---

## 四、如何开发新插件

### 4.1 想在钉钉里加能力 → 扩展本仓库（A 类，推荐）

新指令几乎是一行路由 + 一个函数，全在 `src/bridge.js`：

```js
// 1) 在 _handleDingMessage 里加路由
if (/^\/(weather|天气)\b/.test(text)) {
  await this._handleWeather(msg, text);
  return;
}

// 2) 实现处理函数
async _handleWeather(msg, text) {
  const city = this._extractText(msg).replace(/^\/(weather|天气)\b/, '').trim();
  // ……调用第三方天气 API……
  await this._replyText(msg, `🌤 ${city} 今天晴，25℃`);
}
```

其他可扩展方向：
- 新消息类型（图片 OCR、文件接收、卡片回复）
- 群聊 @ 策略细化
- **多钉钉应用/多机器人**（多份 DingTalkClient，按 robotCode 路由）
- 转发到其他 IM（飞书/企微 → 同一 Bridge 分发）

全部可以放进**这一个项目**，这是 A 类最大的优点：低耦合、易迭代、有测试。

### 4.2 想给 DSH 本体加能力 → Cordis 插件（B 类）

用 DSH 的 Cordis 机制，在**运行时**定义并注入当前 DSH 进程：

```
cordis_inspect_list   → 发现 Host/Client 能力
cordis_inspect_query  → 查询确切 Service/Event/Tool 签名
cordis_define         → 定义插件（纯 JS，Host/Client）
cordis_run            → 注入运行
```

- 这类插件**代码不落在本仓库**；要么用 `cordis_define` 动态注入（DSH 重启丢失），要么写进 DSH 宿主配置持久。
- **适用场景**：给 Agent 加工具（web 搜索、读文件、跑命令）、注册服务、自定义 UI。
- 本会话里 Cordis 动态插件就是一个活例子（凡是 Tool 卡、运行卡都是这套机制的产物）。

### 4.3 两类各放哪的最短答案

| 想做的事 | 放哪 |
| --- | --- |
| 钉钉里的功能、更多 IM、会话控制 | **本仓库 `src/`** ✅ |
| DSH Agent 的工具/能力/界面 | DSH 的 Cordis 插件（不在本仓库）|

---

## 五、重要机制：DSH「主动」给钉钉发消息？能做到什么程度

很多人的第一反应是「那我没在钉钉里说话，DSH 能不能主动联系我？」——**分开看**：

### 当前（现成代码）
桥接器是**纯响应式**的，只有两个触发入口：

```
① 钉钉消息进来 → DSH 处理 → 回发
② DSH 的 assistant 回复事件 → 回发
```

**没有任何「无条件主动推送」**。DSH/Agent 自己不能主动往钉钉塞消息。

### 想支持主动推送，有三种做法（都可行，复杂度递增）

| 做法 | 说明 | 前提 |
| --- | --- | --- |
| **A. sessionWebhook 复用** | 把钉钉某会话最近一次消息携带的 `sessionWebhook` 缓存下来（`.json`），之后任何触发点（定时器、DSH 事件、其它插件）都可 POST 到它来主动发消息 | 该用户**必须先给机器人发过至少一条消息**（才有 webhook）；webhook 有时效/会话限制 |
| **B. batchSend API** | 用 `access_token` + `robot/oToMessages/batchSend` + 目标用户 `userId` 主动推单聊 | 需要目标用户 userId；应用有对应权限 |
| **C. 群机器人 Webhook** | 若用「自定义群机器人」而非「企业内部应用」机器人，可拿固定 webhook 主动推送到群 | 换机器人形态，与现有 Stream 模式不同 |

### 触发源从哪来
「主动」不等于「自己凭空说话」，需要一个触发源，例如：
- **定时**：`setInterval` / cron（如每天 9 点发日报）
- **DSH 事件**：监听 DSH 事件流里的某种状态变化（如任务完成、会话结束）
- **其它服务**：外部程序调用桥接器暴露的 HTTP 接口来触发推送

> 结论：**DSH 自身不能主动「想到」就发**，但**桥接器完全可以做成「有触发就主动推」**——定时、事件、接口都是可行触发源。这属于 A 类能力的扩展。

---

## 六、目录规划：把未来插件都放这个项目（推荐结构）

你想「以后的 DSH 插件都放当前项目」——完全可行，用清晰目录分层即可：

```
deepseek-harness-plugin/            ← 你的「DSH 插件集合 + 脚手架」
├── src/                            ① 独立进程类插件（如钉钉桥接器）
│   ├── index.js                    入口
│   ├── bridge.js                   双向转发（钉钉消息 ↔ DSH）
│   ├── dingtalk-client.js          钉钉 Stream 客户端
│   ├── dsh-client.js               DSH 客户端
│   └── sessions.js                 会话映射
├── plugins/                        ★ ② DSH 宿主插件（每个插件一个子目录）
│   └── minimax-search/
│       └── minimax-search.mjs      例：MiniMax 网页搜索 provider
├── scripts/
│   └── install-plugins.mjs         ★ 脚手架：同步 plugins/ → DSH 宿主
├── config/                         配置模板
├── docs/                           文档（带 frontmatter）
├── test/
└── package.json
```

设计原则：
1. **两类插件分开放**：`src/` 放独立进程类（钉钉桥接器）；`plugins/` 放 DSH 宿主插件（每个子目录=一个插件）。
2. **仓库是唯一真相源**：宿主插件的源码只存在于 `plugins/`；通过脚手架脚本安装到 DSH 宿主。
3. **安装脚手架**：`npm run install:plugins` 把 `plugins/*/` 同步到 `~/.dsh/profiles/<profile>/plugins/`（可 `DSH_PROFILE=tui` 指定 profile）。改完宿主插件 → 重跑脚本 → HMR/重启 DSH 生效。
4. **共享基建**：独立进程类插件都用 Bridge 提供的 `_replyText` / `dsh` / `dingtalk`，不重复造。
5. **可测试**：每个插件带自己的测试 + 文档。

### 为什么不用 `src/plugins/`
早期方案把宿主插件放 `src/plugins/`（随 bridge 进程跑），但 DSH 宿主插件是**注入 DSH 进程**的，不能靠桥接进程加载。所以单独 `plugins/` 目录 + 同步脚本，语义更清晰（宿主插件 vs 进程插件）。

### 放不进这个项目的
- **给 DSH Agent 本体加工具的 Cordis 插件**（web 搜索、文件操作等）——它们不在独立进程里跑，而是注入 DSH 进程，需走 Cordis 机制，无法让它们在「这个桥接进程」里以同样方式跑。
- 但它们**可以被桥接器间接使用**：钉钉 `→` DSH（Agent 带工具）`→` 回发。也就是说，**你在钉钉里提问，DSH 用它的 Cordis 工具（含 Web 搜索）处理，再把结果回发钉钉**——这正好绕过了「桥接器自己没有搜索工具」的限制，只是要先把 DSH 侧的搜索修好/配好。

---

## 七、常见疑问

### Q1：web 搜索失败是这一类吗？
是 **B 类（DSH 本体工具）**，失败原因通常是 DSH 环境的搜索 API key 失效/未配置，与本仓库无关。要修得走 Cordis 机制（或查 DSH 的搜索配置）。

### Q2：桥接器和 DSH 是「谁依赖谁」？
桥接器**依赖 DSH**：没有正在运行的 DSH，钉钉消息进来也没 Agent 可对话。反过来 DSH 不依赖桥接器。

### Q3：打包给其他人用，需要把 DSH 一起打包吗？
如果对方没有自己的 DSH，需要；桥接器单独无法提供对话。如果对方已有 DSH（内网部署的 Harness），只需给桥接器 + 同一套钉钉凭证。

### Q4：动态 Cordis 插件重启会丢，怎么持久？
把插件代码写进 DSH 的宿主合成（host composition / agent preset）即可随 DSH 持久加载——这是 `editing-cordis-compositions` 的范畴，另见 DSH 自带技能文档。

---

## 八、下一步建议

| 目标 | 动作 |
| --- | --- |
| 快速给钉钉加指令/能力 | 在本仓库 `src/bridge.js` 加路由 + 函数（我可代写） |
| 修 DSH 本体 web 搜索 | 走 Cordis 动态插件或排查 DSH 搜索 key |
| 桥接器开机自启 | 我帮你配 launchd |
| 二手机器部署 | 按本文第三节步骤，我可在你机器上实操 |
