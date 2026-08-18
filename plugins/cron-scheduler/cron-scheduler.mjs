/**
 * cron-scheduler.mjs — DSH 宿主插件：自研 cron 定时任务调度器
 *
 * 把「人类可读的配置文件」+「标准 5 字段 cron」带到 DSH 本体，到点唤醒
 * 目标 Agent 会话处理提醒（Agent 的回复经桥接器推送到钉钉）。
 *
 * 配置文件（默认 `~/.dsh/cron-schedules.json`，可用 config.schedulesPath 覆盖）：
 * {
 *   "timezone": "Asia/Shanghai",
 *   "schedules": [
 *     {
 *       "id": "jira-daily",
 *       "cron": "0 10 * * *",
 *       "timezone": "Asia/Shanghai",
 *       "session": "session-xxx",         // 可选：目标会话
 *       "message": "查看 JIRA 支持网缺陷",  // 必填：提醒正文
 *       "title": "每日 JIRA 巡检",          // 可选：钉钉标题
 *       "enabled": true
 *     }
 *   ]
 * }
 *
 * 触发语义（复用同目录 scheduler.js）：
 *  每 30s tick 检测「自上次触发以来有 cron 命中」的任务；多个命中点合并成一次
 *  触发；触发后把 lastFiredAt 回写配置（跨重启不重复触发）。
 *
 * 依赖：ctx.fs(读配置)、ctx.agents(投递)、
 *      创建 user message 用 @deepseek-ai/dsh-llm 的 createUserMessage（官方推荐）。
 *
 * 核心算法单一事实源：与本入口同目录的 cron.js / scheduler.js（整目录自包含搬迁/部署）；
 *  loadCore 默认用 NEW URL('.', import.meta.url) 定位，可用 config.coreDir 覆盖。
 */

import { resolve } from 'node:path'

// createUserMessage 仅在 DSH 宿主环境（node_modules 含 @deepseek-ai/dsh-llm）可用；
// 测试环境解析不到时走自构造 fallback（作用等价：生成带 role/source 的 user 消息与 id）。
let createUserMessage = undefined
try {
  const mod = await import('@deepseek-ai/dsh-llm')
  createUserMessage = mod.createUserMessage
} catch {
  createUserMessage = (input) => ({
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    role: 'user',
    content: input.content,
    source: input.source,
  })
}

export const name = 'cron-scheduler'
export const inject = ['fs', 'agents']

/** tick 间隔：30 秒（cron 分钟精度 + 30s 容差足够） */
const TICK_MS = 30_000
/** 首次启动回看窗口（防历史轰炸）：120s */
const LOOKBACK_MS = 120_000
/** 告警节流窗口：60s */
const WARN_COOLDOWN_MS = 60_000

/**
 * 核心模块目录：
 *  - 默认 = 插件自身所在目录（cron.js/scheduler.js 与入口同目录，整目录搬迁/部署）
 *  - 可用 config.coreDir 覆盖（测试或宿主部署时指向其他位置）
 */
const DEFAULT_CORE_DIR = new URL('.', import.meta.url).pathname

/** lastFiredAt 状态回退文件（相对 coreDir 的两级上级的 config/）：
 *  主配置 `~/.dsh/cron-schedules.json` 常在 DSH 沙箱 workspace 之外，
 *  workspace-write 模式下写不进（FS_SANDBOX_DENIED），导致 lastFired 无法回写、
 *  每次 tick 都把同一命中点重复触发（死循环）。
 *  此状态文件落在 workspace 内（可写），作为 lastFired 的持久化兜底。
 *  插件在 `<repo>/plugins/cron-scheduler/` 时 → `<repo>/config/cron-scheduler-state.json` */
export function stateFilePathOf(config) {
  const dir = coreDirOf(config)
  return `${resolve(dir, '..', '..', 'config')}/cron-scheduler-state.json`
}

function coreDirOf(config) {
  return (config?.coreDir || DEFAULT_CORE_DIR).replace(/\/+$/, '')
}

/** 是否「文件不存在」类错误 */
function isMissingFile(err) {
  const m = err?.code || err?.message || ''
  return /ENOENT|not exist|does not exist|no such file|not_found/i.test(m)
}

/** 加载调度核心模块（cron.js + scheduler.js） */
async function loadCore(config) {
  const dir = coreDirOf(config)
  const scheduler = await import(`${dir}/scheduler.js`)
  const cron = await import(`${dir}/cron.js`)
  return { ...scheduler, parseCron: cron.parseCron }
}

/** 从配置或默认解析 schedulesPath */
export function resolveSchedulesPath(ctx, config) {
  if (config?.schedulesPath) return config.schedulesPath
  let env
  try { env = ctx.get('launchEnvironment') } catch { env = undefined }
  if (env?.get) {
    const fromEnv = env.get('CRON_SCHEDULES_PATH')?.value
    if (fromEnv) return fromEnv
    const home = env.get('HOME')?.value || env.get('USERPROFILE')?.value
    if (home) return `${home}/.dsh/cron-schedules.json`
  }
  return `${process?.env?.HOME || '/Users/zhengyd'}/.dsh/cron-schedules.json`
}

/** 格式化提醒文本（模型作为 user 消息读到；桥接器也可用此前缀识别） */
export function formatReminder(task) {
  const header = task.title ? `【定时提醒 · ${task.title}】` : '【定时提醒】'
  return `${header}\n${task.message}`
}

/**
 * 可测试的调度运行时。
 *  - tryStart()：加载核心 + 读配置建状态（幂等，可重入）
 *  - tick()：一次检测 → 投递 → 回写（可手动驱动）
 *  - dispose()：清理
 */
export class CronSchedulerRuntime {
  /**
   * @param {object} ctx Cordis context（fs/agents/logger）
   * @param {string} schedulesPath 配置路径
   * @param {object} [config] 插件配置
   */
  constructor(ctx, schedulesPath, config = {}) {
    this.ctx = ctx
    this.schedulesPath = schedulesPath
    this.config = config
    this.core = undefined
    this.state = undefined
    this.lastConfigTarget = undefined
    this.warnCooldownUntil = 0
    this.started = false
    this.disposed = false
  }

  // ---- 日志 ----
  _warn(msg) {
    if (this.disposed) return
    const now = Date.now()
    if (now >= this.warnCooldownUntil) {
      this.warnCooldownUntil = now + WARN_COOLDOWN_MS
      console.log(`[cron-scheduler] WARN: ${msg}`)
      try { this.ctx.logger?.warn?.(`cron-scheduler: ${msg}`) } catch {}
    }
  }
  _info(msg) {
    console.log(`[cron-scheduler] ${msg}`)
    try { this.ctx.logger?.info?.(`cron-scheduler: ${msg}`) } catch {}
  }

  // ---- 配置 IO（用 ctx.fs，保持与真实环境一致）----
  async _readConfigFile() {
    const target = await this.ctx.fs.resolve(this.schedulesPath)
    this.lastConfigTarget = target
    try {
      const text = await this.ctx.fs.readText(target)
      return { target, text }
    } catch (e) {
      if (isMissingFile(e)) return { target, text: null }
      throw e
    }
  }

  async _writeConfigFile(text) {
    if (this.lastConfigTarget) {
      // 省略 expected（intent）→ 无条件 create-or-overwrite；显式传空 object 会被后端拒绝
      await this.ctx.fs.writeText(this.lastConfigTarget, text)
    }
  }

  // ---- lastFired 状态文件（workspace 内，沙箱可写）----
  /** 读状态文件 lastFired；不存在或损坏返回 {}。 */
  async _readStateFile() {
    try {
      const p = stateFilePathOf(this.config)
      const target = await this.ctx.fs.resolve(p)
      const text = await this.ctx.fs.readText(target)
      const parsed = JSON.parse(text)
      if (parsed && typeof parsed === 'object' && typeof parsed.lastFired === 'object' && parsed.lastFired !== null) {
        const out = {}
        for (const [id, v] of Object.entries(parsed.lastFired)) {
          const ms = typeof v === 'number' ? v : Date.parse(v)
          if (!Number.isNaN(ms)) out[id] = ms
        }
        return out
      }
    } catch (e) {
      if (!isMissingFile(e) && !/ENOENT|not exist/i.test(String(e?.message))) {
        this._warn(`读取 lastFired 状态文件失败（降级为空）: ${e?.message}`)
      }
    }
    return {}
  }

  /** 写状态文件（workspace 内，workspace-write 下应可写）。失败仅告警，不致命。 */
  async _writeStateFile() {
    try {
      const p = stateFilePathOf(this.config)
      const target = await this.ctx.fs.resolve(p)
      const lastFired = this.state ? this.state.exportLastFired() : {}
      await this.ctx.fs.writeText(target, JSON.stringify({ lastFired }, null, 2) + '\n')
    } catch (e) {
      // 明确区分：workspace 内仍被拒（危险） vs 其他 IO 错误
      const msg = String(e?.message || e)
      if (/FS_SANDBOX_DENIED|sandbox|file access denied/i.test(msg)) {
        this._warn(`lastFired 状态文件被沙箱拒绝！请确保 workspace 可写或提升 sandbox 模式: ${msg}`)
      } else {
        this._warn(`写入 lastFired 状态文件失败: ${msg}`)
      }
    }
  }

  // ---- 启动（幂等）----
  async tryStart() {
    if (this.started || this.disposed) return
    this.core = await loadCore(this.config)
    const { cfg, tasks, state } = await this._buildState()
    this.state = state
    this.currentTasks = tasks
    this.started = true
    this._info(`已加载 ${tasks.length} 个定时任务（配置 ${this.schedulesPath}）`)
  }

  async _buildState() {
    const core = this.core
    const { text } = await this._readConfigFile()
    if (text === null) {
      // 主配置缺失：仍从状态文件恢复 lastFired（防止任务重新启用后重复触发）
      const lastFired = await this._readStateFile()
      return { cfg: { timezone: 'Asia/Shanghai', tasks: [] }, tasks: [], state: new core.TriggerState(lastFired) }
    }
    const cfg = core.normalizeConfig(text)
    const lastFired = await this._readStateFile()
    for (const t of cfg.tasks) {
      if (typeof t.lastFiredAt === 'number' || typeof t.lastFiredAt === 'string') {
        const ms = typeof t.lastFiredAt === 'number' ? t.lastFiredAt : Date.parse(t.lastFiredAt)
        if (!Number.isNaN(ms) && lastFired[t.id] === undefined) lastFired[t.id] = ms
      }
    }
    return { cfg, tasks: cfg.tasks, state: new core.TriggerState(lastFired) }
  }

  /** 重读配置（HMR/外部修改配置后调用；幂等） */
  async reload() {
    if (!this.core) await this.tryStart()
    if (!this.core) return
    const { tasks, state } = await this._buildState()
    this.state = state
    this.currentTasks = tasks
    return { tasks, state }
  }

  // ---- 触发 ----
  async _persistLastFired() {
    // 状态文件（workspace 内）总是写：lastFired 持久化不依赖主配置是否可写
    await this._writeStateFile()
    try {
      const { text } = await this._readConfigFile()
      if (text === null) {
        this._warn('主配置不存在，lastFired 已写入状态文件但未合并回主配置')
        return
      }
      const parsed = JSON.parse(text)
      if (!Array.isArray(parsed.schedules)) return
      const exportLf = this.state.exportLastFired()
      let changed = false
      for (const raw of parsed.schedules) {
        const id = raw.id !== undefined ? String(raw.id) : undefined
        if (id && exportLf[id] !== undefined && raw.lastFiredAt !== exportLf[id]) {
          raw.lastFiredAt = exportLf[id]
          changed = true
        }
      }
      if (changed) {
        await this._writeConfigFile(JSON.stringify(parsed, null, 2) + '\n')
      }
    } catch (e) {
      const msg = String(e?.message || e)
      if (/FS_SANDBOX_DENIED|sandbox|file access denied/i.test(msg)) {
        // 主配置在沙箱外（~/.dsh）：lastFired 仍已由状态文件持久化，可安全降级
        this._warn(`主配置回写 lastFired 被沙箱拒绝（lastFired 已持久化到状态文件，防重复触发仍生效）: ${msg}`)
      } else {
        this._warn(`回写 lastFired 失败: ${msg}`)
      }
    }
  }

  _resolveTargetAgent(sessionId) {
    if (sessionId) {
      const a = this.ctx.agents.get(sessionId)
      if (a) return a
      this._warn(`配置的目标会话 ${sessionId} 不存在，回退 root agent`)
    }
    const roots = this.ctx.agents.roots()
    const clean = roots.filter((a) => !/dingtest|e2e/.test(a.id))
    return clean.find((a) => a.status !== undefined) || clean[0]
  }

  /**
   * 一次检测：找出 due 任务 → 逐个 followup → 回写 lastFired。
   * @param {Date} [now] 当前时刻（测试可注入；缺省 Date.now()）
   * @returns {Promise<Array<{task, at, agentId}>>} 实际投递的列表
   */
  async tick(now = new Date()) {
    if (this.disposed) return []
    if (!this.started) {
      try { await this.tryStart() } catch (e) { this._warn(`启动失败: ${e?.message}`); return [] }
    }
    const fired = []
    try {
      const { tasks, state } = await this._buildState()
      this.state = state
      this.currentTasks = tasks
      const due = state.dueTasks(tasks, now, { lookbackMs: LOOKBACK_MS })
      if (due.length === 0) return []
      for (const { task, at } of due) {
        const agent = this._resolveTargetAgent(task.session)
        if (!agent) {
          this._warn(`任务 ${task.id} 无目标 agent，跳过`)
          continue
        }
        try {
          const message = createUserMessage({
            content: [{ type: 'text', text: formatReminder(task) }],
            source: { kind: 'plugin', plugin: 'cron-scheduler' },
          })
          agent.followup(message)
          // 以「本次 tick 时刻」为消费点（而非代表命中点 at），
          // 保证下一窗口 (now, ...] 只含真正未触发的命中点：不丢、不重、不轰炸。
          state.markFired(task, now)
          fired.push({ task, at, agentId: agent.id })
          // 审计走 logger，不再向 session 日志写自定义事件：
          // cron/dispatch 不在 DSH 已知事件白名单内，写入会污染日志导致历史无法加载。
          this._info(`已触发任务 ${task.id} @ ${at.toISOString()} -> agent ${agent.id}`)
        } catch (e) {
          this._warn(`任务 ${task.id} 投递失败: ${e?.message}`)
        }
      }
      if (fired.length > 0) await this._persistLastFired()
      return fired
    } catch (e) {
      this._warn(`tick 异常: ${e?.message}`)
      return []
    }
  }

  dispose() {
    this.disposed = true
    this.core = undefined
    this.state = undefined
  }
}

/** Cordis 插件 apply */
export function apply(ctx, config = {}) {
  const schedulesPath = resolveSchedulesPath(ctx, config)

  ctx.effect(() => {
    let stopped = false
    let tickTimer
    const runtime = new CronSchedulerRuntime(ctx, schedulesPath, config)

    const tickLoop = async () => {
      if (stopped) return
      await runtime.tick()
    }

    // 启动
    ;(async () => {
      try {
        await runtime.tryStart()
      } catch (e) {
        try { ctx.logger?.warn?.(`cron-scheduler: 启动失败: ${e?.message}`) } catch {}
      }
      if (stopped) return
      tickTimer = setInterval(tickLoop, TICK_MS)
      tickLoop() // 立即检测一次
    })()

    return () => {
      stopped = true
      if (tickTimer !== undefined) clearInterval(tickTimer)
      runtime.dispose()
    }
  }, 'cron-scheduler.runtime')
}
