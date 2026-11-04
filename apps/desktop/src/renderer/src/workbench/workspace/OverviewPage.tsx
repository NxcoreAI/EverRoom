import {
  Check,
  Crosshair,
  Eye,
  FilePlus,
  FileText,
  Flag,
  History,
  Paperclip,
  Play,
  Plus,
  RefreshCw,
  Sparkles,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { AgentSession } from '@nxcore/agent-contract'

import type { OfficeFile } from '@/office-proto/data'

import { useWorkbenchStore } from '../state/store'
import { relativeTimeLabel, sessionDisplayTitle, shortDateLabel } from '../types'
import { cn } from '../ui/cn'
import { Badge, Button, EmptyState, IconButton, Spinner } from '../ui/primitives'
import {
  ACTIVITY_TONE,
  buildActivities,
  collapseActivities,
  type ActivityKind,
  type ActivitySegment,
} from './activity'
import {
  INSIGHT_COPY,
  formatInsightSourceLine,
  formatInsightUpdatedLabel,
  type WorkspaceInsight,
} from './insight'
import type { WorkspacePageProps } from './contracts'
import { useFileLibrary } from './useFileLibrary'
import { useWorkspaceActivities } from './useWorkspaceActivities'
import { useWorkspaceInsight } from './useWorkspaceInsight'
import './overview.css'

/** 与后端 `agent_workspaces.goals` 上限保持一致（最多 12 条）。 */
const MAX_GOALS = 12

/** 动态卡一次最多拉这么多文件库条目参与合并。 */
const ACTIVITY_FILE_LIMIT = 20

/** kind → 图标（与 ACTIVITY_TONE 同源：一个定形状、一个定颜色）。 */
const ACTIVITY_GLYPHS: Record<ActivityKind, typeof Play> = {
  'work-created': FileText,
  'work-run': Play,
  'work-review': Eye,
  'work-done': Check,
  output: FilePlus,
  material: Paperclip,
  plan: Flag,
  insight: Sparkles,
}

/**
 * 工作空间「概览」页：项目头（可编辑）+ 小 E 洞察 + 动态时间线。
 *
 * 数据全部来自真实来源：
 * - 项目头 = `AgentWorkspace`（描述/目标写回 `updateWorkspaceMeta`）；
 * - 洞察 = 最近更新会话的 `agent.getSession` 消息（空则 `getEvents` 兜底）；
 * - 动态 = 本空间 sessions + 本空间文件库（`useFileLibrary`，产物落库自动重拉）合并倒序。
 * 无桥/失败时静默降级为空态，不造 mock 文案。模型与分期见
 * `docs/workspace-overview-activity-plan.zh-CN.md`。
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
  // 本空间文件库（空间隔离 + 产物落库自动重拉）：动态的「产物/材料」行来自这里。
  const files = useFileLibrary(workspace.id, { limit: ACTIVITY_FILE_LIMIT })
  const insight = useWorkspaceInsight({
    workspaceId: workspace.id,
    sessions,
    fileCount: files.state === 'ready' ? files.total : undefined,
  })

  const runningCount = useMemo(
    () => sessions.filter((session) => session.status === 'running').length,
    [sessions],
  )

  // 会话状态指纹：只有「谁在跑/跑完」真的变了才重拉动态，避免 3.5s 轮询每次都打网关。
  const sessionsSignature = useMemo(
    () => sessions.map((session) => `${session.id}:${session.status}:${session.updatedAt}`).join('|'),
    [sessions],
  )
  // 服务端派生（runs 的开始/结束 + 产物/材料 + 计划事件）优先；无桥/失败回落本地派生。
  const hasRunningSession = sessions.some((session) => session.status === 'running')
  const feed = useWorkspaceActivities(workspace.id, {
    limit: ACTIVITY_FILE_LIMIT,
    refreshKey: sessionsSignature,
    // 审批卡（等你确认）不会改会话 updatedAt，只能在有 run 跑着时低频问一次网关。
    pollMs: hasRunningSession ? 10_000 : 0,
  })
  const localActivities = useMemo(
    () => buildActivities({ sessions, files: files.items }),
    [files.items, sessions],
  )
  const activities = feed.state === 'ready' ? feed.items : localActivities

  // 产物落盘（agent-generated / 导入）不会改会话时间戳，但动态里必须立刻多一行：
  // 直接监听办公侧的文件事件，命中本空间就重拉首屏。
  const refreshFeed = feed.refresh
  useEffect(() => {
    const office = window.nxcore?.office
    if (typeof office?.onAgentFile !== 'function') return
    return office.onAgentFile((event) => {
      if (event.type !== 'done' && event.type !== 'edited') return
      if (event.workspaceId && event.workspaceId !== workspace.id) return
      refreshFeed()
    })
  }, [refreshFeed, workspace.id])

  // 折叠：首屏 8 条；「显示更早」先展开本地已加载的，再按游标向网关续拉。
  const [showAll, setShowAll] = useState(false)
  const timeline = showAll ? activities : collapseActivities(activities, false).visible
  const hiddenLocally = activities.length - timeline.length
  const canLoadMore = feed.state === 'ready' && feed.hasMore

  const expandTimeline = () => {
    if (hiddenLocally === 0 && canLoadMore) feed.loadMore()
    setShowAll(true)
  }

  /**
   * 把一个文案段渲染成文本或引用按钮。
   *
   * 引用只存 id：名字在这里实时解析，工作/文件改名后历史行自动跟随；
   * 目标已被删除时给一句 toast，不渲染失效引用（避免「幽灵条目」）。
   */
  const renderSegment = (segment: ActivitySegment, key: string) => {
    if (segment.workId) {
      const session = sessions.find((item) => item.id === segment.workId)
      return (
        <button
          key={key}
          type="button"
          className="wb-ov-activity-ref"
          aria-label={session ? `打开工作：${sessionDisplayTitle(session)}` : '打开工作'}
          onClick={() => (session ? onOpenSession(session.id) : onToast('工作不存在'))}
        >
          {session ? sessionDisplayTitle(session) : '工作'}
        </button>
      )
    }
    if (segment.fileId) {
      const entry = files.items.find((item) => item.catalog.id === segment.fileId)
      return (
        <button
          key={key}
          type="button"
          className="wb-ov-activity-ref"
          aria-label={entry ? `打开文件：${entry.file.name}` : '打开文件'}
          onClick={() => (entry ? onOpenFile(entry.file) : onToast('文件不存在'))}
        >
          {entry?.file.name ?? '文件'}
        </button>
      )
    }
    if (segment.planItemId) {
      // 计划项还没有独立详情路由：跳「计划」看板（任务卡可在那里打开）。
      return (
        <button
          key={key}
          type="button"
          className="wb-ov-activity-ref"
          aria-label="打开计划"
          onClick={() => onOpenPage('plan')}
        >
          计划项
        </button>
      )
    }
    return <span key={key}>{segment.text ?? ''}</span>
  }

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

      <InsightCard
        insight={insight.insight}
        sessions={sessions}
        refreshing={insight.refreshing}
        onRefresh={async () => {
          const ok = await insight.refresh()
          if (ok) onToast(INSIGHT_COPY.refreshToast)
        }}
        onOpenSession={onOpenSession}
      />

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

        {files.state === 'loading' && activities.length === 0 ? (
          <p className="wb-ov-insight-state"><Spinner size={13} /></p>
        ) : null}

        {files.state !== 'loading' && activities.length === 0 ? (
          <EmptyState
            className="wb-ov-empty"
            icon={<History size={18} />}
            title="还没有动态"
            description="空间里发生的工作与文件变化会记录在这里"
          />
        ) : null}

        {timeline.length > 0 ? (
          <ul className="wb-ov-timeline">
            {timeline.map((item) => (
              <li key={item.id}>
                <div className="wb-ov-activity">
                  <span className={cn('wb-ov-activity-icon', `is-${ACTIVITY_TONE[item.kind]}`)}>
                    <ActivityGlyph kind={item.kind} />
                  </span>
                  <span className="wb-ov-activity-label">
                    {item.segments.map((segment, index) => renderSegment(segment, `${item.id}-${index}`))}
                  </span>
                  {relativeTimeLabel(item.at) ? (
                    <time className="wb-ov-activity-time" dateTime={item.at} title={absoluteTimeTitle(item.at)}>
                      {relativeTimeLabel(item.at)}
                    </time>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        ) : null}

        {!showAll && (hiddenLocally > 0 || canLoadMore) ? (
          <button type="button" className="wb-ov-more" onClick={expandTimeline}>
            显示更早
          </button>
        ) : null}

        {showAll ? (
          <div className="wb-ov-more-row">
            {canLoadMore ? (
              <button
                type="button"
                className="wb-ov-more"
                disabled={feed.loadingMore}
                onClick={() => feed.loadMore()}
              >
                {feed.loadingMore ? '加载中…' : '显示更早'}
              </button>
            ) : null}
            <button type="button" className="wb-ov-more" onClick={() => setShowAll(false)}>
              收起
            </button>
          </div>
        ) : null}

        {files.state === 'unavailable' ? (
          <p className="wb-ov-note">文件库暂不可用</p>
        ) : null}
      </section>
    </div>
  )
}

function ActivityGlyph({ kind }: { kind: ActivityKind }) {
  const Glyph = ACTIVITY_GLYPHS[kind]
  return <Glyph size={13} aria-hidden="true" />
}

/** 相对时间旁边给出精确时间（hover 可见），避免「3 分钟前」一直不跳。 */
function absoluteTimeTitle(iso: string): string {
  const time = Date.parse(iso)
  if (!Number.isFinite(time)) return ''
  const date = new Date(time)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function stringArraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

/* ───────────────── 洞察卡 ───────────────── */

/** 首次进入空间播放一次打字机；测试可关闭。 */
const playedInsightWorkspaces = new Set<string>()
let insightTypewriterEnabled = true

/** 单测辅助：关闭/恢复洞察打字机（避免异步 interval 影响断言）。 */
export function __setInsightTypewriterEnabledForTests(enabled: boolean): void {
  insightTypewriterEnabled = enabled
  if (enabled) playedInsightWorkspaces.clear()
}

/** 单测辅助：清空「已播放」记录。 */
export function __resetInsightTypewriterForTests(): void {
  playedInsightWorkspaces.clear()
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

function shouldTypewrite(workspaceId: string, text: string): boolean {
  if (!insightTypewriterEnabled || !text) return false
  if (playedInsightWorkspaces.has(workspaceId)) return false
  return !prefersReducedMotion()
}

/** 打字机：2 字 / 24ms；播完写入「已播放」，同空间再次进入直接全文。 */
function useInsightTypewriter(workspaceId: string, text: string): { shown: string; done: boolean } {
  const [shown, setShown] = useState(() => (shouldTypewrite(workspaceId, text) ? '' : text))

  useEffect(() => {
    if (!shouldTypewrite(workspaceId, text)) {
      setShown(text)
      playedInsightWorkspaces.add(workspaceId)
      return
    }
    let index = 0
    setShown('')
    const timer = window.setInterval(() => {
      index = Math.min(index + 2, text.length)
      setShown(text.slice(0, index))
      if (index >= text.length) {
        window.clearInterval(timer)
        playedInsightWorkspaces.add(workspaceId)
      }
    }, 24)
    return () => window.clearInterval(timer)
  }, [workspaceId, text])

  return { shown, done: shown.length >= text.length }
}

function InsightBody({ workspaceId, text }: { workspaceId: string; text: string }) {
  const { shown, done } = useInsightTypewriter(workspaceId, text)
  return (
    <p className="wb-ov-insight-text">
      {/* 视觉隐藏全文：动画期间读屏可随时读完整内容；aria-live 在动画结束后再播报一次。 */}
      <span className="wb-sr-only">{text}</span>
      <span aria-hidden="true">{shown}</span>
      {done ? null : <span className="wb-ov-insight-caret" aria-hidden="true" />}
    </p>
  )
}

/** 概览 B 区「洞察」卡：按状态机渲染正文 / 空态 / 错误 / 来源 / 证据 / 落款。 */
function InsightCard({
  insight,
  sessions,
  refreshing,
  onRefresh,
  onOpenSession,
}: {
  insight: WorkspaceInsight
  sessions: readonly AgentSession[]
  refreshing: boolean
  onRefresh: () => Promise<void> | void
  onOpenSession: (sessionId: string) => void
}) {
  const [evidenceOpen, setEvidenceOpen] = useState(false)
  const evidenceRef = useRef<HTMLDivElement | null>(null)
  const sourceRef = useRef<HTMLButtonElement | null>(null)
  const origin = insight.origin
  const originSession = origin
    ? sessions.find((session) => session.id === origin.sessionId) ?? null
    : null

  // 证据浮层：Esc / 点外关闭。
  useEffect(() => {
    if (!evidenceOpen) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null
      if (target && (evidenceRef.current?.contains(target) || sourceRef.current?.contains(target))) return
      setEvidenceOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setEvidenceOpen(false)
    }
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [evidenceOpen])

  // 空间/来源变化后浮层失效。
  useEffect(() => {
    setEvidenceOpen(false)
  }, [insight.workspaceId, origin?.sessionId])

  if (insight.status === 'unavailable') return null

  // no-content 也可能有正文（聚合总结成立，只是没有消息级证据）：有 text 就渲染。
  const hasText = Boolean(insight.text)
    && (insight.status === 'ready' || insight.status === 'updating'
      || insight.status === 'refreshing' || insight.status === 'no-content')
  const updatedLabel = formatInsightUpdatedLabel(relativeTimeLabel(insight.updatedAt))
  const canRefresh = insight.status !== 'loading' && insight.status !== 'empty'

  return (
    <section className="wb-ov-card wb-ov-insight" aria-labelledby="wb-ov-insight-heading">
      <header className="wb-ov-card-head">
        <span className="wb-ov-insight-badge">
          <Sparkles size={13} aria-hidden="true" />
          <span id="wb-ov-insight-heading">{INSIGHT_COPY.title}</span>
        </span>
        {insight.status === 'updating' ? (
          <span className="wb-ov-insight-updating">{INSIGHT_COPY.updating}</span>
        ) : null}
        {canRefresh ? (
          <IconButton
            className="wb-ov-insight-refresh"
            label={INSIGHT_COPY.refreshLabel}
            size="sm"
            icon={refreshing ? <Spinner size={12} /> : <RefreshCw size={12} />}
            aria-disabled={refreshing}
            onClick={() => { if (!refreshing) void onRefresh() }}
          />
        ) : null}
      </header>

      {insight.status === 'loading' ? (
        <div className="wb-ov-insight-skeleton" role="status" aria-label={INSIGHT_COPY.loading}>
          <span /><span /><span />
        </div>
      ) : null}

      {hasText && insight.text ? (
        <InsightBody workspaceId={insight.workspaceId} text={insight.text} />
      ) : null}

      {insight.status === 'empty' ? (
        <div className="wb-ov-insight-empty">
          <p className="wb-ov-insight-empty-title">{INSIGHT_COPY.emptyTitle}</p>
          <p className="wb-ov-insight-empty-desc">{INSIGHT_COPY.emptyBody}</p>
        </div>
      ) : null}

      {insight.status === 'no-content' && !insight.text ? (
        <p className="wb-ov-insight-state">{INSIGHT_COPY.noContent}</p>
      ) : null}

      {insight.status === 'error' ? (
        <div className="wb-ov-insight-error">
          <span>{INSIGHT_COPY.error}</span>
          <Button variant="ghost" size="sm" onClick={() => { void onRefresh() }}>
            {INSIGHT_COPY.retry}
          </Button>
        </div>
      ) : null}

      {hasText ? (
        <div className="wb-ov-insight-source">
          <button
            ref={sourceRef}
            type="button"
            className="wb-ov-insight-source-btn"
            aria-haspopup="dialog"
            aria-expanded={evidenceOpen}
            onClick={() => setEvidenceOpen((open) => !open)}
          >
            {formatInsightSourceLine(insight.stats, updatedLabel)}
          </button>
          {evidenceOpen ? (
            <div
              ref={evidenceRef}
              className="wb-ov-insight-evidence"
              role="dialog"
              aria-label={INSIGHT_COPY.evidenceTitle}
            >
              <p className="wb-ov-insight-evidence-title">{INSIGHT_COPY.evidenceTitle}</p>
              <button
                type="button"
                className="wb-ov-insight-evidence-row"
                aria-label={`${INSIGHT_COPY.evidenceOpen}：${originSession ? sessionDisplayTitle(originSession) : '工作'}`}
                onClick={() => {
                  setEvidenceOpen(false)
                  if (origin) onOpenSession(origin.sessionId)
                }}
              >
                <FileText size={13} aria-hidden="true" />
                <span className="wb-ov-insight-evidence-name">
                  {originSession ? sessionDisplayTitle(originSession) : '工作'}
                </span>
                <span className="wb-ov-insight-evidence-time">
                  {relativeTimeLabel(originSession?.updatedAt ?? insight.updatedAt)}
                </span>
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      {hasText ? (
        <footer className="wb-ov-insight-footer">
          <span className="wb-ov-insight-speaker">{INSIGHT_COPY.footer}</span>
        </footer>
      ) : null}
    </section>
  )
}
