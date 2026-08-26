---
title: DSH 分享会 · PPT 讲稿版
description: 正式分享用的 PPT 思路讲稿——按页组织、正常行文，无时间标注、无附录。
tags: [dsh, sharing, ppt, talk]
date: 2026-08-26
status: active
---

# DSH 分享会 · 讲稿

> 主题：**从"我用 dsh 搭了一整套插件"到"dsh 凭什么值得你来试"**
> 每页一个大主题，正常行文（可直接照着讲）。内容基于《DSH-SHARING-OUTLINE》最终版。

---

## 第一页 · 封面

**DSH —— 一切皆插件，两周从用户变成开发者**

今天分享 DeepSeek Harness（DSH），一个 8 月 13 号刚开源的 Agent 框架。我花了两周，从"用它的用户"变成了"给它写插件的人"——期间还把它搞崩过三次。今天讲清楚它是什么、值不值得你也来试。

---

## 第二页 · 为什么是 dsh

AI 模型在"思考"上已经很强，但"让它在真实环境里干活"——读写文件、调 API、走审批、留审计——是另一层工程。dsh 解决的就是这一层：**模型负责思考，Harness 负责让它真正干成事**。一句话概括：**Agent = 模型 + Harness**。

---

## 第三页 · 万物皆插件（核心认知）

dsh 的核心哲学是 **Everything is a Plugin**：模型、工具、会话、沙箱、存储、调度、UI……**全都是插件**，而且**没有特权内核**——你写的插件和官方内置插件权限一模一样。它基于 Cordis，注册即 `ctx.effect()`，卸载自动逆回。

运行中的 dsh 是一棵插件树，由"空条目列表"叠出来的：

```
空条目列表
  └─ dsh-base 组合包        ← 模型/工具/会话/沙箱/审批/设置/凭据
       └─ dsh-web-app 组合包  ← 浏览器应用
            └─ 用户 cordis.patch.yml   ← 你的插件在这里插入
```

"一切皆插件"不是口号，是架构：装什么、叠哪层，全在配置文件里；你写的插件和官方内置的一样，没有隐藏内核。官方没做的能力，你自己能补。

---

## 第四页 · 本机实例：一叠真实的配置文件

这套叠层在我机器上是真实存在的，就在 `~/.dsh/profiles/web/`：

```
~/.dsh/profiles/web/
├── cordis.yml          # profile 根 = []（空，树全靠 patch 叠出）
├── cordis.patch.yml    # ⭐ 我们的 5 条插件引用
├── package.json        # profile = dsh-base + dsh-web-app 两个 bundle
├── node_modules/       # ui-enhance（file: 软链源码）+ playwright-core
└── plugins/            # browser-reader / cron-scheduler / minimax-search
```

`cordis.yml` 是空的，`cordis.patch.yml` 装满插件。所有东西都在配置文件里声明——**没有魔法**。而 `package.json` 里的 `bundles` 就是 dsh 自带的"出厂插件层"：`dsh-base`（核心基座，所有 profile 的第一层）、`dsh-web-app`（浏览器表面）、`dsh-headless`（一次性任务运行器）。

---

## 第五页 · 一个插件长什么样

在 dsh 里，"加一个 AI 能调用的能力"的全部成本，就是一根插件行 + 一个注册函数：

```yaml
# cordis.patch.yml —— 插一条插件行
- insert:
    - id: my-tool
      name: ./plugins/my-tool/my-tool.mjs
```

```js
// my-tool.mjs —— 注册一个工具
export const inject = ['tools']
export function apply(ctx) {
  ctx.tools.register({
    name: 'read_doc', description: '读文档',
    parameters: { path: { type: 'string', required: true } },
    async execute(args) { return readFile(args.path) },
  })
}
```

模型、搜索、定时、UI 的插件都长这样，只是挂载点不同。这就是"万物皆插件"最直接的实证。

---

## 第六页 · 一次对话背后的时序

用户说一句话，底层是这样一条链路：

```
用户输入 ──► turn/start
  claim 输入 ──► 组装提示词+工具schema
  ──► agent/request ──► llm/stream     ← 调模型，流式输出
  ──► 模型要调工具 ──► tool/call ──► pre-execute ──► execute ──► tool/result
  ──► step/end（还欠工作 → 再起一个 step）
  ──► turn/end（不欠了）──► 回复你
```

这一页藏着两个理解后面所有内容的关键设计：

一是**会话日志 = 事件溯源**。每一步都写进 append-only 的会话日志，"模型可见即已记录"是运行时不变量——所以一切可审计、可回放、可分叉。

二是**工具要过一套流水线**。`tools/pre-execute`、`ToolGuard`、`tools/post-execute` 是三个内置的拦截点——审批、守卫、结果裁剪全挂在这里，不用改循环本身。

---

## 第七页 · 定位：dsh 站在哪个位置

市面上的 Agent 很多，dsh 站在一个很少有人占过的位置：

- **比 openclaw 这类"个人助理"更轻**——它不带一堆聊天渠道和预设业务，是内核加配置树，你要什么叠什么；
- **比 LangGraph/ADK 这类"纯 SDK"更完整**——agent 循环、会话、沙箱、审批、UI、/api 全内置，不用从零焊；
- **比 Claude Code / Codex 这类"闭源成品"更开放**——全开源、可自托管、模型自由，对外用通用 /api 协议，不被锁在自家生态；
- 而这一切能成立，靠的是**插件一等公民**——定制场景既不难、又不受限。

一句话：**dsh 比 openclaw 轻，比 SDK 完整，比闭源成品开放；轻到改得动，完整到不用搭，开放到不自锁。** 市面上要么是"能用的成品但改不动"，要么是"随便改但全要自己搭"，dsh 罕见地站在中间。

---

## 第八页 · 我用 dsh 做了什么

两周时间，从这个插件机制上长出了一整套工具箱：

- **钉钉桥接器**：在钉钉里直接和 Agent 对话，定时提醒主动推送；
- **browser-reader**：真浏览器阅读（web_read 系列），确定性读 JS 渲染页面；
- **minimax-search**：把 MiniMax 注册为 web 搜索，`web_search` 直接可用；
- **cron-scheduler**：标准 5 字段 cron 定时，跨重启防重复；
- **ui-enhance**：增强 UI——实时文件树（git 状态）、会话状态面板、打开 IDE；
- **flash-worker**：pro 指挥、flash 执行的 preset。

整个仓库 69 次提交、225 个文件、+16438 行、100 个测试用例、3000+ 行文档。这些不是 PPT 上的设想，是真实跑通的：钉钉能聊、浏览器能读、定时能跑、UI 能看。

---

## 第九页 · 亮点：右侧实时文件树

官方没有的，插件补上。ui-enhance 做了一个类 codex 的右侧文件树：

- 递归目录 + **git 状态徽标（M/A/D/U）**；
- 可拖拽调宽、双击文件在 IDE 打开、路径一键复制；
- **fs.watch + SSE 实时刷新**：改文件或提交，徽标即时更新，不用刷新页面。

做它的原则是"**只做增量，不覆盖官方渲染器**"——这是 client bundle 插件很重要的一条纪律。实时性靠的是 fs.watch + SSE 事件驱动，不是轮询。

---

## 第十页 · 三个真实事故：我把 dsh 搞崩了

接下来是三个真实事故，每一个都让 `dsh web` 直接启动崩溃。但先说结论：**这不是 dsh 的 bug，是它的设计哲学——fail-loud，启动时响亮失败**。官方认为：一个工具插件挂了若静默继续，Agent 会以残缺能力跑出诡异错误；不如启动时把原始堆栈甩你脸上，修完重启。所以"插件把启动搞崩"是特性，不是缺陷。

三个事故分别是：inject 门禁（访问服务没声明）、SessionEvent 白名单（往会话日志写自定义事件）、工具 schema（两套语法混用）。

---

## 第十一页 · 事故 1 & 2 的代码教训

事故 1（inject 门禁）：库一旦在 `apply` 里访问 `ctx.webServer` 却没在 `inject` 声明，boot 直接崩——这是运行时校验，`--dump-config` 和普通 stub 自检都拦不住：

```ts
// ❌ boot 直接崩
export function apply(ctx) { ctx.webServer.register(...) }
// ✅ 必须声明
export const inject = ['webServer']
```

事故 2（SessionEvent 白名单）更隐蔽：DSH 会话日志是事件溯源，往日志写自定义类型（如 `cron/dispatch`）会让整段历史无法加载。审计应该走 logger，绝不进日志：

```text
// ❌ 往会话日志写自定义事件
agent.session.append('cron/dispatch', ...)
// 一个自定义事件类型 = 一段永久不可读的历史
// ✅ 审计走 logger，不进日志
```

---

## 第十二页 · 踩坑 → 5 条铁律 + 三道防线

踩过的坑沉淀成 5 条铁律：

1. **绝不向 session 日志写自定义事件**——审计走 logger；
2. **凡访问 `ctx.<服务>` 必须写进 `inject`**——否则 boot 即崩；
3. **状态持久化落在沙箱可写根内**——`workspace-write` 只放行工作区 + /tmp，写到 ~/.dsh 会被拒；
4. **写入错误不要静默吞**——`FS_SANDBOX_DENIED` 是设计问题不是 IO 抖动；
5. **schema 纪律**——`output.schema` 用对象级 required。

既然常规校验救不了你，我们把"崩溃越早越好"做成了三道防线（全在脚手架里）：
- **① 加载期自检** `check-plugin.mjs`：用 Proxy 模拟真实注入门禁，装进 profile 前先崩给自己看；
- **② 安装门禁** `install-plugins.mjs`：插件自检失败则跳过不装；
- **③ 升级契约检查** `check-dsh-compat.mjs`：升级 dsh 后查 wire 契约漂移（silent 丢弃问题）。

---

## 第十三页 · 多 Agent 协同 + 可移植性

两件事让这套东西真正好用。

一是把 dsh 用成"**两级开发团队**"：主 agent（pro）负责规划、拆任务、review，flash 子 agent 通过 `flash_agent` 工具接管具体编码——pro 想清楚"做什么"，flash 动手"做"。这是 subagent seam 的 per-agent 模型指定，我们做成了可一键安装的 `flash-worker` preset。

需要说清楚的是：**"多 agent 配不同模型"不是 dsh 独有**。Claude Code 可以在 haiku/sonnet/opus 三档里给子 agent 配模型，Codex 可以在 gpt-5.4 系列里配；openclaw 也能配、而且是跨厂商任意模型（它是开源多模型网关）。所以这一项上，真正被拦在"自家模型档位"里的是 Claude Code / Codex 这类闭源成品；**dsh 作为开源 harness，是"能做到多模型"的之一，额外还支持把 Codex、Claude Code 本身拉进来当子 agent**。一句话：跨厂商多模型是"开源 harness 的共性"，dsh 在这项上不输、也谈不上独有。

二是可移植性：DSH 插件有个隐藏痛点——装进 profile 后要用**手工编辑 `cordis.patch.yml`** 才能引用，这直接杀死推广。我们的脚手架 `npm run install:plugins` 把"构建 + 自检 + 装进 profile + 自动补 patch 引用"全包了，新电脑 clone 下来一条命令装齐。

---

## 第十四页 · 企业场景：ERP 三层权限如何落地

举个例子：用户想看销售数据，但 ERP 有三层权限——L1 功能权限（能不能用"查销售"）、L2 数据行权限（只能看 A 部门）、L3 字段权限（看得到数量、看不到金额/成本）。

DSH 的落法不是写一个大 if，而是把三层分别放在工具流水线的三个环节上：

- **L1 功能权限** → 作用域/`restrict`：无权用户的会话里，工具**根本不出现在模型 schema 里**——模型不知道存在，谈不上绕过；
- **L2 数据行权限** → 工具内部注入 + `ToolGuard` 单调守卫：部门从用户身份取、硬编码进 SQL，模型传不了；守卫只能缩权，后面不能反悔；
- **L3 字段权限** → `tools/post-execute` 出口裁剪：**替换 value** 删掉金额/成本字段——审计和回放里也没有。

三层权限从"散落在业务代码里的 if"变成了"工具流水线上的几个环节"，模型全程被管道包住，每一环都绕不过，而且全程自动进事件溯源日志——审计是现成的。

---

## 第十五页 · 企业场景：多领域 Agent 服务化

如果想给多个业务领域（库存、销售、财务）各做一个 Agent、又要统一对外，dsh 的正解是：**一个 host + 多个 agent preset**，而不是"一领域一个 profile"。

preset 就是"这个会话挂哪些工具的装配单"（`preset.yml` + `agent.cordis.yml`，工具行在 `isolate realm` 里，per-session 私有）。一个 web profile 自带 `/api`，外部系统这样调用：

```text
POST /api/session.create  { preset: 'erp-sales', ... }   ← 建"销售领域 Agent"
POST /api/session.prompt  { sessionId, content: '查本月销售' } ← 只有销售工具集可见
```

像一个服务中心：每个领域一扇门，但门都开在同一栋楼里。和三层权限闭环：**preset 管"领域"，L1 restrict 管"人"，L2/L3 管"数据"**。

---

## 第十六页 · 收尾

最后总结三点。

第一是**定位**：dsh 比 openclaw 轻、比 SDK 完整、比闭源成品开放——它站在"轻到改得动、完整到不用搭、开放到不自锁"的位置上，而这全靠插件一等公民。

第二是**早期红利**：dsh 是 8 月 13 号才开源的，现在沉淀的插件和踩坑方法论都是稀缺资产，入场越早越有先发优势。

第三是**方法论可迁移**：自检防线、绝不写自定义事件、事件溯源审计——这些经验不绑定 dsh，换到任何 Agent 框架都通用。

**工具会迭代，方法论是长期资产。** 谢谢大家。

---

## 封底 · 谢谢 / Q&A

仓库：`github.com/codelogickeep/deepseek-harness-plugin`（MIT）｜ 6 类能力均真实跑通
