---
title: 第三方插件搞崩 DSH 的容错研究：结论 + 防线
description: 研究 DSH 对第三方插件崩溃的容错机制（cordis:group isolate、fail-loud 设计），结论是配置层无法隔离崩溃，落地「部署前自检」防线。
tags: [dsh, plugins, resilience, fail-safe, group, isolate]
date: 2026-08-20
status: active
---
# 第三方插件搞崩 DSH：能隔离吗？防线怎么建？

> 背景：`browser-reader` 插件一次 schema 写错导致 `dsh web` 直接启动崩溃。
> 问题：第三方插件能把 DSH 启动/服务搞崩，是不是 DSH 机制不健全？有没有方案解决？

---

## 一、结论先行

| 问题 | 答案 |
| --- | --- |
| DSH 这是不是缺陷？ | **不是**，是刻意的 **fail-loud（启动期响亮失败）** 设计 |
| `cordis:group` + `isolate` 能隔离崩溃吗？ | **不能**。它只隔离「服务实例」，不隔离「插件加载失败」 |
| 进程级插件隔离（插件跑在子进程）？ | DSH 暂无产品级方案（Code Mode worker、e2b 是另一条线） |
| **当前最务实防线** | **部署前「加载期自检」门槛**（已落地 `scripts/check-plugin.mjs`） |

---

## 二、为什么 DSH 故意 fail-loud（源码证据）

`@deepseek-ai/dsh-app-boot` 的 `boot()` 流程：加载 include 树 → `assertEntriesLoaded` → `assertEntriesActivated`：

> `assertEntriesLoaded` turns an enabled fiber-less entry into a rejection naming
> every unresolved plugin, and `assertEntriesActivated` awaits each failed fiber to
> include its original stack in the startup rejection.

Loader 的 `EntryTree.await()`（`cordis-plugin-loader` lib）**递归遍历所有 entry（含嵌套 group/子树）**，任何 entry 失败都会 throw：

```js
async await() {
  ...
  const failures = (await Promise.allSettled([...this.entries()].map(entry => entry._await())))
    .filter(o => o.status === "rejected").map(o => o.reason);
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "loader fibers failed");
  ...
}
```

**设计哲学**：DSH 是「一切皆插件」组合体，一个工具插件挂了若静默继续，Agent 会在运行时以残缺能力出诡异错误；官方认为**启动时响亮失败**（把原始堆栈抛给用户，修完重启）远优于运行时悄悄残废。所以「插件把启动搞崩」是**特性而非 bug**——代价是第三方插件质量参差时体验差。

---

## 三、`cordis:group` / `isolate` 到底隔离什么（源码 + 实验）

### 源码层面
`cordis-plugin-loader` 的 `isolate()`：通过 **Symbol realm**（`symbol#entryId` / `symbol@label`）给不同 entry 提供**同名服务的独立实现实例**。用途是「让两个 group 的同一个服务用不同配置」（如组 A shell timeout 5s、组 B 60s），
**不是错误隔离**。

### 实验验证（2026-08-20，本仓库 scripts/ 之外 /tmp 做的 real boot 测试）
构造一个 `apply()` 直接 `throw new Error('boom')` 的坏插件，放进 `cordis:group`，跑真实 `boot()`：

```
❌ boot() 失败：
probe: plugin tree failed to load: ... failed to apply loader entry bad2 (...): boom from bad plugin
```

**结论实锤**：组内坏插件依然让 boot() 崩溃。GROUP 容器有 `Promise.allSettled` + 回滚逻辑，但那管的是**组内多任务部分失败时的树回滚**，最终 `assertEntriesActivated` 仍会把失败抛出去。

---

## 四、已落地的防线：部署前「加载期自检」

### check-plugin.mjs（核心）
脚本用 stub ctx 真实执行插件 `apply()`，并用 **DSH 真实的 `assertSupportedJsonSchema`**（从 `~/.dsh/profiles` 解析 `@deepseek-ai/dsh-tools`）校验每个注册工具的 `output.schema`。

```bash
node scripts/check-plugin.mjs plugins/browser-reader/browser-reader.mjs
# ✅ 通过 → 可以安全重启 DSH
# ❌ 失败 → 打印与真实 DSH 完全一致的错误栈（重启前必须修）
```

**为什么必须用它**：`dsh --dump-config` 只验证配置树、**不执行 apply()**，schema 错误验不出来
（本次事故就是 dump-config 通过但启动崩溃）。

### install-plugins.mjs（安装门）
安装每个插件前**先对仓库源码跑自检**；失败则**跳过安装并报错**（不写入宿主、不引用 patch），
杜绝「装上了一个会让 DSH 起不来」的插件。三个现存插件（browser-reader / cron-scheduler /
minimax-search）均已在自检门后通过。

### stub ctx 覆盖面（避免误伤合法插件）
check-plugin 的 stub 覆盖常见注入服务：`tools`(真校验) / `web` / `fs` / `agents` / `llm` /
`scheduler` / `logger` / `command` / `settings` / `jobs`。**minimax-search 依赖 `ctx.web`，
第一版 stub 没覆盖被误报，已修复**——经验：stub 必须覆盖插件 `inject` 声明里的服务。

---

## 五、如果未来要真正的进程级容错

- DSH 官方方向：`dsh-code-runtime-worker-thread`（Code Mode worker）、`subprocess-e2b`
  （远程执行世界）——它们把**执行**放进隔离进程，但**工具插件本身**仍同进程加载。
- 社区方向：EAC 桌面版做「装前快照 + 启动失败自动回滚快照 + 事故留痕」，是**运维层兜底**，
  不是进程隔离。
- 若要进正规程隔离：需要 DSH 支持「插件宿主进程 + IPC」，是框架级改造（非插件层能解决），
  成本高、当前不建议。

**务实结论**：在官方提供进程级隔离前，「部署前自检 + 装前门禁 + patch 引用纪律」是性价比
最高的防线；三者已在本仓库落地（`scripts/check-plugin.mjs` + `scripts/install-plugins.mjs` +
LESSONS.md 3.4 的 patch 铁律）。

---

## 六、给「以后装第三方插件」的纪律

1. **第三方插件必须先过 `node scripts/check-plugin.mjs <插件入口>`** 再写进 patch。
2. **一次只加一个**第三方插件并重启验证，避免多插件同时引入无法定位。
3. 插件行写在 patch 最后（insert 列表尾部），出问题可一行 `disabled: true` 快速摘除。
4. 保存一个「最后良好快照」：出事后把 patch 回滚到快照即可恢复。
5. 充分利用 DSH HMR：先 `--dump-config` 确认 patch 解析对，再重启；重启后立即
   `curl http://127.0.0.1:3080/` + `session.list` 双探针。
