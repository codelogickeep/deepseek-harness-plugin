---
title: MiniMax 搜索接入指南（DSH 宿主插件）
description: 把 MiniMax「coding_plan/search」注册为 DSH web 搜索 provider 的完整指南：插件文件、host patch、key 配置、验证，含坑点与回滚。
tags: [minimax, search, dsh, plugin, web-provider]
date: 2026-08-17
status: active
---

# MiniMax 搜索接入指南

> 让 DSH（以及经桥接器的钉钉会话）的 `web_search` 使用 **MiniMax「coding_plan/search」** 真实网页搜索，
> 替代随 DSH 内置但 key 失效的 DeepSeek 官方搜索（`deepseek-official` / `dspark` 无效 key）。
> 本文是**已验证生效**的一键指南（2026-08 本机完成）。

---

## 一、原理速览

MiniMax 搜索是**纯 HTTP API**，无需 MCP / 子进程：

```
POST https://api.minimaxi.com/v1/coding_plan/search   （国内 minimaxi.com）
POST https://api.minimax.io/v1/coding_plan/search     （国际 minimax.io）
Headers: Authorization: Bearer <MINIMAX_API_KEY>
Body:    { "q": "查询词" }
响应:    { organic: [{title, link, snippet, date}], related_searches: [...] }
```

接入动作三件套（都在 DSH 宿主侧）：

| # | 文件（仓库 `deepseek-harness-plugin`） | 作用 |
|---|---|---|
| 1 | `plugins/minimax-search/minimax-search.mjs` | 插件源码（**仓库唯一真相源**）→ 脚手架同步到宿主 |
| 2 | 宿主 `~/.dsh/profiles/web/cordis.patch.yml` | 停用内置 DeepSeek + 把 `web.searchProvider` 指向 `minimax` + 插入插件行 |
| 3 | `~/.dsh/.env` | 存放 `MINIMAX_API_KEY`（DSH 启动自动读） |

---

## 二、前置条件

- 一台装了 DSH 并跑着 `dsh web` 的机器（profile 为 `web`）。
- **MiniMax API key**（`sk-` 开头，MiniMax 开放平台 / tokenPlan 套餐）——放 `~/.zshrc` 或便于导出即可，最终会进 `~/.dsh/.env`。
- 能访问 `api.minimaxi.com`（国内）或 `api.minimax.io`（国际）。

---

## 三、接入步骤

### 第 1 步：确认 key 可用（快速验证）

```bash
# 从 .zshrc 提取（不打印明文）
KEY=$(grep -m1 '^export MINIMAX_API_KEY=' ~/.zshrc | sed 's/^export MINIMAX_API_KEY=//; s/["'"'"']//g')
echo "key 长度: ${#KEY}, 前缀: ${KEY:0:4}"

# 验证 API
curl -s -X POST 'https://api.minimaxi.com/v1/coding_plan/search' \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"q":"测试"}' | python3 -c "import json,sys; d=json.load(sys.stdin); print('organic 条数:', len(d.get('organic',[])))"
```

期望：`organic 条数: >=1`。（否则 key 无效或区域不对，换 `api.minimax.io`。）

### 第 2 步：用脚手架安装插件（仓库 → 宿主）

插件源码在本仓库 `plugins/minimax-search/minimax-search.mjs`，**仓库是唯一真相源**。
用脚手架脚本同步到 DSH 宿主（不需要手动写宿主文件）：

```bash
cd deepseek-harness-plugin        # 本仓库根目录
npm run install:plugins           # 同步 plugins/ → ~/.dsh/profiles/web/plugins/
# 若要装到别的 profile：DSH_PROFILE=tui npm run install:plugins
```

预期输出：

```
✅ 安装插件 [minimax-search] → /Users/.../.dsh/profiles/web/plugins/ (minimax-search.mjs)
已完成：共安装 1 个文件。
```

> 之后每次改 `plugins/minimax-search/` 里的源码，重跑一次 `npm run install:plugins` 即可。
> 脚手架脚本见 [scripts/install-plugins.mjs](../scripts/install-plugins.mjs)。

要点（如需手写/看懂插件）：
- 导出 `{ name, inject: ['web'], apply(ctx, config) }`。
- `apply` 里调用 `ctx.web.registerSearchProvider(new MiniMaxSearchProvider({apiKey, env}))`。
- `env` 来自 `ctx.get('launchEnvironment')`；`resolveApiKey()` **每次实时**解析（config.apiKey → launchEnvironment 快照）。
- **绝不使用 `process.env`**：宿主插件环境没有 `process`（会抛 ReferenceError）。
- `fetch` 是全局可用（与内置 `dsh-web-search-deepseek` 同款用法）。

### 第 3 步：配置宿主 patch

编辑 `~/.dsh/profiles/web/cordis.patch.yml`：

```yaml
# 1) 停用内置 DeepSeek 搜索（key 失效，会一直报 ****park is invalid）
- id: web-search-deepseek
  disabled: true

# 2) 把 web 的搜索选择指向我们的 minimax provider（关键！）
- id: web
  config:
    searchProvider: minimax

# 3) 插入我们的插件
- insert:
    - id: minimax-search
      name: ./plugins/minimax-search.mjs
```

> ⚠️ **为什么必须改 `web.searchProvider`**：`dsh-base` bundle 默认把 `web.searchProvider` 配成 `deepseek-official`。
> 只注册 minimax 不够，选择规则会因「已配置 id」永远选 DeepSeek。必须覆盖为 `minimax`。

### 第 4 步：配置 API key

把 key 写入 DSH 用户层 env 文件（DSH 启动 `loadLayeredEnv` 会读它并注入 launchEnvironment 快照）：

```bash
KEY=$(grep -m1 '^export MINIMAX_API_KEY=' ~/.zshrc | sed 's/^export MINIMAX_API_KEY=//; s/["'"'"']//g')
echo "MINIMAX_API_KEY=$KEY" > ~/.dsh/.env
chmod 600 ~/.dsh/.env
```

### 第 5 步：生效与验证

- **patch 修改后 DSH 的 HMR 会自动重载**，通常**无需重启**。
- 若 HMR 未生效（改插件文件本身时），**重启 DSH**：`kill <3080 监听 pid> && cd <harness 项目> && dsh web`。
- 在任意 DSH 会话里调用 `web_search` 工具，应返回真实结果 + 来源链接：

```
输入: web_search("react 最新版本")
输出: 9 条真实结果（标题/URL/摘要），不再是 "Authentication Fails ... invalid"
```

---

## 四、坑与排错

| 现象 | 原因 | 解决 |
| --- | --- | --- |
| 报 `****park is invalid` | 选到内置 DeepSeek（`web.searchProvider` 仍为 `deepseek-official`） | 换成 `minimax`，且 `web-search-deepseek` 可 `disabled: true` |
| 报 `no usable web provider` / `WEB_PROVIDER_UNAVAILABLE` | minimax `available()` 为 false（key 没读到） | 检查 `~/.dsh/.env` 有 key；插件 `resolveApiKey` 从 launchEnvironment 读 |
| 报 `multiple usable ... AMBIGUOUS` | 配了多个可用 provider 且未显式选 | 在 `web.config.searchProvider` 里指定一个 |
| 插件不加载（lsof 看不到插件文件） | patch 未生效 / 需重启 | 确认 patch YAML 合法；重启 DSH |
| 宿主插件里 `process is not defined` | 宿主环境无 `process` | 改用 `launchEnvironmentOf(ctx)` 读 env / key |

---

## 五、回滚

恢复 DSH 内置 DeepSeek 搜索（或换回原状）：

```bash
# 1) 删掉宿主 patch 里的 minimax 相关条目
#    （web-search-deepseek disabled、web.searchProvider、insert）
# 2) 或直接备份还原 cordis.patch.yml
cp ~/.dsh/profiles/web/cordis.patch.yml ~/.dsh/profiles/web/cordis.patch.yml.bak   # 改前先备份
# 3) 想把插件文件也从宿主移除（仓库源码保留，不删）
rm ~/.dsh/profiles/web/plugins/minimax-search.mjs
```

> 建议：改宿主 patch 前先备份一份 `cordis.patch.yml`。
> 仓库 `plugins/minimax-search/` 是源码；宿主是安装产物。**回滚只在宿主侧操作即可，不动仓库源码。**

---

## 附录 A：插件源码模板

`~/.dsh/profiles/web/plugins/minimax-search.mjs`：

```js
export class MiniMaxSearchProvider {
  constructor({ apiKey = '', env = undefined } = {}) {
    this.id = 'minimax';
    this.apiKey = apiKey;
    this.env = env;
  }
  resolveApiKey() {
    if (this.apiKey) return this.apiKey;
    return this.env?.get?.('MINIMAX_API_KEY')?.value || '';
  }
  available() {
    return Boolean(this.resolveApiKey());
  }
  async search(request, signal) {
    const query = request.query;
    const apiKey = this.resolveApiKey();
    if (!query || !apiKey) return { sources: [], truncated: false };
    const res = await fetch('https://api.minimaxi.com/v1/coding_plan/search', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ q: query }),
      ...(signal !== undefined ? { signal } : {}),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`MiniMax 搜索失败 HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    const data = await res.json();
    if (data.base_resp && data.base_resp.status_code && data.base_resp.status_code !== 0) {
      throw new Error(`MiniMax 搜索错误 ${data.base_resp.status_code}: ${data.base_resp.status_msg || 'unknown'}`);
    }
    const organic = Array.isArray(data.organic) ? data.organic : [];
    const sources = organic
      .slice(0, request.maxResults)
      .map((e) => ({
        url: e.link || '',
        title: e.title || '',
        snippet: e.snippet || '',
        publishedAt: e.date || undefined,
      }))
      .filter((s) => s.url);
    return { sources, truncated: false };
  }
}

export const name = 'minimax-search';
export const inject = ['web'];
export function apply(ctx, config) {
  const env = ctx.get('launchEnvironment');
  ctx.web.registerSearchProvider(new MiniMaxSearchProvider({ apiKey: config?.apiKey || '', env }));
}
```

> 提示：`config` 里可选配 `apiKey`（字面量）作为最高优先级；不配则用 launchEnvironment 的 `MINIMAX_API_KEY`。
> 区域切换可把 endpoint 抽成 `MINIMAX_API_HOST` 驱动（见 `docs/DSH-NOTES.md`）。

---

## 相关文档

- [DSH 知识沉淀](docs/DSH-NOTES.md)（host patch 机制、WebSearchProvider 选择规则、实战细节）
- [插件生态导览](docs/PLUGIN-ECOSYSTEM.md)（两类插件区别）
- [架构说明](docs/ARCHITECTURE.md)
