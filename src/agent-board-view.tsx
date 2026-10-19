/**
 * The sidebar's Agent card right after New Session, with selectable status tiles and inline
 * Session details, including recent completion history. A row opens its Session; its trailing "…"
 * button opens the sidebar row's actions (pin, rename, fork, archive, copy ID). The host's own row
 * menu is a slot only its Workspace browser may render, so these call the same host operations.
 *
 * The sidebar shell declares no seat between New Session and its panel rows, so the card renders
 * through a portal into a host element placed right after that (phone-hidden by dsh-remote-control)
 * button, and is placed again whenever the shell rebuilds the column. It shows on every frame: the
 * computer's own sidebar and the remote phone drawer alike. Rows carry a pick attribute, so
 * dsh-remote-control folds its phone drawer on the same tap that opens the Session.
 *
 * Moved here from dsh-remote-control: the harness marks and the unreleased group are this plugin's own data.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { MenuItem, StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  AGENT_STATES, agentRows, completionHistory, historyRows, residentRows,
  type AgentRow, type AgentState, type CompletionRecord, type HarnessMark,
} from './agent-board.js'

/**
 * The host's primitives, read from its module loader when the card renders. A static import would pull their CSS
 * modules into every Node test that bundles the client; the build keeps the package external.
 */
const ui = (): typeof import('@deepseek-ai/dsh-client-ui-primitives') => require('@deepseek-ai/dsh-client-ui-primitives')

/** Attribute on the card's host element in the sidebar column. */
export const AGENTS_ATTRIBUTE = 'data-hp-agents'
/** Attribute on each Session row; dsh-remote-control folds its phone drawer on a tap there. */
export const AGENTS_PICK_ATTRIBUTE = 'data-hp-agents-pick'

/** The card's copy, merged into this plugin's `harness` locale. */
export const agentsZh = {
  'agents.close': '关闭',
  'agents.title': 'Agent 运行',
  'agents.pending': '待确认',
  'agents.running': '运行中',
  'agents.done': '已完成',
  'agents.resident': '未释放',
  'agents.history': '历史会话',
  'agents.pending.approval': '等待审批',
  'agents.pending.plan-review': '计划待审',
  'agents.pending.question': '等待回答',
  'agents.empty.pending': '暂无待确认的 Agent',
  'agents.empty.running': '暂无运行中的 Agent',
  'agents.empty.done': '暂无已完成会话或历史记录',
  'agents.empty.resident': '暂无未释放进程的会话',
  'agents.menu.more': '“{title}”的更多操作',
  'agents.menu.pin': '置顶会话',
  'agents.menu.unpin': '取消置顶',
  'agents.menu.rename': '重命名',
  'agents.menu.fork': '分叉会话',
  'agents.menu.archive': '归档会话',
  'agents.menu.copyId': '复制 Session ID',
  'agents.rename.title': '重命名会话',
  'agents.rename.field': '会话名称',
  'agents.rename.confirm': '重命名',
  'agents.archive.title': '停止并归档此会话？',
  'agents.archive.desc': '“{title}”仍有正在进行的工作。归档会先停止这些工作，被停止的工作不会自动继续。',
  'agents.archive.confirm': '停止并归档',
  'agents.dialog.cancel': '取消',
  'agents.toast.archived': '会话已归档',
  'agents.toast.forked': '已分叉会话',
  'agents.toast.copied': 'Session ID 已复制',
  'agents.toast.copyFailed': '复制失败，请重试',
  'agents.toast.failed': '操作失败，请重试',
  'agents.time.now': '刚刚',
  'agents.time.minutes': '{n} 分钟',
  'agents.time.hours': '{n} 小时',
  'agents.time.days': '{n} 天',
  'agents.time.months': '{n} 个月',
  'agents.time.years': '{n} 年',
}
export const agentsEn: Record<keyof typeof agentsZh, string> = {
  'agents.close': 'Close',
  'agents.title': 'Agents',
  'agents.pending': 'Waiting',
  'agents.running': 'Running',
  'agents.done': 'Finished',
  'agents.resident': 'Resident',
  'agents.history': 'Session history',
  'agents.pending.approval': 'Waiting for approval',
  'agents.pending.plan-review': 'Plan awaiting review',
  'agents.pending.question': 'Waiting for answer',
  'agents.empty.pending': 'No agents waiting',
  'agents.empty.running': 'No agents running',
  'agents.empty.done': 'No completed sessions or history',
  'agents.empty.resident': 'No idle sessions holding a process',
  'agents.menu.more': 'More actions for “{title}”',
  'agents.menu.pin': 'Pin session',
  'agents.menu.unpin': 'Unpin session',
  'agents.menu.rename': 'Rename',
  'agents.menu.fork': 'Fork session',
  'agents.menu.archive': 'Archive session',
  'agents.menu.copyId': 'Copy Session ID',
  'agents.rename.title': 'Rename session',
  'agents.rename.field': 'Session name',
  'agents.rename.confirm': 'Rename',
  'agents.archive.title': 'Stop and archive this session?',
  'agents.archive.desc': '“{title}” still has work in progress. Archiving stops it first; stopped work does not resume on its own.',
  'agents.archive.confirm': 'Stop and archive',
  'agents.dialog.cancel': 'Cancel',
  'agents.toast.archived': 'Session archived',
  'agents.toast.forked': 'Session forked',
  'agents.toast.copied': 'Session ID copied',
  'agents.toast.copyFailed': 'Copy failed, try again',
  'agents.toast.failed': 'Action failed, try again',
  'agents.time.now': 'now',
  'agents.time.minutes': '{n}min',
  'agents.time.hours': '{n}h',
  'agents.time.days': '{n}d',
  'agents.time.months': '{n}mo',
  'agents.time.years': '{n}y',
}
type AgentKey = keyof typeof agentsZh

/** New Session in the sidebar column: the card takes the seat right after it. */
const ANCHOR = '[class*="_sidebarCol"] button[class*="_newSession"]'

// Kept from dsh-remote-control, so the history a page saved before the move still shows.
const HISTORY_KEY = 'dsh-remote-control.agent-history.v1'

function savedHistory(): CompletionRecord<SessionId>[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]')
    if (!Array.isArray(value)) return []
    return value.filter((entry): entry is CompletionRecord<SessionId> =>
      typeof entry?.id === 'string' && typeof entry.completedAt === 'number' && Number.isFinite(entry.completedAt))
  } catch { return [] }
}

/** Host commands passed through the slot injection face. */
export interface AgentBoardInjected {
  openSession: (sessionId: SessionId) => void
  /** Each Session's harness (dsh, codex, claude-code…) and liveness; empty where harness-provider is absent. */
  harnesses: (sessionIds: SessionId[]) => Promise<Readonly<Record<string, HarnessMark>>>
  pinSession: (sessionId: SessionId) => Promise<void>
  unpinSession: (sessionId: SessionId) => Promise<void>
  renameSession: (sessionId: SessionId, title: string) => Promise<void>
  forkSession: (sessionId: SessionId) => Promise<unknown>
  /** Rejects with the host's `WorkspaceArchiveError` while the Session still has work running. */
  archiveSession: (sessionId: SessionId, options?: { stopActivity: true }) => Promise<void>
}

/** The harness-provider Remote call the board reads harnesses from. */
export interface HarnessRemote {
  harnesses: (request: { sessionIds: string[] }) => Promise<
    { ok: true; value: Record<string, HarnessMark> } | { ok: false; error: { message: string } }>
}

/** Overlay props supplied by the slot renderer. */
type Translate = (key: AgentKey, params?: Record<string, unknown>) => string

export type AgentBoardProps = PropsRuntime<'shell.overlay'> & { t: Translate } & InjectFace<AgentBoardInjected>

const DOT: Record<AgentState, StateDotState> = { pending: 'warning', running: 'ongoing', done: 'done', resident: 'idle' }

/** Row menu actions, in the host row menu's order. */
type RowAction = 'pin' | 'unpin' | 'rename' | 'fork' | 'archive' | 'copyId'

function actionIcon(action: RowAction): React.JSX.Element {
  const { IconArchiveOutlineRegular, IconBranchOutlineRegular, IconCopyOutlineRegular, IconEditOutlineRegular,
    IconPinFillRegular, IconPinOutlineRegular } = ui()
  switch (action) {
    case 'pin': return <IconPinOutlineRegular />
    case 'unpin': return <IconPinFillRegular />
    case 'rename': return <IconEditOutlineRegular />
    case 'fork': return <IconBranchOutlineRegular />
    case 'archive': return <IconArchiveOutlineRegular size={14} />
    case 'copyId': return <IconCopyOutlineRegular />
  }
}

/** Whether the host refused an archive because the Session still has work running (ui-workspace's own test). */
function activeRefusal(reason: unknown): boolean {
  return reason instanceof Error && reason.name === 'WorkspaceArchiveError'
    && (reason as Error & { rpcError?: { code?: string } }).rpcError?.code === 'workspace/session-active'
}

/** Most Session ids one harness-provider `harnesses` call accepts. */
const MARK_BATCH = 1000

const STYLE = ''
  + `[${AGENTS_ATTRIBUTE}] button{font:inherit;color:inherit;background:none;border:0;padding:0;text-align:left;`
  + 'cursor:pointer;-webkit-tap-highlight-color:transparent}'
  + '.hp-agents-card{margin:4px 0 8px;padding:8px;border-radius:16px;container-type:inline-size;'
  + 'box-shadow:inset 0 0 0 0.5px var(--dsw-alias-border-l3);display:flex;flex-direction:column;gap:6px}'
  + '.hp-agents-head{height:32px;display:flex;align-items:center;padding:0 6px}'
  + '.hp-agents-head b{font-size:15px;font-weight:600}'
  + '.hp-agents-tiles{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px}'
  + '.hp-agents-tile{height:60px;border-radius:12px;padding:8px 10px !important;box-sizing:border-box;display:flex;'
  + 'flex-direction:column;justify-content:space-between;background:var(--dsw-alias-interactive-bg-hover) !important}'
  // A desktop sidebar (264px and up) leaves a quarter too narrow for a tile's label: two rows of two there.
  + '@container (max-width:308px){.hp-agents-tiles{grid-template-columns:repeat(2,minmax(0,1fr))}}'
  + '.hp-agents-tile[aria-pressed="true"]{box-shadow:inset 0 0 0 1.5px var(--dsw-alias-label-tertiary)}'
  + '.hp-agents-tile[data-state="pending"]{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 16%,transparent) !important}'
  + '.hp-agents-tile[data-state="done"]{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 14%,transparent) !important}'
  + '.hp-agents-tile span{display:flex;align-items:center;gap:6px;font-size:12px;white-space:nowrap;color:var(--dsw-alias-label-secondary)}'
  + '.hp-agents-tile b{font-size:20px;font-weight:700;line-height:24px}'
  + '.hp-agents-item{height:48px;min-height:48px;border-radius:10px;display:flex;align-items:center}'
  + '.hp-agents-item:has(.hp-agents-row:active){background:var(--dsw-alias-interactive-bg-active)}'
  + '.hp-agents-row{flex:1;min-width:0;height:100%;padding:6px 0 6px 8px !important;box-sizing:border-box;'
  + 'display:flex;align-items:center;gap:10px}'
  + '.hp-agents-more{width:36px;height:40px;flex:none;display:flex !important;align-items:center;justify-content:center;'
  + 'color:var(--dsw-alias-label-secondary) !important}'
  + '.hp-agents-input{width:100%;box-sizing:border-box;height:40px;padding:0 12px;border-radius:10px;font:inherit;font-size:16px;'
  + 'color:var(--dsw-alias-label-primary);background:var(--dsw-specific-input-major,transparent);'
  + 'border:0.5px solid var(--dsw-alias-border-l3);outline:none}'
  + '.hp-agents-error{margin-top:8px;font-size:13px;color:var(--dsw-alias-state-error-primary)}'
  + '.hp-agents-lead{width:16px;flex:none;display:flex;justify-content:center}'
  + '.hp-agents-text{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}'
  + '.hp-agents-title{font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}'
  + '.hp-agents-meta{font-size:12px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}'
  + '.hp-agents-meta[data-state="pending"]{color:var(--dsw-alias-state-warn-primary)}'
  + '.hp-agents-time{flex:none;font-size:12px;color:var(--dsw-alias-label-tertiary)}'
  + '.hp-agents-empty{margin:0;padding:10px 6px;font-size:13px;color:var(--dsw-alias-label-secondary)}'
  + '.hp-agents-list{max-height:40dvh;overflow:auto;display:flex;flex-direction:column;gap:12px}'
  + '.hp-agents-group h3{margin:0 0 6px;padding:0 6px;font-size:13px;font-weight:500;display:flex;align-items:center;gap:6px;'
  + 'color:var(--dsw-alias-label-secondary)}'
  // Five 48px rows plus the card's padding; further rows stay reachable by native scrolling.
  + '.hp-agents-group > div{padding:4px;max-height:248px;box-sizing:border-box;overflow-y:auto;'
  + 'overscroll-behavior-y:contain;scrollbar-width:thin;border-radius:16px;box-shadow:inset 0 0 0 0.5px var(--dsw-alias-border-l3)}'

/**
 * Keep a host element right after New Session in the sidebar column.
 * @returns the placed host, or null before the column exists.
 */
function useCardHost(): HTMLElement | null {
  const [host] = useState(() => {
    const element = document.createElement('div')
    element.setAttribute(AGENTS_ATTRIBUTE, '')
    return element
  })
  const [placed, setPlaced] = useState(false)
  useEffect(() => {
    const place = (): void => {
      if (host.isConnected && host.previousElementSibling?.matches(ANCHOR) === true) return
      const anchor = document.querySelector(ANCHOR)
      if (anchor === null) host.remove()
      else anchor.after(host)
      setPlaced(anchor !== null)
    }
    place()
    const observer = new MutationObserver(place)
    observer.observe(document.body, { childList: true, subtree: true })
    return () => {
      observer.disconnect()
      host.remove()
      setPlaced(false)
    }
  }, [host])
  return placed ? host : null
}

/**
 * Read harness-provider's marks for the listed Sessions, and again every 30 seconds so a reclaimed
 * process leaves the unreleased group; a failed batch waits for the next round.
 * @returns mark by Session identity, as far as known.
 */
function useMarks(ids: readonly string[], lookup: AgentBoardInjected['harnesses']): ReadonlyMap<string, HarnessMark> {
  const [marks, setMarks] = useState<ReadonlyMap<string, HarnessMark>>(() => new Map())
  const latest = useRef(lookup)
  latest.current = lookup
  const key = ids.join('\n')
  useEffect(() => {
    if (key === '') return
    const all = key.split('\n') as SessionId[]
    const ask = (): void => {
      for (let start = 0; start < all.length; start += MARK_BATCH) {
        latest.current(all.slice(start, start + MARK_BATCH)).then((batch) => {
          setMarks((previous) => {
            const next = new Map(previous)
            for (const [id, mark] of Object.entries(batch)) next.set(id, mark)
            return next
          })
        }, () => {})
      }
    }
    ask()
    const timer = window.setInterval(ask, 30_000)
    return () => { window.clearInterval(timer) }
  }, [key])
  return marks
}

/** A clock for relative times that ticks while the board is shown. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = window.setInterval(() => { setNow(Date.now()) }, 30_000)
    return () => { window.clearInterval(timer) }
  }, [active])
  return now
}

function timeLabel(at: number, now: number, t: Translate): string {
  const { unit, n } = ui().relativeTime(at, now)
  return unit === 'now' ? t('agents.time.now') : t(`agents.time.${unit}`, { n })
}

function stateLabel(row: AgentRow<SessionId>, t: Translate): string {
  return row.pending === undefined ? t(`agents.${row.state}`) : t(`agents.pending.${row.pending}`)
}

function Row({ row, mark, pinned, now, t, open, act }: {
  row: AgentRow<SessionId>; mark: HarnessMark | undefined; pinned: boolean; now: number; t: Translate
  open: (id: SessionId) => void; act: (action: RowAction, row: AgentRow<SessionId>) => void
}) {
  const { Menu, StateDot, IconEllipsisOutlineRegular } = ui()
  const [menuOpen, setMenuOpen] = useState(false)
  const harness = mark?.harness
  const meta = [stateLabel(row, t), row.workspace].filter(Boolean).join(' · ')
  const actions: RowAction[] = [pinned ? 'unpin' : 'pin', 'rename', 'fork', 'archive', 'copyId']
  const items: MenuItem[] = actions.map(id => ({ id, icon: actionIcon(id), label: t(`agents.menu.${id}`) }))
  return (
    <div className="hp-agents-item">
      <button
        type="button"
        className="hp-agents-row"
        // This plugin's sidebar mark sheet draws the logo into the first span, breathing while it runs,
        // with a corner badge on delegated Sessions.
        data-hp-harness={harness}
        data-hp-delegated={mark?.delegated === true ? '' : undefined}
        data-hp-running={harness !== undefined && row.state === 'running' ? '' : undefined}
        {...{ [AGENTS_PICK_ATTRIBUTE]: '' }}
        onClick={() => { open(row.id) }}
      >
        <span className="hp-agents-lead">{harness === undefined && <StateDot state={DOT[row.state]} />}</span>
        <span className="hp-agents-text">
          <span className="hp-agents-title">{row.title}</span>
          <span className="hp-agents-meta" data-state={row.state}>{meta}</span>
        </span>
        <span className="hp-agents-time">{timeLabel(row.updatedAt, now, t)}</span>
      </button>
      <Menu
        open={menuOpen}
        onClose={() => { setMenuOpen(false) }}
        portal
        align="end"
        items={items}
        onSelect={(id) => { setMenuOpen(false); act(id as RowAction, row) }}
        anchor={(
          <button
            type="button"
            className="hp-agents-more"
            aria-label={t('agents.menu.more', { title: row.title })}
            onClick={() => { setMenuOpen(value => !value) }}
          >
            <IconEllipsisOutlineRegular />
          </button>
        )}
      />
    </div>
  )
}

/** A rename or stop-and-archive request; `draft` is present for rename. */
interface ActionDialog {
  title: string
  description?: string
  draft?: string
  confirm: string
  run: (value: string) => Promise<void>
}

/** One request's dialog: the draft, in-flight and error state die with it. */
function ActionDialogView({ dialog, t, close }: { dialog: ActionDialog; t: Translate; close: () => void }) {
  const { Button, Modal } = ui()
  const [draft, setDraft] = useState(dialog.draft ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const composing = useRef(false)
  const value = draft.trim()
  const blocked = busy || (dialog.draft !== undefined && value === '')
  const dismiss = (): void => { if (!busy) close() }
  const confirm = (): void => {
    if (blocked) return
    setBusy(true)
    setError(null)
    dialog.run(value).then(close, (reason: unknown) => {
      setBusy(false)
      setError(reason instanceof Error ? reason.message : String(reason))
    })
  }
  return (
    <Modal
      open
      onClose={dismiss}
      closeLabel={t('agents.close')}
      title={dialog.title}
      {...(dialog.description === undefined ? {} : { description: dialog.description })}
      footer={(
        <>
          <Button variant="outline" disabled={busy} onClick={dismiss}>{t('agents.dialog.cancel')}</Button>
          <Button variant="primary" disabled={blocked} onClick={confirm}>{dialog.confirm}</Button>
        </>
      )}
    >
      {dialog.draft !== undefined && (
        <input
          className="hp-agents-input"
          value={draft}
          aria-label={t('agents.rename.field')}
          data-modal-autofocus
          disabled={busy}
          onChange={(event) => { setDraft(event.target.value); setError(null) }}
          onCompositionStart={() => { composing.current = true }}
          onCompositionEnd={() => { composing.current = false }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !composing.current) { event.preventDefault(); confirm() }
          }}
        />
      )}
      {error !== null && <div className="hp-agents-error" role="alert">{error}</div>}
    </Modal>
  )
}

function Tile({ state, count, selected, t, pick }: {
  state: AgentState; count: number; selected: boolean; t: Translate; pick: () => void
}) {
  const { StateDot } = ui()
  // The running spinner only turns while something runs; an empty tile rests on the idle dot.
  const dot = state === 'running' && count === 0 ? 'idle' : DOT[state]
  return (
    <button
      type="button"
      className="hp-agents-tile"
      data-state={state}
      aria-pressed={selected}
      onClick={pick}
    >
      <span><StateDot state={dot} size={dot === 'ongoing' ? 12 : 10} />{t(`agents.${state}`)}</span>
      <b>{count}</b>
    </button>
  )
}

/**
 * Render the Agent card and inline details into the sidebar column.
 * @returns the portal, or null before the column exists.
 */
export function AgentBoard(props: AgentBoardProps): React.JSX.Element | null {
  const { t, useSessions, useSessionStatus, useWorkspaces, openSession } = props
  const host = useCardHost()
  const now = useNow(host !== null)
  const sessions = useSessions(value => value)
  const workspaces = useWorkspaces(value => value)
  const list = useMemo(() => ({
    ...sessions,
    ids: sessions.ids.filter(id => !workspaces.archivedSessionIds.includes(id)),
  }), [sessions, workspaces.archivedSessionIds])
  const statuses = useSessionStatus(value => value)
  const rows = useMemo(() => agentRows(list, statuses), [list, statuses])
  const [history, setHistory] = useState(savedHistory)
  const previous = useRef<typeof statuses>()
  useEffect(() => {
    if (list.phase !== 'ready' || workspaces.phase !== 'ready') { previous.current = undefined; return }
    const before = previous.current
    previous.current = statuses
    setHistory(current => {
      const next = completionHistory(list, statuses, before, current)
      return next.length === current.length && next.every((entry, index) =>
        entry.id === current[index]?.id && entry.completedAt === current[index]?.completedAt) ? current : next
    })
  }, [list, statuses, workspaces.phase])
  useEffect(() => {
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(history)) } catch { /* Storage may be disabled. */ }
  }, [history])
  const completed = useMemo(() => historyRows(list, statuses, history), [list, statuses, history])
  const candidates = useMemo(() => host === null ? []
    : list.ids.filter(id => list.byId[id]?.blank === false && list.byId[id]?.origin !== 'subagent'), [host, list])
  const marks = useMarks(candidates, props.harnesses)
  const resident = useMemo(() => residentRows(list, statuses, marks), [list, statuses, marks])
  const [filter, setFilter] = useState<AgentState>('running')
  const [dialog, setDialog] = useState<ActionDialog | null>(null)
  const [toast, setToast] = useState<{ text: string; seq: number } | null>(null)
  if (host === null) return null

  const { StateDot, Toast, writeClipboard } = ui()
  const pinned = new Set<string>(workspaces.pinnedSessionIds)
  const say = (key: Parameters<Translate>[0]): void => {
    setToast(previous => ({ text: t(key), seq: (previous?.seq ?? 0) + 1 }))
  }
  const failed = (): void => { say('agents.toast.failed') }
  const act = (action: RowAction, row: AgentRow<SessionId>): void => {
    switch (action) {
      case 'pin': props.pinSession(row.id).catch(failed); break
      case 'unpin': props.unpinSession(row.id).catch(failed); break
      case 'fork': props.forkSession(row.id).then(() => { say('agents.toast.forked') }, failed); break
      case 'copyId':
        void writeClipboard(row.id).then((copied) => { say(copied ? 'agents.toast.copied' : 'agents.toast.copyFailed') })
        break
      case 'rename':
        setDialog({ title: t('agents.rename.title'), draft: row.title, confirm: t('agents.rename.confirm'),
          run: title => props.renameSession(row.id, title) })
        break
      case 'archive':
        props.archiveSession(row.id).then(() => { say('agents.toast.archived') }, (reason: unknown) => {
          if (!activeRefusal(reason)) { failed(); return }
          setDialog({ title: t('agents.archive.title'), description: t('agents.archive.desc', { title: row.title }),
            confirm: t('agents.archive.confirm'),
            run: () => props.archiveSession(row.id, { stopActivity: true }).then(() => { say('agents.toast.archived') }) })
        })
        break
    }
  }

  const all = [...rows, ...resident]
  const counts = { pending: 0, running: 0, done: 0, resident: 0 }
  for (const row of all) counts[row.state] += 1
  const shown = all.filter(row => row.state === filter)
  const showHistory = filter === 'done' && completed.length > 0

  return createPortal(
    <>
      <style>{STYLE}</style>
      <section className="hp-agents-card" aria-label={t('agents.title')}>
        <div className="hp-agents-head"><b>{t('agents.title')}</b></div>
        <div className="hp-agents-tiles">
          {AGENT_STATES.map(state => (
            <Tile key={state} state={state} count={counts[state]} selected={filter === state} t={t}
              pick={() => { setFilter(state) }} />
          ))}
        </div>
        <div className="hp-agents-list" role="region" aria-label={t(`agents.${filter}`)}>
          {shown.length === 0 && !showHistory && <p className="hp-agents-empty">{t(`agents.empty.${filter}`)}</p>}
          {shown.length > 0 && (
            <section className="hp-agents-group">
              <h3><StateDot state={DOT[filter]} size={filter === 'running' ? 12 : 10} />{t(`agents.${filter}`)}</h3>
              <div>{shown.map(row => <Row key={row.id} row={row} mark={marks.get(row.id)} pinned={pinned.has(row.id)} now={now} t={t} open={openSession} act={act} />)}</div>
            </section>
          )}
          {showHistory && (
            <section className="hp-agents-group hp-agents-history">
              <h3><StateDot state="done" size={10} />{t('agents.history')}</h3>
              <div>{completed.map(row => <Row key={row.id} row={row} mark={marks.get(row.id)} pinned={pinned.has(row.id)} now={now} t={t} open={openSession} act={act} />)}</div>
            </section>
          )}
        </div>
      </section>
      {dialog !== null && <ActionDialogView dialog={dialog} t={t} close={() => { setDialog(null) }} />}
      {toast !== null && <Toast key={toast.seq} text={toast.text} onDone={() => { setToast(null) }} />}
    </>,
    host,
  )
}
