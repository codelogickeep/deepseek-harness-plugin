/**
 * cron.js — 自研定时任务插件的核心调度逻辑（纯 ESM，零依赖，可测试）
 *
 * 支持标准 5 字段 cron 表达式：
 *   ┌───────────── minute (0 - 59)
 *   │ ┌─────────── hour (0 - 23)
 *   │ │ ┌───────── day of month (1 - 31)
 *   │ │ │ ┌─────── month (1 - 12)
 *   │ │ │ │ ┌───── day of week (0 - 7)  (0 和 7 都是 Sunday)
 *   │ │ │ │ │
 *   * * * * *
 *
 * 每个字段支持：
 *   *        任意值
 *   *\/n     步进（如 *\/5 每 5 单位）
 *   a,b,c    枚举（如 0,30）
 *   a-b      范围（如 9-18）
 *   a-b\/n   范围+步进（如 9-18/2）
 *   n        精确值
 *
 * 实现完全运行在 UTC 内部；用户提供的 timezone（IANA）只在「本地时间到 UTC」
 * 转换时用到（基于 Date 的本地时区偏移换算）。注意：Node 的 Date 无法直接
 * 解析任意 IANA zone 的本地时间，本实现用「给定时区当前 offset」近似——
 * 对日级/小时级定时足够（DST 切换日的边界情况有专门注释）。
 */

/**
 * 解析单个 cron 字段为允许值集合（数组，升序）。
 * @param {string} field cron 字段原文
 * @param {number} min 允许最小值
 * @param {number} max 允许最大值
 * @returns {number[]} 升序的允许值数组
 * @throws {Error} 字段非法
 */
export function parseField(field, min, max) {
  if (field === undefined || field === null || String(field).trim() === '') {
    throw new Error(`cron 字段为空`)
  }
  const text = String(field).trim()
  const values = new Set()

  // 逗号分隔的枚举/列表
  const parts = text.split(',')
  for (const part of parts) {
    if (part === '') throw new Error(`cron 字段 "${text}" 含空项`)
    // 步进：*/n 或 a-b/n
    let range
    let step = 1
    if (part.includes('/')) {
      const [rangePart, stepPart] = part.split('/')
      if (stepPart === undefined || !/^\d+$/.test(stepPart)) {
        throw new Error(`cron 字段 "${part}" 步进非法`)
      }
      step = parseInt(stepPart, 10)
      if (step <= 0) throw new Error(`cron 字段 "${part}" 步进必须为正`)
      range = rangePart
    } else {
      range = part
    }

    if (range === '*') {
      for (let v = min; v <= max; v += step) values.add(v)
    } else if (/^-?\d+$/.test(range)) {
      // 单值（也接受 n/n 形式，等价 n）
      const v = parseInt(range, 10)
      assertInRange(v, min, max, text)
      values.add(v)
    } else if (/^-?\d+-(-?\d+)?$/.test(range) && range.includes('-')) {
      // 范围 a-b
      const [a, b] = range.split('-').map((x) => parseInt(x, 10))
      assertInRange(a, min, max, text)
      assertInRange(b, min, max, text)
      if (a > b) throw new Error(`cron 字段 "${part}" 范围起始大于结束`)
      for (let v = a; v <= b; v += step) values.add(v)
    } else {
      throw new Error(`cron 字段 "${part}" 无法解析`)
    }
  }

  return [...values].sort((x, y) => x - y)
}

function assertInRange(value, min, max, fieldText) {
  if (value < min || value > max) {
    throw new Error(`cron 字段 "${fieldText}" 值 ${value} 超出 ${min}-${max}`)
  }
}

/**
 * 解析完整 cron 表达式（5 字段，空格分隔）。
 * @param {string} expression
 * @returns {{minutes:number[], hours:number[], daysOfMonth:number[], months:number[], daysOfWeek:number[]}}
 */
export function parseCron(expression) {
  const fields = String(expression).trim().split(/\s+/)
  if (fields.length !== 5) {
    throw new Error(`cron 表达式 "${expression}" 必须为 5 字段（分 时 日 月 周）`)
  }
  return {
    minutes: parseField(fields[0], 0, 59),
    hours: parseField(fields[1], 0, 23),
    daysOfMonth: parseField(fields[2], 1, 31),
    months: parseField(fields[3], 1, 12),
    daysOfWeek: parseField(fields[4], 0, 7).map((d) => (d === 7 ? 0 : d)), // 7 → 0 (Sunday)
    daysOfMonthIsStar: isStarField(fields[2]),
    daysOfWeekIsStar: isStarField(fields[4]),
  }
}

/** 判断字段原文是否为「纯通配 *」（决定日/周二选一或 OR 语义） */
function isStarField(field) {
  return String(field).trim() === '*'
}

/** 按 IANA 时区缓存 Intl.DateTimeFormat（避免逐分钟重复创建，性能关键）。 */
const _dtfCache = new Map()

/** 把 UTC 时刻换算成目标时区的本地分量（year/month/day/hour/minute）。 */
function zonedParts(timezone, date) {
  let dtf = _dtfCache.get(timezone)
  if (!dtf) {
    dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    })
    _dtfCache.set(timezone, dtf)
  }
  const map = {}
  for (const p of dtf.formatToParts(date)) map[p.type] = p.value
  let hour = parseInt(map.hour, 10)
  if (hour === 24) hour = 0 // 极少数 ICU 实现午夜用 24
  return {
    year: parseInt(map.year, 10),
    month: parseInt(map.month, 10),
    day: parseInt(map.day, 10),
    hour,
    minute: parseInt(map.minute, 10),
  }
}

/**
 * 判断某日历日是否匹配「日」和「周」字段（cron 语义：两者都指定时用 OR；一方是 * 则只取另一方）。
 * 星期几是日历日的固有属性（不随时区变化），直接用 zoned 的 year/month/day 计算。
 */
function zonedDayMatches(spec, p) {
  const domStar = spec.daysOfMonthIsStar === true
  const dowStar = spec.daysOfWeekIsStar === true
  if (domStar && dowStar) return true
  const dow = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay()
  if (domStar) return spec.daysOfWeek.includes(dow)
  if (dowStar) return spec.daysOfMonth.includes(p.day)
  // 都指定：OR 语义（标准 cron）
  return spec.daysOfMonth.includes(p.day) || spec.daysOfWeek.includes(dow)
}

/**
 * 计算给定时刻之后（不含）的下一次触发。
 * @param {object} spec parseCron 的结果
 * @param {Date} after 从这一刻之后找（不含这一刻本身）
 * @param {string} [timezone] IANA 时区（如 "Asia/Shanghai"）；缺省按 UTC。
 * @returns {Date} 下一次触发时刻（可能跨月/年向后找，最远找 5 年）
 * @throws {Error} 5 年内找不到（配置错误，如 2月30日）
 */
export function nextOccurrence(spec, after, timezone) {
  // cron 的「时/分/日/月/周」都按 timezone 解释。在 UTC 轴上从 after 的
  // 下一分钟整点逐分钟推进，对每个候选 UTC 时刻换算成 timezone 的本地
  // 分量来匹配——这样「上海 10:00」才命中 UTC 02:00，而不是误命中 UTC 10:00。
  const tz = timezone || 'UTC'
  let cursor = new Date(Math.floor(after.getTime() / 60000) * 60000 + 60000)

  // 迭代上限：最多找 5 年（约 1826 天 * 24 * 60 分钟），防死循环
  const maxGuard = 1826 * 24 * 60
  for (let guard = 0; guard < maxGuard; guard += 1) {
    const p = zonedParts(tz, cursor)
    const monthOk = spec.months.includes(p.month)
    const dayOk = monthOk && zonedDayMatches(spec, p)
    const hourOk = spec.hours.includes(p.hour)
    const minuteOk = spec.minutes.includes(p.minute)
    if (dayOk && hourOk && minuteOk) {
      return new Date(cursor.getTime())
    }
    cursor = new Date(cursor.getTime() + 60000)
  }

  throw new Error('cron 表达式在 5 年内没有下一次触发（请检查配置）')
}

/**
 * 计算未来 N 次触发时刻（含下一次）。
 * @param {string|object} expression cron 表达式或已解析 spec
 * @param {Date} from 起点（不含此刻）
 * @param {number} count 次数，默认 1
 * @returns {Date[]}
 */
export function nextOccurrences(expression, from, count = 1) {
  const spec = typeof expression === 'string' ? parseCron(expression) : expression
  const result = []
  let cursor = from
  for (let i = 0; i < count; i += 1) {
    const next = nextOccurrence(spec, cursor)
    result.push(next)
    cursor = next
  }
  return result
}

/**
 * 把「本地时间字符串 HH:mm」+ IANA 时区解释为下一次该时刻的 UTC Date。
 * 由于 Node 原生 Date 只支持系统时区，这里通过「目标时区当前 offset」近似：
 *   target = UTC_guess + targetOffset - localOffset
 * 日内精度足够；DST 切换当天可能偏差 1 小时（标注）。
 *
 * @param {string} hhmm "10:00"
 * @param {string} timezone IANA 如 "Asia/Shanghai"
 * @param {Date} after 从这一刻之后开始找
 * @returns {Date} 下一次该本地时刻的 UTC 时间
 */
export function nextLocalTime(hhmm, timezone, after) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm).trim())
  if (!match) throw new Error(`时间 "${hhmm}" 格式应为 HH:mm`)
  const hour = parseInt(match[1], 10)
  const minute = parseInt(match[2], 10)
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new Error(`时间 "${hhmm}" 超出范围`)
  }
  // 目标时区在 today 时刻的 UTC offset（分钟）
  const targetOffset = utcOffsetMin(timezone, after)
  const localNow = new Date()
  const localOffset = -localNow.getTimezoneOffset() // 本地 UTC+8 → 480 (分钟)

  // 构建「目标时区今天的 local hour」对应的 UTC 时刻
  // UTC_moment = local_naive_as_UTC - targetOffset_mins
  // 用 after 所在 UTC 日推算一个朴素 UTC（即假装 local 时间就是 UTC 的时/分）
  const naiveUtc = new Date(Date.UTC(
    after.getUTCFullYear(), after.getUTCMonth(), after.getUTCDate(),
    hour, minute, 0, 0,
  ))
  let candidate = new Date(naiveUtc.getTime() - (targetOffset - localOffset) * 60000)
  // 确保在 after 之后
  if (candidate.getTime() <= after.getTime()) {
    candidate = new Date(candidate.getTime() + 24 * 60 * 60 * 1000)
  }
  return candidate
}

/** 估算某 IANA 时区在某 UTC 时刻的 UTC offset（分钟）。兼容常见 zone，未知用 0。 */
function utcOffsetMin(timezone, at) {
  if (!timezone) return 0
  try {
    // 利用 Intl 计算该时区某时刻的 utc offset
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    })
    const parts = dtf.formatToParts(at)
    const map = {}
    for (const p of parts) map[p.type] = p.value
    const asUTC = Date.UTC(
      parseInt(map.year, 10), parseInt(map.month, 10) - 1, parseInt(map.day, 10),
      parseInt(map.hour, 10) % 24, parseInt(map.minute, 10), parseInt(map.second, 10),
    )
    return Math.round((asUTC - at.getTime()) / 60000)
  } catch {
    return 0
  }
}

/** 格式化为 ISO（UTC），便于日志与事件 */
export function toIso(date) {
  return date.toISOString()
}
