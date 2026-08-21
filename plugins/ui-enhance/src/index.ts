/**
 * ui-enhance — Node（宿主）半身
 *
 * 增强能力（宿主侧）：
 *   ├─ ④ 快捷打开 VS Code：注册 `/api/ui-enhance/open-in-editor` 路由，
 *   │     client 半身按钮 fetch 该路由 → 本侧 `code <workspace>` 打开编辑器。
 *   │     通道参考 dsh-webui 的 `/api/file-explorer`（ctx.webServer 服务）。
 *   └─ 其余主体能力在 client 半身（src/client/），Node 侧保持轻量。
 */

import { spawn, spawnSync } from 'node:child_process'
import { promises as fsp, watch } from 'node:fs'
import { resolve, sep, join, relative } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'

export const name = 'ui-enhance'

/** Services required to register the route and resolve a default workspace. */
export const inject = ['webServer', 'workspaceRegistry']

const ROUTE_PREFIX = '/api/ui-enhance'

/** 宿主 webServer 服务的路由注册契约（与 dsh-webui 相同的扩展面）。 */
declare module '@deepseek-ai/cordis' {
  interface Context {
    webServer: {
      register(route: {
        kind: 'exact' | 'prefix'
        path: string
        handler: (req: IncomingMessage, res: ServerResponse) => void
      }): () => void
    }
    workspaceRegistry: {
      list(): { id: string, title: string, path: string }[]
    }
  }
}

type Req = IncomingMessage
type Res = ServerResponse

/** 读取请求体（JSON），空体视为 {}。 */
function readBody(req: Req): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8')
        resolve(raw ? JSON.parse(raw) : {})
      } catch {
        resolve({})
      }
    })
    req.on('error', () => resolve({}))
  })
}

/** 写 JSON 响应。 */
function json(res: Res, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

/** IDE 命令映射（与 client 的 IDE_OPTIONS 保持一致）。 */
const EDITOR_COMMANDS: Record<string, string> = {
  vscode: 'code',
  cursor: 'cursor',
  windsurf: 'windsurf',
  trae: 'trae',
}

/** 检测本机已安装的 IDE（命令存在于 PATH）。返回可用 editor id 列表（按 IDE_OPTIONS 顺序）。 */
function listAvailableEditors(): string[] {
  const ORDER = ['vscode', 'cursor', 'windsurf', 'trae']
  const available: string[] = []
  for (const id of ORDER) {
    const cmd = EDITOR_COMMANDS[id]
    const r = spawnSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' })
    if (r.status === 0) available.push(id)
  }
  return available
}

/** 打开给定编辑器打开工作区目录或具体文件。editor 为空/未知时回退 vscode。 */
function openInEditor(workspacePath: string, editor = 'vscode', fileRel?: string): Promise<{ ok: boolean, message: string }> {
  if (!workspacePath || typeof workspacePath !== 'string') {
    return Promise.resolve({ ok: false, message: 'missing workspace path' })
  }
  const cmd = EDITOR_COMMANDS[editor] ?? 'code'
  // 打开具体文件：目标为相对路径（限定在工作区内），传给 IDE 打开单文件
  const target = fileRel ? resolve(workspacePath, fileRel) : workspacePath
  return new Promise((resolve) => {
    const child = spawn(cmd, [target], {
      stdio: 'ignore',
      detached: true,
    })
    child.on('error', (err) => resolve({ ok: false, message: `${cmd} launch failed: ${err.message}` }))
    child.on('spawn', () => {
      child.unref()
      resolve({ ok: true, message: `${cmd} opened ${target}` })
    })
  })
}

/**
 * 获取工作区根。
 * - 传入 sessionId 时：按「会话 → 所属 workspace」映射跟随当前会话（切换会话即换目录）
 * - 无 sessionId 或找不到时：回退注册表第一个
 */
function resolveWorkspace(ctx: Context, sessionId?: string): string {
  const workspaces = ctx.workspaceRegistry.list()
  if (sessionId) {
    // 运行时的 Workspace 实体含 sessionIds（类型 stub 未声明，用断言访问）
    const owned = workspaces.find((w) =>
      (w as { sessionIds?: readonly string[] }).sessionIds?.includes(sessionId))
    if (owned?.path) return owned.path
  }
  return workspaces[0]?.path ?? ''
}

/** 当前所有工作区路径（SSE 全量监听：任一工作区变化都广播）。 */
function listWorkspaceRoots(ctx: Context): string[] {
  return ctx.workspaceRegistry.list().map((w) => w.path).filter(Boolean)
}

/** 需要跳过的目录（不进入递归/展示）。 */
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '.turbo', 'coverage', '.cache', '.DS_Store'])

/**
 * 解析 `git status --porcelain=v1` 输出为 {相对路径: 状态码}。
 * 例：` M plugins/ui-enhance/src/index.ts` → key="plugins/ui-enhance/src/index.ts", code="M"
 *     `?? docs/x.md` → "docs/x.md" → "??"
 * 注意：git 用 / 作分隔符，与平台无关；保留 as-is 便于前端匹配。
 */
function loadGitStatus(cwd: string): Map<string, string> {
  const map = new Map<string, string>()
  if (!cwd) return map
  const r = spawnSync('git', ['status', '--porcelain=v1', '--no-renames'], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 8000,
  })
  if (r.status !== 0) return map
  for (const line of r.stdout.split('\n')) {
    if (!line || line.length < 4) continue
    const code = line.slice(0, 2).trim() || '?'
    const path = line.slice(3).replace(/"/g, '')
    map.set(path, code)
    // 也标记父目录（简化：精确匹配即可，前端用前缀匹配）
  }
  return map
}

/** git 汇总统计（供侧栏底部显示）：分支 + 计数 + 最近提交。 */
function loadGitSummary(cwd: string): { branch: string | null, modified: number, added: number, deleted: number, untracked: number, lastCommit: string | null, ahead: number | null } {
  const empty = { branch: null, modified: 0, added: 0, deleted: 0, untracked: 0, lastCommit: null, ahead: null }
  if (!cwd) return empty
  // 分支
  const b = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, encoding: 'utf8', stdio: ['ignore','pipe','ignore'], timeout: 5000 })
  const branch = b.status === 0 ? (b.stdout.trim() || null) : null
  // ahead/behind（相对 upstream）
  let ahead: number | null = null
  const u = spawnSync('git', ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'], { cwd, encoding: 'utf8', stdio: ['ignore','pipe','ignore'], timeout: 5000 })
  if (u.status === 0) {
    const m = u.stdout.trim().split(/\s+/)
    if (m.length === 2 && !isNaN(+m[0])) ahead = +m[0]
  }
  // status 计数
  const s = spawnSync('git', ['status', '--porcelain=v1', '--no-renames'], { cwd, encoding: 'utf8', stdio: ['ignore','pipe','ignore'], timeout: 8000 })
  let modified = 0, added = 0, deleted = 0, untracked = 0
  if (s.status === 0) {
    for (const line of s.stdout.split('\n')) {
      if (!line || line.length < 4) continue
      const code = line.slice(0, 2)
      const first = code[0], second = code[1]
      if (code === '??') untracked++
      else if (first === 'A' || second === 'A') added++
      else if (first === 'D' || second === 'D') deleted++
      else modified++
    }
  }
  // 最近提交
  let lastCommit: string | null = null
  const c = spawnSync('git', ['log', '-1', '--format=%h %s'], { cwd, encoding: 'utf8', stdio: ['ignore','pipe','ignore'], timeout: 5000 })
  if (c.status === 0) lastCommit = c.stdout.trim() || null
  return { branch, modified, added, deleted, untracked, lastCommit, ahead }
}

/**
 * 列出工作区根下 dir（相对路径）的单层目录内容。
 * 返回 { name, path, type, git, size }[]（目录在前，字母序）。
 */
async function readTree(root: string, relDir: string): Promise<{ name: string, path: string, type: 'dir' | 'file', git: string | null, size: number | null }[]> {
  const dirAbs = resolve(root, relDir)
  // containment：必须落在 root 内
  if (dirAbs !== root && !dirAbs.startsWith(root + sep)) {
    throw new Error('path outside workspace')
  }
  const entries = await fsp.readdir(dirAbs, { withFileTypes: true })
  const gitMap = loadGitStatus(root)
  const out: { name: string, path: string, type: 'dir' | 'file', git: string | null, size: number | null }[] = []
  for (const ent of entries) {
    if (ent.name === '.git' || ent.name === 'node_modules' || ent.name.startsWith('.')) continue
    const rel = relDir ? join(relDir, ent.name) : ent.name
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name)) continue
      out.push({ name: ent.name, path: rel, type: 'dir', git: gitMap.get(rel) ?? null, size: null })
    } else if (ent.isFile()) {
      let size: number | null = null
      try { size = (await fsp.stat(join(dirAbs, ent.name))).size } catch { /* ignore */ }
      out.push({ name: ent.name, path: rel, type: 'file', git: gitMap.get(rel) ?? null, size })
    }
  }
  // 目录在前，各自字母序
  out.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : (a.type === 'dir' ? -1 : 1)))
  return out
}

/* ── 实时文件变更推送（SSE + fs.watch）────────────────────────────── */

/** 已连接的 SSE 客户端（响应对象集合）。 */
const sseClients = new Set<ServerResponse>()

/** 文件变更 debounce 定时器。 */
let sseTimer: ReturnType<typeof setTimeout> | null = null

/** 向所有 SSE 客户端广播一次变更事件（防抖 150ms）。 */
function broadcastChanged(): void {
  if (sseTimer !== null) return
  sseTimer = setTimeout(() => {
    sseTimer = null
    for (const res of sseClients) {
      try { res.write('event: changed\ndata: {}\n\n') } catch { /* client gone */ }
    }
  }, 150)
}

/** 路径是否需要跳过（.git/node_modules 内部噪音不广播，避免高频刷屏）。 */
function isNoisePath(p: string): boolean {
  const parts = p.split(sep)
  return parts.some((part) => part === '.git' || part === 'node_modules')
}

/** 启动对多个工作区根的文件系统监听（macOS/FSEvents 支持 recursive）。返回清理函数。 */
function startWorkspaceWatchers(roots: string[]): () => void {
  const watchers: Array<ReturnType<typeof watch>> = []
  for (const root of roots) {
    try {
      const w = watch(root, { recursive: true }, (_eventType, filename) => {
        if (!filename) return
        const p = String(filename)
        if (isNoisePath(p)) return
        broadcastChanged()
      })
      watchers.push(w)
    } catch (err) {
      // recursive 在某些平台不可用：降级为非递归（至少捕获根级变化）
      try {
        const w = watch(root, (_eventType, filename) => {
          if (!filename) return
          if (isNoisePath(String(filename))) return
          broadcastChanged()
        })
        watchers.push(w)
      } catch (err2) {
        console.warn(`[ui-enhance] fs.watch 启动失败 (${root}):`, String(err2))
      }
    }
  }
  return () => {
    for (const res of sseClients) {
      try { res.end() } catch { /* noop */ }
    }
    sseClients.clear()
    if (sseTimer !== null) { clearTimeout(sseTimer); sseTimer = null }
    for (const w of watchers) { try { w.close() } catch { /* noop */ } }
  }
}

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: (req, res) => {
      void handle(ctx, req, res)
    },
  }), 'ui-enhance: routes')

  // 文件系统监听：全部工作区变化（git 提交/文件增删）→ SSE 广播 → 前端实时刷新
  ctx.effect(() => {
    let cleanup: (() => void) | null = null
    try {
      const roots = listWorkspaceRoots(ctx)
      if (roots.length > 0) cleanup = startWorkspaceWatchers(roots)
    } catch (err) {
      console.warn('[ui-enhance] watcher 启动失败:', String(err))
    }
    return () => {
      if (cleanup) { cleanup(); cleanup = null }
    }
  }, 'ui-enhance: workspace watcher')
}

/** 路由分发。 */
async function handle(ctx: Context, req: Req, res: Res): Promise<void> {
  const url = (req.url ?? '').split('?')[0]
  const search = (req.url ?? '').split('?')[1] ?? ''
  const params = new URLSearchParams(search)
  const suffix = url.slice(ROUTE_PREFIX.length)

  if (req.method === 'GET' && suffix === '/editors') {
    const editors = listAvailableEditors()
    json(res, 200, { editors })
    return
  }

  if (req.method === 'GET' && suffix === '/tree') {
    try {
      const sessionId = params.get('session') ?? undefined
      const root = resolveWorkspace(ctx, sessionId)
      if (!root) {
        json(res, 500, { error: 'no workspace' })
        return
      }
      const dir = params.get('dir') ?? ''
      const entries = await readTree(root, dir)
      // 顶层额外返回 git 汇总（分支 + 计数 + 最近提交），供侧栏底部显示
      const git = loadGitSummary(root)
      json(res, 200, { root, dir, entries, git })
    } catch (err) {
      json(res, 500, { error: `tree failed: ${String(err instanceof Error ? err.message : err)}` })
    }
    return
  }

  if (req.method === 'GET' && suffix === '/events') {
    // SSE：文件系统变化时推送 `changed` 事件，前端收到即刷新 git 徽标（实时）
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    // 发送初始注释，确保连接建立
    res.write(': connected\n\n')
    sseClients.add(res)
    req.on('close', () => { sseClients.delete(res) })
    return
  }

  if (req.method === 'POST' && suffix === '/open-in-editor') {
    const body = await readBody(req)
    let workspace = String(body.workspace ?? body.path ?? '')
    if (!workspace) {
      // 未显式指定时：优先「会话所属工作区」（跟随当前会话），回退注册表第一个
      const sessionId = body.session ? String(body.session) : undefined
      workspace = resolveWorkspace(ctx, sessionId)
      if (!workspace) {
        json(res, 500, { ok: false, message: 'no workspace' })
        return
      }
    }
    const editor = String(body.editor ?? 'vscode')
    const fileRel = typeof body.file === 'string' && body.file ? body.file : undefined
    const result = await openInEditor(workspace, editor, fileRel)
    json(res, result.ok ? 200 : 400, result)
    return
  }

  json(res, 404, { error: `no route for ${req.method} ${suffix}` })
}
