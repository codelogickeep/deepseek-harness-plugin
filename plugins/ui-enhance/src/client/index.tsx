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

/** IDE 按钮（主按钮）：高对比蓝色实底。 */
const ideBtn: React.CSSProperties = {
  ...chipBase,
  cursor: 'pointer',
  color: '#ffffff',
  background: 'linear-gradient(135deg, rgba(37,99,235,0.85) 0%, rgba(29,78,216,0.85) 100%)',
  border: 'none',
  boxShadow: 'none',
  // 中间与下拉直角拼接（圆角只由外层容器提供）
  borderRadius: 0,
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
/** ▾ 下拉分区：比主按钮颜色略淡，左侧细分隔线；与主按钮直角拼接。 */
const ideCaretBtn: React.CSSProperties = {
  ...chipBase,
  cursor: 'pointer',
  color: 'rgba(255,255,255,0.92)',
  background: 'rgba(255,255,255,0.10)',
  border: 'none',
  borderLeft: '1px solid rgba(255,255,255,0.35)',
  // 直角拼接（不做圆角）
  borderRadius: 0,
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
  useSession: <T>(selector?: (s: unknown) => T) => T | undefined
}

/** 会话快照关心的字段（运行时真实类型按契约提供）。 */
interface SnapshotLike {
  running?: boolean
  runningCalls?: readonly { tool?: { name?: string } | null }[] | null
  queue?: readonly unknown[] | null
  /** 完整消息流，含已完成的 tool-result 节点（A1 数据源）。 */
  nodes?: readonly NodeLike[] | null
}

/** 会话消息流节点的最小形状（只取 A1 关心的部分）。 */
interface NodeLike {
  kind?: string
  time?: number
  isError?: boolean
  /** callTime 是 ToolResultNode 顶层字段（call 在窗口内时为开始时间戳），非 call 内部。 */
  callTime?: number | null
  call?: { name?: string | null, argsRaw?: string | null } | null
}

/** ② 会话头部「实时状态面板」。 */
function SessionStatusPanel(props: SessionKit): React.ReactElement | null {
  const { useSession } = props
  const snap = useSession<SnapshotLike>((s) => s as SnapshotLike)

  const running = Boolean(snap?.running)
  const runningCalls = snap?.runningCalls ?? []
  const toolName_ = runningCalls.length > 0 ? (runningCalls[0]?.tool?.name ?? '') : ''
  const queued = (snap?.queue?.length ?? 0) - (running ? 1 : 0)

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

  const label = state === 'busy' ? '打开中…' : state === 'done' ? '已打开 ✓' : state === 'error' ? '打开失败' : current.label
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

/* ---------- A1：工具调用统计 ---------- */

/** 汇总出的单次工具调用记录。 */
interface CallStat {
  name: string
  ok: boolean
  durationMs: number | null
  time: number
}

/** 徽标样式（chip 风格，可点击）。 */
const statsBadge: React.CSSProperties = {
  ...chipBase,
  cursor: 'pointer',
  background: 'rgba(139,92,246,0.16)',
  color: '#7c3aed',
  border: '1px solid rgba(139,92,246,0.5)',
  padding: '3px 11px',
  fontSize: 13,
}
const statsBadgeHover: React.CSSProperties = {
  ...statsBadge,
  background: 'rgba(139,92,246,0.26)',
}
const statsBadgeRunning: React.CSSProperties = {
  ...statsBadge,
  background: 'rgba(34,197,94,0.16)',
  color: '#16a34a',
  border: '1px solid rgba(34,197,94,0.5)',
}

/** ③ 会话工具调用统计：遍历快照 nodes 收集 tool-result，展示统计徽标 + 展开面板。 */
function ToolCallStats(props: SessionKit): React.ReactElement | null {
  const { useSession } = props
  const [open, setOpen] = React.useState(false)
  const [hovered, setHovered] = React.useState(false)
  const panelRef = React.useRef<HTMLDivElement | null>(null)

  const snap = useSession<SnapshotLike>((s) => s as SnapshotLike)

  // 收集工具调用记录（已完成）：nodes 里的 tool-result 节点
  const stats = React.useMemo<CallStat[]>(() => {
    const nodes = snap?.nodes ?? []
    const out: CallStat[] = []
    for (const n of nodes as NodeLike[]) {
      if (n?.kind !== 'tool-result' || !n.call) continue
      const dur = n.time != null && n.callTime != null ? n.time - n.callTime : null
      out.push({
        name: n.call.name ?? '?',
        ok: !n.isError,
        durationMs: dur != null && dur >= 0 ? dur : null,
        time: n.time ?? 0,
      })
    }
    return out
  }, [snap])

  const running = Boolean(snap?.running)
  const total = stats.length
  const ok = stats.filter((c) => c.ok).length
  const fail = total - ok
  const avgMs = total > 0
    ? Math.round(stats.reduce((acc, c) => acc + (c.durationMs ?? 0), 0) / total)
    : 0

  // 工具分布：name -> 次数
  const dist = React.useMemo<{ name: string, count: number }[]>(() => {
    const m = new Map<string, number>()
    for (const c of stats) m.set(c.name, (m.get(c.name) ?? 0) + 1)
    return Array.from(m.entries()).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count)
  }, [stats])

  const recent = stats.slice(-6).reverse()

  // 点击外部关闭面板
  React.useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent): void => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const fmtDur = (ms: number | null): string => {
    if (ms == null) return '—'
    if (ms < 1000) return `${ms}ms`
    return `${(ms / 1000).toFixed(1)}s`
  }

  const badgeStyle = running ? statsBadgeRunning : (hovered ? statsBadgeHover : statsBadge)

  return (
    <div style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }} ref={panelRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={badgeStyle}
        title={`工具调用统计：${total} 次`}
      >
        <span style={{ fontSize: 13 }}>🔧</span>
        <span>{total}</span>
      </button>
      {open ? (
        <div style={{
          position: 'absolute',
          top: 'calc(100% + 6px)',
          right: 0,
          zIndex: 1000,
          width: 300,
          background: 'var(--dsw-surface, #1e293b)',
          border: '1px solid var(--dsw-border, rgba(148,163,184,0.35))',
          borderRadius: 12,
          boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
          padding: '12px 14px',
          color: 'var(--dsw-text-primary, #e2e8f0)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <span style={{ fontWeight: 800, fontSize: 14 }}>工具调用统计</span>
            {running ? <span style={{ fontSize: 12, color: '#16a34a', fontWeight: 700 }}>🟢 运行中</span> : null}
          </div>
          {/* 总览数字 */}
          <div style={{ display: 'flex', gap: 10, marginBottom: 10 }}>
            <span style={overviewCell}>总数 {total}</span>
            <span style={{ ...overviewCell, color: '#16a34a' }}>成功 {ok}</span>
            <span style={{ ...overviewCell, color: fail > 0 ? '#dc2626' : '#64748b' }}>失败 {fail}</span>
            <span style={overviewCell}>均耗 {fmtDur(avgMs)}</span>
          </div>
          {/* 工具分布 */}
          {dist.length > 0 ? (
            <div style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--dsw-text-secondary, #cbd5e1)', marginBottom: 6 }}>工具分布</div>
              {dist.slice(0, 8).map((d) => {
                const pct = Math.round((d.count / total) * 100)
                return (
                  <div key={d.name} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
                    <span style={{ fontSize: 12, width: 110, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--dsw-text-secondary, #cbd5e1)' }}>{d.name}</span>
                    <div style={{ flex: 1, height: 6, borderRadius: 3, background: 'rgba(148,163,184,0.2)', overflow: 'hidden' }}>
                      <div style={{ height: '100%', width: `${pct}%`, background: 'linear-gradient(90deg, #8b5cf6, #6366f1)', borderRadius: 3 }} />
                    </div>
                    <span style={{ fontSize: 12, fontWeight: 700, width: 24, textAlign: 'right' }}>{d.count}</span>
                  </div>
                )
              })}
            </div>
          ) : (
            <div style={{ fontSize: 12, color: 'var(--dsw-text-tertiary, #94a3b8)', marginBottom: 8 }}>本会话暂无工具调用</div>
          )}
          {/* 最近流水 */}
          {recent.length > 0 ? (
            <div>
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--dsw-text-secondary, #cbd5e1)', marginBottom: 6 }}>最近调用</div>
              {recent.map((c, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '2px 0', fontSize: 12 }}>
                  <span style={{ color: c.ok ? '#16a34a' : '#dc2626', fontWeight: 800 }}>{c.ok ? '✓' : '✗'}</span>
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--dsw-text-secondary, #cbd5e1)' }}>{c.name}</span>
                  <span style={{ color: 'var(--dsw-text-tertiary, #94a3b8)', fontVariantNumeric: 'tabular-nums' }}>{fmtDur(c.durationMs)}</span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

const overviewCell: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  padding: '3px 8px',
  borderRadius: 6,
  background: 'rgba(148,163,184,0.12)',
  color: 'var(--dsw-text-secondary, #cbd5e1)',
}

/* ---------- 文件树侧栏 ---------- */

/** 树条目（来自 Node 半身 /tree 路由）。 */
interface TreeEntry {
  name: string
  path: string
  type: 'dir' | 'file'
  git: string | null
  size: number | null
}

/** git 汇总（底部栏显示）：分支 + 计数 + 最近提交。 */
interface GitSummary {
  branch: string | null
  modified: number
  added: number
  deleted: number
  untracked: number
  lastCommit: string | null
  ahead: number | null
}

/** git 状态 → 徽标文案/颜色。 */
function gitBadge(code: string | null): { label: string, color: string, bg: string } | null {
  if (!code) return null
  const first = code[0]
  if (first === 'M') return { label: 'M', color: '#f59e0b', bg: 'rgba(245,158,11,0.16)' }
  if (first === 'A') return { label: 'A', color: '#22c55e', bg: 'rgba(34,197,94,0.16)' }
  if (first === 'D') return { label: 'D', color: '#ef4444', bg: 'rgba(239,68,68,0.16)' }
  if (first === 'R') return { label: 'R', color: '#8b5cf6', bg: 'rgba(139,92,246,0.16)' }
  if (first === 'C') return { label: 'C', color: '#8b5cf6', bg: 'rgba(139,92,246,0.16)' }
  if (first === 'U') return { label: 'U', color: '#f97316', bg: 'rgba(249,115,22,0.16)' }
  if (first === '?') return { label: '?', color: '#64748b', bg: 'rgba(148,163,184,0.16)' }
  return { label: first, color: '#cbd5e1', bg: 'rgba(148,163,184,0.16)' }
}

/** 单个树节点（带展开状态的 directory）。 */
interface TreeNode {
  entry: TreeEntry
  loaded: boolean
  children: TreeEntry[]
  expanded: boolean
  loading: boolean
  error?: string
}

/** 右侧文件树抽屉 + 右上角开关。 */
/** 右侧文件树面板（对齐左侧侧边栏的浅色融入风格）+ 右上角开关。 */
function FileTreePanel(): React.ReactElement {
  const [open, setOpen] = React.useState(false)
  const [width, setWidth] = React.useState(280)
  const [root, setRoot] = React.useState('')
  const [git, setGit] = React.useState<GitSummary | null>(null)
  // 当前选中（显示在头部路径区）的相对路径，默认 '/' 表示项目根
  const [selPath, setSelPath] = React.useState<string>('/')
  const [copied, setCopied] = React.useState(false)
  const [rootNodes, setRootNodes] = React.useState<TreeNode[] | null>(null)
  const [loadingRoot, setLoadingRoot] = React.useState(false)
  const [err, setErr] = React.useState('')
  // 树版本号：任一节点展开/收起后 +1，强制重渲染
  const [, setTreeVersion] = React.useState(0)

  // 打开时加载根目录
  const loadRoot = React.useCallback(async () => {
    setLoadingRoot(true)
    setErr('')
    try {
      const r = await fetch('/api/ui-enhance/tree?dir=')
      const d: { root: string, git: GitSummary | null, entries: TreeEntry[] } = await r.json()
      setRoot(d.root)
      setGit(d.git ?? null)
      setRootNodes((d.entries ?? []).map((e) => ({ entry: e, loaded: false, children: [], expanded: false, loading: false })))
    } catch (e) {
      setErr(`加载失败: ${String(e)}`)
    } finally {
      setLoadingRoot(false)
    }
  }, [])

  // 打开时让主内容区（centerCol）往左缩，右侧让出面板宽度给文件树（与左侧栏对称，融为一体）
  React.useEffect(() => {
    if (typeof document === 'undefined') return
    const col = document.querySelector<HTMLElement>('[class*="centerCol"]')
    if (!col) return
    if (open) {
      col.style.marginRight = `${width}px`
      col.style.transition = 'margin-right 0.15s ease'
    } else {
      col.style.marginRight = ''
    }
    return () => { col.style.marginRight = '' }
  }, [open, width])

  // 拖拽调整面板宽度（拖拽条在面板左缘）：往左拖变宽、往右拖变窄
  const startDrag = (e: React.MouseEvent): void => {
    e.preventDefault()
    const startX = e.clientX
    const startW = width
    const onMove = (ev: MouseEvent): void => {
      const next = Math.min(520, Math.max(220, startW - (ev.clientX - startX)))
      setWidth(next)
    }
    const onUp = (): void => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }

  // 展开/收起目录
  const toggleDir = async (node: TreeNode): Promise<void> => {
    if (node.expanded) {
      node.expanded = false
      setTreeVersion((v) => v + 1)
      return
    }
    node.expanded = true
    if (!node.loaded) {
      node.loading = true
      try {
        const r = await fetch(`/api/ui-enhance/tree?dir=${encodeURIComponent(node.entry.path)}`)
        const d: { entries: TreeEntry[] } = await r.json()
        node.children = (d.entries ?? []).map((e) => ({ entry: e, loaded: false, children: [], expanded: false, loading: false }))
        node.loaded = true
      } catch {
        node.error = '加载失败'
      } finally {
        node.loading = false
      }
    }
    setTreeVersion((v) => v + 1)
  }

  const toggleOpen = (): void => {
    const next = !open
    setOpen(next)
    if (next && rootNodes === null) void loadRoot()
  }

  const refresh = (): void => { void loadRoot() }

  /** 双击文件 → 在当前 IDE 中打开该文件（Node 半身支持 file 参数）。 */
  const openFile = async (filePath: string): Promise<void> => {
    try {
      await fetch('/api/ui-enhance/open-in-editor', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ file: filePath }),
      })
    } catch { /* ignore */ }
  }

  /** 复制路径到剪贴板（显示短暂 ✓ 反馈）。 */
  const copyPath = async (path: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(path)
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch { /* clipboard 不可用时忽略 */ }
  }

  /** 递归渲染目录（浅色，对齐左侧栏）。 */
  const renderLevel = (nodes: TreeNode[], depth: number): React.ReactElement[] => {
    return nodes.map((node) => {
      const entry = node.entry
      const badge = gitBadge(entry.git)
      const indent = { paddingLeft: 10 + depth * 16 }
      const isDir = entry.type === 'dir'
      const isSel = selPath === `/${entry.path}`
      return (
        <React.Fragment key={entry.path}>
          <div
            role="button"
            tabIndex={0}
            onClick={() => {
              setSelPath(`/${entry.path}`)
              if (isDir) void toggleDir(node)
            }}
            onDoubleClick={() => { if (!isDir) void openFile(entry.path) }}
            title={isDir ? entry.path : `双击在编辑器中打开 ${entry.path}`}
            style={{
              ...indent,
              display: 'flex', alignItems: 'center', gap: 7,
              paddingTop: 4, paddingBottom: 4, paddingRight: 10,
              cursor: isDir ? 'pointer' : 'default',
              borderRadius: 8,
              fontSize: 13,
              color: '#0f1115',
              whiteSpace: 'nowrap',
              background: isSel ? 'rgba(37, 99, 235, 0.08)' : 'transparent',
            }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = isSel ? 'rgba(37, 99, 235, 0.12)' : 'rgba(0,0,0,0.05)' }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = isSel ? 'rgba(37, 99, 235, 0.08)' : 'transparent' }}
          >
            <span style={{ fontSize: 10, width: 12, color: '#9aa1ab', flexShrink: 0 }}>
              {isDir ? (node.expanded ? '▾' : '▸') : ''}
            </span>
            <span style={{ fontSize: 13, flexShrink: 0 }}>{isDir ? '📁' : '📄'}</span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', flex: 1 }}>{entry.name}</span>
            {badge ? (
              <span style={{
                fontSize: 10, fontWeight: 800, padding: '0 5px', borderRadius: 4,
                color: badge.color, background: badge.bg, flexShrink: 0,
              }}>{badge.label}</span>
            ) : null}
          </div>
          {isDir && node.expanded ? (
            <div>
              {node.loading ? <div style={{ ...indent, fontSize: 12, color: '#6b7280', paddingLeft: 26 }}>加载中…</div> : null}
              {node.error ? <div style={{ ...indent, fontSize: 12, color: '#dc2626', paddingLeft: 26 }}>{node.error}</div> : null}
              {node.loaded && !node.loading ? renderLevel(node.children, depth + 1) : null}
            </div>
          ) : null}
        </React.Fragment>
      )
    })
  }

  const nodes = rootNodes ?? []

  // 头部打开开关按钮（浅色 chip），图标：左竖三点 + 右三横线
  const toggleBtnStyle: React.CSSProperties = {
    ...chipBase,
    cursor: 'pointer',
    background: open ? 'rgb(229, 231, 235)' : 'rgb(243, 244, 246)',
    color: '#0f1115',
    border: '1px solid rgb(209, 213, 219)',
    // svg 高 22 + border 2 + padding 2*2 = 28，与打开 IDE/状态按钮等高（28px）
    padding: '2px 8px',
    borderRadius: 8,
    fontSize: 13,
    lineHeight: 0,
    display: 'inline-flex',
    alignItems: 'center',
  }

  // svg 高 22（与 IDE/状态按钮文字行高一致）
  const toggleIcon = (
    <svg viewBox="0 0 28 22" width="22" height="22" style={{ display: 'block' }}>
      {/* 左：竖三点 */}
      <circle cx="4" cy="3" r="1.8" fill="currentColor" />
      <circle cx="4" cy="11" r="1.8" fill="currentColor" />
      <circle cx="4" cy="19" r="1.8" fill="currentColor" />
      {/* 右：三横线 */}
      <line x1="10" y1="3" x2="25" y2="3" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
      <line x1="10" y1="11" x2="25" y2="11" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
      <line x1="10" y1="19" x2="25" y2="19" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
    </svg>
  )

  return (
    <>
      <button
        type="button"
        onClick={toggleOpen}
        style={toggleBtnStyle}
        title={open ? '关闭文件树' : '项目文件树'}
        aria-expanded={open}
      >
        {toggleIcon}
      </button>
      {open ? (
        <div style={{
          position: 'fixed',
          top: 0, right: 0, bottom: 0,
          width,
          zIndex: 2000,
          background: 'rgb(249, 250, 251)',
          borderLeft: '1px solid rgb(229, 231, 235)',
          display: 'flex', flexDirection: 'column',
          color: '#0f1115',
          fontFamily: 'inherit',
        }}>
          {/* 拖拽条：面板左缘 6px */}
          <div
            onMouseDown={startDrag}
            title="拖拽调整宽度"
            style={{
              position: 'absolute', left: -3, top: 0, bottom: 0, width: 6,
              cursor: 'col-resize', zIndex: 3,
            }}
          />
          {/* 头：74px 高、两行式，分隔线对齐中间区域（y 74，即中间 76 上移 2px） */}
          <div style={{
            display: 'flex', flexDirection: 'column',
            padding: '0 14px',
            borderBottom: '1px solid rgb(229, 231, 235)',
            height: 74, boxSizing: 'border-box',
          }}>
            {/* 第一行：当前路径（相对项目根，默认 '/'）+ 复制按钮 */}
            <div style={{
              display: 'flex', alignItems: 'center', gap: 6, height: 37, flexShrink: 0,
            }}>
              <span
                title={selPath === '/' ? '项目根目录' : '回到项目根目录'}
                onClick={() => { setSelPath('/') }}
                style={{
                  fontWeight: 400, fontSize: 13, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1,
                  color: '#0f1115', cursor: 'pointer',
                }}
              >
                {selPath}
              </span>
              <button
                type="button"
                onClick={() => void copyPath(selPath)}
                style={iconBtn}
                title="复制路径"
              >
                {copied ? '✓' : '⧉'}
              </button>
            </div>
            {/* 第二行：操作按钮（y 37-74），与中间 tabs 行同高 */}
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8, height: 37, flexShrink: 0,
              justifyContent: 'flex-end',
            }}>
              <button type="button" onClick={refresh} style={iconBtn} title="刷新">⟳</button>
            </div>
          </div>
          {/* 树 */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '8px 6px' }}>
            {loadingRoot ? <div style={{ fontSize: 12, color: '#6b7280', padding: 8 }}>加载中…</div> : null}
            {err ? <div style={{ fontSize: 12, color: '#dc2626', padding: 8 }}>{err}</div> : null}
            {!loadingRoot && !err && nodes.length === 0 ? (
              <div style={{ fontSize: 12, color: '#6b7280', padding: 8 }}>空工作区或无文件</div>
            ) : null}
            {!loadingRoot && !err ? renderLevel(nodes, 0) : null}
          </div>
          {/* 底部：git 汇总信息（分支 + 变更计数 + 最近提交） */}
          <div style={{
            borderTop: '1px solid rgb(229, 231, 235)', padding: '8px 14px 9px',
            fontSize: 11, color: '#4b5563',
            display: 'flex', flexDirection: 'column', gap: 3,
          }}>
            {git ? (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{
                    fontSize: 11, fontWeight: 700, color: '#b45309', background: 'rgb(254, 243, 199)',
                    padding: '1px 7px', borderRadius: 999, border: '1px solid rgb(252, 211, 77)', whiteSpace: 'nowrap',
                  }}>⎇ {git.branch || '—'}</span>
                  {git.ahead !== null && git.ahead > 0 ? (
                    <span style={{ color: '#2563eb', fontWeight: 600 }}>↑{git.ahead} 未推送</span>
                  ) : null}
                  <span style={{ flex: 1 }} />
                  <span style={{ color: '#6b7280', fontWeight: 600 }}>{git.modified + git.added + git.deleted + git.untracked} 处变更</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
                  {git.modified > 0 ? <span style={gitChip('#f59e0b', 'rgba(245,158,11,0.14)')}>M {git.modified}</span> : null}
                  {git.added > 0 ? <span style={gitChip('#22c55e', 'rgba(34,197,94,0.14)')}>A {git.added}</span> : null}
                  {git.deleted > 0 ? <span style={gitChip('#ef4444', 'rgba(239,68,68,0.14)')}>D {git.deleted}</span> : null}
                  {git.untracked > 0 ? <span style={gitChip('#64748b', 'rgba(100,116,139,0.14)')}>? {git.untracked}</span> : null}
                  {git.modified === 0 && git.added === 0 && git.deleted === 0 && git.untracked === 0 ? (
                    <span style={{ color: '#22c55e', fontWeight: 600 }}>✓ 工作区干净</span>
                  ) : null}
                </div>
                {git.lastCommit ? (
                  <div style={{ color: '#6b7280', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    ◷ {git.lastCommit}
                  </div>
                ) : null}
              </>
            ) : (
              <div style={{ color: '#9aa1ab' }}>无 git 信息</div>
            )}
          </div>
        </div>
      ) : null}
    </>
  )
}

const iconBtn: React.CSSProperties = {
  border: 'none', background: 'transparent', color: '#6b7280',
  cursor: 'pointer', fontSize: 14, padding: '2px 5px', borderRadius: 5,
}

/** git 计数小徽标（底部栏）。 */
function gitChip(color: string, bg: string): React.CSSProperties {
  return {
    fontSize: 10, fontWeight: 800, color, background: bg,
    padding: '1px 6px', borderRadius: 4, whiteSpace: 'nowrap',
  }
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
      id: 'ui-enhance-tool-stats',
      order: 6,
    }, ToolCallStats))
  ctx.slots.inject('conversation.session.header.utilities', () =>
    ctx.slots.register({
      name: 'conversation.session.header.utilities',
      id: 'ui-enhance-file-tree',
      order: 110,
    }, FileTreePanel))
  ctx.slots.inject('conversation.session.header.utilities', () =>
    ctx.slots.register({
      name: 'conversation.session.header.utilities',
      id: 'ui-enhance-open-editor',
      order: 100,
    }, OpenInEditorButton))

  // 隐藏官方「Session log 下载」按钮：官方 dsh-session-log-export 在该 slot
  // 注册 id=session-log-download（priority 默认 0）。按 slot 系统语义，
  // 「同 id + 更低 priority 覆盖原生条目」（dsh-webui 已验证此机制），
  // 我们用 priority -100 注册同 id、渲染 null 将其隐藏。
  ctx.slots.inject('conversation.session.header.utilities', () =>
    ctx.slots.register({
      name: 'conversation.session.header.utilities',
      id: 'session-log-download',
      priority: -100,
    }, () => null))
}
