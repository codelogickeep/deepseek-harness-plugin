---
title: flash-worker — 「pro 指挥、flash 执行」多 Agent 开发协同
description: 一个 DSH agent preset，给主 agent（pro）新增 flash_agent 工具，把具体编码任务委派给 flash 模型子 agent 执行，形成 orchestrator-worker 两级协同；以模板 + 脚手架方式分发。
tags: [preset, multi-agent, flash, orchestrator, scaffold]
---

# flash-worker：pro 指挥、flash 执行

## 是什么

一个 DSH **agent preset**，基于标准 `code`（PTC 模式）加一行工具：

- 主 agent 保持 **pro 模型**（负责规划、拆任务、决策、review、汇总）；
- 新增 `flash_agent` 工具：主 agent 把**具体编码/执行任务**委派给它；
- `flash_agent` 用 **flash 模型**的独立子 agent 执行，返回结果给主 agent；
- 子 agent **保留全部工具集**（bash/edit/write/read/glob/grep 等），与主 agent 同权执行。

本质是 **orchestrator-worker（编排者-执行者）** 模式：pro 想清楚「做什么」，flash 动手「做」。

## 原理

DSH 的 subagent seam 原生支持 per-agent 模型指定。`@deepseek-ai/dsh-tool-subagent`
的 config 接受 `agentOptions: { provider, model }`，在执行委派时注入子 agent 的
LLM 路由。preset 里新增的工具行：

```yaml
- id: tool-subagent-flash
  name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: spawn            # subagent 执行后端（spawn 进程）
    toolName: flash_agent      # 暴露给主 agent 的工具名
    backgroundMode: continuable # 支持 send_message 持续指挥
    agentOptions:
      provider: <flash-provider>  # 子 agent 的 LLM provider 路由
      model: <flash-model>        # 子 agent 的 LLM model id
```

- `provider: spawn` 是 subagent 的**执行后端**（在哪跑），不是模型；
- `agentOptions.provider/model` 才是子 agent 的**模型路由**（用哪个 LLM）；
- `backgroundMode: continuable` 让主 agent 可用 `send_message` 给同一个 flash
  子 agent 追加指令，实现多轮指挥。

## 安装

```bash
# 方式 A：独立安装（只装 preset）
npm run install:flash-worker -- --provider <flash-provider> --model <flash-model>

# 方式 B：一键安装（宿主插件 + preset + 切默认）
npm run setup -- --provider <flash-provider> --model <flash-model> --set-default
```

provider/model 来源优先级：`--provider/--model` 参数 →
`FLASH_PROVIDER`/`FLASH_MODEL` 环境变量 → 交互式询问。

查看当前安装（只读，不重装）：

```bash
npm run install:flash-worker -- --show
```

打印已安装的 provider/model、文件路径与默认 preset 是否指向本 preset。

安装动作：
1. 渲染 `presets/flash-worker/agent.cordis.yml.tpl`（注入 provider/model）；
2. 幂等安装到 `~/.dsh/.agent-presets/flash-worker/`；
3. 检查 `settings.yaml` 中是否已出现该 provider（未出现则提示先配模型）；
4. `--set-default` 时把 `agent-presets.default` 切到 `flash-worker`。

DSH 的 preset 发现**不做缓存**，安装后运行时立即可见；切换默认后新建会话即生效
（若未生效，重启 DSH）。

## 前置条件

1. **flash 模型已在 DSH 注册**：`agentOptions.provider` 必须是宿主 llm 服务里
   已注册的 provider 路由（如 `deepseek-official`），model 是该路由下的模型 id。
   preset 不能自带模型 provider——模型路由是宿主平面能力。
2. **Node >= 22**（脚手架用顶层 await 与 `replaceAll`）。

例如在 `settings.yaml` 里配置一个本地 flash gateway：

```yaml
llm-deepseek:
  baseURL: http://<你的 gateway>/v1
  models:
    - id: deepseek-v4-flash
      name: deepseek-v4-flash
      contextWindow: 256000
      maxTokens: 64000
```

然后 `--provider deepseek-official --model deepseek-v4-flash`。

## 使用

切到 `flash-worker` preset 后，新会话里主 agent 的工具列表多一个 `flash_agent`：

- 主 agent 收到编码任务时，把「读代码、写补丁、跑测试」等具体动作打包成一个
  自包含 prompt，调用 `flash_agent` 委派；
- flash 子 agent 用自己的上下文执行并返回结果；
- 主 agent 检查结果、决定下一步（继续委派 / 自己修 / 收尾）。

多轮指挥：`flash_agent` 返回 durable subagent id，主 agent 可用 `send_message`
继续给同一个 flash 子 agent 追加指令（continuable 模式）。

## 发布机制

- **模板 + 脚手架参数化**：仓库只放带 `{{FLASH_PROVIDER}}`/`{{FLASH_MODEL}}`
  占位符的模板，安装时注入用户自己的模型，避免把个人模型 id 写死进开源仓库。
- **纯文件分发**：preset 就是目录 + `agent.cordis.yml` + `preset.yml`，无 npm
  包格式；复制到用户 preset 根目录即被发现。
- **包名从宿主解析**：preset 里的 `@deepseek-ai/dsh-*` 行由 DSH 宿主 node_modules
  解析，preset 自身不携带依赖，天然轻量可移植。

## 目录归属

按仓库「目录规矩」：

| 类别 | 位置 | 部署 |
| --- | --- | --- |
| Agent preset | `presets/flash-worker/` | `npm run install:flash-worker` / `npm run setup` |
| DSH 宿主插件 | `plugins/<name>/` | `npm run install:plugins` |
| 独立进程插件 | `src/` | launchd / npm start |
