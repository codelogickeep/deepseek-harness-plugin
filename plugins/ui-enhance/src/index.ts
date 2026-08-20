/**
 * ui-enhance — Node（宿主）半身
 *
 * 增强能力（宿主侧）：
 *   ├─ ④ 快捷打开 VS Code：注册 `/api/ui-enhance/open-in-editor` 路由，
 *   │     client 半身按钮 fetch 该路由 → 本侧 `code <workspace>` 打开编辑器。
 *   │     通道参考 dsh-webui 的 `/api/file-explorer`（ctx.webServer 服务）。
 *   └─ 其余主体能力在 client 半身（src/client/），Node 侧保持轻量。
 */

import { spawn } from 'node:child_process'
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
  insiders: 'code-insiders',
}

/** 打开给定编辑器打开工作区目录。editor 为空/未知时回退 vscode。 */
function openInEditor(workspacePath: string, editor = 'vscode'): Promise<{ ok: boolean, message: string }> {
  if (!workspacePath || typeof workspacePath !== 'string') {
    return Promise.resolve({ ok: false, message: 'missing workspace path' })
  }
  const cmd = EDITOR_COMMANDS[editor] ?? 'code'
  return new Promise((resolve) => {
    const child = spawn(cmd, [workspacePath], {
      stdio: 'ignore',
      detached: true,
    })
    child.on('error', (err) => resolve({ ok: false, message: `${cmd} launch failed: ${err.message}` }))
    child.on('spawn', () => {
      child.unref()
      resolve({ ok: true, message: `${cmd} opened ${workspacePath}` })
    })
  })
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
  const suffix = url.slice(ROUTE_PREFIX.length)

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
    const result = await openInEditor(workspace, editor)
    json(res, result.ok ? 200 : 400, result)
    return
  }

  json(res, 404, { error: `no route for ${req.method} ${suffix}` })
}
