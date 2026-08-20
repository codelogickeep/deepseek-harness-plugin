# UI-Enhance — DSH 增强型 UI 交互界面插件

浏览器端（client bundle）增强插件，为 DeepSeek Harness Web 界面增量添加官方没有的交互能力。
**原则：只做增量，不覆盖/替换官方渲染器。**

## 功能现状

| 能力 | 状态 | 说明 |
|------|------|------|
| ② 会话状态面板 | ✅ 已验证 | 会话头部显示 🟢运行中/⚪空闲 + 当前工具名 + 排队计数 + 会话短ID |
| ④ 打开 VS Code | ✅ 已验证 | 会话头部右上角「⧉ 打开 VS Code」按钮，打开当前工作区 |
| ① 消息渲染增强 | ⏸ 暂缓 | 官方已完善（markdown/代码块复制/思考行/操作条），等具体需求 |
| ③ 工具调用可视化 | ⏳ 待做 | 计划增强工具调用展示 |

## 架构图

```
┌──────────────────────────────────────────────────────────┐
│  plugins/ui-enhance（npm 包，同时是 DSH 插件条目）        │
│  package.json: dsh.client.platform=web + exports["./client"] │
├──────────────────────────────────────────────────────────┤
│  构建: tsdown → lib/client.js（closure-factory）          │
│        tsc     → lib/index.js （Node 宿主半身）           │
│  部署: install-plugins.mjs（构建→自检→pnpm file:→验证）     │
├──────────────────────────────────────────────────────────┤
│  Node 半身 (lib/index.js)                                 │
│    inject: ['webServer', 'workspaceRegistry']            │
│    ├─ ctx.webServer.register('/api/ui-enhance/...')       │
│    │    └─ POST /open-in-editor → spawn('code',[path])    │
│    └─ workspaceRegistry.list() → 取工作区路径             │
│                                                          │
│  Client 半身 (lib/client.js)                              │
│    inject: ['slots', 'locale']                            │
│    apply(ctx) → ctx.slots.inject('conversation.session.   │
│                   header.utilities', ...)                 │
│    ├─ SessionStatusPanel（② 状态面板）                    │
│    │    useSession 快照 → running/tool/queue              │
│    └─ OpenInEditorButton（④ 按钮）                        │
│         fetch('/api/ui-enhance/open-in-editor')           │
└──────────────────────────────────────────────────────────┘
```

## 技术要点

- **client bundle 形态**：DSH 要求 client bundle 是 `window.__ModuleLoader__.load({id, factory})`
  closure-factory（tsdown `banner`/`footer` 包装，产物 git 忽略、安装时构建）
- **external**：react 全家桶 + `@deepseek-ai/*` 走宿主模块表（`deps.neverBundle`/`alwaysBundle`）
- **slot 选择**：`conversation.session.header.utilities` 是 list 型 slot（非 keyed），
  与官方/dsh-webui 通过 `id` 区分，无冲突
- **禁止触碰**：`conversation.chat.node` 是 keyed slot，官方已占用
  `assistant-step`/`tool-call`/`user` 等 key——自定义 UI 不在此注册
- **client→host 通道**：Node 半身注册 `webServer` HTTP 路由，client 用 `fetch('/api/...')`
  调用（dsh-webui 同款范式）

## 开发/部署/验收

```bash
# 部署（构建 + Node 自检 + 安装到 profile + 验证）
node scripts/install-plugins.mjs

# 单独自检 Node 半身
node scripts/check-plugin.mjs plugins/ui-enhance/lib/index.js

# 重启 DSH 使 Node 路由生效（前端刷新即可拉新 bundle）
# 验收：会话头部 → 「⧉ 打开 VS Code」按钮 + 状态面板
#      POST /api/ui-enhance/open-in-editor → {"ok":true,...}
```

## 事故教训（inject 门禁）

**现象**：Node 半身源码里访问 `ctx.webServer`，但未在 `inject` 声明，
DSH 启动时 cordis 抛 `cannot get property "webServer" without inject` 直接崩。

**根因**：cordis（DSH 宿主框架）强制「访问服务必须在插件的 `inject` 导出里声明」。
这是**运行时校验**，`--dump-config` 和旧版自检（stub ctx 直接展开服务）都拦不住。

**制度修复**（已落地）：
1. `scripts/check-plugin.mjs`：stub ctx 改为 **Proxy 模拟真实 cordis 注入门禁**——
   访问未在 `inject` 声明的服务即抛**与 DSH 完全一致**的报错；`ctx.get()`（内置查找）
   放行不误伤
2. `scripts/install-plugins.mjs`：client 包安装链路在构建后对 `lib/index.js` 跑 Node 半身
   自检，未通过则**跳过安装**（DSH 不会因此起不来）
3. 插件代码要求：凡访问 `ctx.<服务>` 必须同步加进 `export const inject = [...]`
