/**
 * ui-enhance — client 半身（浏览器 UI 增强）
 *
 * 已实现：
 *   ② 会话状态面板：会话头部显示运行状态 + 当前工具 + 排队数 + 会话短ID
 *   ④ 打开 IDE 按钮：右上角「在编辑器中打开工作区」，支持多 IDE 选择
 * 设计原则：只做增量、看得清（高对比实底色 + 大字号 + 醒目状态点）。
 *
 * slot 契约：conversation.session.header.utilities（list 型，scope: session），
 * 用 id 区分第三方条目（官方/dsh-webui 各占自己的 id）。
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import React from 'react'

import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'

/* ---------- 样式（高对比，确保头部清晰可见） ---------- */

const chipBase: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 7,
  padding: '3px 12px',
  borderRadius: 8,
  fontSize: 13,
  lineHeight: '22px',
  fontWeight: 700,
  whiteSpace: 'nowrap',
  letterSpacing: '0.2px',
}

/** 运行态 chip：绿色实底，深色文字。 */
const runningChip: React.CSSProperties = {
  ...chipBase,
  background: 'rgba(34,197,94,0.18)',
  color: '#16a34a',
  border: '1px solid rgba(34,197,94,0.55)',
  boxShadow: '0 0 0 1px rgba(34,197,94,0.15)',
}

/** 空闲态 chip：灰底，深灰文字。 */
const idleChip: React.CSSProperties = {
  ...chipBase,
  background: 'rgba(148,163,184,0.16)',
  color: '#64748b',
  border: '1px solid rgba(148,163,184,0.45)',
}

const dot: React.CSSProperties = {
  width: 10,
  height: 10,
  borderRadius: '50%',
  flexShrink: 0,
}

const runningDotReal: React.CSSProperties = {
  ...dot,
  background: '#16a34a',
  boxShadow: '0 0 6px 1px rgba(34,197,94,0.8)',
  animation: 'ui-enhance-pulse 1.6s infinite',
}

const idleDotReal: React.CSSProperties = {
  ...dot,
  background: '#94a3b8',
}

const toolName: React.CSSProperties = {
  fontWeight: 600,
  opacity: 0.9,
  maxWidth: 200,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  color: 'inherit',
}

const queueBadge: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  padding: '0 9px',
  borderRadius: 8,
  fontSize: 12,
  fontWeight: 800,
  lineHeight: '22px',
  background: 'rgba(245,158,11,0.22)',
  color: '#b45309',
  border: '1px solid rgba(245,158,11,0.6)',
}

const sessionChip: React.CSSProperties = {
  ...chipBase,
  background: 'rgba(100,116,139,0.14)',
  color: '#475569',
  border: '1px solid rgba(100,116,139,0.4)',
  fontWeight: 600,
  fontSize: 12,
}

/** IDE 按钮（主按钮）：高对比蓝色实底。 */
const ideBtn: React.CSSProperties = {
  ...chipBase,
  cursor: 'pointer',
  color: '#ffffff',
  background: 'linear-gradient(135deg, rgba(37,99,235,0.85) 0%, rgba(29,78,216,0.85) 100%)',
  border: 'none',
  boxShadow: 'none',
  transition: 'filter 0.15s ease, transform 0.1s ease, background 0.15s ease',
  fontFamily: 'inherit',
}
const ideBtnHover: React.CSSProperties = {
  ...ideBtn,
  background: 'linear-gradient(135deg, rgba(37,99,235,0.95) 0%, rgba(29,78,216,0.95) 100%)',
  filter: 'brightness(1.1)',
}
const ideBtnActive: React.CSSProperties = {
  ...ideBtn,
  filter: 'brightness(0.9)',
  transform: 'translateY(1px)',
}
const ideBtnBusy: React.CSSProperties = {
  ...ideBtn,
  background: 'linear-gradient(135deg, rgba(100,116,139,0.75) 0%, rgba(71,85,105,0.75) 100%)',
  cursor: 'wait',
}
const ideBtnDone: React.CSSProperties = {
  ...ideBtn,
  background: 'linear-gradient(135deg, rgba(22,163,74,0.85) 0%, rgba(21,128,61,0.85) 100%)',
}
const ideBtnErr: React.CSSProperties = {
  ...ideBtn,
  background: 'linear-gradient(135deg, rgba(220,38,38,0.8) 0%, rgba(185,28,28,0.8) 100%)',
}

/** 连体按钮组：统一圆角/边框/阴影，内部按钮裁剪成一体。 */
const ideGroup: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'stretch',
  borderRadius: 10,
  overflow: 'hidden',
  border: '1px solid rgba(29,78,216,0.7)',
  background: 'linear-gradient(135deg, rgba(37,99,235,0.85) 0%, rgba(29,78,216,0.85) 100%)',
  boxShadow: '0 1px 4px rgba(37,99,235,0.3)',
}
const ideGroupHover: React.CSSProperties = {
  ...ideGroup,
  background: 'linear-gradient(135deg, rgba(37,99,235,0.95) 0%, rgba(29,78,216,0.95) 100%)',
  boxShadow: '0 1px 6px rgba(37,99,235,0.4)',
}
/** ▾ 下拉分区：比主按钮颜色略淡，左侧细分隔线。 */
const ideCaretBtn: React.CSSProperties = {
  ...chipBase,
  cursor: 'pointer',
  color: 'rgba(255,255,255,0.92)',
  background: 'rgba(255,255,255,0.10)',
  border: 'none',
  borderLeft: '1px solid rgba(255,255,255,0.35)',
  padding: '3px 7px',
  width: 28,
  justifyContent: 'center',
  fontFamily: 'inherit',
  fontSize: 12,
}
const ideCaretBtnHover: React.CSSProperties = {
  ...ideCaretBtn,
  background: 'rgba(255,255,255,0.20)',
}

/* ---------- 组件 ---------- */

/** 会话快照钩子的最小形状（与运行时契约对齐）。 */
interface SessionKit {
  sessionId: string
  useSession: <T>(selector?: (s: unknown) => T) => T | undefined
}

/** 会话快照关心的字段（运行时真实类型按契约提供）。 */
interface SnapshotLike {
  running?: boolean
  runningCalls?: readonly { tool?: { name?: string } | null }[] | null
  queue?: readonly unknown[] | null
}

/** ② 会话头部「实时状态面板」。 */
function SessionStatusPanel(props: SessionKit): React.ReactElement | null {
  const { sessionId, useSession } = props
  const snap = useSession<SnapshotLike>((s) => s as SnapshotLike)

  const running = Boolean(snap?.running)
  const runningCalls = snap?.runningCalls ?? []
  const toolName_ = runningCalls.length > 0 ? (runningCalls[0]?.tool?.name ?? '') : ''
  const queued = (snap?.queue?.length ?? 0) - (running ? 1 : 0)
  const shortId = sessionId?.slice(0, 8) ?? ''

  return (
    <>
      <span style={running ? runningChip : idleChip} title={running ? '会话运行中' : '会话空闲'}>
        <span style={running ? runningDotReal : idleDotReal} />
        <span>{running ? '运行中' : '空闲'}</span>
        {toolName_ ? <span style={toolName} title={toolName_}>· {toolName_}</span> : null}
      </span>
      {queued > 0 ? (
        <span style={queueBadge} title={`${queued} 条消息排队中`}>
          ⏳ {queued}
        </span>
      ) : null}
      {shortId && !running ? (
        <span style={sessionChip} title={sessionId}>#{shortId}</span>
      ) : null}
    </>
  )
}

/* ---------- IDE 打开 ---------- */

/** 支持打开的编辑器（命令 + 展示名）。与 Node 半身的路由契约一致。 */
const IDE_OPTIONS = [
  { id: 'vscode', label: 'VS Code', cmd: 'code' },
  { id: 'cursor', label: 'Cursor', cmd: 'cursor' },
  { id: 'windsurf', label: 'Windsurf', cmd: 'windsurf' },
  { id: 'trae', label: 'Trae', cmd: 'trae' },
]

/** 选择菜单（点击 IDE 名切换）+ 打开按钮。 */
function OpenInEditorButton(): React.ReactElement {
  const [state, setState] = React.useState<'idle' | 'busy' | 'done' | 'error'>('idle')
  const [hovered, setHovered] = React.useState(false)
  const [pressed, setPressed] = React.useState(false)
  const [menuOpen, setMenuOpen] = React.useState(false)
  const [editor, setEditor] = React.useState<string>('vscode')
  // 本机已安装的 IDE id 列表（由 Node 半身检测）；空=尚未加载
  const [available, setAvailable] = React.useState<string[]>([...IDE_OPTIONS.map((o) => o.id)])
  const menuRef = React.useRef<HTMLDivElement | null>(null)

  // 拉取本机可用 IDE 列表（Node 半身 /api/ui-enhance/editors 检测命令是否存在）
  React.useEffect(() => {
    let alive = true
    fetch('/api/ui-enhance/editors')
      .then((r) => (r.ok ? r.json() : { editors: [] }))
      .then((d: { editors?: string[] }) => {
        if (!alive) return
        const list = Array.isArray(d.editors) && d.editors.length > 0 ? d.editors : IDE_OPTIONS.map((o) => o.id)
        setAvailable(list)
      })
      .catch(() => { /* 保持默认全量 */ })
    return () => { alive = false }
  }, [])

  // 从 localStorage 恢复上次选用 IDE（并在可用列表中校验）
  React.useEffect(() => {
    try {
      const saved = localStorage.getItem('ui-enhance:ide')
      if (saved && available.includes(saved)) setEditor(saved)
    } catch { /* ignore */ }
  }, [available])

  const availableOptions = IDE_OPTIONS.filter((o) => available.includes(o.id))
  // 兜底：至少保留 VS Code
  const effectiveOptions = availableOptions.length > 0 ? availableOptions : IDE_OPTIONS.filter((o) => o.id === 'vscode')
  const current = effectiveOptions.find((o) => o.id === editor) ?? effectiveOptions[0]

  const launch = async (): Promise<void> => {
    if (state === 'busy') return
    setState('busy')
    setMenuOpen(false)
    try {
      const res = await fetch('/api/ui-enhance/open-in-editor', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ editor: current.id }),
      })
      setState(res.ok ? 'done' : 'error')
    } catch {
      setState('error')
    }
    setTimeout(() => setState('idle'), 2000)
  }

  const pickEditor = (id: string): void => {
    setEditor(id)
    setMenuOpen(false)
    try { localStorage.setItem('ui-enhance:ide', id) } catch { /* ignore */ }
  }

  // 点击外部关闭菜单
  React.useEffect(() => {
    if (!menuOpen) return
    const onDoc = (e: MouseEvent): void => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [menuOpen])

  const label = state === 'busy' ? '打开中…' : state === 'done' ? '已打开 ✓' : state === 'error' ? '打开失败' : `打开 ${current.label}`
  const btnStyle = state === 'busy' ? ideBtnBusy : state === 'done' ? ideBtnDone : state === 'error' ? ideBtnErr
    : hovered ? ideBtnHover : pressed ? ideBtnActive : ideBtn

  return (
    <div style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }} ref={menuRef}>
      {/* 连体按钮组：主按钮 + 下拉（整体一个，下拉略淡） */}
      <div style={hovered || menuOpen ? ideGroupHover : ideGroup}>
        <button
          type="button"
          onClick={launch}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          onMouseDown={() => setPressed(true)}
          onMouseUp={() => setPressed(false)}
          style={btnStyle}
          title={`在 ${current.label} 中打开当前工作区`}
        >
          <span style={{ fontSize: 14 }}>⧉</span>
          <span>{label}</span>
        </button>
        <button
          type="button"
          aria-label="选择 IDE"
          onClick={() => setMenuOpen((v) => !v)}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          style={hovered ? ideCaretBtnHover : ideCaretBtn}
          title="选择要打开的编辑器"
        >
          <span style={{ fontSize: 12 }}>▾</span>
        </button>
      </div>
      {menuOpen ? (
        <div style={{
          position: 'absolute',
          top: 'calc(100% + 6px)',
          right: 0,
          zIndex: 1000,
          background: 'var(--dsw-surface, #1e293b)',
          border: '1px solid var(--dsw-border, rgba(148,163,184,0.35))',
          borderRadius: 10,
          boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
          padding: 4,
          minWidth: 160,
        }}>
          {effectiveOptions.map((o) => (
            <button
              key={o.id}
              type="button"
              onClick={() => pickEditor(o.id)}
              style={{
                display: 'block',
                width: '100%',
                textAlign: 'left',
                padding: '7px 12px',
                borderRadius: 7,
                border: 'none',
                background: o.id === editor ? 'rgba(37,99,235,0.22)' : 'transparent',
                color: o.id === editor ? 'var(--dsw-text-primary, #f1f5f9)' : 'var(--dsw-text-secondary, #cbd5e1)',
                fontSize: 13,
                fontWeight: o.id === editor ? 700 : 500,
                cursor: 'pointer',
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = o.id === editor ? 'rgba(37,99,235,0.28)' : 'rgba(148,163,184,0.14)' }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = o.id === editor ? 'rgba(37,99,235,0.22)' : 'transparent' }}
            >
              {o.label}{o.id === editor ? '  ✓' : ''}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

/* ---------- 插件主体 ---------- */

export const inject = ['slots', 'locale']

const NS = 'ui-enhance'

/** 客户端插件主体。 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, {
    zh: { running: '运行中', idle: '空闲', queued: '排队' },
    en: { running: 'running', idle: 'idle', queued: 'queued' },
  }), 'ui-enhance: dictionaries')

  // 注入脉冲动画（一次性）
  if (typeof document !== 'undefined' && !document.getElementById('ui-enhance-anim')) {
    const tag = document.createElement('style')
    tag.id = 'ui-enhance-anim'
    tag.textContent = '@keyframes ui-enhance-pulse { 0% { box-shadow: 0 0 0 0 rgba(34,197,94,0.5); } 70% { box-shadow: 0 0 0 7px rgba(34,197,94,0); } 100% { box-shadow: 0 0 0 0 rgba(34,197,94,0); } }'
    document.head.appendChild(tag)
  }

  ctx.slots.inject('conversation.session.header.utilities', () =>
    ctx.slots.register({
      name: 'conversation.session.header.utilities',
      id: 'ui-enhance-session-status',
      order: 5,
    }, SessionStatusPanel))
  ctx.slots.inject('conversation.session.header.utilities', () =>
    ctx.slots.register({
      name: 'conversation.session.header.utilities',
      id: 'ui-enhance-open-editor',
      order: 6,
    }, OpenInEditorButton))
}
