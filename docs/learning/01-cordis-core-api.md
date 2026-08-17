---
title: Cordis 核心编程模型（Context/事件/Fiber/Registry/Service）
description: DSH 本地 docs 精读学习笔记（来源 docs/01-*）——Cordis 核心编程模型（Context/事件/Fiber/Registry/Service）
tags: [cordis, api, core]
date: 2026-08-17
status: learning-note
---
# Cordis 核心编程模型学习笔记（01）

> 来源：DSH 本地文档英文版 `docs/cordis-primer.md`、`docs/cordis-api/{context,events,fiber,inherited,registry,service}.md`。
> 全部内容严格依据上述文档，未加入超出文档的臆测；文档未说明处均已标注「(文档未明说)」。
> 注：context/events/fiber/registry/service 五个文件由 `scripts/gen-cordis-catalog.ts` 从 vendored 源码自动生成，签名后的 JSDoc 即原始源码注释，可信度高。

---

## 1. 核心概念与机制

### 1.1 整体心智模型（Primer 的五个想法）

- **插件是实现了 Service 的对象**：可以是带可选 `inject` 与 `apply(ctx)` 字段的函数，也可以是一个 `Service` 子类，其生命周期被挂载到当前 context。
- **context 是服务的仓库**：一个服务在 context 上认领一个稳定的 `ctx.<key>`（如 `ctx.tools`、`ctx.llm`、`ctx.sessions`）；其他插件通过 key 找到服务，而不是 import 具体实现。
- **用 `inject` 声明服务依赖**：声明了必需服务的插件会等到这些服务存在才加载，因此加载顺序是通过「服务需求」表达出来的，而不是手工编排启动顺序。
- **类型化事件用于通信**：服务通过 TypeScript 声明合并（declaration merging）声明事件名，再以 `emit`/`waterfall`/`parallel`/`serial` 之一分发，分别对应「观察 / 包裹 / 扇出 / 按序执行」。
- **所有注册都是可逆（reversible）副作用**：prompt 段、工具 schema、适配器、provider、监听器都通过 `ctx.effect()` 或 `ctx.on()` 安装，reload 与 teardown 时可预测地回卷。

### 1.2 Context 的结构

context 是 Cordis 的核心对象，API 总入口。它是一个 **proxy**：「普通属性读取走 service resolver」；`extend()`/`isolate()`/`intercept()` 会创建作用域化的**子 context**，而**不改变父 context**。

- `ctx.extend(meta?)`：创建子 context。子 context **原型式继承**当前 context 的每个属性，`meta` 的**自有属性遮蔽**继承来的属性；父 context 不被修改。
- `ctx.isolate(name, label?)`：为指定 `name` 服务创建**独立 service scope**。在该返回的 context 之下，对 `name` 服务的读写都解析到新 label 而非父级，因此可以在不污染父级作用域的情况下提供不同实现。对两次 `isolate()` 传入**相同 `label` 会合并作用域**；label 默认是全新唯一 symbol。
- `ctx.intercept(name, config)`：为「在此 context 之下启动的插件」附加该服务的拦截配置。这些插件解析到的 config 中会**合并**该拦截条目（祖先条目在前，见 `Service[symbols.resolveConfig]`）；父 context 不受影响。
- 环境句柄：`ctx.root`（所有子 context 共享的根，标注 `@experimental`）、`ctx.baseUrl?`、`ctx.events`、`ctx.logger`（`ctx.logger(name)` 得命名 logger）、`ctx.reflect`（支撑 proxy 的反射层）、`ctx.registry`、`ctx.fiber`。
- 混合（mixin）机制：`ctx.events`、`ctx.registry` 的方法被**混合到 ctx 本身**——即 `ctx.on`/`ctx.emit` 转发到 `ctx.events.*`，`ctx.plugin`/`ctx.inject` 转发到 `ctx.registry.*`。另有 `Context.effect`/`filter`/`isolate`/`intercept` 四个静态 symbol key 与诊断/过滤/隔离/拦截相关。
- `Context.is(value)`：跨 realm、跨多份 cordis 实例地判断一个值是否为 context（品牌由 global symbol 标记，而非 `instanceof`）。

### 1.3 服务仓库的底层 API（ctx.get/set/provide/accessor/mixin）

这套 API 属于 `ctx.reflect` 背后的 reflect.ts，均与「当前 fiber」绑定。

- `ctx.get(name, strict?)`：**不要求 inject** 直接从仓库读取服务。`strict` 默认 `true`：只有**提供该服务的 fiber 当前仍 active** 的实现才被返回；尚未提供时返回 `undefined`。
- `ctx.set(name, value)`：覆盖已提供服务实例的值。**只有提供该服务的 fiber 才能 set 它**；对未提供的名字 set 会 throw。
- `ctx.provide(name, value)`：为当前 fiber 注册一个服务实现。只有该 fiber active 后，**同一 isolation scope 内的依赖者**才可见；当返回的 disposer 运行或 fiber unload 时注销（并唤醒等它的依赖者）。名字已被本 scope 提供、或已被声明为 accessor 时 throw。返回注销用 disposer。
- `ctx.accessor(name, options)`：定义由 `get`/`set` hooks 支撑的**计算型 context 属性**；当前 fiber unload 时移除；名字已声明则 throw。
- `ctx.mixin(name, mixins)`：把某服务的选定成员**直接暴露到 ctx 上**——每个被混合的 key 变成一个转发 accessor（方法会绑定到该服务），例如 `ctx.on` 转发到 `ctx.events.on`。也可传来源对象 + source-key→ctx-key 映射。混合项随 fiber unload 移除。

### 1.4 事件系统与分发模式

事件分发 API 混合进每个 context。`DispatchMode` 合法值为 `'emit' | 'parallel' | 'serial' | 'bail' | 'waterfall'`。Primer 给出矩阵：`emit` 不 await、按注册顺序、无返回值；`waterfall` 不 await（语义上为 middle-ware）、按注册顺序、有返回值；`parallel` await、所有 listener 并行、无返回值；`serial` await、按注册顺序、有返回值。

- `ctx.emit(name, ...args)`：**同步**分发，忽略 listener 返回值，不等待。
- `ctx.parallel(name, ...args)`：**并发**运行所有 listener，返回在所有 listener settle 后 resolve 的 Promise。
- `ctx.serial(name, ...args)`：**按序 await** listener 直到其中一个 **bail**；返回第一个 bail 值（非 null、非 false、非 undefined）。
- `ctx.bail(name, ...args)`：**同步**版按序调用直到 bail；返回第一个 bail 值。
- `ctx.waterfall(name, ...args)`：最后一个参数是 `next` continuation，形成 **around 中间件**。listener 收到 `(...args, next)`；调用 `next()` 委托给链中下一个（最内层是 built-in 行为），**不调用 `next()` 即 veto/短路**；值通过 `next()` 的返回值传播。返回最外层 listener 的返回值。
  - 协作型 listener 通常**修改共享的 request/decision 对象**，然后继续委托；也可以**完全替换结果**，下游只看到替换后的结果。
  - `prepend: true` 只在必须跑在普通注册之前时使用。
  - 对**单一决策型事件**，短路就是设计：policy listener 在「自己拥有决策」时直接 return 不调 `next()`；而只做注解/观察的 listener **必须继续委托**。
- `ctx.on(name, listener, options?)` / `ctx.once(...)`：注册**当前 fiber 拥有**的监听器；返回删除该监听器的 disposer（返回 `true` 表示删除时它仍处于注册态）。`once` 首次调用后自移除。`EventOptions = { prepend?: boolean; global?: boolean }`，其中 `global: true` 表示 **无视 context 的 filter 检查**也接收事件；`options` 传布尔等价于 `prepend` 简写。
- **分发模式是事件的公开契约的一部分**：新 harness 事件用 `@mode` 标记记录，使生成的目录能校验「声明与分发点是否匹配」。这是「事件类型 = 协议」的关键设计。

### 1.5 Fiber 生命周期

fiber 是一个**已加载的 plugin 实例**：它的生命周期状态、校验后的 config、注册的 effects。`ctx.fiber` 是当前 fiber，`ctx.effect()` 委托给它。

- `ctx.effect(execute, label?)`：注册 cleanup-aware effect。`execute` **立即运行**；它产出的 disposer 被收集，并在「返回的 disposer 被调用」或「fiber unload」二者**先到者**时按**逆序**统一执行。disposer 调用两次是 no-op。fiber 已释放时 throw `CordisError('INACTIVE_EFFECT')`；`execute` 返回非法形态时 throw `TypeError`。可传 `label` 供 `getEffects()` 诊断显示。
- `Effect` 合法形态：单个 disposer、disposer 的 promise，或（可 async 的）**迭代器产出多个 disposer**——generator effect 每产出一个就注册一个。
- `Disposable`：释放资源的函数；**fiber unload 时按注册逆序运行**，可为 async（unload 会 await 它们）。
- `EffectMeta`：`{ label, children: EffectMeta[] }`，用于把嵌套 effect 标签暴露成诊断树（如 `ctx.on("event")`、`ctx.provide("name")` 作为 label）；`Context.effect` symbol 上挂着这个树。
- fiber 字段：`uid`（registry 内唯一 id，根 fiber 为 0，disposed 后为 `null`）、`ctx`（extends 父 context）、`config`（校验后的配置，由 update 更新）、`state`（生命周期状态，**状态转换 emit `internal/status`**）、`dispose`、`store`（加载期间必需服务实现快照，否则 `undefined`）、`inertia`（进行中的 load/unload 过渡 Promise）、`name`（从最近具名祖先继承，否则 `'root'`）。
- fiber 方法：`assertActive()`（已 dispose 则 throw `INACTIVE_EFFECT`）、`getEffects()`、`await()`（等待当前生命周期工作并重抛启动错误）、`restart()`（dispose 后立即用当前 config 重载）、`update(config, noSave?)`（先校验再应用并重启；**先跑 `internal/update` waterfall**，让 update 钩子与 HMR 可 veto 或替换这次重启）。
- 错误与校验：`CordisError` 带稳定机器可读 code，目前 `Code = { INACTIVE_EFFECT: 'cannot create effect on inactive context' }`；`ValidationError` 在配置未通过 **standard-schema** 校验时抛出，把 schema issues 聚合成消息。

### 1.6 Registry：插件加载与注入

- `ctx.plugin(plugin, ...args)`：在当前 context 加载插件。`plugin` 可为**函数 `(ctx, config) => any`**、**类 `new (ctx, config)`** 或 **`{ apply(ctx, config) }` 对象**三种形态；`args` 按该插件的 `Config`（StandardSchemaV1）schema **校验后**传入。返回 fiber（PromiseLike），await 它直到加载完成，config 或启动出错则 reject。
- `ctx.inject(deps, callback)`：`ctx.plugin({ inject, apply: callback })` 的简写。callback 任一必需服务变化时会被 **unload 并重跑**。`deps` 是数组（不带拦截配置）或「name → 拦截配置」的对象；`Inject.resolve()` 把数组/对象/类继承的 inject 元数据归一化为一个普通 map。
- `Plugin.Base` 元数据字段：`name?`（诊断名）、`Config?`（校验器）、`inject?`、`provide?: string | string[]`（该插件提供的服务名，供 `Service` 与 loader 读取）、`intercept?: Dict<boolean>`（声明消费哪些服务的拦截配置）。另有 `Plugin.Transform { schema?: true; Config(config): T }` 用于用户面配置 → 运行时配置。
- `Plugin.Runtime`：同一个 plugin callback 的所有 fiber **共享**的 registry 记录——`name`、`fibers`（每个 `ctx.plugin()` 调用一个活的 fiber）、`callback`（registry 的**身份键**）、`Config`。

### 1.7 Service 基类

`Service` 是 context 服务的基类。**作为插件被加载的 Service 子类把自己注册为 `ctx.<name>`**。子类在构造器里调 `super(ctx, name)`，服务**立即注册**，并**随 owning fiber 自动移除**。实例有 `service.name`。类装载相关 symbol：`Service.init`（class plugin 构造后运行的实例方法键）、`Service.check`（传给 `ctx.provide()` 的可用性谓词键）、`Service.config`（幻影拦截配置类型参数键）、`Service.invoke`（让服务可调用——如 `ctx.logger()`）、`Service.extend`（派生扩展服务实例的助手）、`Service.tracker`（context 追踪元数据）、`Service.resolveConfig`（拦截配置解析助手，被 `ctx.intercept` 引用）。

### 1.8 继承的 ctx 成员与事件（inherited.md, cordis core + loader/hmr/timer）

- 定时/工具：`ctx.timer（+ interval / timeout / throttle / debounce）`——disposable 定时器助手；`timer` 键运行时提供，四个助手直接混合到 ctx。
- `ctx.loader`（config Loader）、`ctx.hmr`（HMR 监听器）。
- 内部事件目录（见第 5 节列表）：`internal/plugin`、`internal/status`、`internal/service`（拦截钩子）、`internal/update`（waterfall）、`internal/get`（waterfall）、`internal/set`（waterfall）、`internal/listener`、`internal/dispatch`；loader/hmr 侧 `hmr/change`、`hmr/reload`、`exit`、`loader/config-update`、`loader/entry-init`、`loader/partial-dispose`、`loader/patch-context`。

---

## 2. 关键设计决策与原因

1. **context 是 proxy，子 context 不写父 context**。普通属性读取统一走 service resolver，`extend/isolate/intercept` 生成新的作用域链。这样隔离、拦截、元数据叠加都不污染原有结构，保证应用的可观测性与可预测性。`Context.is()` 用 global symbol 而非 `instanceof` 做品牌判断，是为了兼容多份 cordis 副本与跨 realm。
2. **加载顺序由依赖声明表达，而非手工编排**。插件声明 `inject`，registry 等全部必需服务可用后才激活该 fiber；某服务变化时 `ctx.inject` 的 callback「卸载并重跑」。这让依赖图驱动生命周期，天然支持 HMR 与动态增删。
3. **分发模式成为事件的公开契约**。`emit/parallel/serial/bail/waterfall` 是五种不通用的语义；harness 用 `@mode` 让生成目录可交叉校验「声明 vs 使用」，把类型错误前移到编译期。业务上「观察 vs 包裹 vs 扇出 vs 按序决策」被强制挑选其一。
4. **waterfall 即 around 中间件**：`next()` 驱动值传递与短路，设计上明确区分「拥有决策的 policy listener（不调 next）」与「只注解的 listener（必须委托）」;这是 Cordis 实现 AOP/策略钩子的首选机制。
5. **一切注册都是可逆副作用，生命周期归 fiber**。`ctx.on/provide/accessor/mixin`、effect 内的 disposer、`ctx.timer` 系列全部「随 fiber unload 自动清理」；effect 的 disposer **按注册逆序**运行并可 async（unload 会 await）。目的是让 reload、restart、update、teardown 都**可预测地回卷**，避免泄漏与悬挂监听。
6. **update 前跑 `internal/update` waterfall**，让 HMR 与持久化钩子能 veto 或替换「校验→重启」的默认路径；`noSave` 用于指示持久化钩子不回写磁盘。这使配置热更新的语义可由钩子扩展而非硬编码。
7. **错误稳定可机器判读**：框架错误统一用 `CordisError.code`（如 `INACTIVE_EFFECT`），配置错误用 `ValidationError`，便于上层逻辑识别与自动化处理。
8. **基础能力以 symbol 扩展**：`ctx.get/provide/accessor/mixin` 走 reflect 层、`Service` 各阶段用 symbol（init/check/config/invoke/extend/tracker/resolveConfig），即在不把业务逻辑塞进 prototype 的前提下开放框架内部扩展点。

---

## 3. 对「钉钉桥接器 + 自研定时任务插件」的可复用结论/代码模式

> 以下为从上述文档机制推导出的可复用模式，与文档一致；项目具体需求不在本文档范围内，故不编造细节。

1. **配置-校验-可逆的插件骨架**：插件函数挂 `name`、`config`/`Config`（standard-schema 校验器）、`inject`、`provide` 元数据；`apply(ctx, config)` 主体内所有副作用（监听器、定时器、服务提供）都收敛进 `ctx.effect(() => { ... return () => { /* 逆序清理 */ } })`，并把 related teardown 放同一个 effect 以保证回卷顺序。
2. **定时任务的计时器一律用 `ctx.timer` 系列**：`interval/timeout/throttle/debounce` 都是「disposable 定时助手」，挂在 fiber 生命线上。这样无论插件 reload、restart、update 还是临时 stop，计时器都被自动回收，杜绝「重复跑/僵尸定时器」——这正是自研定时任务插件最需要的可逆性。每次调度可再用 `ctx.effect` 包裹，使任务注册本身也可逆。
3. **桥接器/任务核心分 scope**：若想让「钉钉适配器实现」只在某个子插件内可见而不污染全局，用 `ctx.isolate(name)` 派生 scope；同一 `label` 的两次 `isolate()` 可把两个插件合并进同一 scope。跨 scope 通信则走事件。
4. **事件即协议，先定 DispatchMode**：为任务相关协议（如「任务执行前审批」）定义事件并选好分发模式——单决策用 `serial`/`bail`（首个 veto 即停），并发上报用 `parallel`，需要链式改写/策略注入用 `waterfall`，纯通知用 `emit`。声明合并（declaration merging）定义 `Events` 接口中的签名，并在 dispatch 处保持模式一致（内置 `@mode` 语义）。
5. **用 waterfall 做策略钩子**：例如「发送钉钉消息」定义成 waterfall 事件，真正发送放最内层 built-in；审批/限流/脱敏/重试插件作为 listener，通过「不调 `next()` 短路」或「修改共享对象后委托」来注入策略，互不感知。
6. **服务可见性靠 provide/inject**：桥接器输出服务（如 `ctx.dingTalk`）时用 `provide` 声明、`ctx.provide(name, value)` 注册，产出 disposer；任务插件用 `inject: ['dingTalk', ...]` 声明硬依赖，让 Cordis 保证「服务可用才激活」的加载排序，并通过 `await fiber` 拿到稳定结果。
7. **内部事件用于调试/监控**：`internal/plugin`、`internal/status`（状态转换）、`internal/listener`、`internal/dispatch` 可用于排查「某插件为何没加载」「某监听为何没触发」；`fiber.getEffects()`/`EffectMeta` 标签可盘点某纤维当前挂着哪些 effect。

---

## 4. 不确定处标注（文档未明说）

- (文档未明说) `ctx.effect` 返回的 disposer 在「手动调用」与「fiber unload」二选一语义下，其返回的 `Promise<void>` settle 的具体时序细节（哪些清理是同步哪些是 async）。
- (文档未明说) `EventOptions.global` 之外，`Context.filter` 符号对应的 listener filter 如何在每次分发时被「consulted」（何时命中、如何注册 filter）——events.md 只给出 `global` 选项，未展开 filter 的注册/匹配细节。
- (文档未明说) `serial` 与 `bail` 对「同步 vs async listener」的边界行为差异，除「serial 会 await、bail 是同步」之外的异常传播（是否中断链）。
- (文档未明说) `ctx.events`/`ctx.registry` 混合到 ctx 的触发时机与生命周期（fiber 卸载时混合项是否/如何移除，文档只明确 reflect 层 `mixin` 随 fiber unload 移除）。
- (文档未明说) `ctx.isolate(name)` 与 `Service` 子类、`ctx.intercept` 三者组合时的作用域优先级细节（文档仅提到 isolate 独立 scope、intercept 祖先优先）。
- (文档未明说) `Service.check`（availability predicate）在实际 `ctx.provide` 中被调用的时机；`Service.tracker` 的具体用途样例。
- (文档未明说) `ctx.timer` 各助手的具体签名参数；`hmr/change`/`hmr/reload` 触发的精确条件。
- (文档未明说) serpent/`loader/*` 各事件的载荷字段。

---

## 5. 相关联术语 / 事件名列表

**术语与类型**：Context、proxy、child context、service resolver、service scope、isolate label、intercept config、fiber、Effect、SyncEffect/AsyncEffect/EffectMeta、Disposable/disposer、`Plugin.Function/Constructor/Object/Base/Transform/Runtime`、`Inject` / `Inject.resolve`、`Service.name`、deceleration merging（声明合并）、reversible effect、waterfall（around 中间件）、short-circuit / bail、prepend / global filter、`CordisError`（`Code.INACTIVE_EFFECT`）、`ValidationError`、standard-schema、`DispatchMode`。

**事件**：`internal/plugin`、`internal/status`、`internal/service`、`internal/update`（waterfall）、`internal/get`（waterfall）、`internal/set`（waterfall）、`internal/listener`、`internal/dispatch`；`hmr/change`、`hmr/reload`；`exit`；`loader/config-update`、`loader/entry-init`、`loader/partial-dispose`、`loader/patch-context`。

**Symbol 键**：`Context.effect`、`Context.filter`、`Context.isolate`、`Context.intercept`、`Service.init`、`Service.check`、`Service.config`、`Service.invoke`、`Service.extend`、`Service.tracker`、`Service.resolveConfig`。
