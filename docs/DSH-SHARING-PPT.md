---
title: DSH 分享会 · PPT 讲稿版
description: 正式分享用的 PPT 思路讲稿——每页一个主题、无时间标注、无附录，基于 DSH-SHARING-OUTLINE 提炼。
tags: [dsh, sharing, ppt, talk]
date: 2026-08-26
status: active
---

# DSH 分享会 · PPT 讲稿

> 主题：**从"我用 dsh 搭了一整套插件"到"dsh 凭什么值得你来试"**
> 一页一个主题，可直接照着做 PPT。每页含：页面大标题 + 屏幕要点（放 PPT 上）+ 口播（给讲者）。
> 素材基于《DSH-SHARING-OUTLINE》最终版；无时间标注、无附录。

---

## PPT 1 · 封面

**大标题**：DSH —— 一切皆插件，两周从用户变成开发者

**副标题**：我把 DeepSeek 刚开源的 Agent 框架，变成了一整套属于自己的工具箱

**口播**
大家好。今天分享 DeepSeek Harness（DSH）——一个 8 月 13 号刚开源的 Agent 框架。我花了两周，从"用它的用户"变成了"给它写插件的人"。过程中还把它搞崩过三次。今天我会讲清楚它是什么、值不值得你也来试。

---

## PPT 2 · 为什么是 dsh

**大标题**：先把一个事实摆上台面

**屏幕要点**
- AI 写代码很快，但"AI 怎么理解你的环境、调你的系统"才是瓶颈
- dsh 解决的就是这个：模型负责思考，**Harness 负责让它真正干成事**
- 一句话：**Agent = 模型 + Harness**

**口播**
现在 AI 模型很强，但"让它在真实环境里干活"——读写文件、调 API、走审批、留审计——这是另一层工程。dsh 就是这一层：模型是灵魂，Harness 让它在现实里持续工作。

---

## PPT 3 · 万物皆插件（核心认知）

**大标题**：Everything is a Plugin

**屏幕要点**
- 模型 / 工具 / 会话 / 沙箱 / 存储 / 调度 / UI……**全是插件**
- **没有特权内核**：你写的插件和官方内置插件权限一模一样
- 基于 Cordis：注册即 `ctx.effect()`，卸载自动逆回

```text
空条目列表
  └─ dsh-base 组合包        ← 模型/工具/会话/沙箱/审批/设置/凭据
       └─ dsh-web-app 组合包  ← 浏览器应用
            └─ 用户 cordis.patch.yml   ← 你的插件在这里插入
```

**口播**
"一切皆插件"不是口号，是架构。装什么样、叠什么层，全在配置文件里。你写的插件和官方内置的，权限一样——没有黑盒内核。这也意味着：官方没做的能力，你自己能补。

---

## PPT 4 · 本机实例：一叠真实的配置文件

**大标题**：在我机器上，它就是这些文件

**屏幕要点**
```
~/.dsh/profiles/web/
├── cordis.yml          # profile 根 = []（空，树全靠 patch 叠出）
├── cordis.patch.yml    # ⭐ 我们的 5 条插件引用
├── package.json        # profile = dsh-base + dsh-web-app 两个 bundle
├── node_modules/       # ui-enhance（file: 软链源码）+ playwright-core
└── plugins/            # browser-reader / cron-scheduler / minimax-search
```

**口播**
这是刚才那张叠层图在磁盘上的真实样子：`cordis.yml` 空着，`patch.yml` 装满插件。所有东西都在配置文件里声明——**没有魔法**。

---

## PPT 5 · 一个插件长什么样

**大标题**：加一个"AI 能力"的全部成本

**屏幕要点**
```yaml
# cordis.patch.yml —— 插一条插件行
- insert:
    - id: my-tool
      name: ./plugins/my-tool/my-tool.mjs
```
```js
export const inject = ['tools']
export function apply(ctx) {
  ctx.tools.register({
    name: 'read_doc', description: '读文档',
    parameters: { path: { type: 'string', required: true } },
    async execute(args) { return readFile(args.path) },
  })
}
```

**口播**
"添加一个 AI 能调用的能力"就这么点成本。模型、搜索、定时、UI 都长这样——只是挂载点不同。

---

## PPT 6 · 一次对话背后的时序

**大标题**：用户一句话，底层发生什么

**屏幕要点**
```text
用户输入 ──► turn/start
  claim 输入 ──► 组装提示词+工具schema
  ──► agent/request ──► llm/stream     ← 调模型，流式输出
  ──► 模型要调工具 ──► tool/call ──► pre-execute ──► execute ──► tool/result
  ──► step/end（还欠工作 → 再起一个 step）
  ──► turn/end（不欠了）──► 回复你
```

**两个关键设计**：会话日志 = 事件溯源（模型可见即已记录）；工具流水线 = 策略介入点（审批/守卫/裁剪都挂在这里）

**口播**
这一页是理解后面所有内容的钥匙：一次对话是一个"轮次"，每步都写进 append-only 的会话日志（所以可审计、可回放）；工具调用要过一套流水线——审批、守卫、结果裁剪全挂在这。

---

## PPT 7 · 定位：dsh 站在哪个位置（重点页）

**大标题**：市面上的 Agent，dsh 站在一个很少有人占过的位置

**屏幕要点**
| 对比方向 | dsh |
| --- | --- |
| vs **openclaw**（个人助理） | **更轻**：内核+配置树，不带一堆渠道/业务 |
| vs **LangGraph/ADK**（纯 SDK） | **更完整**：loop/沙箱/审批/UI//api 全内置 |
| vs **Claude Code/Codex**（闭源成品） | **更开放+守通用协议**：全开源/自托管/模型自由 |
| **插件一等公民** | 定制**不难**，又不失**灵活** |

**口播**
一句话：**dsh 比 openclaw 轻，比 SDK 完整，比闭源成品开放；而这一切靠'插件一等公民'——定制既不难、又不受限。** 市面上要么是"能用的成品但改不动"，要么是"随便改但全要自己搭"，dsh 站在中间。

---

## PPT 8 · 我用 dsh 做了什么（实证）

**大标题**：两周，长出一整套插件工具箱

**屏幕要点**
| 插件 | 一句话 |
| --- | --- |
| 钉钉桥接器 | 在钉钉里直接对话 Agent，定时提醒主动推送 |
| browser-reader | 真浏览器阅读（web_read 系列），读 JS 渲染页 |
| minimax-search | MiniMax 注册为 web 搜索，`web_search` 直接可用 |
| cron-scheduler | 标准 5 字段 cron 定时，跨重启防重复 |
| ui-enhance | 增强 UI：实时文件树（git 状态）/ 状态面板 / 打开 IDE |
| flash-worker | pro 指挥、flash 执行的 preset |

**数据**：69 commits / 225 files / +16438 行 / 100 测试 / 3000+ 行文档

**口播**
这些不是 PPT 上的设想，是本仓库真实跑通的。钉钉能聊、浏览器能读、定时能跑、UI 能看——全是从"插件机制"长出来的。

---

## PPT 9 · 亮点：右侧实时文件树

**大标题**：官方没有的，插件补上

**屏幕要点**
- 类 codex 的右侧文件树：递归目录 + **git 状态徽标（M/A/D/U）**
- 可拖拽调宽 · 双击文件在 IDE 打开 · 路径一键复制
- **fs.watch + SSE 实时刷新**：改文件/提交，徽标即时更新，不刷新页面
- 一根红线：**只做增量，不覆盖官方渲染器**

**口播**
这个文件树官方没有。我们做的原则是"只做增量，不覆盖"——这是 client bundle 插件很重要的纪律。实时性是靠 fs.watch + SSE 事件驱动，不是轮询。

---

## PPT 10 · 三个真实事故：我把 dsh 搞崩了

**大标题**：不是 dsh 的 bug，是它的设计哲学

**屏幕要点**
- **fail-loud（启动时响亮失败）**：插件挂了宁可起不来，也不要带病运行
- 事故 1 · inject 门禁：访问服务没声明 → `cannot get property "webServer" without inject`
- 事故 2 · SessionEvent 白名单：往会话日志写自定义事件 → 整段历史无法加载
- 事故 3 · 工具 schema：两套语法混用 → 启动直接崩

**口播**
三个事故，每一个都让 `dsh web` 起不来。但这不是 bug，是设计：官方认为"一个工具插件挂了若静默继续，Agent 会以残缺能力跑出诡异错误；不如启动时响亮失败，修完重启"。

---

## PPT 11 · 事故 1 & 2 的代码教训

**大标题**：两个标准死法，一眼看清

**屏幕要点**
```ts
// ❌ boot 直接崩
export function apply(ctx) { ctx.webServer.register(...) }
// ✅ 必须声明
export const inject = ['webServer']
```
```text
// ❌ 往会话日志写自定义事件
agent.session.append('cron/dispatch', ...)
// 一个自定义事件类型 = 一段永久不可读的历史
// ✅ 审计走 logger，不进日志
```

**口播**
第一个是"没声明就访问服务"，运行时校验，编译查不出。第二个更隐蔽——DSH 会话日志是事件溯源，白名单外的事件会毁掉整份历史。这两条已经写成铁律。

---

## PPT 12 · 踩坑 → 5 条铁律 + 三道防线

**大标题**：把"崩溃越早越好"变成工程实践

**屏幕要点**
**5 条铁律**
1. 绝不向 session 日志写自定义事件
2. 凡访问 `ctx.<服务>` 必须写进 `inject`
3. 状态持久化落在沙箱可写根内（`workspace-write` 只放行工作区 + /tmp）
4. 写入错误不要静默吞
5. schema 纪律：`output.schema` 对象级 required

**三道防线（脚手架）**
- ① 加载期自检 `check-plugin.mjs`（Proxy 模拟注入门禁）
- ② 安装门禁 `install-plugins.mjs`（失败跳过不装）
- ③ 升级契约检查 `check-dsh-compat.mjs`（查 wire 契约漂移）

**口播**
既然常规校验救不了你，我写了三道防线：**装进 profile 之前，就让它先崩给自己看**。这三道都是脚手架，跑一条命令就有。

---

## PPT 13 · 多 Agent 协同 + 可移植性

**大标题**：dsh 的两个"模式"

**屏幕要点**
- **pro 指挥、flash 执行**：主 agent 规划/review，flash 子 agent 干活（flash-worker preset）
- **一条命令装齐**：`npm run install:plugins` = 构建 + 自检 + 装进 profile + 自动补 patch 引用

**口播**
两件事让这套东西真正好用：一是把 dsh 用成"两级开发团队"，主 agent 想清楚做什么、子 agent 动手做；二是可移植性——新电脑 clone 下来一条命令装齐，插件引用自动补进配置文件。

---

## PPT 14 · 企业场景：ERP 三层权限如何落地

**大标题**：一个具体场景，看 DSH 的"设计态"

**屏幕要点**
- 用户看销售数据，ERP 有三层权限：
  - L1 功能权限 —— 能不能用"查销售"
  - L2 数据行权限 —— 只有 A 部门数据
  - L3 字段权限 —— 看得到数量，看不到金额/成本
- **DSH 的落法**（不是一个大 if，是流水线上的三个环）：
  - L1 → 作用域 restrict（模型看不到无权工具）
  - L2 → 工具内部注入 dept + ToolGuard 单调守卫
  - L3 → post-execute 出口裁剪（替换 value，审计里也没有）

**口播**
做企业软件最怕三件事：AI 乱动数据、出了事说不清、权限被绕过。DSH 把三层权限落在工具流水线的三个环节——L1 管"模型看不看得到"，L2 管"数据源只出哪些行"，L3 管"出口只留哪些列"。模型从头到尾被管道包住，每一环都绕不过，而且全程自动进审计。

---

## PPT 15 · 企业场景：多领域 Agent 服务化

**大标题**：库存/销售/财务，各一个 Agent，统一发布成 API

**屏幕要点**
- 纠偏：不要"一领域一个 profile"，而是**一个 host + 多个 agent preset**
- preset = "这个会话挂哪些工具的装配单"（preset.yml + agent.cordis.yml）
- 一个 web profile 自带 `/api`：
  - `session.create?preset=erp-sales` → 建销售领域 Agent
  - `session.prompt` → 发消息，只有销售工具集可见
- preset 管"领域"、L1 restrict 管"人"、L2/L3 管"数据"

**口播**
如果你要给多个业务领域各做一个 Agent、又要统一对外——dsh 的正解是一套 host + 一堆 preset。像一个服务中心，每个领域一扇门，但门都开在同一栋楼里，对外走同一个 /api。

---

## PPT 16 · 收尾

**大标题**：为什么值得你花时间试 dsh

**屏幕要点**
1. **定位**：比 openclaw 轻、比 SDK 完整、比闭源成品开放——插件一等公民让定制不难又不失灵活
2. **早期红利**：8/13 开源，生态窗口期，现在入场拿到第一波稀缺经验
3. **方法论可迁移**：自检防线、绝不写自定义事件、事件溯源审计——不绑定 dsh，任何 Agent 框架通用

**口播**
最后说三点：第一，dsh 的位置罕见——轻到改得动，完整到不用搭，开放到不自锁；第二，它是 8 月 13 号才开源的，现在的插件和踩坑方法论都是稀缺资产；第三，我这几周沉淀的经验，换到任何 Agent 框架都适用。**工具会迭代，方法论是长期资产。** 谢谢大家。

---

## PPT 收尾页（感谢页）

**大标题**：谢谢 · Q&A

**底部**：仓库 `github.com/codelogickeep/deepseek-harness-plugin`（MIT）· 6 类能力 · 均真实跑通
