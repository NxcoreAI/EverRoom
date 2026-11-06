import { FileText, LayoutGrid, RotateCw } from 'lucide-react'
import { useCallback, useMemo } from 'react'

import type { AgentSession, AgentWorkspace } from '@nxcore/agent-contract'

import { type FileKind, blankFile } from '@/office-proto/data'
import { FileTypeIcon } from '@/office-proto/pages/parts'
import type { JournalActionDto } from '@/shared/sources'
import { useOptionalAccount } from '@/state/AccountContext'

import { useWorkbenchStore } from '../state/store'
import { relativeTimeLabel, sessionDisplayTitle } from '../types'
import { Badge, Button, PageHeader, Spinner } from '../ui/primitives'
import { DailyJournalCard } from './DailyJournalCard'
import { FileTableRow } from './fileTable'
import { HomeNote, HomeSection, requestNewSpace, workspaceSummary } from './parts'
import { useFileLibrary } from './useFileLibrary'

/** 按本机时间给问候语；不掺任何假数据。 */
function greetingFor(hour: number): string {
  if (hour < 5) return '夜深了'
  if (hour < 9) return '早上好'
  if (hour < 12) return '上午好'
  if (hour < 14) return '中午好'
  if (hour < 18) return '下午好'
  return '晚上好'
}

/** 「新建」右栏的四个文件瓦片（顺序照原型：文字文档 / 表格 / 演示 / Markdown）。 */
const NEW_FILE_KINDS: ReadonlyArray<{ kind: FileKind; label: string }> = [
  { kind: 'docx', label: '文字文档' },
  { kind: 'xlsx', label: '表格' },
  { kind: 'pptx', label: '演示' },
  { kind: 'md', label: 'Markdown' },
]

/** 「最近」分栏的条数：与原型一致（3 个项目空间 + 4 个文件）。 */
const RECENT_SPACE_LIMIT = 3
const RECENT_FILE_LIMIT = 4
/**
 * 文件库按「目录条目」取数、过滤掉图片等不可打开项后才剩文档，所以要多取一些：
 * 只取 4 条时，前 4 条若是图片，最近文件会莫名变空。
 */
const RECENT_FILE_FETCH = 40

/** 「最近」分栏里空间行的副行：「时间 · N 项工作」+（有描述/目标/目录时）一行摘要。 */
function spaceSubLine(workspace: AgentWorkspace, sessionCount: number): string {
  return [
    relativeTimeLabel(workspace.lastOpenedAt),
    `${sessionCount} 项工作`,
    workspaceSummary(workspace, ''),
  ].filter(Boolean).join(' · ')
}

/**
 * 最近页，布局照 everoffice 原型 `pages/RecentView.tsx`：
 *
 * 问候头 → 今日洞察卡 →「新建」分栏（左：空白项目空间瓦片；右：四类文件瓦片）
 * →「最近」分栏（左：最近 3 个项目空间；右：最近 4 个文件）→ 最近的工作。
 *
 * 与原型不同的只有数据源：问候语用真实账号名、副标题用真实计数、文件行来自文件库；
 * 原型的起草遮罩（mock 步骤）没有真实数据源，不迁移。
 * 原型的每日洞察卡已接真实日记（`window.nxcore.journal`，见 `DailyJournalCard`）。
 * 「最近的工作」是本端多出的一节：会话 = 一项工作，原型没有会话概念。
 */
export function RecentPage() {
  const workspaces = useWorkbenchStore((state) => state.workspaces)
  const sessions = useWorkbenchStore((state) => state.sessions)
  const openHome = useWorkbenchStore((state) => state.openHome)
  const openWorkspaceTab = useWorkbenchStore((state) => state.openWorkspaceTab)
  const openFileInWorkspace = useWorkbenchStore((state) => state.openFileInWorkspace)
  const files = useFileLibrary(RECENT_FILE_FETCH)

  const accountState = useOptionalAccount()
  const account = accountState?.account ?? null
  const userName = account?.authenticated ? account.user?.name?.trim() : null

  const sessionCountOf = useMemo(() => {
    const counts = new Map<string, number>()
    for (const session of sessions) {
      if (!session.workspaceId) continue
      counts.set(session.workspaceId, (counts.get(session.workspaceId) ?? 0) + 1)
    }
    return counts
  }, [sessions])

  const recentWorkspaces = useMemo(
    () => [...workspaces]
      .sort((left, right) => Date.parse(right.lastOpenedAt) - Date.parse(left.lastOpenedAt))
      .slice(0, RECENT_SPACE_LIMIT),
    [workspaces],
  )

  const workspaceNames = useMemo(
    () => new Map(workspaces.map((workspace) => [workspace.id, workspace.name])),
    [workspaces],
  )

  /** 最近工作：只看归属到现存空间的会话，避免点开不存在的标签。 */
  const recentSessions = useMemo(() => {
    const ids = new Set(workspaces.map((workspace) => workspace.id))
    return sessions
      .filter((session): session is AgentSession & { workspaceId: string } =>
        Boolean(session.workspaceId) && ids.has(session.workspaceId as string))
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
      .slice(0, 4)
  }, [sessions, workspaces])

  const greeting = greetingFor(new Date().getHours())

  /**
   * 今日洞察卡的动作落地（卡片只抛 action，不自己导航）：
   * - open-file：`file:<id>` 在文件库里查得到就在归属工作空间打开；查不到就静默
   *   忽略（本页没有 toast，宁可少做也不弹错误）；
   * - ask-agent：落到最近空间的「新工作草稿」——渲染层还没有「带 prompt 起会话」的入口
   *   （`createSession` 不收 prompt），但草稿视图已经是可输入的空会话，比停在空间概览更接近意图。
   */
  const handleJournalAction = useCallback((action: JournalActionDto) => {
    if (action.kind === 'open-file') {
      const fileId = action.targetId.startsWith('file:') ? action.targetId.slice('file:'.length) : ''
      const item = fileId ? files.items.find((candidate) => candidate.file.id === fileId) : undefined
      if (item) openFileInWorkspace(item.file)
      return
    }
    const workspaceId = recentWorkspaces[0]?.id
    if (workspaceId) openWorkspaceTab(workspaceId, { kind: 'draft' })
  }, [files.items, openFileInWorkspace, openWorkspaceTab, recentWorkspaces])

  // 副标题只放这一屏看不到的总量；文件库没读出来就不提数字，加载态由「最近」分栏自己说。
  const summary = [
    workspaces.length > 0 ? `${workspaces.length} 个项目空间` : null,
    files.state === 'ready' && files.total > 0 ? `${files.total} 个文件` : null,
  ].filter(Boolean).join(' · ')
  const subtitle = summary || '一个项目空间装一个项目的资料、工作与产物。'

  return (
    <div className="wb-home-scroll">
      <PageHeader
        title={userName ? `${greeting}，${userName}` : greeting}
        subtitle={subtitle}
      />

      <DailyJournalCard onAction={handleJournalAction} />

      <HomeSection title="新建">
        <div className="wb-home-split">
          <div className="wb-home-split-col">
            <div className="wb-home-split-label">
              <LayoutGrid size={13} aria-hidden="true" />
              项目空间
            </div>
            <div className="wb-home-new-row">
              <button
                type="button"
                className="wb-home-new-tile"
                title="新建空白项目空间"
                onClick={requestNewSpace}
              >
                <span className="wb-home-new-glyph" aria-hidden="true"><LayoutGrid size={24} /></span>
                <span className="wb-home-new-name">空白空间</span>
              </button>
            </div>
          </div>

          <div className="wb-home-split-col">
            <div className="wb-home-split-label">文件</div>
            <div className="wb-home-new-row">
              {NEW_FILE_KINDS.map(({ kind, label }) => (
                <button
                  key={kind}
                  type="button"
                  className="wb-home-new-tile"
                  title={`新建${label}（在默认项目空间打开）`}
                  onClick={() => openFileInWorkspace(blankFile(kind))}
                >
                  <FileTypeIcon kind={kind} size={46} />
                  <span className="wb-home-new-name">{label}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </HomeSection>

      <HomeSection title="最近">
        <div className="wb-home-split">
          <div className="wb-home-split-col">
            <div className="wb-home-split-label">
              <LayoutGrid size={13} aria-hidden="true" />
              项目空间
              <button type="button" className="wb-home-split-link" onClick={() => openHome('spaces')}>
                全部
              </button>
            </div>
            {recentWorkspaces.length === 0 ? (
              <HomeNote>还没有项目空间。新建一个，把资料、工作和产物放在一起。</HomeNote>
            ) : (
              <div className="wb-home-list">
                {recentWorkspaces.map((workspace) => (
                  <button
                    key={workspace.id}
                    type="button"
                    className="wb-home-space-row"
                    onClick={() => openWorkspaceTab(workspace.id)}
                  >
                    <span className="wb-home-space-icon" aria-hidden="true"><LayoutGrid size={17} /></span>
                    <span className="wb-home-space-main">
                      <strong className="wb-home-truncate">{workspace.name}</strong>
                      <span className="wb-home-truncate">
                        {spaceSubLine(workspace, sessionCountOf.get(workspace.id) ?? 0)}
                      </span>
                    </span>
                    <span className="wb-home-space-row-open">打开</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="wb-home-split-col">
            <div className="wb-home-split-label">
              文件
              <button type="button" className="wb-home-split-link" onClick={() => openHome('files')}>
                全部
              </button>
            </div>
            {files.state === 'loading' ? (
              <div className="wb-home-state"><Spinner /> 正在读取资料…</div>
            ) : null}
            {files.state === 'unavailable' ? (
              <HomeNote>
                资料暂不可用
                <Button variant="ghost" size="sm" icon={<RotateCw size={12} />} onClick={files.reload}>
                  重试
                </Button>
              </HomeNote>
            ) : null}
            {files.state === 'ready' && files.items.length === 0 ? (
              <HomeNote>
                <FileText size={14} aria-hidden="true" />
                资料还没有文件
                <Button variant="ghost" size="sm" onClick={() => openHome('files')}>去导入</Button>
              </HomeNote>
            ) : null}
            {files.state === 'ready' && files.items.length > 0 ? (
              <div className="wb-home-list">
                {files.items.slice(0, RECENT_FILE_LIMIT).map((item) => (
                  <FileTableRow
                    key={item.file.id}
                    item={item}
                    menu={false}
                    actions={{ onOpen: (target) => openFileInWorkspace(target.file) }}
                  />
                ))}
              </div>
            ) : null}
          </div>
        </div>
      </HomeSection>

      <HomeSection title="最近的工作">
        {recentSessions.length === 0 ? (
          <HomeNote>还没有工作。打开一个项目空间就能开始第一项工作。</HomeNote>
        ) : (
          <div className="wb-home-list">
            {recentSessions.map((session) => (
              <button
                key={session.id}
                type="button"
                className="wb-home-row"
                onClick={() => openWorkspaceTab(session.workspaceId, { kind: 'session', sessionId: session.id })}
              >
                <span className="wb-home-row-main">
                  <span className="wb-home-row-title">
                    <span className={`wb-home-dot is-${session.status}`} aria-hidden="true" />
                    <span className="wb-home-truncate">{sessionDisplayTitle(session)}</span>
                  </span>
                  <span className="wb-home-row-sub">
                    {workspaceNames.get(session.workspaceId) ?? '工作空间'}
                    {' · '}
                    {relativeTimeLabel(session.updatedAt)}
                  </span>
                </span>
                {session.status === 'running' ? <Badge tone="running" dot>进行中</Badge> : null}
              </button>
            ))}
          </div>
        )}
      </HomeSection>
    </div>
  )
}
