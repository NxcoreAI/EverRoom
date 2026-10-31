import { FileText, LayoutGrid, Plus, RotateCw } from 'lucide-react'
import { useMemo } from 'react'

import type { AgentSession, AgentWorkspace } from '@nxcore/agent-contract'

import { FileTypeIcon } from '@/office-proto/pages/parts'
import { useOptionalAccount } from '@/state/AccountContext'

import { useWorkbenchStore } from '../state/store'
import { relativeTimeLabel, sessionDisplayTitle } from '../types'
import { Badge, Button, EmptyState, PageHeader, Spinner } from '../ui/primitives'
import { HomeNote, HomeSection, requestNewSpace } from './parts'
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

function firstLine(value: string | null | undefined): string {
  const text = value?.trim()
  if (!text) return ''
  return text.split(/\r?\n/, 1)[0] ?? ''
}

function workspaceSummary(workspace: AgentWorkspace): string {
  return firstLine(workspace.description)
    || ((workspace.goals ?? []).length > 0 ? `目标：${(workspace.goals ?? []).join(' · ')}` : '')
    || workspace.path
    || '应用托管空间'
}

/** 最近页：真实 workspace / session / 文件库的最近一屏（无洞察、无问候打字机、无知识库）。 */
export function RecentPage() {
  const workspaces = useWorkbenchStore((state) => state.workspaces)
  const sessions = useWorkbenchStore((state) => state.sessions)
  const openHome = useWorkbenchStore((state) => state.openHome)
  const openWorkspaceTab = useWorkbenchStore((state) => state.openWorkspaceTab)
  const openFileTab = useWorkbenchStore((state) => state.openFileTab)
  const files = useFileLibrary(8)

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
      .slice(0, 3),
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
  const fileSummary = files.state === 'ready'
    ? `文件库 ${files.total} 个文件`
    : files.state === 'loading'
      ? '正在读取文件库…'
      : '文件库暂不可用'
  const subtitle = files.state === 'loading'
    ? `${workspaces.length} 个项目空间 · ${fileSummary}`
    : `${fileSummary} · ${workspaces.length} 个项目空间`

  return (
    <div className="wb-home-scroll">
      <PageHeader
        eyebrow="主页"
        title={userName ? `${greeting}，${userName}` : greeting}
        subtitle={subtitle}
        actions={(
          <>
            <Button variant="secondary" icon={<FileText size={15} />} onClick={() => openHome('files')}>
              所有文件
            </Button>
            <Button variant="primary" icon={<Plus size={15} />} onClick={requestNewSpace}>
              新建项目空间
            </Button>
          </>
        )}
      />

      <HomeSection
        title="最近的空间"
        actionLabel="全部空间"
        onAction={() => openHome('spaces')}
      >
        {recentWorkspaces.length === 0 ? (
          <HomeNote>还没有项目空间 · 新建一个来组织资料与工作。</HomeNote>
        ) : (
          <div className="wb-home-card-grid">
            {recentWorkspaces.map((workspace) => (
              <button
                key={workspace.id}
                type="button"
                className="wb-home-space-card"
                onClick={() => openWorkspaceTab(workspace.id)}
              >
                <span className="wb-home-space-icon" aria-hidden="true"><LayoutGrid size={17} /></span>
                <span className="wb-home-space-main">
                  <strong>{workspace.name}</strong>
                  <span title={workspaceSummary(workspace)}>{workspaceSummary(workspace)}</span>
                </span>
                <span className="wb-home-space-side">
                  <span className="wb-home-space-meta">
                    {sessionCountOf.get(workspace.id) ?? 0} 项工作
                  </span>
                  <span className="wb-home-space-meta">{relativeTimeLabel(workspace.lastOpenedAt)}</span>
                </span>
              </button>
            ))}
            <button type="button" className="wb-home-space-card is-new" onClick={requestNewSpace}>
              <span className="wb-home-space-icon" aria-hidden="true"><Plus size={17} /></span>
              <span className="wb-home-space-main">
                <strong>新建项目空间</strong>
                <span>装一个项目的资料、工作与产物</span>
              </span>
            </button>
          </div>
        )}
      </HomeSection>

      <HomeSection
        title="最近的工作"
        actionLabel="全部空间"
        onAction={() => openHome('spaces')}
      >
        {recentSessions.length === 0 ? (
          <HomeNote>还没有工作 · 打开一个项目空间开始第一次任务。</HomeNote>
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

      <HomeSection
        title="最近的文件"
        actionLabel="所有文件"
        onAction={() => openHome('files')}
      >
        {files.state === 'loading' ? (
          <div className="wb-home-state"><Spinner /> 正在读取文件库…</div>
        ) : null}
        {files.state === 'unavailable' ? (
          <div className="wb-home-state">
            文件库暂不可用
            <Button variant="ghost" size="sm" icon={<RotateCw size={12} />} onClick={files.reload}>重试</Button>
          </div>
        ) : null}
        {files.state === 'ready' && files.items.length === 0 ? (
          <EmptyState
            icon={<FileText size={18} />}
            title="文件库还没有文件"
            description="在「所有文件」页导入后，最近文件会出现在这里。"
            action={<Button variant="secondary" size="sm" onClick={() => openHome('files')}>去导入文件</Button>}
          />
        ) : null}
        {files.state === 'ready' && files.items.length > 0 ? (
          <div className="wb-home-list">
            {files.items.map((item) => (
              <button
                key={item.file.id}
                type="button"
                className="wb-home-row"
                title={item.file.name}
                onClick={() => openFileTab(item.file)}
              >
                <FileTypeIcon kind={item.file.kind} size={28} />
                <span className="wb-home-row-main">
                  <span className="wb-home-row-title">
                    <span className="wb-home-truncate">{item.file.name}</span>
                  </span>
                  <span className="wb-home-row-sub">
                    {[item.catalog.sourceLabel, item.file.updatedLabel, item.file.sizeLabel]
                      .filter((part) => part && part !== '—')
                      .join(' · ')}
                  </span>
                </span>
              </button>
            ))}
          </div>
        ) : null}
      </HomeSection>
    </div>
  )
}
