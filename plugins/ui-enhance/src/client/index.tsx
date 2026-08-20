/**
 * ui-enhance — client 半身（浏览器 UI 增强）
 *
 * 阶段 B-②：会话/工作区增强。
 *   会话头部 utilities 区展示「实时会话状态面板」：
 *     - 运行状态（🟢 运行中 / ⚪ 空闲）+ 当前正在调用的工具名
 *     - 排队消息计数
 *     - 会话标识
 *   数据来自会话标准套件注入的 useSession 快照（ConversationSnapshot），
 *   全部为前端只读渲染，无需宿主通道。
 *
 * slot 契约：conversation.session.header.utilities 是 ui-conversation 声明的
 * list 型 slot（scope: session）。组件 props 由框架注入会话标准套件
 * （sessionId / useSession 等）。
 * 注意：conversation.chat.node 是 keyed slot（官方 ui-tool 已占用
 * tool-call key）——自定义 UI 不能直接在那里注册，避免冲突。
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import React from 'react'

// Type-only: 拉入 ui-conversation 的 SlotMap 合并（slot 注册的类型契约）。
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'

/* ---------- 样式 ---------- */

const chip: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '2px 10px',
  borderRadius: 999,
  fontSize: 12,
  lineHeight: '20px',
  fontWeight: 600,
  whiteSpace: 'nowrap',
  background: 'rgba(48,80,120,0.14)',
  color: 'var(--dsw-text-secondary, #cbd5e1)',
  border: '1px solid var(--dsw-border, rgba(148,163,184,0.28))',
}

const dot: React.CSSProperties = {
  width: 8,
  height: 8,
  borderRadius: '50%',
  display: 'inline-block',
}

const runningDot: React.CSSProperties = {
  ...dot,
  background: '#22c55e',
  boxShadow: '0 0 0 0 rgba(34,197,94,0.5)',
  animation: 'ui-enhance-pulse 1.6s infinite',
}

const idleDot: React.CSSProperties = {
  ...dot,
  background: '#94a3b8',
}

const toolName: React.CSSProperties = {
  fontWeight: 500,
  opacity: 0.85,
  maxWidth: 180,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
}

const queueBadge: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  padding: '0 8px',
  borderRadius: 999,
  fontSize: 11,
  fontWeight: 700,
  background: 'rgba(245,158,11,0.18)',
  color: '#fbbf24',
  border: '1px solid rgba(245,158,11,0.4)',
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
  partial?: unknown
}

/** 会话头部「实时状态面板」。 */
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
      <span style={chip} title={running ? '会话运行中' : '会话空闲'}>
        <span style={running ? runningDot : idleDot} />
        <span>{running ? '运行中' : '空闲'}</span>
        {toolName_ ? <span style={toolName} title={toolName_}>· {toolName_}</span> : null}
      </span>
      {queued > 0 ? (
        <span style={queueBadge} title={`${queued} 条消息排队中`}>
          ⏳ {queued}
        </span>
      ) : null}
      {shortId ? (
        <span style={{ ...chip, opacity: 0.7, fontWeight: 500 }} title={sessionId}>
          #{shortId}
        </span>
      ) : null}
    </>
  )
}

/* ---------- 插件主体 ---------- */

/** 按钮样式（沿用 chip 风格，可点击）。 */
const btnStyle: React.CSSProperties = {
  ...chip,
  cursor: 'pointer',
  color: 'var(--dsw-text-primary, #e2e8f0)',
  background: 'rgba(59,130,246,0.14)',
  border: '1px solid rgba(59,130,246,0.45)',
  transition: 'background 0.15s ease',
}
const btnHover: React.CSSProperties = {
  ...btnStyle,
  background: 'rgba(59,130,246,0.28)',
}

/** ④ 打开 VS Code 按钮：fetch 宿主 /api/ui-enhance/open-in-editor 路由。 */
function OpenInEditorButton(): React.ReactElement {
  const [state, setState] = React.useState<'idle' | 'busy' | 'done' | 'error'>('idle')
  const [hovered, setHovered] = React.useState(false)

  const onClick = async (): Promise<void> => {
    if (state === 'busy') return
    setState('busy')
    try {
      const res = await fetch('/api/ui-enhance/open-in-editor', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
      setState(res.ok ? 'done' : 'error')
    } catch {
      setState('error')
    }
    setTimeout(() => setState('idle'), 2000)
  }

  const label = state === 'busy' ? '打开中…' : state === 'done' ? '已打开 ✓' : state === 'error' ? '打开失败' : '打开 VS Code'

  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={hovered ? btnHover : btnStyle}
      title="在 VS Code 中打开当前工作区"
    >
      <span style={{ fontSize: 13 }}>⧉</span>
      <span>{label}</span>
    </button>
  )
}

export const inject = ['slots', 'locale']

const NS = 'ui-enhance'

/** 客户端插件主体。 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, {
    zh: {
      running: '运行中',
      idle: '空闲',
      queued: '排队',
    },
    en: {
      running: 'running',
      idle: 'idle',
      queued: 'queued',
    },
  }), 'ui-enhance: dictionaries')

  // 往追加 <style> 注入脉冲动画（首次加载时一次性）
  if (typeof document !== 'undefined' && !document.getElementById('ui-enhance-anim')) {
    const tag = document.createElement('style')
    tag.id = 'ui-enhance-anim'
    tag.textContent = '@keyframes ui-enhance-pulse { 0% { box-shadow: 0 0 0 0 rgba(34,197,94,0.45); } 70% { box-shadow: 0 0 0 6px rgba(34,197,94,0); } 100% { box-shadow: 0 0 0 0 rgba(34,197,94,0); } }'
    document.head.appendChild(tag)
  }

  // 会话头部 utilities 区：list 型 slot（非 keyed），与官方/dsh-webui 区分 id
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
