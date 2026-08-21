# DSH 插件实战：从 0 到 1 给 DeepSeek Harness 开发插件

> 作者：codelogickeep
> 配套仓库：https://github.com/codelogickeep/deepseek-harness-plugin
> 读完约 5 分钟。文中每个「坑」都是真实事故复盘，不是理论推演。

---

## 一、为什么写这篇

2026 年 8 月，DeepSeek 开源了自己的 Agent 运行框架 DSH（DeepSeek Harness），核心哲学就一句话：
**Everything is a plugin（万物皆插件）**。模型、工具、会话、存储、UI……全部是 Cordis 插件，
没有特权内核，你的插件和官方内置插件权限一模一样。

这个生态太早期了——官方开发者预览版、迭代极快、破坏性变更不打招呼、社区插件少而散。
我在这期间给 DSH 写了不少插件，踩了无数坑，其中几个坑**直接把 DSH 搞崩过**（不是比喻，是字面意义的 boot 失败）。

这篇把我 60+ 次提交沉淀的经验写出来，分四块：
1. **插件形态怎么选**（宿主插件 / client bundle / preset——很多人第一步就选错）
2. **三个真实事故**（为什么我的插件能让 DSH 起不来）
3. **可移植性**：怎么让插件在新电脑一条命令装好
4. **给新手的检查清单**

---

## 二、插件形态：先选对「你在写哪种插件」

DSH 的插件分三类，选错形态 = 后面的所有努力都白费：

| 形态 | 是什么 | 代码位置 | 典型场景 |
| --- | --- | --- | --- |
| **宿主插件** | 跑在 DSH Node 进程里的 `.mjs` 模块，被 `cordis.patch.yml` 加载 | 仓库 `plugins/<name>/`，入口是 `.mjs` | 新工具、新服务、改配置<br>（如 MiniMax 搜索、cron 定时、浏览器阅读） |
| **client bundle 插件** | 跑在浏览器里的前端 bundle，`window.__ModuleLoader__.load({id, factory})` 封装 | `plugins/<name>/src/client/`，用 tsdown 构建 | UI 增强（会话头部、文件树、面板） |
| **Agent preset** | 一组 agent 配置模板，脚手架渲染安装到 `~/.dsh/.agent-presets/` | `presets/<name>/` | 调整 agent 的模型/工具/系统提示（如 flash-worker） |

还有个**独立进程**的特殊形态（如钉钉桥接器，它不跑在 DSH 进程里，通过 `/api` 协议通信）——
它本质是「另一个程序」而不是插件：虽然放在插件仓库里统一管理，但它不依赖 DSH 进程运行。

**最容易选错的地方**：你想加 UI，但跑去写宿主插件；你想加工具，但跑去写 client bundle。
记住一个判断：**要碰 DOM/浏览器 → client bundle；要碰 Node 服务/工具/schema → 宿主插件。**
两者靠 `webServer` 路由 `fetch('/api/...')` 桥接（`/api/<插件前缀>/...`，宿主注册、client 调用）。

---

## 三、三个真实事故：我的插件是怎么把 DSH 搞崩的

### 事故 1：inject 门禁 —— 「装上就崩」的标准死法

**现象**：写了一个 client bundle 插件的 Node 半身，访问 `ctx.webServer` 注册路由。
`--dump-config` 检查没问题，**旧的 stub 自检也过了**（它直接展开服务、没模拟注入门禁），
重启 DSH —— 直接崩。

**错误**：
```
cannot get property "webServer" without inject
```

**根因**：Cordis（DSH 宿主框架）强制「访问服务必须在插件的 `inject` 导出里声明」。
这是**运行时校验**——不是编译期、不是 config 校验，`--dump-config` 和普通 stub 自检都拦不住，
只有真实 boot 时才爆。

```ts
// ❌ 这样写，boot 直接崩
export function apply(ctx: Context) {
  ctx.webServer.register(...)  // 没声明 inject → crash
}

// ✅ 必须这样
export const inject = ['webServer', 'workspaceRegistry']
export function apply(ctx: Context) {
  ctx.webServer.register(...)
}
```

**教训**：DSH 插件「能在我的机器跑」不等于「安装了 DSH 起得来」。插件崩溃分两种路径，后果不同：
- **加载时崩溃**（inject 未声明、schema 非法）→ DSH **boot 失败**（起不来）
- **运行时崩溃**（沙箱、事件类型）→ DSH **能启动但数据被污染**（更隐蔽）

**防线**（这次事故逼我重写了自检工具）：既然旧的 stub 自检拦不住 inject 门禁，那就让自检
**模拟真实的注入门禁**——用 **Proxy stub ctx**：访问未在 `inject` 声明的服务就抛**与真实 DSH
完全一致**的报错；`ctx.get()`（内置查找）放行不误伤。安装前对每个插件跑一遍，过了才允许装进 profile。

### 事故 2：SessionEvent 白名单 —— 一条自定义事件，毁掉整个历史日志

**现象**：自研 cron 定时插件，在到点时往会话日志写了个自定义事件类型 `cron/dispatch`，
本意是「审计」。重启后该会话**历史无法加载**（`SessionFormatUnsupportedError`）。

**根因**：DSH 会话日志是**事件溯源**架构——`Session.append(type, data)` 产生事件，
持久化后重建会话完全靠**重放这些事件**。因此 DSH 对事件类型有严格保护：

- **白名单**：`KNOWN_SESSION_EVENT_TYPES` 只含官方事件（`turn/start`、`user/message`、`schedule/change` 等）
- **读路径**：遇到白名单之外且未标记 `ignorable: true` 的类型 → 抛错，**拒绝解释整份日志**
- **致命点**：`Session.append()` 的 options 只支持 surface 字段，**插件无法写入 `ignorable` 标记**

所以对会话日志来说：**一个自定义事件类型 = 一段永久不可读的历史**（只能离线改日志恢复）。

**教训（5 条插件开发法则）**：
1. **绝不向 session 日志写自定义事件类型**——审计走 `ctx.logger`，那才是给人看的
2. **状态持久化必须落在沙箱可写根内**（workspace 内，不是配置目录）
3. 跨 tick 防重复的状态，不要依赖「回写失败不报错」的路径
4. 写入错误不要静默吞
5. 修会话日志文件要小心（`assertEventsSupported` 会整份拒绝）

### 事故 3：fs.watch 实时刷新 —— 「轮询不够，得换 SSE」的设计纠正

**现象**：给文件树做 git 状态刷新，第一版用 client 端 `setInterval` 每 3 秒拉一次 `/tree`——
能用，但用户说「这不是实时」。

**纠正**：换成事件驱动。
- Node 半身：`fs.watch(workspace, {recursive: true})` 监听文件变化（macOS 支持 recursive），
  过滤掉 `.git`/`node_modules` 噪音 + 150ms debounce，变化时通过 **SSE** 推给前端
- client：面板打开时 `new EventSource('/api/ui-enhance/events')`，收到 `changed` 事件
  才拉一次 `/tree`（轻量刷新，保留展开状态）

**踩到的细节**：
- `webServer` 的 handler 是 `(req, res)`，**官方类型注释明确写着可以 hold response open（如 SSE）**——
  「Owns the full response lifecycle (may hold the response open, e.g. SSE)」，
  所以挂着当 SSE 长连接不是 hack，是官方认可用法
- `fs.watch` recursive 不是所有平台都好使，要降级（catch 后 non-recursive + warn）
- 前端刷新要「轻量」：根级 fetch 一次返回 git 汇总 + 根目录 entries，
  更新已存在节点的 git 字段、增删条目，**但不重建整棵树**（保住展开状态）

实测效果：commit 后 M 徽标即时消失，创建/删除文件即时增删条目。

---

## 四、可移植性：让插件在新电脑一条命令装好

DSH 插件有个隐藏痛点：**插件装进 `~/.dsh/profiles/<profile>/`，引用写死在 `cordis.patch.yml`，
而这个 patch 是 DSH 首次启动自动生成的、profile 内手工维护的文件**。

如果你的插件引用需要手工加进 patch，那么「给别人用」就变成「教别人手工编辑配置文件」——
这是推广杀手。

我的方案（写进脚手架 `install-plugins.mjs`）：
1. 仓库内维护 `presets/web-cordis.patch.yml.tpl`——插件引用的**唯一真相源**
2. 安装时自动**检测目标 patch 里缺哪个插件 id**，缺失才追加，幂等、不覆盖用户已有条目
3. 新增的条目按 YAML 缩进正确插入（`- insert:` 数组成员 4 空格缩进）

于是新电脑上：

```bash
# 先跑一次 `npx @deepseek-ai/dsh web` 让它生成 cordis.patch.yml 骨架
git clone https://github.com/codelogickeep/deepseek-harness-plugin.git
cd deepseek-harness-plugin
npm install
cd plugins/ui-enhance && pnpm install && cd ../..
npm run install:plugins    # 构建 + 自检 + 装进 profile + 自动补 patch 引用
# 重启 DSH，全部插件生效
```

一个坑：**patch 合并要对 YAML 缩进认真**——一开始我按「行」插，把用户已有的 `schedule` 块的
`name:` 行挤走了，YAML 解析直接崩。改成「找到 insert 数组最后一个成员的末尾再插」才稳定。

---

## 五、给新手 DSH 插件开发者的检查清单

1. **先选对形态**：碰 DOM → client bundle；碰服务/工具 → 宿主插件
2. **`inject` 声明**：凡访问 `ctx.<服务>` 必须同步写进 `export const inject`，
   否则 boot 即崩（`--dump-config` 拦不住）
3. **绝不写自定义 session 事件类型**——一个就毁一个会话历史
4. **自检前置**：装进 profile 前，用 stub ctx 跑「加载期自检」，过了才允许装
5. **patch 引用自动补**：别让用户手工编辑 `cordis.patch.yml`，模板 + 幂等合并
6. **client bundle 走规范**：tsdown closure-factory（`__ModuleLoader__.load`），
   external 掉 react/`@deepseek-ai/*`
7. **UI 增量优先**：能加在 slot 里的绝不去改官方渲染器——`conversation.chat.node` 是 keyed slot，
   官方已占用，别碰
8. **实时性用事件驱动**（SSE/fs.watch），别用轮询糊弄「实时」

---

## 六、资源

- 完整仓库（4 个 DSH 插件：browser-reader / cron-scheduler / minimax-search / ui-enhance
  + 钉钉桥接器独立程序 + flash-worker preset + 脚手架）：https://github.com/codelogickeep/deepseek-harness-plugin
- 中文架构/踩坑复盘：仓库 `docs/` 下有
  - `LESSONS.md`（钉钉桥接 + 协议对接方法论）
  - `CRON-SCHEDULER-INCIDENT.md`（SessionEvent 白名单事故全复盘）
  - `UI-ENHANCE.md`（client bundle + inject 门禁 + SSE）
  - `PLUGIN-RESILIENCE.md`（fail-loud 原理 + 自检防线）
- 官方：DSH GitHub、`dsh-plugin` topic、DeepSeek Harness Discord

> DSH 在 developer preview，破坏性变更频繁——插件盯紧你用的 API，别追太新的没验证的特性。

---

*如果这篇对你有帮助，欢迎到 GitHub 给仓库点个 Star，或在 Discussions 交流你的 DSH 插件经验。*
