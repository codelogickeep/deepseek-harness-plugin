/**
 * scheduler.js 单元测试
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeConfig,
  normalizeTask,
  TriggerState,
  findHitInWindow,
} from '../src/scheduler.js'
import { parseCron } from '../src/cron.js'

test('normalizeConfig: 合法配置', () => {
  const cfg = normalizeConfig(JSON.stringify({
    timezone: 'Asia/Shanghai',
    schedules: [
      { id: 'a', cron: '0 10 * * *', message: '提醒A' },
      { id: 'b', cron: '*/30 * * * *', message: '提醒B', timezone: 'UTC', enabled: false },
    ],
  }))
  assert.equal(cfg.timezone, 'Asia/Shanghai')
  assert.equal(cfg.tasks.length, 2)
  assert.equal(cfg.tasks[0].id, 'a')
  assert.equal(cfg.tasks[0].enabled, true)
  assert.equal(cfg.tasks[1].enabled, false)
  assert.equal(cfg.tasks[1].timezone, 'UTC')
})

test('normalizeConfig: 非法 JSON', () => {
  assert.throws(() => normalizeConfig('not json'))
})

test('normalizeConfig: 缺少 schedules 数组', () => {
  assert.throws(() => normalizeConfig('{}'))
  assert.throws(() => normalizeConfig('{"a":1}'))
})

test('normalizeConfig: 缺 message / 缺 cron / 非法格式报错', () => {
  assert.throws(() => normalizeConfig('{"schedules":[{"id":"x","cron":"0 10 * * *"}]}')) // 缺 message
  assert.throws(() => normalizeConfig('{"schedules":[{"id":"x","message":"hi"}]}')) // 缺 cron
  assert.throws(() => normalizeConfig('{"schedules":[{"id":"x","cron":"0 99 * * *","message":"hi"}]}')) // 非法 cron
})

test('TriggerState.nextFor: 返回下次触发', () => {
  const st = new TriggerState()
  const task = normalizeTask({ id: 't', cron: '0 10 * * *', message: 'x' }, 0, 'UTC')
  const from = new Date('2026-08-17T09:00:00Z')
  assert.equal(st.nextFor(task, from).toISOString(), '2026-08-17T10:00:00.000Z')
})

test('TriggerState.nextWakeups: 升序返回所有任务下次触发', () => {
  const st = new TriggerState()
  const tasks = [
    normalizeTask({ id: 'a', cron: '0 10 * * *', message: 'x' }, 0, 'UTC'),
    normalizeTask({ id: 'b', cron: '30 8 * * *', message: 'x' }, 1, 'UTC'),
  ]
  const from = new Date('2026-08-17T08:00:00Z')
  const ws = st.nextWakeups(tasks, from)
  assert.deepEqual(ws.map((w) => [w.task.id, w.at.toISOString()]), [
    ['b', '2026-08-17T08:30:00.000Z'],
    ['a', '2026-08-17T10:00:00.000Z'],
  ])
})

test('TriggerState.nextWakeups: enabled=false 不参与', () => {
  const st = new TriggerState()
  const tasks = [
    normalizeTask({ id: 'a', cron: '0 10 * * *', message: 'x' }, 0, 'UTC'),
    normalizeTask({ id: 'c', cron: '0 9 * * *', message: 'x', enabled: false }, 2, 'UTC'),
  ]
  const from = new Date('2026-08-17T08:00:00Z')
  const ws = st.nextWakeups(tasks, from)
  assert.deepEqual(ws.map((w) => w.task.id), ['a'])
})

test('TriggerState.dueTasks: 触发语义（跨重启跳过不重复）', () => {
  const st = new TriggerState()
  const task = normalizeTask({ id: 'daily', cron: '0 10 * * *', message: 'x' }, 0, 'UTC')

  // 无记录 + now 恰好在命中后 30 秒内 → 首次不轰炸历史
  const now = new Date('2026-08-17T10:00:30Z')
  let due = st.dueTasks([task], now)
  assert.equal(due.length, 1) // 10:00 命中在 lookback 内

  // 标记触发
  st.markFired(task, due[0].at)

  // 同一分钟再次 tick → 不重复
  const again = new Date('2026-08-17T10:00:45Z')
  assert.equal(st.dueTasks([task], again).length, 0)

  // 第二天 10:00 → 再次触发
  const nextDay = new Date('2026-08-18T10:00:10Z')
  due = st.dueTasks([task], nextDay)
  assert.equal(due.length, 1)
  assert.equal(due[0].at.toISOString(), '2026-08-18T10:00:00.000Z')
})

test('TriggerState.dueTasks: 多个周期跳过只触发一次', () => {
  const st = new TriggerState()
  const task = normalizeTask({ id: 'm', cron: '*/15 * * * *', message: 'x' }, 0, 'UTC')
  // 上次触发 10:00，现在 11:00（跳过了 10:15..10:45）→ 应触发一次（代表 11:00 命中）
  st.markFired(task, new Date('2026-08-17T10:00:00Z'))
  const now = new Date('2026-08-17T11:00:10Z')
  const due = st.dueTasks([task], now)
  assert.equal(due.length, 1)
})

test('TriggerState.dueTasks: DST/大窗口不会海量补触发（只一次）', () => {
  const st = new TriggerState()
  const task = normalizeTask({ id: 'h', cron: '0 * * * *', message: 'x' }, 0, 'UTC') // 每小时
  // 上次触发昨天 10:00，现在今天 16:00（20+ 小时过去）
  st.markFired(task, new Date('2026-08-16T10:00:00Z'))
  const now = new Date('2026-08-17T16:00:10Z')
  const due = st.dueTasks([task], now)
  assert.equal(due.length, 1) // 只触发一次，代表 16:00 命中
})

test('TriggerState.dueTasks: 首次不轰炸历史（lookback 外不触发）', () => {
  const st = new TriggerState()
  const task = normalizeTask({ id: 'n', cron: '0 * * * *', message: 'x' }, 0, 'UTC')
  // 无记录，now 是 16:00，5 小时无 tick → 只触发 16:00 命中（lookback 内），不补 11-15 点
  const now = new Date('2026-08-17T16:00:10Z')
  const due = st.dueTasks([task], now)
  assert.equal(due.length, 1)
})

test('TriggerState: 跨重启恢复（配置 lastFired）', () => {
  // 配置里有 lastFired，重启后 10:01 tick 不重复触发 10:00
  const st = new TriggerState({ daily: Date.parse('2026-08-17T10:00:00Z') })
  const task = normalizeTask({ id: 'daily', cron: '0 10 * * *', message: 'x' }, 0, 'UTC')
  const now = new Date('2026-08-17T10:01:00Z')
  assert.equal(st.dueTasks([task], now).length, 0)
  // 次日 10:00 正常触发
  const next = new Date('2026-08-18T10:00:10Z')
  assert.equal(st.dueTasks([task], next).length, 1)
})

test('findHitInWindow: 窗口内命中', () => {
  const spec = parseCron('0 10 * * *')
  const hit = findHitInWindow(spec, Date.parse('2026-08-17T09:00:00Z'), Date.parse('2026-08-17T10:00:05Z'))
  assert.ok(hit)
  assert.equal(hit.toISOString(), '2026-08-17T10:00:00.000Z')
})

test('findHitInWindow: 窗口内无命中', () => {
  const spec = parseCron('0 10 * * *')
  const hit = findHitInWindow(spec, Date.parse('2026-08-17T10:00:01Z'), Date.parse('2026-08-17T10:05:00Z'))
  assert.equal(hit, undefined)
})
