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
import { promises as fsp } from 'node:fs'
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

/** 获取当前工作区根（注册表第一个的 path）。 */
function resolveWorkspace(ctx: Context): string {
  const workspaces = ctx.workspaceRegistry.list()
  return workspaces[0]?.path ?? ''
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

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: (req, res) => {
      void handle(ctx, req, res)
    },
  }), 'ui-enhance: routes')
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
      const root = resolveWorkspace(ctx)
      if (!root) {
        json(res, 500, { error: 'no workspace' })
        return
      }
      const dir = params.get('dir') ?? ''
      const entries = await readTree(root, dir)
      // 顶层额外返回根信息 + git 分支
      let branch: string | null = null
      if (!dir) {
        const b = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
          cwd: root, encoding: 'utf8', stdio: ['ignore','pipe','ignore'], timeout: 5000,
        })
        if (b.status === 0) branch = b.stdout.trim() || null
      }
      json(res, 200, { root, dir, entries, branch })
    } catch (err) {
      json(res, 500, { error: `tree failed: ${String(err instanceof Error ? err.message : err)}` })
    }
    return
  }

  if (req.method === 'POST' && suffix === '/open-in-editor') {
    const body = await readBody(req)
    let workspace = String(body.workspace ?? body.path ?? '')
    if (!workspace) {
      // 未显式指定时，用「最近工作区」（注册表第一个）的路径
      try {
        const workspaces = ctx.workspaceRegistry.list()
        workspace = workspaces[0]?.path ?? ''
      } catch (err) {
        json(res, 500, { ok: false, message: `workspace registry unavailable: ${String(err)}` })
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
