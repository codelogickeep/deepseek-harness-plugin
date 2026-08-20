/**
 * browser-reader.mjs — DSH 宿主插件：浏览器阅读（真实浏览器渲染 + 确定性读页）
 *
 * 给 DSH Agent 一个「真浏览器阅读」能力：用 Playwright 驱动本机 Chromium/
 * Edge，打开 JS 渲染页面后**确定性**地读出渲染文本，而不是靠视觉模型猜。
 * 相比 DSH 内置 web_fetch（只拿 HTML，读不了 JS 渲染内容），这是完整浏览器。
 *
 * 工具集（聚焦阅读，交互从简）：
 *   - web_read           打开 URL/本地文件，返回渲染后的文本正文（含标题/URL）
 *   - web_read_continue  往下滚动加载懒加载内容，继续读
 *   - web_read_console   读取页面控制台错误（判断页面健康度）
 *   - web_read_screenshot 截图保存到工作区（给人类复核）
 *   - web_read_close     关闭页面释放资源
 *
 * 设计原则：
 *   - 无视觉确定性阅读：text 模式读渲染正文、html 模式读 outerHTML，靠 DOM 不靠像素
 *   - 本地路径/目录自动静态伺服（127.0.0.1 临时端口，只读）
 *   - 远程域名默认拒绝，须把域名加进 allowedHosts（安全默认）
 *   - 一条 DSH 进程一个共享浏览器（多会话复用），页面按 pageId 隔离
 *   - playwright-core 从 DSH 宿主依赖解析（安装脚本已在 profile 装好）
 */

import { createServer } from 'node:http'
import { readFile, stat, mkdir } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

// ---- 静态配置 ----

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.pdf': 'application/pdf',
}

const DEFAULT_CONFIG = {
  headless: true,
  browserChannels: ['chrome', 'msedge', 'chromium'],
  viewportWidth: 1280,
  viewportHeight: 800,
  navigationTimeoutMs: 20000,
  actionTimeoutMs: 8000,
  screenshotDir: '.dsh-web-read',
  maxReadChars: 30000,
  maxConsoleMessages: 200,
  allowedHosts: [],
  keepAliveMs: 15 * 60 * 1000,
}

/** 页面里提取「正文」的脚本：优先 article/main 语义容器，回退 body 文本。 */
// 必须用「真实函数」而非字符串：playwright 的 page.evaluate 对字符串按表达式求值，
// 箭头函数字符串会被当作函数对象返回（而不是其返回值），导致 content 为函数而非文本。
// 本函数是纯函数（无外部闭包依赖），playwright 会自动序列化到浏览器上下文执行。
function EXTRACT_TEXT_FN() {
  const selectors = ['article', 'main article', '[role="main"]', 'main', '#content', '.content', '.post', '.entry-content', '.markdown-body'];
  let el = null;
  for (const sel of selectors) {
    const cand = document.querySelector(sel);
    if (cand && cand.innerText && cand.innerText.trim().length > 100) { el = cand; break; }
  }
  if (!el) el = document.body;
  if (!el) return '';
  return el.innerText.replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function safeStr(v) {
  if (v === null || v === undefined) return ''
  return String(v)
}

// ---- 本地静态伺服 ----

class StaticServers {
  constructor() {
    this.servers = new Map() // rootPath -> { server, baseUrl }
  }

  async serve(rootPath) {
    const existing = this.servers.get(rootPath)
    if (existing) return existing.baseUrl
    const server = createServer((req, res) => this._handle(req, res, rootPath))
    await new Promise((ok, fail) => {
      server.once('error', fail)
      server.listen(0, '127.0.0.1', () => ok())
    })
    const port = server.address().port
    const baseUrl = `http://127.0.0.1:${port}`
    this.servers.set(rootPath, { server, baseUrl })
    return baseUrl
  }

  _handle(req, res, rootPath) {
    let pathname
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname)
    } catch {
      res.writeHead(400)
      res.end('bad url')
      return
    }
    if (pathname.includes('..')) {
      res.writeHead(403)
      res.end('forbidden')
      return
    }
    const abs = join(rootPath, pathname)
    if (abs !== rootPath && !abs.startsWith(rootPath + '/') && process.platform !== 'win32' && !abs.startsWith(rootPath + '\\')) {
      res.writeHead(403)
      res.end('forbidden')
      return
    }
    stat(abs).then((info) => {
      if (info.isFile()) return abs
      // 目录/找不到 → SPA 回退 index.html
      return join(rootPath, 'index.html')
    }).then((file) => readFile(file)).then((buf) => {
      res.writeHead(200, { 'Content-Type': MIME[extname(abs)] || 'application/octet-stream' })
      res.end(buf)
    }).catch(() => {
      res.writeHead(404)
      res.end('not found')
    })
  }

  dispose() {
    for (const { server } of this.servers.values()) {
      try { server.close() } catch { /* ignore */ }
    }
    this.servers.clear()
  }
}

// ---- 浏览器管理器（单例，一个 DSH 进程共享一个浏览器）----

class BrowserManager {
  constructor() {
    this.browser = null
    this.pages = new Map()
    this.playwright = null
    this._nextPageId = 1
    this._nextSeq = 1
    this._idleTimer = null
    this._disposed = false
  }

  _loadPlaywright() {
    if (this.playwright) return this.playwright
    // 动态解析 playwright-core：从插件模块自身所在目录向上找 node_modules，
    // DSH 启动加载本插件时模块位置是 ~/.dsh/profiles/web/plugins/browser-reader/，
    // 其上的 ~/.dsh/profiles/web/node_modules 装着 playwright-core。
    const base = fileURLToPath(new URL('.', import.meta.url))
    const require = createRequire(base)
    try {
      this.playwright = require('playwright-core')
      return this.playwright
    } catch (err) {
      throw new Error(
        `无法加载 playwright-core：${err?.message ?? err}。`
        + '请先运行：cd ~/.dsh/profiles/web && pnpm add playwright-core（DSH profile 级依赖）',
      )
    }
  }

  async _launchBrowser(channels, headless) {
    const pw = this._loadPlaywright()
    let lastError = null
    for (const channel of channels) {
      try {
        const browser = await pw.chromium.launch({
          channel: channel !== 'chromium' ? channel : undefined,
          headless,
          args: ['--no-sandbox', '--disable-dev-shm-usage'],
        })
        if (browser === null || browser === undefined) throw new Error('launch returned null')
        return browser
      } catch (err) {
        lastError = err
      }
    }
    throw new Error(
      `无法启动浏览器（尝试通道 ${channels.join(', ')}）。最后错误：${safeStr(lastError?.message)}`,
    )
  }

  async _ensureBrowser(cfg) {
    if (this._idleTimer) clearTimeout(this._idleTimer)
    this._idleTimer = setTimeout(() => { this._disposeIfIdle() }, cfg.keepAliveMs)
    if (this.browser) return this.browser
    this.browser = await this._launchBrowser(cfg.browserChannels, cfg.headless)
    this.browser.on('disconnected', () => {
      for (const id of [...this.pages.keys()]) this.pages.delete(id)
      this.browser = null
    })
    return this.browser
  }

  async _disposeIfIdle() {
    if (this.pages.size > 0 || !this.browser) return
    try { await this.browser.close() } catch { /* ignore */ }
    this.browser = null
  }

  async open(url, cfg, signal) {
    this._throwIfAborted(signal)
    const browser = await this._ensureBrowser(cfg)
    const page = await browser.newPage({ viewport: { width: cfg.viewportWidth, height: cfg.viewportHeight } })
    const pageId = String(this._nextPageId++)
    const record = { pageId, page, console: [], failures: [], lastSeq: 0 }
    this.pages.set(pageId, record)

    page.on('console', (msg) => {
      record.console.push({ seq: this._nextSeq++, level: msg.type(), text: safeStr(msg.text()) })
      if (record.console.length > cfg.maxConsoleMessages) record.console.shift()
    })
    page.on('pageerror', (err) => {
      record.console.push({ seq: this._nextSeq++, level: 'error', text: `[pageerror] ${safeStr(err?.message)}` })
      if (record.console.length > cfg.maxConsoleMessages) record.console.shift()
    })
    page.on('requestfailed', (req) => {
      record.failures.push({ url: safeStr(req.url()), reason: safeStr(req.failure()?.errorText) })
    })

    try {
      await page.goto(url, { timeout: cfg.navigationTimeoutMs, waitUntil: 'load', signal })
    } catch (err) {
      if (signal?.aborted) throw err
      try {
        await page.goto(url, { timeout: cfg.navigationTimeoutMs, waitUntil: 'domcontentloaded', signal })
      } catch (err2) {
        if (signal?.aborted || err2?.name === 'AbortError') throw err2
        // 页面可能部分加载：保留 DOM
      }
    }
    return record
  }

  get(pageId) {
    const record = this.pages.get(pageId)
    if (!record) throw new Error(
      `未知页面 ${JSON.stringify(pageId)}。可用的页面：${[...this.pages.keys()].join(', ') || '（无，请先 web_read）'}`,
    )
    return record
  }

  async close(pageId) {
    const record = this.pages.get(pageId)
    if (!record) return pageId
    await record.page.close().catch(() => {})
    this.pages.delete(pageId)
    return pageId
  }

  _throwIfAborted(signal) {
    if (signal?.aborted) {
      const err = new Error('operation aborted')
      err.name = 'AbortError'
      throw err
    }
  }

  async dispose() {
    this._disposed = true
    if (this._idleTimer) clearTimeout(this._idleTimer)
    for (const id of [...this.pages.keys()]) {
      await this.pages.get(id).page.close().catch(() => {})
    }
    this.pages.clear()
    if (this.browser) {
      await this.browser.close().catch(() => {})
      this.browser = null
    }
  }
}

// ---- 目标解析 + 安全策略 ----

async function resolveTarget(target, allowedHosts, servers) {
  if (/^https?:\/\//i.test(target)) {
    const url = new URL(target)
    const host = url.hostname
    if (!LOCAL_HOSTS.has(host) && !allowedHosts.includes(host)) {
      throw new Error(
        `主机 ${JSON.stringify(host)} 未在允许名单。本地主机（localhost/127.0.0.1）开箱即用；`
        + '访问远程站点需把域名加入 cordis.patch.yml 的 browser-reader.allowedHosts。',
      )
    }
    return { url: url.href, served: false }
  }
  if (/^file:\/\//i.test(target)) {
    target = fileURLToPath(target)
  }
  const path = resolve(target)
  const info = await stat(path).catch(() => {
    throw new Error(`目标 ${JSON.stringify(target)} 既不是 URL 也不是存在的文件/目录`)
  })
  if (info.isDirectory()) {
    const base = await servers.serve(path)
    return { url: `${base}/`, served: true }
  }
  const base = await servers.serve(resolve(path, '..'))
  const name = path.split('/').pop()
  return { url: `${base}/${encodeURIComponent(name)}`, served: true }
}

// ---- 插件入口 ----

export const name = 'browser-reader'
export const inject = ['tools']

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config }
  const manager = new BrowserManager()
  const servers = new StaticServers()
  let lastPageId = null

  ctx.effect(() => async () => {
    servers.dispose()
    await manager.dispose()
  })

  const getPage = (args) => {
    const id = args?.pageId || lastPageId
    if (!id) throw new Error('还没有打开任何页面，请先调用 web_read 打开。')
    return manager.get(id)
  }

  // ---- web_read ----
  ctx.tools.register({
    name: 'web_read',
    description:
      '用真实浏览器打开并阅读网页或本地文件。能读 JavaScript 渲染后的内容'
      + '（Web 应用/SPA/动态页）。接受 http(s) URL（本地主机默认放行，其他域名需'
      + '配置 allowedHosts）或本地文件/目录路径（自动只读伺服）。'
      + '返回 { pageId, title, url, content, truncated }。内容过长时用'
      + ' web_read_continue 继续读；读完用 web_read_close 关闭。',
    timeoutMs: 2 * cfg.navigationTimeoutMs + 15000,
    parameters: {
      target: {
        type: 'string',
        required: true,
        description: 'http(s) URL，或文件/目录路径（相对当前工作目录）。',
      },
      mode: {
        type: 'string',
        description: 'text（默认，渲染正文）| html（outerHTML 原文）。',
      },
      waitMs: {
        type: 'number',
        description: '加载后额外等待毫秒（懒加载/动画场景调大，上限 15s）。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pageId: { type: 'string' },
          url: { type: 'string' },
          title: { type: 'string' },
          content: { type: 'string' },
          truncated: { type: 'boolean' },
        },
        required: ['pageId', 'url', 'title', 'content', 'truncated'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: `📄 ${value.title || '(无标题)'}  [${value.url}]\n${value.content}${value.truncated ? '\n…（内容过长已截断，可用 web_read_continue 继续）' : ''}`,
      }],
    },
    async execute(args, exec) {
      manager._throwIfAborted(exec.signal)
      const resolved = await resolveTarget(args.target, cfg.allowedHosts, servers)
      const record = await manager.open(resolved.url, cfg, exec.signal)
      lastPageId = record.pageId
      const page = record.page
      if (args.waitMs && args.waitMs > 0) {
        await page.waitForTimeout(Math.min(args.waitMs, 15000)).catch(() => {})
      }
      const title = await page.title().catch(() => '')
      let content
      try {
        content = args.mode === 'html'
          ? await page.evaluate(() => document.body ? document.body.outerHTML : '')
          : await page.evaluate(EXTRACT_TEXT_FN)
      } catch (err) {
        throw new Error(`读取页面内容失败：${safeStr(err?.message)}`)
      }
      const truncated = content.length > cfg.maxReadChars
      return {
        pageId: record.pageId,
        url: resolved.url,
        title,
        content: truncated ? content.slice(0, cfg.maxReadChars) : content,
        truncated,
      }
    },
  })

  // ---- web_read_continue ----
  ctx.tools.register({
    name: 'web_read_continue',
    description:
      '在已打开的页面上继续阅读：向下滚动触发懒加载/虚拟列表加载，返回最新'
      + '提取的正文（通常是全文视角）。可指定页面的 mode。',
    parameters: {
      pageId: { type: 'string', description: '页面 id；默认最近打开的页面。' },
      mode: { type: 'string', description: 'text（默认）| html。' },
      scrollPx: { type: 'number', description: '滚动像素数，默认等于视口高度（约触发一次懒加载）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pageId: { type: 'string' },
          content: { type: 'string' },
          truncated: { type: 'boolean' },
        },
        required: ['pageId', 'content', 'truncated'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.content + (value.truncated ? '\n…（仍有更多内容，可再次调用）' : ''),
      }],
    },
    async execute(args, exec) {
      manager._throwIfAborted(exec.signal)
      const record = getPage(args)
      const scroll = args.scrollPx ?? cfg.viewportHeight
      try {
        await record.page.evaluate(() => { window.scrollTo(0, 0) })
        await record.page.waitForTimeout(120)
        await record.page.evaluate((px) => { window.scrollBy(0, px) }, scroll)
        await record.page.waitForTimeout(500)
      } catch (err) {
        throw new Error(`滚动加载失败：${safeStr(err?.message)}`)
      }
      let content
      try {
        content = args.mode === 'html'
          ? await record.page.evaluate(() => document.body ? document.body.outerHTML : '')
          : await record.page.evaluate(EXTRACT_TEXT_FN)
      } catch (err) {
        throw new Error(`读取页面内容失败：${safeStr(err?.message)}`)
      }
      const truncated = content.length > cfg.maxReadChars
      return {
        pageId: record.pageId,
        content: truncated ? content.slice(0, cfg.maxReadChars) : content,
        truncated,
      }
    },
  })

  // ---- web_read_console ----
  ctx.tools.register({
    name: 'web_read_console',
    description:
      '读取已打开页面的控制台消息和失败请求，判断页面健康度（验证前端工作）。',
    parameters: {
      pageId: { type: 'string', description: '页面 id；默认最近打开的页面。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pageId: { type: 'string' },
          messages: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false,
              properties: { level: { type: 'string' }, text: { type: 'string' } },
              required: ['level', 'text'],
            },
          },
          failedRequests: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false,
              properties: { url: { type: 'string' }, reason: { type: 'string' } },
              required: ['url', 'reason'],
            },
          },
        },
        required: ['pageId', 'messages', 'failedRequests'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.messages.length === 0 && value.failedRequests.length === 0
          ? '控制台干净：无消息、无失败请求。'
          : `${value.messages.length} 条控制台消息，${value.failedRequests.length} 个失败请求：\n`
            + value.messages.map(m => `[${m.level}] ${m.text}`).join('\n')
            + (value.failedRequests.length ? `\n${value.failedRequests.map(f => `[请求失败] ${f.url} (${f.reason})`).join('\n')}` : ''),
      }],
    },
    execute(args, exec) {
      manager._throwIfAborted(exec.signal)
      const record = getPage(args)
      return Promise.resolve({
        pageId: record.pageId,
        messages: record.console.map(e => ({ level: e.level, text: e.text })),
        failedRequests: record.failures.map(f => ({ url: f.url, reason: f.reason })),
      })
    },
  })

  // ---- web_read_screenshot ----
  ctx.tools.register({
    name: 'web_read_screenshot',
    description:
      '将已打开页面截图保存到工作区。截图是给人类复核用的；机器可验证请用'
      + ' web_read / web_read_console。',
    parameters: {
      pageId: { type: 'string', description: '页面 id；默认最近打开的页面。' },
      fullPage: { type: 'boolean', description: '截整页（含滚动区）还是仅视口。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pageId: { type: 'string' },
          path: { type: 'string' },
        },
        required: ['pageId', 'path'],
      },
      render: (_args, value) => [{ type: 'text', text: `截图保存到 ${value.path}（页面 ${value.pageId}）` }],
    },
    async execute(args, exec) {
      manager._throwIfAborted(exec.signal)
      const record = getPage(args)
      const dir = resolve(cfg.screenshotDir)
      await mkdir(dir, { recursive: true })
      const path = join(dir, `${record.pageId}-${Date.now()}.png`)
      try {
        await record.page.screenshot({ path, fullPage: args.fullPage === true, timeout: cfg.actionTimeoutMs })
      } catch (err) {
        throw new Error(`截图失败：${safeStr(err?.message)}`)
      }
      return { pageId: record.pageId, path }
    },
  })

  // ---- web_read_close ----
  ctx.tools.register({
    name: 'web_read_close',
    description: '关闭已打开的页面，释放浏览器资源。阅读完成后应关闭。',
    parameters: {
      pageId: { type: 'string', description: '页面 id；默认最近打开的页面。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { closed: { type: 'string' } },
        required: ['closed'],
      },
      render: (_args, value) => [{ type: 'text', text: `已关闭页面 ${value.closed}。` }],
    },
    async execute(args, exec) {
      manager._throwIfAborted(exec.signal)
      const id = args.pageId || lastPageId
      if (!id) throw new Error('还没有打开任何页面。')
      const closed = await manager.close(id)
      if (lastPageId === closed) lastPageId = null
      return { closed }
    },
  })
}
