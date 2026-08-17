---
title: DSH 知识沉淀：官方动态 + 插件机制实战
description: DeepSeek Harness 官方动态（v0.1 开源）与宿主插件机制实战：cordis.patch.yml、WebSearchProvider、MiniMax 搜索接入模板。
tags: [dsh, knowledge, plugins, cordis, research]
date: 2026-08-17
status: active
---
# DSH 知识沉淀：官方动态 + 插件机制实战

> 来源：2026-08 期间通过 DSH 内置（现为 MiniMax）web 搜索检索到的官方/社区资料，
> 加上本人在本机 DSH (deepseek-harness) 上亲手接入 MiniMax 搜索插件的实战经验。
> 本文是「事实 + 已验证结论」，与 [PLUGIN-ECOSYSTEM.md](./PLUGIN-ECOSYSTEM.md)（概念导览）互补。

---

## 一、DSH 官方最新动态（截至 2026-08）

### 1.1 重磅发布：DeepSeek Harness 开发者预览版 v0.1 开源

- **时间**：2026-08-13 正式发布，**MIT 协议**在 GitHub 开源；发布后快速登上 GitHub 涨星榜首。
- **口号 / 核心理念**：**「一切皆插件」**（Everything is a plugin）。
- **技术底座**：基于 **Cordis 插件元框架**。Cordis 微内核只负责插件的加载/卸载与依赖关系；Agent 的所有能力都是 Cordis 插件，通过服务与事件协作，**在配置层自由组合**。
- **能力全部插件化**：模型、工具、技能、会话、沙箱、存储、循环、调度、UI 等。
- **预置四种运行模式**：标准、PTC（程序化工具调用）、极简、创造。
- **快速上手**：本地 Node.js 工具链 + `npx` 拉起 Web 交互界面。
- **开发者无需改源码**：新增/替换插件即可扩展任何能力。

> ⚠️ 官方明确：处于**开发者预览阶段**、快速迭代，**未来会破坏兼容性**。接入/学习需关注版本。

### 1.2 架构分层（官方/社区拆解）

- 典型能力拆分为**接口（interface）/ 实现（implementation）/ 消费者（consumer）**三层，边界清晰、可替换。
- 能力独立包示例：`packages/llm`（模型适配）、`packages/shell`（进程树）、`packages/fs`（文件读写）。
- **Agent 生命周期**：一次用户输入 = 一个任务轮次（turn），包含多个步骤（step）；每步 = 一次模型请求 + 后续工具执行。
- 模型请求前组装提示词、环境状态、工具；请求后模型输出、工具调用和结果进入事件流。
- **工具调用流水线**：前置策略 → 安全守卫 → 执行包装 → 后置处理；支持并行安全控制。

### 1.3 相关社区资料（原文可溯源）

- 科创板日报：开发者预览版开放测试、MIT 开源
- CSDN：DSH 架构拆解（微内核 + 依赖注入、三个值得抄的设计、两个坑）
- 多篇报道：登 GitHub 涨星榜首；「像玩乐高一样拼插件」
- 博客园：DeepSeek V4 Harness 协议合规审计（Probe-Based Wire Protocol、16 个文档化怪癖）
- 招聘情报：Agent Harness 岗位出现（Model + Harness = Agent 公式）

---

## 二、DSH 宿主插件机制（本机实锤，已在运行中验证）

> 以下来自在本机 `deepseek-harness` 上实际操作、查阅安装包源码、并**成功运行**的经验。

### 2.1 宿主合成怎么组合插件

- 每个 profile（如 `web`）就是一个目录：`~/.dsh/profiles/<name>/`。
- 插件行写在 **`cordis.yml` / `cordis.patch.yml`**（loader patch 层），顶层是一个 YAML 数组。
- bundle（如 `dsh-base`）自带 `cordis.patch.yml`，包含内置插件行（timer、hmr、llm、session、web、tool-web……）。
- **用户层 patch**（`~/.dsh/profiles/web/cordis.patch.yml`）在 bundle 之后应用，可对已有行做 **id 定向覆盖 / disable / insert**：

```yaml
# 覆盖某行的 config
- id: web
  config:
    searchProvider: minimax

# 停用一个内置行
- id: web-search-deepseek
  disabled: true

# 插入一个自定义插件行（name 指向本地文件）
- insert:
    - id: minimax-search
      name: ./plugins/minimax-search.mjs
```

关键机制：
- patch 的 **`id`** 用于在已有 entry 列表中定位目标行，`disabled`/`config` 等字段直接覆盖到该行（`target[key] = value`）。
- patch 修改后 **HMR 会自动重载**（`watchUserPatches` / cordis-plugin-hmr），**无需重启 DSH 即生效**（已在 2026-08 本机验证）。
- 若要持久生效，配置写在宿主 profile 的 patch；动态 `cordis_define` 插件则是进程内临时的（重启丢）。

### 2.2 自定义 provider：接入 web 搜索（MiniMax 实战）

DSH 的 `web` 服务（`ctx.web`）是「外部能力 seam」：
- `registerSearchProvider(provider)` / `registerFetchProvider(provider)`：注册第三方 provider。
- `search(request, signal)` / `fetch(...)`：按选择规则执行。

**`WebSearchProvider` 接口（必须实现）**：

```js
{
  id: string,
  available(): boolean,                       // 本地廉价检查，不能发网络
  search(request, signal): Promise<WebSearchResult>  // request: {query, maxResults?}
}
// WebSearchResult: { content?, sources: [{url, title?, snippet?, publishedAt?}], truncated }
```

**选择规则（重要）**：
- 配置了 `searchProvider: <id>` → 用该 provider（未注册→MISSING，不可用→UNAVAILABLE）。
- 未配置 → 恰好一个可用 → 用它；多个可用 → **AMBIGUOUS**（必须显式配一个）；零个 → UNAVAILABLE。

> ⚠️ 所以**只注册 provider 不够**：内置 `dsh-base` 默认把 `web.searchProvider` 配成 `deepseek-official`，必须**在用户 patch 里覆盖为我们的 provider id**，否则永远选内置。

### 2.3 我们接入的 MiniMax 搜索 Provider（可复用模板）

MiniMax「coding_plan/search」是**纯 HTTP API**（不需要 MCP / 子进程）：

```
POST https://api.minimaxi.com/v1/coding_plan/search   （国内 minimaxi.com）
POST https://api.minimax.io/v1/coding_plan/search     （国际 minimax.io）
Headers: Authorization: Bearer <MINIMAX_API_KEY>
Body:    { "q": "查询词" }
响应:    { organic: [{title, link, snippet, date}], related_searches: [...] }
```

**接入三步**（已在本机完成并验证生效）：
1. **插件文件** `~/.dsh/profiles/web/plugins/minimax-search.mjs`：
   - 导出 `{ name, inject: ['web'], apply(ctx, config) }`，在 `apply` 里 `ctx.web.registerSearchProvider(new MiniMaxSearchProvider(...))`。
   - `available()` / `search()` 里**每次实时**从 `launchEnvironmentOf(ctx)` 解析 key（宿主插件环境**没有 `process`**，不要用 `process.env`）。
   - key 放哪：`~/.dsh/.env`（DSH 启动的 `loadLayeredEnv` 会读 user 层 `.env` 并注入 launchEnvironment 快照；也会写 `process.env`——但对宿主插件仍以快照为准）。
2. **宿主 patch** `cordis.patch.yml`：`disable` 掉 `web-search-deepseek`，把 `web.searchProvider` 覆盖为 `minimax`，`insert` 插件行。
3. **验证**：改完 patch 后 HMR 自动生效，`web_search` 工具直接返回真实结果。

> 关键经验：宿主插件环境受限（无 `process`、无裸 `import` 之外的 node API），但**有全局 `fetch`**（内置 DeepSeek provider 同款用法）。写自定义 provider 要紧贴官方 provider（如 `dsh-web-search-deepseek`）的模式。

---

## 三、对「钉钉桥接器」项目的启示

- **DSH 官方正是「外部接入插件化」的设计**（模型/工具/IM 都是可换插件），我们的钉钉桥接器就是这个思路下的独立进程形态，与 DSH 官方架构不冲突、反而是互补：
  - 钉钉桥接器 = 外部集成（独立进程 ↔ DSH 的 `/api`）。
  - DSH 本体插件 = 给 Agent 加能力（注册进 `web`/`tools` 等服务）。
- 我们已把 **MiniMax 搜索**做成 DSH 本体能力（`web` provider），钉钉侧无需自己实现搜索；Agent 在钉钉里提问会自然使用该搜索。

---

## 四、溯源链接

- 科创板日报 · DeepSeek Harness 开发者预览版开放测试（MIT 开源、一切皆插件）：
  https://so.html5.qq.com/page/real/search_news?docid=70000021_2676a7dc75a58652
- CSDN · DeepSeek Harness(DSH) 架构拆解（三个值得抄的设计，两个要留心的坑）：
  https://blog.csdn.net/2501_91807877/article/details/163724191
- 腾讯新闻 · DeepSeek开源工具DSH登GitHub涨星榜首：
  https://so.html5.qq.com/page/real/search_news?docid=70000021_6446a7df7a541552
- 腾讯新闻 · DeepSeek开源首款Agent产品Harness（v0.1、MIT、Cordis、四模式）：
  https://so.html5.qq.com/page/real/search_news?docid=70000021_9296a7e72ae68752
- 腾讯新闻 · DeepSeek发布 Harness 开发者预览版：
  https://so.html5.qq.com/page/real/search_news?docid=70000021_4826a7dd37d70252
- 腾讯新闻 · DeepSeek Harness开发者预览版开源公测（插件化架构构建智能体框架）：
  https://so.html5.qq.com/page/real/search_news?docid=70000021_0126a80184a47065
- 腾讯新闻 · 像玩乐高一样拼插件，DeepSeek Harness能带来哪些改变?（Cordis机制详解）：
  https://so.html5.qq.com/page/real/search_news?docid=70000021_3336a7e996035452
- 博客园 · DeepSeek V4 Harness 协议合规审计（Probe-Based Wire Protocol）：
  https://www.cnblogs.com/32bin/p/22085555
- 博客园 · DeepSeek 悄悄挂出 Agent Harness 岗位（Model + Harness = Agent）：
  https://www.cnblogs.com/itech/p/20100852
