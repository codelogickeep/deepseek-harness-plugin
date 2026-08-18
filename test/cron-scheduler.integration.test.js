/**
 * cron-scheduler 集成测试：用 mock ctx 驱动 CronSchedulerRuntime，
 * 完整验证「配置 → due 检测 → followup 投递 → 审计事件 → lastFired 回写」链路。
 */
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'

const plugin = await import(new URL('../plugins/cron-scheduler/cron-scheduler.mjs', import.meta.url).href)

/** 内存 fs mock（resolve/readText/writeText） */
function makeMemoryFs(initialFiles = {}) {
  const files = new Map(Object.entries(initialFiles))
  return {
    files,
    service: {
      async resolve(p) { return { targetKey: `mem:${p}`, displayPath: p } },
      async readText(target) {
        const p = target.displayPath
        if (!files.has(p)) {
          const err = new Error(`ENOENT: no such file ${p}`)
          err.code = 'ENOENT'
          throw err
        }
        return files.get(p)
      },
      async writeText(target, text) {
        files.set(target.displayPath, text)
        return undefined
      },
    },
  }
}

function cfgText(tasks) {
  return JSON.stringify({ timezone: 'Asia/Shanghai', schedules: tasks }, null, 2)
}

function makeCtx(configText, schedulesPath = '/tmp/cron-test.json') {
  const memFs = makeMemoryFs(configText ? { [schedulesPath]: configText } : {})
  const followed = []
  const appended = []
  const agents = []
  const ctx = {
    get() { return undefined },
    logger: { warn: mock.fn(), info: mock.fn() },
    fs: memFs.service,
    agents: {
      roots() { return agents },
      get(id) { return agents.find((a) => a.id === id) },
    },
    // 供 integration 使用，不真正跑 Cordis effect（只验证 runtime 类）
  }
  const makeAgent = (id, status = 'running') => {
    const agent = {
      id,
      status,
      session: { append(type, data) { appended.push({ type, data }) } },
      followup(msg) { followed.push({ id, msg }) },
    }
    agents.push(agent)
    return agent
  }
  return { ctx, memFs, followed, appended, makeAgent }
}

test('plugin 元数据：name/inject', () => {
  assert.equal(plugin.name, 'cron-scheduler')
  assert.ok(plugin.inject.includes('fs'))
  assert.ok(plugin.inject.includes('agents'))
})

test('formatReminder: 带标题与不带标题', () => {
  assert.match(plugin.formatReminder({ title: '每日 JIRA', message: '看缺陷' }), /每日 JIRA/)
  assert.match(plugin.formatReminder({ title: '每日 JIRA', message: '看缺陷' }), /看缺陷/)
  assert.match(plugin.formatReminder({ message: '无标题' }), /【定时提醒】/)
  assert.match(plugin.formatReminder({ message: '无标题' }), /无标题/)
})

test('完整触发链路：到点 followup + 不写自定义事件 + 回写 lastFired', async () => {
  // 配置一个「过去 1 分钟内命中」的任务（当前时刻人为设成整 5 分钟后）
  const cron = '*/5 * * * *'
  const schedulesPath = '/tmp/cron-integration.json'
  const { ctx, followed, appended, memFs, makeAgent } = makeCtx(
    cfgText([{ id: 'every5', cron, message: '五分钟提醒', title: '测试提醒' }]),
    schedulesPath,
  )
  makeAgent('session-target-001', 'idle')

  const runtime = new plugin.CronSchedulerRuntime(ctx, schedulesPath, {})
  await runtime.tryStart()

  // 确定性验证完整链路：cron 每小时整点，固定 now 注入
  // T = 12:30（上一整点 12:00 在 lookback 内）→ 触发
  const T = new Date('2026-08-17T12:30:00.000Z')
  const fired = await runtime.tick(T)
  assert.equal(fired.length, 1)
  assert.equal(followed.length, 1)
  assert.ok(followed[0].msg.content[0].text.includes('测试提醒'))
  assert.ok(followed[0].msg.source.plugin === 'cron-scheduler')
  assert.ok(followed[0].msg.content[0].text.includes('【定时提醒 · 测试提醒】'))

  // 约束：不得往会话日志写 DSH 未知的自定义事件类型（会被 read 路径拒读）
  assert.equal(appended.length, 0, '插件不应写自定义 session 事件（cron/dispatch 等）')

  // 回写
  const written = JSON.parse(memFs.files.get(schedulesPath))
  assert.equal(typeof written.schedules[0].lastFiredAt, 'number')
  assert.ok(written.schedules[0].lastFiredAt > 0)
})

test('不重复触发：同一命中点 tick 两次只投一次（确定性）', async () => {
  const schedulesPath = '/tmp/cron-dedup.json'
  const { ctx, followed, memFs, makeAgent } = makeCtx(
    cfgText([{ id: 'm', cron: '0 * * * *', message: 'M', title: 'T' }]),
    schedulesPath,
  )
  makeAgent('s-1', 'idle')

  const runtime = new plugin.CronSchedulerRuntime(ctx, schedulesPath, {})
  await runtime.tryStart()

  // T0=12:01（本小时整点刚过 1 分钟，lookback 内）→ 触发整点命中
  const T0 = new Date('2026-08-17T12:01:00.000Z')
  const f0 = await runtime.tick(T0)
  assert.equal(f0.length, 1)
  assert.equal(followed.length, 1)

  // T1=12:30（同小时，无新整点）→ 不重复
  const f1 = await runtime.tick(new Date('2026-08-17T12:30:00.000Z'))
  assert.equal(f1.length, 0)
  assert.equal(followed.length, 1)

  // T2=14:00（跨到 14:00 整点）→ 触发（13:00/14:00 命中合并为一次投递）
  const f2 = await runtime.tick(new Date('2026-08-17T14:00:01.000Z'))
  assert.equal(f2.length, 1)
  assert.equal(followed.length, 2)

  // 14:05 再 tick：14:00 命中后 next 是 15:00，不在窗口 → 不重复
  const f3 = await runtime.tick(new Date('2026-08-17T14:05:00.000Z'))
  assert.equal(f3.length, 0)
  assert.equal(followed.length, 2)

  // 跨到 15:00 整点 → 又一次触发
  const f4 = await runtime.tick(new Date('2026-08-17T15:00:01.000Z'))
  assert.equal(f4.length, 1)
  assert.equal(followed.length, 3)
})

test('disabled 任务不触发', async () => {
  const schedulesPath = '/tmp/cron-disabled.json'
  const { ctx, followed, makeAgent } = makeCtx(
    cfgText([{ id: 'off', cron: '* * * * *', message: '关', enabled: false }]),
    schedulesPath,
  )
  makeAgent('s-2', 'idle')
  const runtime = new plugin.CronSchedulerRuntime(ctx, schedulesPath, {})
  await runtime.tryStart()
  await runtime.tick()
  assert.equal(followed.length, 0)
})

test('配置不存在：不崩溃、不触发', async () => {
  const { ctx, followed } = makeCtx(undefined)
  const runtime = new plugin.CronSchedulerRuntime(ctx, '/tmp/does-not-exist.json', {})
  await runtime.tryStart()
  await runtime.tick()
  assert.equal(followed.length, 0)
})

test('resolveSchedulesPath: config 优先', () => {
  const ctx = { get() { return undefined } }
  assert.equal(plugin.resolveSchedulesPath(ctx, { schedulesPath: '/x/y.json' }), '/x/y.json')
})

test('lastFired 状态文件兜底：主配置沙箱外不可写时仍跨 tick/跨重启防重复触发（死循环根除）', async () => {
  const schedulesPath = '/tmp/cron-sandbox-outer.json' // 模拟 ~/.dsh 主配置
  const config = { coreDir: new URL('../plugins/cron-scheduler', import.meta.url).pathname }
  const statePath = plugin.stateFilePathOf(config) // config/cron-scheduler-state.json

  // 1) 第一实例：主配置 writeText 抛 FS_SANDBOX_DENIED（模拟沙箱外），状态文件正常写入
  const files = new Map([[schedulesPath, cfgText([{ id: 'everymin', cron: '* * * * *', message: 'per', title: 'T' }])]])
  const followed = []
  const agents = []
  const makeAgent = (id, status = 'idle') => {
    const a = { id, status, session: { append() {} }, followup(m) { followed.push({ id, msg: m }) } }
    agents.push(a)
    return a
  }
  const fsDenyConfig = {
    files,
    service: {
      async resolve(p) { return { targetKey: `mem:${p}`, displayPath: p } },
      async readText(target) {
        const p = target.displayPath
        if (!files.has(p)) { const err = new Error(`ENOENT: no such file ${p}`); err.code = 'ENOENT'; throw err }
        return files.get(p)
      },
      async writeText(target, text) {
        if (target.displayPath === schedulesPath) {
          const err = new Error(`cannot write "${target.displayPath}": file access denied under workspace-write mode`)
          err.code = 'FS_SANDBOX_DENIED'
          throw err
        }
        files.set(target.displayPath, text)
        return undefined
      },
    },
  }
  const ctx = {
    get() { return undefined },
    logger: { warn: mock.fn(), info: mock.fn() },
    fs: fsDenyConfig.service,
    agents: { roots() { return agents }, get(id) { return agents.find((a) => a.id === id) } },
  }
  makeAgent('main-session')

  const r1 = new plugin.CronSchedulerRuntime(ctx, schedulesPath, config)
  await r1.tryStart()
  // T=12:00:30（12:00 整点在 lookback 内）→ 触发；markFired 用 now=12:00:30
  const T = new Date('2026-08-17T12:00:30.000Z')
  const fired1 = await r1.tick(T)
  assert.equal(fired1.length, 1, '第一次 tick 应触发')
  assert.equal(followed.length, 1)
  // 主配置没被写坏，且没有 lastFiredAt
  assert.ok(!JSON.parse(files.get(schedulesPath)).schedules[0].lastFiredAt, '主配置应保持未被修改（沙箱拒）')
  // 状态文件写入了 lastFired
  const stateText = files.get(statePath)
  assert.ok(stateText, '应写入状态文件')
  const stateParsed = JSON.parse(stateText)
  assert.equal(typeof stateParsed.lastFired.everymin, 'number', '状态文件应记录 everymin lastFired')

  // 2) 同一实例下 30s 后（同一分钟窗口已消费）：不重复触发同一命中点
  const fired1b = await r1.tick(new Date('2026-08-17T12:00:45.000Z'))
  assert.equal(fired1b.length, 0, '同一分钟窗口内不应重复触发')
  assert.equal(followed.length, 1)

  // 3) 跨实例（模拟 DSH 重启）：同一时刻重新起 runtime，从状态文件恢复 lastFired → 不重复触发已消费命中点
  const r2 = new plugin.CronSchedulerRuntime(ctx, schedulesPath, config)
  await r2.tryStart()
  const fired2 = await r2.tick(new Date('2026-08-17T12:00:59.000Z'))
  assert.equal(fired2.length, 0, '重启后靠状态文件恢复 lastFired，不应重复触发已消费命中点')
  assert.equal(followed.length, 1)

  // 4) 跨实例且推进到新命中点（12:01 整点）：应触发（正常每分钟节奏），且只触发一次
  const fired3 = await r2.tick(new Date('2026-08-17T12:01:01.000Z'))
  assert.equal(fired3.length, 1, '推进到新的整点命中点应触发')
  assert.equal(followed.length, 2)
  const fired3b = await r2.tick(new Date('2026-08-17T12:01:30.000Z'))
  assert.equal(fired3b.length, 0, '新命中点消费后不应重复')
  assert.equal(followed.length, 2)
})
