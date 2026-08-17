---
title: Cordis 实战教程七章节要点
description: DSH 本地 docs 精读学习笔记（来源 docs/02-*）——Cordis 实战教程七章节要点
tags: [cordis, tutorial, practice]
date: 2026-08-17
status: learning-note
---
# 学习笔记 02：Cordis 教程（从零写插件的完整实战）

> 来源：`deepseek-harness/docs/cordis-tutorial/` 目录英文版 8 个文件（index + 01~07）。
> 主题：第一个插件、生命周期与 effect、服务与 inject、事件与 waterfall、配置校验 Schema、组合与 HMR、接入真实 harness。

---

## 1. 核心概念与机制

### 1.1 插件形态与装载（01-first-plugin）
- **插件本质**：在 Loader 配置里，一个插件模块**具名导出 `apply` 函数**。Cordis 装载时以 **context（`ctx`）** 调用 `apply`，插件通过这个 `ctx` 注册自己贡献的一切能力。
- 插件有三种形态：
  1. **函数插件**：`export function apply(ctx: Context) {}`（最常用）。
  2. **对象插件**：`{ name, apply(ctx) {} }`（只有对象形态必须有 `apply` 方法；函数形态 Cordis 直接调用函数本身，名字仅供诊断用）。
  3. **类插件**：`class MyService extends Service { constructor(ctx){ super(ctx, 'myTutorialService') } }`（第 3 章 Service 就是这条路径）。
- `export const name` 是**可选的显示元数据**，只用于诊断标签。
- **组合方式**：`cordis.yml` 是一个**插件条目列表**：`- name: './hello.ts'`。`name` 是模块说明符（相对路径或 npm 包名），Loader 装载每条。**条目并发启动**，列表位置不保证加载顺序；顺序由服务依赖（`inject`）决定，而非文件顺序。
- 启动器：`node --import tsx ../../vendor/cordis/bin.js` —— 它创建根 `Context`、挂载 **Loader** 插件、让 Loader 读取当前目录 `./cordis.yml`。`--import tsx` 让 Node 免构建直接跑 TS。
- **失败语义**：`apply` 抛错 → 进程直接死亡（loud failure，不是跳过）；但模块**无法解析**（路径/包名拼写错）只通过 logger 报告，引导期可能被丢失，表现为"条目像没生效"。

### 1.2 生命周期与 effect（02-lifecycle-and-effects）
- 插件可被卸载：配置编辑、热重载、显式 dispose、或**必需服务消失**。
- **Effect 机制**：凡通过 Cordis API 注册的东西都是 effect，归其插件所有，插件卸载时自动撤销。Cordis **不管理**的资源（定时器、连接、watcher）必须包进 `ctx.effect(() => { ...; return disposer })`：
  - effect 函数体在**加载时**执行，返回的 disposer 在**卸载时**执行；插件生命周期资源绝不自己去调 disposer。
  - `ctx.plugin(heartbeat)` 从**代码**挂载函数作为插件（与 YAML 装载同一操作），返回 **fiber**（一个已装载插件实例的运行时句柄）。
  - `fiber.dispose()` 在所有清理（含异步 disposer）完成后 resolve，并**递归卸载**其挂载的子插件。
- **Fiber 状态机**：`PENDING → LOADING → ACTIVE → UNLOADING → DISPOSED`，另有分支 `↘ FAILED`。
  - PENDING：已声明但所需服务不可用；LOADING/ACTIVE：`apply` 运行中/已完成；FAILED：`apply` 或配置校验抛错；UNLOADING/DISPOSED：disposer 运行中/全部拆除。
- **哪些已是 effect**：`ctx.on(event, listener)`（卸载即移除监听，**永远不需要手动 removeListener**）；`ctx.plugin(child)`（子随父销毁）；Service 注册；harness 注册表如 `ctx.tools.register(...)` 把返回的 disposer 挂到调用插件，自动回退。
- **顺序注意**：disposers 按注册逆序启动，但**多个异步 disposer 并发执行**；如需串行拆解，就都放进同一个 disposer 里 await。

### 1.3 服务与 inject（03-services）
- **Service** 是插件的具名能力，另一插件经 `ctx` 消费。harness 中 `ctx.tools`、`ctx.llm`、`ctx.agents` 都是服务。**消费者按能力名（如 `'tools'`）而不是按提供者导入**，所以配置可选提供者而不动消费者。
- **提供服务**：`class GreeterService extends Service { constructor(ctx){ super(ctx, 'greeter') } }`，然后 `ctx.plugin(GreeterService)` 挂载（Service 子类本身是类形态插件）。运行时注册是 effect，卸载提供者即移除服务。
- **编译期类型**：`declare module '@deepseek-ai/cordis' { interface Context { greeter: GreeterService } }` 是**声明合并**，只加类型、不生成代码；缺了运行时照样工作，只是消费者失去类型安全。
- **消费**：`export const inject = ['greeter']`。Cordis 让插件停在 **PENDING** 直到每个列出服务都存在，因此在 `apply` 内 `ctx.greeter` **保证就绪**。
- **依赖在加载后也跟踪**：`inject` 不是一次性启动检查——必需服务在运行期消失（提供者被卸载/热替换），会**连带卸载所有依赖它的插件**，服务回来后**再次加载**。这也解释了配置里替换服务提供商（卸载 `dsh-bash-local`、挂另一个 `shell` provider）时，所有 `inject: ['shell']` 的插件会干净地对着新实现重启。
- **可选依赖**：跳过 `inject`，在使用处试探：`const greeter = ctx.get('greeter'); greeter?.greet('maybe') ?? 'no greeter available'`（未加载提供者时返回 undefined，插件照常运行）。
- **命名**：服务名是**应用级扁平命名空间**，要为自研服务加独特前缀/命名空间（harness 占用了 `tools`、`llm` 这样的裸名）。

### 1.4 事件与 dispatch 模式（04-events）
- **事件**让插件发布"某事发生"而无需知道谁在听；harness 用它处理工具结果、模型请求、审批决定等交互。
- 事件名通过 `interface Events { 'stats/report'(name: string, count: number): void }` 声明合并；`namespace/action` 命名约定保持扁平事件命名空间可读。声明文件里 `import type {} from './stats.ts'` 只为让 TS 看到合并。
- **五种 dispatch 模式**（事件用哪种是**契约一部分**）：
  | 模式 | 调用 | 语义 |
  |---|---|---|
  | emit | `ctx.emit(name, ...args)` | 同步广播，返回值/Promise 不等待不收集 |
  | parallel | `await ctx.parallel(...)` | 所有监听器并发，一起 await |
  | serial | `await ctx.serial(...)` | 按序执行并可 await，首个非 null/false/undefined 返回值胜出并停止后续 |
  | bail | `ctx.bail(...)` | serial 的同步版 |
  | waterfall | `ctx.waterfall(name, ...args, next)` | 环绕式中间件，见下 |
- **Waterfall（变换或短路）**：每个监听器收参外加 `next()` 续延；可**变换 `next()` 的返回值**，或**不调用 `next()` 直接返回**以短路整条链——即 Cordis 文档所称的 **veto（否决）**。示例中监听器 1 包装下游结果（大写），监听器 2 在输入含 `blocked` 时短路；`ctx.waterfall('demo/transform', input, async () => default)` 的最内层默认永不触发。
- **纪律**：只观察/注释的 waterfall 监听器**必须调用 `next()`**；忘记调用 = 故意短路，会静默吞掉下游所有人的默认行为。这是本仓库的固定规则。
- harness 用 waterfall 承载可被合作插件包装或应答的决策：`agent/request`（替换模型调用配置）、`approval/request`（策略代答用户）。

### 1.5 配置校验 Schema（05-config）
- `cordis.yml` 条目可带 `config` 块，插件声明 schema 在 `apply` 运行前校验。**坏配置以精确错误失败，插件绝不半配置启动**。
- 模式：导出同名 `interface Config` 与运行时 `export const Config: Schema<Config> = Schema.object({ ... })` —— 消费者得类型、Cordis 得校验器。本仓库用 **Schemastery**；Cordis 接受任何 [Standard Schema](https://standardschema.dev/) 校验器，所以**普通对象不能当 Config**。
- Schema 默认值生效：漏掉的字段由默认补全，`apply` 永远收到**完整且校验过的配置**。校验失败抛 `ValidationError: invalid config: ...`，fiber 进 FAILED。
- **额外原则**：schema 合法但引用不存在资源/提供者的配置，插件应尽早拒绝。
- **计算配置**：本仓库 Loader 支持 `!!js` 标签做装载期计算，`greeting: !!js process.env.DEMO_GREETING ?? 'Hello'`。`!!js` 仅在 `config` 内和条目的 `disabled` 字段有效；`disabled: !!js ...` 每次装载决策时求值（本仓库扩展），可让某行按平台/环境自我门控。

### 1.6 组合与 HMR（06-composition-and-hmr）
- 条目元数据：`id`（稳定身份，让 Loader 区分"编辑现有条目"与"删了加一个"）、`disabled: true`（保留条目但跳过挂载，翻回来即重新加载它及所有 PENDING 在它服务上的插件）。
- `groups` 可嵌套一组同载同卸的条目；**`isolate`** 给组一个服务名的独立实例——两个组可各见一个配置不同的 `shell` provider 互不影响。
- **HMR**：因为卸载释放 effect、加载跟随依赖，HMR 能"卸载+加载"替换运行中插件。`@deepseek-ai/cordis-plugin-hmr` 监视文件，保存即重载。两个支持插件：logger console 导出器（否则看不到 HMR 消息）、`cordis-plugin-timer`（HMR `inject` 它来防抖，缺了它 HMR 永远 PENDING 而静默）。
- **条目必须有 `id`**：没有 id 的条目每次读取都会生成 id，于是任何配置编辑都被当成"删除+新增"而整条重挂载，即使它自己没变。
- **诊断"永不加载"**：`inject` 命名了没人提供的服务 → 永远 PENDING、什么都不打印、**不报错**（合法状态，提供者可能稍后挂载）。PENDING fiber 也不维持 Node 事件循环，空跑组合会静默 exit 0。诊断法：枚举 `ctx.registry.values()`，对每个 runtime 的 `fiber.state === FiberState.PENDING` 报告"缺必需服务"。

### 1.7 接入真实 harness（07-into-the-harness）
- **注册模型可调用工具**：`inject: ['tools']` + `ctx.tools.register(defineTool({ name, description, parameters, output: { schema, render }, async execute(args) {} }))`。
- `defineTool` 把 `parameters` 规范转成展示给模型的 JSON Schema、推断 `args` 类型、并在 `execute` 前校验模型提供的参数。`output.schema` 声明规范返回值的**canonical value**；`output.render` 另行产出 Native 与持久化的结果内容（如 `[{ type: 'text', text: value }]`）。
- **手工执行管线**：`ctx.tools.execute({ callId: CallId('demo-1'), name, arguments, signal: new AbortController().signal })`（stand-in 模型；CallId 打上提供者会发的关联 id）。
- **观察者插件**：另一插件经 **`tools/result`** 事件看每次工具调用：`ctx.on('tools/result', (exec, result) => ...)`。该事件在结果物化时发出，**早于 `execute` 的 Promise 对调用方 resolve**。两插件彼此不知道对方存在——注册表服务 + 事件把它们连起来。
- **组合里的隐式依赖**：`dsh-tools` inject `systemPrompt` 服务（工具向系统提示贡献 schema），所以列表里要有 `dsh-system-prompt`；没有它 tools 插件停 PENDING。
- 完整 agent = 这套组合 + LLM adapter + agent 循环 + 持久化 + 入口（对照 `examples/headless-agent/cordis.yml`）。

---

## 2. 关键设计决策与原因

1. **插件即函数 + 配置即组合**：插件只描述"贡献什么"，`cordis.yml` 决定"应用是什么"。没有框架引导代码，条目的加载/卸载完全交给 Loader 与依赖图。
2. **一切可卸载的注册都做成 effect**：卸载、热重载、依赖消失三条路径统一走同一套撤销逻辑，杜绝泄漏与"持有失效引用"。
3. **依赖驱动启动顺序而非文件顺序**：并发启动 + `inject` gating，使提供者替换/热重载成为可能——这是 HMR 与服务替换的前提。
4. **服务按名字消费、不按实现导入**：配置可以换实现而不动消费者（消费者只认 `'tools'`），这是三层可替换能力设计的基础。
5. **waterfall 把"拦截"做进事件契约**：联合插件既能装饰也能否决（veto），把模型调用/审批这类"多方可应答"的决策变成可组合管线；代价是观测者必须记得 `next()`。
6. **配置在 apply 前强校验 + 失败要 loud**：半配置启动是错误；PENDING 是合法态但不该静默误导——于是提供诊断工具与"检查拼写/检查注入名"的排障路径。
7. **`!!js` 仅限 config 与 disabled**：把"装载期计算"限制在数据装载兴趣点，其余元数据保持静态、可 diff。

---

## 3. 对「钉钉桥接器 + 自研定时任务插件」项目可复用的结论/代码模式

1. **服务提供范式**：定时任务调度器应做成 `class SchedulerService extends Service { constructor(ctx){ super(ctx, 'dingtalkScheduler') } }` + `ctx.plugin(SchedulerService)`；钉钉能力做成 `class DingtalkService extends Service { super(ctx, 'dingtalk') }`。消费者一律 `inject: ['dingtalk', 'dingtalkScheduler']`，实现可日后替换（如真 HTTP vs mock）。
2. **声明合并模板**：`declare module '@deepseek-ai/cordis' { interface Context { dingtalk: DingtalkService } interface Events { 'dingtalk/message'(...): void } }` —— 一门一影子（Context）加事件签名双合并；桥接器侧再加 `import type {} from './dingtalk.ts'` 让 TS 看见合并。
3. **定时器必须 `ctx.effect()`**：setInterval/setTimeout 是非管理资源，包进 `ctx.effect(() => { const t = setInterval(...); return () => clearInterval(t) })`，disposer 逆序但异步并发；串行拆解就合并进一个 disposer await。`ctx.on`、`ctx.tools.register`、`ctx.plugin` 已是 effect，勿重复包装。
4. **事件接线（钉钉→定时任务、反之）**：钉钉消息到达经 `ctx.emit('dingtalk/message', ...)` 广播；定时任务可设计为 `waterfall` 模式（如 `'scheduler/next'`）供插件装饰/否决，注意观测监听器必须 `next()` 否则吞掉默认行为。
5. **配置校验**：`export interface Config { ... }` + `export const Config: Schema<Config> = Schema.object({ ...default })`，用 Schemastery；`apply(ctx, config)` 收到完整校验过的配置；hook 名称/钉钉关键字等用 `.default()` 兜底。配置里可用 `!!js process.env.DINGTALK_WEBHOOK ?? '...'` 做装载期取值。
6. **组合与 gating**：`cordis.yml` 条目务必写显式 `id`（否则每次编辑都会重挂载）；`disabled: !!js <平台/环境判断>` 让钉钉桥在指定平台才启用；若桥接与任务分组隔离（两组各见不同配置），用 `groups` + `isolate`。
7. **接入 harness 工具**：把"手动触发某定时任务/发钉钉消息"暴露为 `ctx.tools.register(defineTool({...}))`，`output.render` 产出 `[{ type:'text', ... }]`；另一插件经 `ctx.on('tools/result', ...)` 做全局审计，不侵入执行者。
8. **排障模板**：`inject` 名拼错 = 永远 PENDING = 什么也不打印；复制第 6 章的 `ctx.registry` + `FiberState.PENDING` 循环做启动诊断日志。

---

## 4. 不确定处（文档未明说）

- `isolate` 与 `groups` 的逐字段语法、以及 `isolate` 命名空间在 YAML 里的确切写法，教程只给了概念，未给可运行的 `cordis.yml` 完整示例（指向 primer 与 service isolation 示例页）。
- `ctx.tools.execute` 的 `signal` 与 `CallId` 之外还应传哪些必填/可选字段、`callId` 必须唯一还是可复用，教程未枚举 execute 的完整入参 schema。
- `tools/result` 事件的**完整载荷字段**（除 `exec` 与 `result` 外是否还有别的参数）以及它与 `tools/before-call` 等其它事件的关系，教程未展开。
- `apply` 的 Promise 返回（async plugin）是否被 Cordis await、失败如何归类，教程未明说。
- `ctx.registry` 的类型/API（Cross 之外的 key 结构、`runtime.fibers` 之外还有哪些字段）只给出最小遍历示例。

---

## 5. 相关联术语/事件名列表

- **机制术语**：Context、Loader、fiber、FiberState（PENDING / LOADING / ACTIVE / UNLOADING / DISPOSED / FAILED）、effect、disposer、inject、`ctx.get()`、Service（extends Service / `super(ctx, name)`）、声明合并（`interface Context` / `interface Events`）、Standard Schema、Schemastery、`Schema<Config>`、HMR、`isolate`、groups、veto、canonical value。
- **事件名**：`stats/report`（demos）、`demo/transform`（waterfall demo）、`tools/result`（harness）、`agent/request`（waterfall）、`approval/request`（waterfall）。
- **服务名**：`greeter`、`stats`、`tools`、`llm`、`agents`、`shell`、`timer`、`systemPrompt`。
- **包/模块**：`@deepseek-ai/cordis`、`@deepseek-ai/schemastery`（Schemastery）、`@deepseek-ai/cordis-plugin-hmr`、`@deepseek-ai/cordis-plugin-timer`、`@deepseek-ai/cordis-plugin-logger-console`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-llm`（`CallId`）、`@deepseek-ai/dsh-system-prompt`、`vendor/cordis/bin.js`（launcher）。
