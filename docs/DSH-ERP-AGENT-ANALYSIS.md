# DSH 在两类 ERP Agent 场景下的优势深度分析

> 定位：给「好业财 ERP 研发团队」看的决策型文档——我们到底要不要、以及为什么值得用 DSH 去构建两类 Agent。
> 现状基线：团队现有 `~/OpenProject/ai-erp` 是 **Python FastAPI + Streamlit + LangGraph + MCP + RAG** 的「AI 增强层 Sidecar」，跑在原 Java ERP 旁侧。注意：其中的 `app/mcp/server.py` 实际是 **FastAPI REST 工具网关**（`/tools` + `/invoke` 的 JSON 接口，`get_inventory_tool`/`create_order_tool` 等），并非标准 MCP 协议 server（无 `FastMCP`/stdio/streamable-http）——这影响后面的迁移路径判断。
> 目标场景：① **ERP Agent 给客户用**（产品化交付、多租户、可审计）；② **ERP 研发 Agent 给开发/测试用**（内部提效、慢 SQL 治理、UI-AI 回放）。
> 方法：先列 DSH 的**独有特性**（对比 LangGraph/ADK/CC/Codex/Dify 后真正差异化的点），再逐一映射到我们的两个场景，最后给出选型结论与落地路径。

---

## 〇、先对齐认知：你现在在 LangGraph 上「照着重写 DSH 已有的轮子」

在展开 DSH 的优势之前，必须先说清楚一个事实——**你现在的 ai-erp 用 LangGraph 手写的那套 agent 状态机，恰好就是 DSH 开箱即有的东西**：

| 你在 `app/agent/graph.py` 手写的 | DSH 内置等价物 | 谁维护 |
| --- | --- | --- |
| `intent_classifier_node`（意图分类） | agent loop 的 turn/step 决策 + `agent/pre-step` | DSH core |
| `planner_node`（任务规划） | Agent 自主规划（自然语言工具选择） | 模型 + DSH loop |
| `tool_executor_node`（工具执行） | `ctx.tools` 注册表 + `tools/pre-execute → execute → post-execute` 流水线 | DSH core |
| `should_retry`（重试逻辑） | `llm-retry` / `agent/request-error` / `timeout-policy` | DSH plugins |
| `AgentState`（状态管理） | 事件溯源会话日志（`SessionEvent`，append-only 可回放） | DSH session |
| Streamlit UI | `dsh web`（浏览器 GUI，含文件树/状态面板/文件树） | DSH web-app |
| `guardrails/`（审批、权限） | `approval` seam + `sandbox` + `permission-presets` | DSH base |

**这不是"LangGraph 不好"，而是"LangGraph 是开发框架（零件库），你要自己焊整机；DSH 是 harness（整机 + 图纸），你要做的是换零件。"** 理解了这一点，下面 DSH 的每一条优势就都是"你不用再自己造的东西"。

---

## 一、DSH 的独有特性清单（先摆事实）

以下特性全部来自 DSH 官方源码/doc 实测（`~/OpenProject/deepseek-harness`），并标注「哪些是 LangGraph/CC/Codex/Dify 没有或难做到的」：

| # | 独有特性 | 具体内容 | 横向对比 |
| --- | --- | --- | --- |
| F1 | **一切皆插件（无特权内核）** | 模型/工具/会话/沙箱/存储/循环/调度/UI 全是 Cordis 插件，配置树组合，可逆副作用 | LangGraph 只有"你写的代码"；Dify 只能画节点；CC/Codex 黑盒 |
| F2 | **事件溯源会话日志（append-only + 可回放/分叉）** | "模型可见即已记录"；fork/resume/transcript/遥测全靠同一条事件流 | LangGraph 用 checkpointer（快照恢复）；DSH 是全量可审计重放 |
| F3 | **多 profile = 多部署形态** | 同一内核换外壳：`web`（浏览器）/`tui`（终端）/`headless`（一次性任务）/自定义 profile | Dify 只有 SaaS/自托管平台；CC/Codex 只有 CLI |
| F4 | **内置 /api 外部客户端协议** | `POST /api/session.prompt` + `WS /api/events.mux`，任何外部程序能接入 | LangGraph 要自己写 API；CC/Codex 无此协议层 |
| F5 | **四大 modes（standard/PTC/minimal/cordis）按会话选** | 同一进程可并存原生 + Code Mode 会话；PTC 让一次往返顶五次 | 其他工具是全局单一形态 |
| F6 | **approval/sandbox/credentials 三件套（内置安全）** | 按会话审批策略（ask/never）、沙箱（bwrap/Landlock/Seatbelt/ACL）、凭据按操作解析热更新 | LangGraph 全靠你自己加；Dify 有权限但不可编程定到会话级 |
| F7 | **subagent 多 provider** | 能把 Codex/Claude Code 当子 agent；per-agent 模型指定（pro 指挥 flash 执行） | LangGraph 要自己实现子 agent 路由；CC/Codex 锁自家 |
| F8 | **模型自由（seam）** | `ctx.llm` 注册任意 provider——DeepSeek/MiniMax/OpenAI 兼容端点都行 | CC 绑 Anthropic、Codex 绑 OpenAI、Dify 面板切、LangGraph 代码定 |
| F9 | **可版本化/可移植一切皆文件** | 配置=YAML、会话=jsonl、历史=git 可管；一次性 scaffold 装齐 | Dify 配置在自家目录；CC/Codex 配置私有 |
| F10 | **模型可见即已记录 = 天然审计轨迹** | 每一步（prompt/思考/工具调用/结果/子agent）都进日志，Trajectory 视图可溯源 | 客户 ERP 审计、合规场景的杀手锏 |

---

## 二、场景 ①：ERP Agent 给客户用（产品化交付）

### 2.1 这是什么场景
把"自然语言问库存 / 查订单 / 智能分析 / 执行业务操作"做成**产品功能**交付给企业客户。硬约束：**多租户安全隔离、敏感操作审批、全程可审计、部署可控（私有化/本地）**。

### 2.2 DSH 的优势逐条落位

**优势 1：audit-ready——事件溯源日志 = 现成的合规审计（F2/F10）**
客户 ERP 最怕"AI 干了什么说不清"。DSH 把**每一次模型输入、每次工具调用、每个结果、每次子 agent 调度**全写进 append-only 会话日志，而且"模型可见即已记录"是运行时不变量（不是事后补记）。这意味着：
- AI 对客户数据做的每一次操作，都能回放重建；
- 出了纠纷/审计，把 jsonl 导出来就是完整证据链；
- Trajectory 视图肉眼可查。**这套审计能力 LangGraph 要自己写，Dify 做不到这么细且可编程。**

**优势 2：审批 = 产品功能而非补丁（F6）**
ERP 的"创建订单/改库存/删数据"这类高危操作，产品上必须有人工审批。DSH 的 `approval` seam 是**内置的一等公民**：
- `ask` 策略天然触发人类应答（UI 弹窗/桥接器推钉钉）；
- `never` 策略兜底拒绝；`allowed-once` 单次授权；
- 审批决策是一对审计事件（`approval/asked` + `approval/decided`），进日志。
对比：你的 ai-erp 现在是自己写 `guardrails/permission_checker.py`——DSH 是你不用写这个文件，还能做得更细（会话级策略 + 审计闭环）。

**优势 3：多租户隔离的天然抓手（F1/F6）**
DSH 的沙箱是**按平台分层 + 按会话工作区围栏**的（Linux bwrap/Landlock、macOS Seatbelt、Windows ACL）。配合 `permission-presets`（read-only / workspace-write / danger-full-access），你能在**配置层**控制"每个客户会话能碰什么"，而不是在代码里写死。多租户 = 每客户一个 profile/工作区 + 沙箱围栏 + 凭据（F6 credentials 按操作解析、热轮换不重启）——这套是 LangGraph 完全没有、Dify 做不到会话级的。

**优势 4：交付形态自由（F3/F4）—— 这是"给客户"的核心差异化**
DSH 同一内核可以切出多种交付形态：
| 客户场景 | 交付形态 |
| --- | --- |
| Web 端客户用 | `dsh --profile web`（浏览器 GUI）|
| 钉钉/企微客户用 | 钉钉桥接器（我们已验证）→ 客户在聊天里直接问 |
| CLI/脚本接进 ERP | `dsh --profile headless "任务"`（无服务器，跑完即退）|
| 嵌进你们自己的产品 | `/api` 协议（`session.prompt` + `events.mux`）→ 你写壳，DSH 当 Agent 引擎 |
| 私有化部署 | 全本地/本地优先，默认不出本机 |

> **关键洞察**：你现在的 ai-erp 是"Python Sidecar + Streamlit 前端"——前端、Agent、安全、审计**全部自己写**。用 DSH，这些是 profile 层的选择，不是 coding 工作量。你的 Java ERP 只要调 `/api` 就能获得整套 Agent。

**优势 5：模型可替换 = 不被某一家模型锁死（F8）**
给客户交付时，客户可能指定模型（信创/合规/成本）。DSH 的 `ctx.llm` 能注册 DeepSeek、MiniMax、任意 OpenAI 兼容端点。客户要换模型 = 改一行配置，不是重写适配。

### 2.3 客户向场景的一句话结论
> **如果目标是"把 AI 能力产品化交付给客户"，DSH 是唯一一个"把审计、审批、沙箱隔离、多形态交付、模型自由"全部内置且可编程到会话级的 harness。** 你不再需要把 LangGraph + 自写 guardrails + 自写前端 + 自写审计拼在一起。

---

## 三、场景 ②：ERP 研发 Agent 给开发/测试用（内部提效）

### 3.1 这是什么场景
团队 8 人，业务域库存/仓储/配送。研发 Agent 用来：读 Java ERP 代码库、写迁移脚本、跑测试修 bug、**慢 SQL 治理**、**UI-AI 录制回放**、沉淀**团队 Skill**。

### 3.2 DSH 的优势逐条落位

**优势 1：PTC 模式 = 一次程序编排，审计完整的工程执行（F5）**
你的 ERP 打标场景（"读三个表 → 写迁移 → 跑测试 → 修 bug"）在 standard 模式是 3-5 次 LLM 往返，在 **PTC（Code Mode）** 下模型写一个 TypeScript 程序、`run_code` 一次执行完。官方原话："a sequence that would be five round trips becomes one." 对研发提效的直接收益：快、可复现、日志干净。

**优势 2：慢 SQL 治理的正规军（F2/F10）**
你的技术方向里有"慢 SQL 治理"。DSH 的事件溯源日志把**每次工具调用、每次查询、每次结果**都记录下来——这意味着你能拿到"Agent 当时实际执行了什么 SQL、返回了什么"的完整轨迹。对比：其他工具的日志是给自己的，DSH 的日志是**可查询、可回放、可 fork 重放的工程资产**。慢 SQL 发现 → 回放到当时上下文 → 让 Agent 修复 → 再回放验证，是一个闭环。

**优势 3：UI-AI 录制/回放的底座（F2 + subagent）**
DSH 的会话可以 **fork**：把一次出问题的会话 fork 出来，改个 prompt/工具再跑，不影响原会话。这正好支撑"UI-AI 录制智能回放"——录制的是一次完整 Agent 轨迹，回放是再过一遍。加上 subagent 多 provider（F7），可以让不同模型换着跑同一个任务对比效果。

**优势 4：团队 Skill 沉淀 = 可版本化的工程资产（F1/F9）**
DSH 的 skills 是插件（`SKILL.md`），配 `skill-filesystem` 自动注入相关上下文。你们团队想把"库存异常排查 SOP""仓储配送标准流程"沉淀成 skill：
- skill = 文本文件 → git 可管理 → 随版本分发；
- 团队 Agent 会自动按需加载对应 skill；
- 对比 Dify（只能画节点）、LangGraph（要写代码），DSH 的"知识 = 文件"是最轻的团队资产化方式。

**优势 5：多 profile = 研发流水线一条龙（F3）**
| 研发环节 | DSH 形态 |
| --- | --- |
| 日常问答/定位 | `standard` 会话 |
| 多步工程（迁移/重构/测试） | `code`（PTC）会话 |
| CI 里跑回归/批量 | `headless "任务"` |
| 自定义 ERP 专属 Agent | `cordis` 起步 → 复制成 `erp-dev` preset |
| 钉钉里让 Agent 干活 | 钉钉桥接器 |

**优势 6：pro 指挥 flash 执行 = 成本与质量平衡（F7）**
我们已经验证的 `flash-worker` preset：主 agent（pro）规划/review，flash 子 agent 干具体活。对 ERP 研发团队意味着：复杂任务质量在线、日常成本可控、多人共享同一套协同模式。

### 3.3 研发向场景的一句话结论
> **如果目标是"研发内部提效 + 沉淀团队工程资产"，DSH 的 PTC 模式、事件溯源回放、Skill 文件化、多 profile 流水线，正好命中我们四个技术方向里的三个（Skill 工程化、可审计性、慢 SQL 治理），UI-AI 回放也能借 fork/回放机制落地。**

---

## 四、和现在的 LangGraph 路线怎么处？（不推翻，是迁移路径）

### 4.1 用一张表说清楚"什么值得搬、什么不值得"

| 你现在的资产 | DSH 里对应 | 迁移成本 |
| --- | --- | --- |
| `app/agent/graph.py`（状态机） | **丢弃**——DSH agent loop 内置 | 低（删代码）|
| `app/agent/nodes.py`（四个节点） | **丢弃**——成为 DSH 的 turn/step | 低（删代码）|
| `app/guardrails/*.py`（审批/权限） | **迁移到 DSH approval/sandbox seam** | 中（换成内置）|
| `app/mcp/tools/*.py`（库存/订单工具业务逻辑） | **保留**——包成 DSH 原生工具（`ctx.tools.register`，schema 描述参数），你的 REST 工具逻辑几乎原样迁入 | 低（换注册位置）|
| `app/rag/*`（RAG 链路） | **保留**——DSH 里 RAG 是一个工具/skill | 低 |
| `app/ui/streamlit_app.py`（前端） | **可选换成** `dsh web`，或用你的壳 + /api | 低到中 |
| `app/mcp/server.py`（REST 工具网关） | **可选丢弃/降级**——你的实现是 FastAPI REST（非标准 MCP 协议），DSH 消费它的最简路径是直接注册为 DSH 工具；若要保留则升级为标准 `mcp-client` 可对接的 server | 低到中 |

> **核心判断：你现在 ai-erp 里最"重"的部分（agent 编排 + guardrails + UI + 审计）恰恰是 DSH 免费送的；最"值钱"的部分（业务工具、RAG、业务知识）恰恰是你可以原样保留的。** 所以这不是推翻重来，是把"通用轮子"卸掉换 DSH 的，把"业务资产"搬上去。

### 4.2 DSH vs LangGraph 在 ERP 场景的直接对比（决策表）

| 维度 | DSH | LangGraph（你现在的路线） |
| --- | --- | --- |
| agent 循环 | ✅ 内置（turn/step/工具流水线/重试） | ❌ 自己写（你已写 170 行 graph.py）|
| 审计 | ✅ 事件溯源全量日志，免费 | ❌ 自己加日志/自己接存储 |
| 审批 | ✅ 内置 approval seam，会话级策略 + 审计 | ❌ 自己写 permission_checker + 自己接 UI |
| 沙箱多租户 | ✅ 内置（bwrap/Landlock/Seatbelt/ACL） | ❌ 自己接 sandbox 库 |
| UI | ✅ `dsh web` 全套；或 /api 自己接 | ❌ 自写 Streamlit |
| 子 agent/多模型 | ✅ 内置多 provider、per-agent 模型 | ⚠️ 可做但自己编排 |
| 部署形态 | ✅ 多 profile（web/tui/headless/自定义） | ⚠️ 自写服务 + 自写入口 |
| 团队资产（skill） | ✅ 文件化、git 可管理 | ❌ 自建知识体系 |
| 学习成本 | 中（理解配置树/插件） | 低中（Python 熟悉）|
| 成熟度 | ⚠️ 开发者预览（破坏性变更） | ✅ 成熟 |
| **净判断** | **把通用轮子免了，聚焦业务** | 全自建，灵活但负担重 |

---

## 五、落地建议（三步走，风险可控）

1. **第一步（验证）**：用 DSH 起一个 `erp-bridge` 最小验证——接 1 个库存查询工具（复用你 ai-erp 的 `inventory_tools.py` 逻辑），跑通"自然语言问库存 → 审批 → 回答 → 审计日志"。目标：**证明 DSH 能把现有业务工具原样挂上**。1-2 天。
   - **验证清单（照着做）**：
     1. `dsh --profile web` 起一个 web profile，确认 GUI 起来；
     2. 把 `get_inventory_tool` 逻辑包成 DSH 工具（`ctx.tools.register`，写 schema），patch 进 `cordis.patch.yml`；
     3. 会话里用自然语言问"某 SKU 库存够不够"，确认工具被调用；
     4. 把会话 `approval/policy` 设为 `ask`，确认高危操作（如调 `create_order`）触发审批；
     5. 导出一份会话 jsonl 日志，确认"模型输入/工具调用/结果"全量可回放（审计证据）。
2. **第二步（内部提效试点）**：研发场景先跑——做 `erp-dev` preset（PTC 模式 + 团队 skill + 慢 SQL 治理用例），团队 8 人选 2-3 人试用，沉淀使用反馈和 SOP。核心价值抓 **审计 + 回放 + skill 沉淀**。
3. **第三步（客户化立项）**：如果前两步验证通过，评估将 ai-erp Sidecar 的 Agent 内核替换为 DSH——保留业务工具/RAG，把编排/审批/审计/前端迁到 DSH。**风险对冲**：DSH 是开发者预览，建议**并行跑**（新项目用 DSH，老 Sidecar 维持），不搞"大迁移"。

---

## 六、风险与边界（不吹不黑）

| 风险 | 说明 | 应对 |
| --- | --- | --- |
| 开发者预览、破坏性变更 | 两周内 0.1.0-rc.8→0.1.1-rc.2 三次 | 锁定版本 + 我们的 `check-dsh-compat` 契约检查已就绪 |
| 生态年轻 | 官方插件少，社区少 | 自研（我们有 5 个插件经验）+ 持续跟踪上游 |
| 学习曲线 | "配置树/插件/事件"心法需要适应 | 8 人组选 1-2 人先当"DSH 布道者" |
| 客户部署环境 | 不确定客户服务器 OS/网络（沙箱依赖平台 runner） | 先验证沙箱在目标环境可用；不可用可降级 danger-full-access + 审批兜底 |
| 你不能用它的部分 | Dify 的可视化给业务、LangGraph 的极致灵活给复杂多 agent | DSH 不是替代一切，是补"自研 Agent 底座"这一格 |

---

## 七、一句话总结（给领导/给团队）

> **我们的 ai-erp 现在 80% 的代码在造 DSH 免费送的轮子（agent 循环、审批、审计、UI）。DSH 让我们把精力放回真正值钱的 20%（业务工具、业务知识、RAG、团队 Skill）。** 客户向要审计/审批/多租户/多形态交付，研发向要 PTC/Skill/回放/流水线——两条线 DSH 都有唯一契合点。风险（预览期）用「并行试点 + 版本锁定 + 契约检查」控住。
