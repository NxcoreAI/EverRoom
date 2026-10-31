import {
  Crosshair,
  FileText,
  History,
  MessageSquare,
  Plus,
  Sparkles,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { AgentSession, AgentSessionSnapshot } from '@nxcore/agent-contract'

import { fetchRealFiles, type RealOfficeFile } from '@/office-proto/data'
import { FileTypeIcon } from '@/office-proto/pages/parts'

import { useWorkbenchStore } from '../state/store'
import { relativeTimeLabel, shortDateLabel } from '../types'
import { cn } from '../ui/cn'
import { Badge, Button, EmptyState, Spinner } from '../ui/primitives'
import {
  ACTIVITY_COLLAPSED_LIMIT,
  buildActivities,
  collapseActivities,
  extractInsightText,
  insightTextFromEvents,
  type ActivityItem,
} from './activity'
import type { WorkspacePageProps } from './contracts'
import './overview.css'

/** 与后端 `agent_workspaces.goals` 上限保持一致（最多 12 条）。 */
const MAX_GOALS = 12

/** 动态卡一次最多拉这么多文件库条目参与合并。 */
const ACTIVITY_FILE_LIMIT = 20

/**
 * 工作空间「概览」页：项目头（可编辑）+ 小 E 洞察 + 动态时间线。
 *
 * 数据全部来自真实来源：
 * - 项目头 = `AgentWorkspace`（描述/目标写回 `updateWorkspaceMeta`）；
 * - 洞察 = 最近更新会话的 `agent.getSession` 消息（空则 `getEvents` 兜底）；
 * - 动态 = 本空间 sessions + `fetchRealFiles` 文件库条目合并倒序。
 * 无桥/失败时静默降级为空态，不造 mock 文案。
 */
export function OverviewPage({
  workspace,
  sessions,
  onOpenSession,
  onOpenFile,
  onOpenPage,
  onNewWork,
  onToast,
}: WorkspacePageProps) {
  const updateWorkspaceMeta = useWorkbenchStore((state) => state.updateWorkspaceMeta)
  const files = useWorkspaceFiles(ACTIVITY_FILE_LIMIT)
  const insight = useWorkspaceInsight(sessions)

  const runningCount = useMemo(
    () => sessions.filter((session) => session.status === 'running').length,
    [sessions],
  )

  const activities = useMemo(
    () => buildActivities({ sessions, files: files.items }),
    [files.items, sessions],
  )
  const [timelineExpanded, setTimelineExpanded] = useState(false)
  const timeline = collapseActivities(activities, timelineExpanded)

  /* ── 项目名称行内编辑 ── */
  const [titleEditing, setTitleEditing] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const titleRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (titleEditing) titleRef.current?.focus()
  }, [titleEditing])

  function startTitleEdit(): void {
    setTitleDraft(workspace.name)
    setTitleEditing(true)
  }

  const commitTitle = useCallback(() => {
    if (!titleEditing) return
    const next = titleDraft.trim()
    setTitleEditing(false)
    if (!next || next === workspace.name) return
    void updateWorkspaceMeta(workspace.id, { name: next }).then((ok) => {
      if (!ok) onToast('名称保存失败，请稍后重试')
    })
  }, [onToast, titleDraft, titleEditing, updateWorkspaceMeta, workspace.id, workspace.name])

  /* ── 描述行内编辑（失焦 / ⌘Enter 保存） ── */
  const [descriptionEditing, setDescriptionEditing] = useState(false)
  const [descriptionDraft, setDescriptionDraft] = useState('')
  const descriptionRef = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    if (descriptionEditing) descriptionRef.current?.focus()
  }, [descriptionEditing])

  function startDescriptionEdit(): void {
    setDescriptionDraft(workspace.description ?? '')
    setDescriptionEditing(true)
  }

  const commitDescription = useCallback(() => {
    if (!descriptionEditing) return
    const next = descriptionDraft.trim()
    setDescriptionEditing(false)
    if (next === (workspace.description ?? '').trim()) return
    void updateWorkspaceMeta(workspace.id, { description: next ? next : null }).then((ok) => {
      if (!ok) onToast('描述保存失败，请稍后重试')
    })
  }, [descriptionDraft, descriptionEditing, onToast, updateWorkspaceMeta, workspace.description, workspace.id])

  /* ── 目标药丸（可增删，最多 12 条） ── */
  const [goals, setGoals] = useState<string[]>(workspace.goals ?? [])
  const [savingGoals, setSavingGoals] = useState(false)
  const [goalAdding, setGoalAdding] = useState(false)
  const [goalDraft, setGoalDraft] = useState('')
  const goalInputRef = useRef<HTMLInputElement | null>(null)
  /** 本地刚写入、服务端快照还没回来的目标；用来避免「保存成功后又被旧 props 回滚」。 */
  const lastPersistedGoalsRef = useRef<string[] | null>(null)

  // 服务端目标变了（保存成功 / 其它入口修改）就同步本地列表；本地保存期间不回滚。
  useEffect(() => {
    const serverGoals = workspace.goals ?? []
    const persisted = lastPersistedGoalsRef.current
    if (persisted && stringArraysEqual(serverGoals, persisted)) {
      lastPersistedGoalsRef.current = null
    }
    if (!savingGoals && !lastPersistedGoalsRef.current) setGoals(serverGoals)
  }, [savingGoals, workspace.goals])

  useEffect(() => {
    if (goalAdding) goalInputRef.current?.focus()
  }, [goalAdding])

  const persistGoals = useCallback((next: string[]) => {
    setGoals(next)
    lastPersistedGoalsRef.current = next
    setSavingGoals(true)
    void updateWorkspaceMeta(workspace.id, { goals: next }).then((ok) => {
      setSavingGoals(false)
      if (!ok) {
        lastPersistedGoalsRef.current = null
        setGoals(workspace.goals ?? [])
        onToast('目标保存失败，请稍后重试')
      }
    })
  }, [onToast, updateWorkspaceMeta, workspace.goals, workspace.id])

  function addGoal(raw: string): void {
    const value = raw.trim()
    if (!value) return
    if (goals.includes(value)) {
      setGoalDraft('')
      return
    }
    if (goals.length >= MAX_GOALS) {
      onToast('目标最多 12 条')
      return
    }
    if (savingGoals) return
    persistGoals([...goals, value])
    setGoalDraft('')
  }

  function removeGoal(goal: string): void {
    if (savingGoals || !goals.includes(goal)) return
    persistGoals(goals.filter((item) => item !== goal))
  }

  function startGoalAdd(): void {
    setGoalDraft('')
    setGoalAdding(true)
  }

  function closeGoalAdd(): void {
    setGoalAdding(false)
    setGoalDraft('')
  }

  /* ── 项目头 meta 行（工作总数在侧栏分组头，进行中聚合状态在页头 badge，这里只留开始日期） ── */
  const startedLabel = shortDateLabel(workspace.createdAt) || '—'
  const hasDescription = Boolean(workspace.description?.trim())

  function openActivity(item: ActivityItem): void {
    if (item.target.type === 'session') onOpenSession(item.target.sessionId)
    else onOpenFile(item.target.file)
  }

  return (
    <div className="wb-wspage wb-ov">
      <header className="wb-ov-head">
        <div className="wb-ov-head-top">
          <Badge tone={runningCount > 0 ? 'running' : 'neutral'} dot>
            {runningCount > 0 ? `进行中 ${runningCount}` : '待开始'}
          </Badge>
          <Button variant="primary" icon={<Plus size={15} />} onClick={onNewWork}>
            新建工作
          </Button>
        </div>

        <div className="wb-ov-title-row">
          {titleEditing ? (
            <input
              ref={titleRef}
              className="ui-input wb-ov-title-input"
              aria-label="工作空间名称"
              value={titleDraft}
              onChange={(event) => setTitleDraft(event.target.value)}
              onBlur={commitTitle}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  commitTitle()
                } else if (event.key === 'Escape') {
                  event.preventDefault()
                  setTitleEditing(false)
                }
              }}
            />
          ) : (
            <h1 className="wb-ov-title">
              <button
                type="button"
                className="wb-ov-title-btn"
                title="点击重命名工作空间"
                onClick={startTitleEdit}
              >
                {workspace.name}
              </button>
            </h1>
          )}
        </div>

        {descriptionEditing ? (
          <textarea
            ref={descriptionRef}
            className="ui-input ui-textarea wb-ov-desc-input"
            aria-label="项目描述（⌘Enter 保存）"
            placeholder="补充项目描述…"
            value={descriptionDraft}
            onChange={(event) => setDescriptionDraft(event.target.value)}
            onBlur={commitDescription}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault()
                commitDescription()
              } else if (event.key === 'Escape') {
                event.preventDefault()
                setDescriptionEditing(false)
              }
            }}
          />
        ) : (
          <button
            type="button"
            className={cn('wb-ov-desc', !hasDescription && 'is-empty')}
            onClick={startDescriptionEdit}
          >
            {hasDescription ? workspace.description : '补充项目描述…'}
          </button>
        )}

        <div className="wb-ov-goals" role="group" aria-label="目标">
          {goals.map((goal) => (
            <span key={goal} className="wb-ov-goal">
              <Crosshair size={12} aria-hidden="true" />
              <span className="wb-ov-goal-text" title={goal}>{goal}</span>
              <button
                type="button"
                className="wb-ov-goal-remove"
                aria-label={`移除目标：${goal}`}
                title="移除目标"
                disabled={savingGoals}
                onClick={() => removeGoal(goal)}
              >
                <X size={12} aria-hidden="true" />
              </button>
            </span>
          ))}

          {goalAdding ? (
            <input
              ref={goalInputRef}
              className="wb-ov-goal-input"
              aria-label="新目标"
              placeholder="输入目标"
              maxLength={200}
              value={goalDraft}
              onChange={(event) => setGoalDraft(event.target.value)}
              onBlur={() => {
                if (goalDraft.trim()) addGoal(goalDraft)
                closeGoalAdd()
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ',') {
                  event.preventDefault()
                  if (goalDraft.trim()) addGoal(goalDraft)
                  else closeGoalAdd()
                } else if (event.key === 'Escape') {
                  event.preventDefault()
                  closeGoalAdd()
                } else if (event.key === 'Backspace' && !goalDraft && goals.length > 0) {
                  event.preventDefault()
                  removeGoal(goals[goals.length - 1]!)
                }
              }}
            />
          ) : goals.length < MAX_GOALS ? (
            <button type="button" className="wb-ov-goal-add" onClick={startGoalAdd} disabled={savingGoals}>
              ＋ 添加目标
            </button>
          ) : null}
          {savingGoals ? <Spinner size={12} className="wb-ov-goals-spinner" /> : null}
        </div>

        <p className="wb-ov-meta">{startedLabel} 开始</p>
      </header>

      {insight.status === 'loading' || insight.text ? (
        <section className="wb-ov-card" aria-labelledby="wb-ov-insight-heading">
          <header className="wb-ov-card-head">
            <span className="wb-ov-insight-badge">
              <Sparkles size={13} aria-hidden="true" />
              <span id="wb-ov-insight-heading">洞察</span>
            </span>
          </header>
          {insight.status === 'loading' ? (
            <p className="wb-ov-insight-state"><Spinner size={13} /></p>
          ) : insight.text ? (
            <p className="wb-ov-insight-text">{insight.text}</p>
          ) : null}
        </section>
      ) : null}

      <section className="wb-ov-card" aria-labelledby="wb-ov-activity-heading">
        <header className="wb-ov-card-head">
          <h2 id="wb-ov-activity-heading">动态</h2>
          <button
            type="button"
            className="ui-btn ui-btn--ghost ui-btn--sm wb-ov-card-action"
            onClick={() => onOpenPage('plan')}
          >
            全部工作
          </button>
        </header>

        {files.status === 'loading' && activities.length === 0 ? (
          <p className="wb-ov-insight-state"><Spinner size={13} /></p>
        ) : null}

        {files.status !== 'loading' && activities.length === 0 ? (
          <EmptyState
            className="wb-ov-empty"
            icon={<History size={18} />}
            title="还没有动态"
          />
        ) : null}

        {timeline.visible.length > 0 ? (
          <ul className="wb-ov-timeline">
            {timeline.visible.map((item) => (
              <li key={item.id}>
                <button type="button" className="wb-ov-activity" onClick={() => openActivity(item)}>
                  <span className={cn('wb-ov-activity-icon', item.kind === 'file-generated' && 'is-accent', item.kind === 'session-run' && 'is-running')}>
                    <ActivityIcon item={item} />
                  </span>
                  <span className="wb-ov-activity-label">{item.label}</span>
                  <span className="wb-ov-activity-time">{relativeTimeLabel(item.at)}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}

        {activities.length > ACTIVITY_COLLAPSED_LIMIT ? (
          <button
            type="button"
            className="wb-ov-more"
            onClick={() => setTimelineExpanded((value) => !value)}
          >
            {timelineExpanded ? '收起' : '显示更早'}
          </button>
        ) : null}

        {files.status === 'unavailable' ? (
          <p className="wb-ov-note">文件库暂不可用</p>
        ) : null}
      </section>
    </div>
  )
}

function ActivityIcon({ item }: { item: ActivityItem }) {
  if (item.target.type === 'file') {
    return item.kind === 'file-generated'
      ? <Sparkles size={13} aria-hidden="true" />
      : <FileTypeIcon kind={item.target.file.kind} size={20} />
  }
  return item.kind === 'session-run'
    ? <MessageSquare size={13} aria-hidden="true" />
    : <FileText size={13} aria-hidden="true" />
}

function stringArraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

/* ───────────────── 真实数据 hooks ───────────────── */

type LoadState = 'loading' | 'ready' | 'unavailable'

/** 文件库条目（含 Agent 产物/材料）；无桥或失败 → unavailable，动态只留工作项。 */
function useWorkspaceFiles(limit: number): { status: LoadState; items: RealOfficeFile[] } {
  const [status, setStatus] = useState<LoadState>('loading')
  const [items, setItems] = useState<RealOfficeFile[]>([])

  useEffect(() => {
    let cancelled = false
    void fetchRealFiles(limit)
      .then((result) => {
        if (cancelled) return
        if (!result) {
          setStatus('unavailable')
          return
        }
        setItems(result.items)
        setStatus('ready')
      })
      .catch(() => {
        if (!cancelled) setStatus('unavailable')
      })
    return () => { cancelled = true }
  }, [limit])

  return { status, items }
}

interface InsightState {
  status: LoadState | 'empty'
  text: string | null
}

/** 洞察：取本空间最近更新的会话，折出最后一条 assistant 文本。 */
function useWorkspaceInsight(sessions: readonly AgentSession[]): InsightState {
  const latest = useMemo(() => {
    let current: AgentSession | null = null
    let currentTime = Number.NEGATIVE_INFINITY
    for (const session of sessions) {
      const parsed = Date.parse(session.updatedAt)
      const time = Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY
      if (!current || time > currentTime) {
        current = session
        currentTime = time
      }
    }
    return current
  }, [sessions])

  const sessionId = latest?.id ?? null
  const updatedAt = latest?.updatedAt ?? ''

  const [state, setState] = useState<InsightState>({ status: 'loading', text: null })

  useEffect(() => {
    if (!sessionId) {
      setState({ status: 'empty', text: null })
      return
    }
    let cancelled = false
    setState({ status: 'loading', text: null })
    void loadInsightText(sessionId).then((text) => {
      if (cancelled) return
      setState(text ? { status: 'ready', text } : { status: 'empty', text: null })
    })
    return () => { cancelled = true }
  }, [sessionId, updatedAt])

  return state
}

/** 消息快照优先；快照没有正文时用该会话 activeRun 的事件流兜底。失败静默。 */
async function loadInsightText(sessionId: string): Promise<string | null> {
  const agent = window.nxcore?.agent
  if (!agent?.getSession) return null
  try {
    const snapshot: AgentSessionSnapshot = await agent.getSession(sessionId)
    const fromMessages = extractInsightText(snapshot.messages ?? [])
    if (fromMessages) return fromMessages
    if (!snapshot.activeRun || !agent.getEvents) return null
    const events = await agent.getEvents(sessionId, snapshot.activeRun.id, 0)
    return insightTextFromEvents(events ?? [])
  } catch {
    return null
  }
}
