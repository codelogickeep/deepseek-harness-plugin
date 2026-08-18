/**
 * cron.js 单元测试
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCron, parseField, nextOccurrence, nextOccurrences } from '../src/cron.js'

function utc(date) {
  return date.toISOString()
}

test('parseField: 通配符', () => {
  assert.deepEqual(parseField('*', 0, 59), [...Array(60).keys()])
  assert.deepEqual(parseField('*', 0, 23), [...Array(24).keys()])
})

test('parseField: 步进 */n', () => {
  assert.deepEqual(parseField('*/15', 0, 59), [0, 15, 30, 45])
  // hour 字段 0-23，*/30 只有 0（30 超出范围）
  assert.deepEqual(parseField('*/30', 0, 23), [0])
})

test('parseField: 枚举', () => {
  assert.deepEqual(parseField('0,30', 0, 59), [0, 30])
  assert.deepEqual(parseField('1,2,3', 0, 12), [1, 2, 3])
})

test('parseField: 范围', () => {
  assert.deepEqual(parseField('9-11', 0, 23), [9, 10, 11])
  assert.deepEqual(parseField('1-5', 1, 31), [1, 2, 3, 4, 5])
})

test('parseField: 范围+步进', () => {
  assert.deepEqual(parseField('0-10/5', 0, 59), [0, 5, 10])
})

test('parseField: 单值', () => {
  assert.deepEqual(parseField('5', 0, 59), [5])
})

test('parseField: 非法值报错', () => {
  assert.throws(() => parseField('60', 0, 59))
  assert.throws(() => parseField('a', 0, 59))
  assert.throws(() => parseField('1/', 0, 59))
  assert.throws(() => parseField('*/0', 0, 59))
  assert.throws(() => parseField('9-1', 0, 23)) // 范围起始大于结束
})

test('parseCron: 基本表达式', () => {
  const spec = parseCron('0 10 * * *')
  assert.deepEqual(spec.minutes, [0])
  assert.deepEqual(spec.hours, [10])
  assert.equal(spec.daysOfMonth.length, 31)
  assert.deepEqual(spec.months, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
  assert.equal(spec.daysOfWeek.length, 8)
})

test('parseCron: 周 7 视为 0（Sunday）', () => {
  const spec = parseCron('0 0 * * 7')
  assert.deepEqual(spec.daysOfWeek, [0])
  const spec2 = parseCron('0 0 * * 0')
  assert.deepEqual(spec2.daysOfWeek, [0])
})

test('parseCron: 字段数错误', () => {
  assert.throws(() => parseCron('0 10 * *'))
  assert.throws(() => parseCron('0 10 * * * *'))
})

test('nextOccurrence: 每天 10 点（UTC）', () => {
  const spec = parseCron('0 10 * * *')
  const from = new Date('2026-08-17T05:30:00.000Z')
  const next = nextOccurrence(spec, from)
  assert.equal(utc(next), '2026-08-17T10:00:00.000Z')
})

test('nextOccurrence: 已过今日 10 点 → 明天', () => {
  const spec = parseCron('0 10 * * *')
  const from = new Date('2026-08-17T11:30:00.000Z')
  const next = nextOccurrence(spec, from)
  assert.equal(utc(next), '2026-08-18T10:00:00.000Z')
})

test('nextOccurrence: 每 15 分钟', () => {
  const spec = parseCron('*/15 * * * *')
  const from = new Date('2026-08-17T10:07:00.000Z')
  const next = nextOccurrence(spec, from)
  assert.equal(utc(next), '2026-08-17T10:15:00.000Z')
})

test('nextOccurrence: 工作日 9 点（周一至周五）', () => {
  // 2026-08-17 是周一
  const spec = parseCron('0 9 * * 1-5')
  const from = new Date('2026-08-17T08:00:00.000Z')
  const next = nextOccurrence(spec, from)
  assert.equal(utc(next), '2026-08-17T09:00:00.000Z')
  // 周六 8 点 → 周一
  const fromSat = new Date('2026-08-22T08:00:00.000Z') // 周六
  assert.equal(utc(nextOccurrence(spec, fromSat)), '2026-08-24T09:00:00.000Z') // 周一
})

test('nextOccurrence: 每月 1 日 0 点', () => {
  const spec = parseCron('0 0 1 * *')
  const from = new Date('2026-08-17T00:00:00.000Z')
  assert.equal(utc(nextOccurrence(spec, from)), '2026-09-01T00:00:00.000Z')
})

test('nextOccurrence: 每分钟（* * * * *）', () => {
  const spec = parseCron('* * * * *')
  const from = new Date('2026-08-17T10:30:45.000Z')
  assert.equal(utc(nextOccurrence(spec, from)), '2026-08-17T10:31:00.000Z')
})

test('nextOccurrence: 2026-08-17 是周一（验证基准）', () => {
  assert.equal(new Date('2026-08-17T00:00:00Z').getUTCDay(), 1)
  assert.equal(new Date('2026-08-22T00:00:00Z').getUTCDay(), 6) // 周六
  assert.equal(new Date('2026-08-24T00:00:00Z').getUTCDay(), 1) // 周一
})

test('nextOccurrence: 跨年边界', () => {
  const spec = parseCron('0 0 1 1 *') // 每年 1 月 1 日 0 点
  const from = new Date('2026-12-31T20:00:00.000Z')
  assert.equal(utc(nextOccurrence(spec, from)), '2027-01-01T00:00:00.000Z')
})

test('nextOccurrence: 2月30 不存在（非法配错场景 5 年内无结果报错）', () => {
  const spec = parseCron('0 0 30 2 *') // 2月30 永不存在
  assert.throws(() => nextOccurrence(spec, new Date('2026-08-17T00:00:00Z')))
})

test('nextOccurrences: 未来 3 次', () => {
  const times = nextOccurrences('0 10 * * *', new Date('2026-08-17T09:00:00Z'), 3)
  assert.deepEqual(times.map(utc), [
    '2026-08-17T10:00:00.000Z',
    '2026-08-18T10:00:00.000Z',
    '2026-08-19T10:00:00.000Z',
  ])
})

test('nextOccurrences: 5 字段复杂表达式 每月1日周一0点', () => {
  // cron 标准语义：日与周同时指定时用 OR。
  // 0 0 1-7 * 1 = 每月「1-7 号的任意一天」或「任意周一」的 0 点。
  // 2026-08-17 是周一（非 1-7 日但满足周=1）→ 当天 0 点已过 → 2026-08-24 是下一个周一。
  // 2026-09-07 也是周一，但 8-24 更早。
  const spec = parseCron('0 0 1-7 * 1')
  const from = new Date('2026-08-17T00:00:00Z')
  assert.equal(utc(nextOccurrence(spec, from)), '2026-08-24T00:00:00.000Z')
})
