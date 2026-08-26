#!/usr/bin/env node
/**
 * restart-dsh-and-verify.mjs — 重启 DSH（launchd: com.deepseek.dsh）并验证关键结果
 *
 * 独立于 DSH 进程运行（nohup/后台）：因为重启会终止 DSH 宿主自身，
 * 本脚本设计为分离执行，完成「重启 → 等待就绪 → 验证会话历史 → 检查 bridge」，
 * 全程把结果写入日志文件，便于重启后人工核对。
 *
 * 用法：
 *   node tools/restart-dsh-and-verify.mjs            # 立即重启（kickstart -k）
 *   node tools/restart-dsh-and-verify.mjs --dry-run   # 只验证当前 DSH 状态，不重启
 */
import { execFileSync, spawn } from 'node:child_process'
import { writeFileSync, appendFileSync } from 'node:fs'

const DSH_LABEL = 'com.deepseek.dsh'
const BRIDGE_LABEL = 'com.dsh.dingtalk-bridge'
const BASE = 'http://127.0.0.1:3080'
const LOG = '/tmp/dsh-restart-verify.log'
const dryRun = process.argv.includes('--dry-run')

const log = (line) => {
  const ts = new Date().toISOString()
  const s = `[${ts}] ${line}`
  console.log(s)
  try { appendFileSync(LOG, s + '\n') } catch {}
}
const logHead = () => {
  try { writeFileSync(LOG, `# DSH restart+verify @ ${new Date().toISOString()}\n`) } catch {}
}

async function call(method, payload) {
  const rpcId = crypto.randomUUID()
  const res = await fetch(`${BASE}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(15000),
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload: payload ?? {} }),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return (await res.json()).result
}

async function waitForDsh(maxMs = 180_000) {
  const start = Date.now()
  while (Date.now() - start < maxMs) {
    try {
      const r = await call('session.list', {})
      if (r?.ok) return true
    } catch {}
    await new Promise((r) => setTimeout(r, 2000))
  }
  return false
}

async function verify() {
  const results = []
  const sessions = ['session-12367081-a592-4494-9bd0-364eca9c3998', 'session-f8605eda-94e9-4993-b64a-e51e71c186b9']
  for (const sid of sessions) {
    try {
      const r = await call('session.history', { sessionId: sid, maxMessages: 2 })
      results.push(`${sid.slice(0, 20)} => history ${r?.ok ? 'OK' : `FAIL ${JSON.stringify(r?.error)?.slice(0, 100)}`}`)
    } catch (e) {
      results.push(`${sid.slice(0, 20)} => history ERROR ${e.message}`)
    }
  }
  try {
    const r = await call('session.list', {})
    results.push(`session.list => ${r?.ok ? `OK (${r.value?.items?.length ?? '?'} sessions)` : 'FAIL'}`)
  } catch (e) {
    results.push(`session.list => ERROR ${e.message}`)
  }
  return results
}

async function launchctlStatus(label) {
  try {
    const out = execFileSync('launchctl', ['print', `gui/${process.getuid()}/${label}`], { encoding: 'utf8' })
    const m = out.match(/state = (\w+)/)
    return m ? m[1] : 'unknown'
  } catch {
    return 'not-found'
  }
}

async function main() {
  logHead()
  log(`starting (dryRun=${dryRun})`)

  const stateBefore = await launchctlStatus(DSH_LABEL)
  log(`dsh launchctl state before: ${stateBefore}`)

  if (!dryRun) {
    log(`kickstart -k ${DSH_LABEL} ...`)
    try {
      execFileSync('launchctl', ['kickstart', '-k', `gui/${process.getuid()}/${DSH_LABEL}`], { encoding: 'utf8' })
      log('kickstart returned (launchd will restart DSH)')
    } catch (e) {
      log(`kickstart failed: ${e.message}`)
      process.exitCode = 1
    }
  }

  log('waiting for DSH to be ready...')
  const up = await waitForDsh()
  log(`DSH ready: ${up ? 'YES' : 'NO (timeout)'}`)

  const stateAfter = await launchctlStatus(DSH_LABEL)
  log(`dsh launchctl state after: ${stateAfter}`)
  const bridgeState = await launchctlStatus(BRIDGE_LABEL)
  log(`bridge launchctl state: ${bridgeState}`)

  if (up) {
    const results = await verify()
    for (const r of results) log(r)
    const allOk = results.every((r) => r.includes('OK'))
    log(allOk ? 'RESULT: ALL OK' : 'RESULT: SOME FAILURES (see above)')
  } else {
    log('RESULT: DSH did NOT come back up')
  }
  log('done')
}

main().catch((e) => log(`fatal: ${e.message}`))
