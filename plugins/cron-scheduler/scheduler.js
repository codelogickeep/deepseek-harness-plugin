/**
 * scheduler.js — 自研定时任务插件：可测试的调度核心（纯 ESM，零依赖）
 *
 * 职责（不碰 IO/Timer/Agent，只做纯逻辑）：
 *  - 校验并规范化「任务配置」（来自 cron-schedules.json）
 *  - 基于 cron 解析计算每个任务的下次触发
 *  - 维护每个任务的「已触发」状态（内存态），支持冻结/恢复
 *  - 判断哪些任务「自上次触发以来出现了需要触发的命中点」
 *
 * 配置文件格式（cron-schedules.json）：
 * {
 *   "timezone": "Asia/Shanghai",        // 全局时区，任务可覆盖
 *   "schedules": [
 *     {
 *       "id": "jira-daily",
 *       "cron": "0 10 * * *",             // 5 字段 cron（分 时 日 月 周）
 *       "timezone": "Asia/Shanghai",      // 可选，覆盖全局
 *       "session": "session-xxx",         // 可选：目标会话；缺省 → 当前活跃 root agent
 *       "message": "查看 JIRA 支持网缺陷",  // 提醒正文（必填）
 *       "title": "每日 JIRA 巡检",          // 可选：钉钉标题
 *       "enabled": true                   // 可选，默认 true
 *     }
 *   ]
 * }
 *
 * 触发语义（健壮、无丢失、无重复）：
 *  每次 tick（系统唤醒）时，对每个任务计算「上次触发时刻 last → now」之间
 *  是否出现 cron 命中点。若出现且未触发过 → 触发（标记 last = now）。
 *  这样：重启迟到、时钟回拨、跳过多个周期都正确处理：
 *   - 一个或多个命中点只触发一次（到点合并，避免积压轰炸）
 *   - 已触发过的命中点不重复
 *   - 配置里 `lastFiredAt` 字段用于跨重启恢复（防止重启后重复触发）
 */

import { parseCron, nextOccurrence, toIso } from './cron.js'

/** 校验并规范化单个任务。返回规范任务对象；非法抛错（带 id 上下文）。 */
export function normalizeTask(raw, index, defaultTimezone) {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`#${index}: 任务必须是对象`)
  }
  const id = raw.id !== undefined && raw.id !== '' ? String(raw.id) : `task-${index}`
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new Error(`#${index}: id "${id}" 只能含字母数字 _ -`)
  }
  if (typeof raw.cron !== 'string' || raw.cron.trim() === '') {
    throw new Error(`#${index} (${id}): 缺少 cron 表达式`)
  }
  const message = raw.message !== undefined ? String(raw.message).trim() : ''
  if (!message) {
    throw new Error(`#${index} (${id}): 缺少 message（提醒内容）`)
  }
  // 解析 cron（抛错→配置错误）
  const spec = parseCron(raw.cron)
  const timezone = raw.timezone || defaultTimezone || 'Asia/Shanghai'
  const session = raw.session !== undefined ? String(raw.session) : undefined
  const title = raw.title !== undefined ? String(raw.title) : undefined
  const enabled = raw.enabled !== false
  // 透传 lastFiredAt（上次触发时间；配置回写后用于跨重启恢复）
  const lastFiredAt = raw.lastFiredAt

  return {
    id,
    cron: String(raw.cron).trim(),
    spec,
    timezone,
    message,
    title,
    session: session || undefined,
    enabled,
    lastFiredAt,
    rawIndex: index,
  }
}

/** 从配置文件内容解析出规范化任务列表（带校验）。 */
export function normalizeConfig(text) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    throw new Error(`cron-schedules.json 不是合法 JSON: ${e.message}`)
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.schedules)) {
    throw new Error('cron-schedules.json 缺少 schedules 数组')
  }
  const defaultTimezone = typeof parsed.timezone === 'string' ? parsed.timezone : 'Asia/Shanghai'
  return {
    timezone: defaultTimezone,
    tasks: parsed.schedules.map((raw, i) => normalizeTask(raw, i, defaultTimezone)),
  }
}

/**
 * 任务触发状态机。
 *  - `lastFiredAt`：每任务上次触发的 UTC 时间戳。
 *  - 加载时从配置 lastFired 恢复（跨重启）。
 */
export class TriggerState {
  constructor(lastFiredByTask = {}) {
    /** Map<taskId, number(millis)> */
    this.lastFired = new Map()
    for (const [id, v] of Object.entries(lastFiredByTask || {})) {
      const ms = typeof v === 'number' ? v : Date.parse(v)
      if (!Number.isNaN(ms)) this.lastFired.set(id, ms)
    }
  }

  /** 计算某任务在 now 之后的下一次触发（UTC Date）。 */
  nextFor(task, now = new Date()) {
    if (!task.enabled) return undefined
    return nextOccurrence(task.spec, now)
  }

  /**
   * 计算所有任务的下一次触发时刻（升序），用于安排下一次唤醒。
   * 返回 [{ task, at }]，只含 enabled 且 at > now。
   */
  nextWakeups(tasks, now = new Date()) {
    const nowMs = now.getTime()
    return tasks
      .filter((t) => t.enabled)
      .map((t) => ({
        task: t,
        at: nextOccurrence(t.spec, now),
      }))
      .filter((w) => w.at.getTime() > nowMs)
      .sort((a, b) => a.at - b.at)
  }

  /**
   * 找出「自上次触发以来（last，不含）→ now（含）」有 cron 命中点的任务。
   * 触发语义：
   *  - 若 last 未记录（首次或新任务）→ 从「上一个可能的命中点」算起？
   *    首启：为避免把历史命中点全部补触发，首次从 now 之前的
   *    lookbackMs（默认 2 分钟）开始找，且 onlyIfWithin=true。
   *    这样刚配置的任务不会立刻轰炸历史。
   *  - 业务上：每个命中点（分钟级）最多触发一次；多个命中点合并为一次触发。
   *
   * @param {object[]} tasks 规范化任务
   * @param {Date} now 当前时刻
   * @param {object} [opts] { lookbackMs } 无记录时的回看窗口；默认 120_000
   * @returns {Array<{task, at:Date}>} 应触发的任务及代表命中点
   */
  dueTasks(tasks, now = new Date(), opts = {}) {
    const lookbackMs = opts.lookbackMs ?? 120_000
    const nowMs = now.getTime()
    const results = []
    for (const task of tasks) {
      if (!task.enabled) continue
      const last = this.lastFired.get(task.id)
      let fromMs
      if (last !== undefined) {
        // 从上次触发之后开始
        fromMs = last
      } else {
        // 无记录：首次。只回看 lookback 窗口，避免立刻补历史轰炸
        fromMs = nowMs - lookbackMs
      }
      // 找 (fromMs, nowMs] 之间第一个 cron 命中点
      const hit = findHitInWindow(task.spec, fromMs, nowMs)
      if (hit !== undefined) {
        results.push({ task, at: hit })
      }
    }
    return results
  }

  /** 标记某任务在 at 触发。返回毫秒时间戳。 */
  markFired(task, at = new Date()) {
    const ms = at.getTime()
    this.lastFired.set(task.id, ms)
    return ms
  }

  /** 导出 lastFired（用于回写配置文件，millis）。 */
  exportLastFired() {
    return Object.fromEntries(this.lastFired)
  }
}

/**
 * 在 (fromMs, toMs] 开区间内找第一个 cron 命中点（分钟级精确）。
 * 返回 Date 或 undefined。
 * 实现：从 fromMs 的下一分钟开始，逐分钟/跳跃式检查，直到 toMs。
 *  为效率：先找 fromMs 之后 cron 的下一个 occurrence（nextOccurrence 支持快速跳），
 *  若 next <= toMs 且有命中 → 返回；否则窗口内无命中。
 */
export function findHitInWindow(spec, fromMs, toMs) {
  if (toMs - fromMs <= 0) return undefined
  // fromMs 向下取整到分钟，然后找 after 的下一个 occurrence
  const fromDate = new Date(fromMs)
  try {
    let cursor = nextOccurrence(spec, fromDate)
    // nextOccurrence 返回严格 > fromDate；若它 ≤ toMs 即有命中
    if (cursor.getTime() <= toMs) {
      return cursor
    }
  } catch {
    // 五年内无下一次 → 窗口无命中
    return undefined
  }
  return undefined
}
