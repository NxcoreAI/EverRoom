import {
  CalendarDays,
  ChevronRight,
  FolderOpen,
  LayoutDashboard,
  Loader2,
  MoreHorizontal,
  Package,
  Pencil,
  PlusCircle,
  Trash2,
} from 'lucide-react'
import React, { useEffect, useRef, useState } from 'react'

import type { AgentSession } from '@nxcore/agent-contract'

import type { WorkspaceTab } from '../types'
import {
  WORK_SESSION_STATUS_META,
  WORKSPACE_PAGES,
  relativeTimeLabel,
  sessionDisplayTitle,
  workSessionStatus,
} from '../types'
import { useWorkbenchStore, useWorkspace, useWorkspaceSessions } from '../state/store'
import { Hint, IconButton } from '../ui/primitives'
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '../ui/menu'
import { ConfirmModal } from '../ui/modal'
import { cn } from '../ui/cn'

const PAGE_ICONS: Record<string, React.ReactNode> = {
  overview: <LayoutDashboard size={16} strokeWidth={1.8} />,
  library: <FolderOpen size={16} strokeWidth={1.8} />,
  outputs: <Package size={16} strokeWidth={1.8} />,
  plan: <CalendarDays size={16} strokeWidth={1.8} />,
}

type DeleteTarget = { kind: 'workspace'; id: string; title: string } | { kind: 'session'; id: string; title: string }

/** 工作空间标签的侧栏：空间标题 + 功能菜单 + 工作列表（= 该空间的会话）。 */
export function WorkspaceSidebar({ tab }: { tab: WorkspaceTab }) {
  const workspace = useWorkspace(tab.workspaceId)
  const sessions = useWorkspaceSessions(tab.workspaceId)
  const setWorkspaceView = useWorkbenchStore((state) => state.setWorkspaceView)
  const renameWorkspace = useWorkbenchStore((state) => state.renameWorkspace)
  const deleteWorkspace = useWorkbenchStore((state) => state.deleteWorkspace)
  const renameSession = useWorkbenchStore((state) => state.renameSession)
  const deleteSession = useWorkbenchStore((state) => state.deleteSession)

  const [renamingWorkspace, setRenamingWorkspace] = useState(false)
  const [workspaceDraft, setWorkspaceDraft] = useState('')
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setRenamingWorkspace(false)
    setRenamingSessionId(null)
  }, [tab.workspaceId])

  if (!workspace) return null

  const activePage = tab.view.kind === 'page' ? tab.view.page : null
  const activeSessionId = tab.view.kind === 'session' ? tab.view.sessionId : null

  const beginRenameWorkspace = () => {
    setWorkspaceDraft(workspace.name)
    setRenamingWorkspace(true)
  }
  const commitRenameWorkspace = () => {
    const name = workspaceDraft.trim()
    if (name && name !== workspace.name) void renameWorkspace(workspace.id, name)
    setRenamingWorkspace(false)
  }

  const confirmDelete = async () => {
    if (!deleteTarget) return
    setBusy(true)
    if (deleteTarget.kind === 'workspace') await deleteWorkspace(deleteTarget.id)
    else await deleteSession(deleteTarget.id)
    setBusy(false)
    setDeleteTarget(null)
  }

  const startDraft = () => {
    const existingDraft = tab.view.kind === 'draft'
    if (!existingDraft) setWorkspaceView(tab.id, { kind: 'draft' })
  }

  return (
    <aside className="wb-sidebar wb-ws-sidebar" aria-label="工作空间导航">
      <div className="wb-sidebar-titlebar" aria-hidden="true" />

      <div className="wb-ws-head">
        {renamingWorkspace ? (
          <input
            className="ui-input wb-ws-name-input"
            autoFocus
            value={workspaceDraft}
            aria-label="工作空间名称"
            onChange={(event) => setWorkspaceDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commitRenameWorkspace()
              if (event.key === 'Escape') setRenamingWorkspace(false)
            }}
            onBlur={commitRenameWorkspace}
          />
        ) : (
          <Hint label={workspace.path ?? '没有绑定本地目录'} side="bottom">
            <h2 className="wb-ws-name" title={workspace.name}>{workspace.name}</h2>
          </Hint>
        )}
        <Menu>
          <MenuTrigger asChild>
            <IconButton label="工作空间操作" size="sm" icon={<MoreHorizontal size={15} />} />
          </MenuTrigger>
          <MenuContent align="end">
            <MenuItem icon={<Pencil size={14} />} onSelect={beginRenameWorkspace}>重命名空间</MenuItem>
            <MenuSeparator />
            <MenuItem
              icon={<Trash2 size={14} />}
              danger
              disabled={workspace.kind === 'default'}
              onSelect={() => setDeleteTarget({ kind: 'workspace', id: workspace.id, title: workspace.name })}
            >
              删除空间
            </MenuItem>
          </MenuContent>
        </Menu>
      </div>

      <nav className="wb-sidebar-nav" aria-label="工作空间功能">
        <button
          type="button"
          className={cn('wb-nav-item', tab.view.kind === 'draft' && 'is-active')}
          onClick={startDraft}
        >
          <span className="wb-nav-icon" aria-hidden="true"><PlusCircle size={16} strokeWidth={1.8} /></span>
          <span className="wb-nav-label">新建工作</span>
        </button>
        {WORKSPACE_PAGES.map((page) => (
          <button
            key={page.key}
            type="button"
            className={cn('wb-nav-item', activePage === page.key && 'is-active')}
            aria-current={activePage === page.key ? 'page' : undefined}
            onClick={() => setWorkspaceView(tab.id, { kind: 'page', page: page.key })}
          >
            <span className="wb-nav-icon" aria-hidden="true">{PAGE_ICONS[page.key]}</span>
            <span className="wb-nav-label">{page.label}</span>
          </button>
        ))}
      </nav>

      <div className="wb-ws-work">
        <div className="wb-ws-work-head">
          <span>工作</span>
          <span className="wb-ws-work-count">{sessions.length}</span>
        </div>
        <div className="wb-ws-work-list" role="list">
          {tab.view.kind === 'draft' ? (
            <div className="wb-ws-work-row is-active is-draft">
              <span className="wb-ws-work-dot" aria-hidden="true" />
              <span className="wb-ws-work-title">新工作</span>
              <span className="wb-ws-work-time">草稿</span>
            </div>
          ) : null}
          {sessions.length === 0 && tab.view.kind !== 'draft' ? (
            <div className="wb-ws-work-empty">还没有工作</div>
          ) : null}
          {sessions.map((session) => (
            <WorkRow
              key={session.id}
              session={session}
              active={session.id === activeSessionId}
              renaming={renamingSessionId === session.id}
              onOpen={() => setWorkspaceView(tab.id, { kind: 'session', sessionId: session.id })}
              onStartRename={() => setRenamingSessionId(session.id)}
              onFinishRename={() => setRenamingSessionId(null)}
              onRename={(title) => { void renameSession(session.id, title) }}
              onDelete={() => setDeleteTarget({ kind: 'session', id: session.id, title: sessionDisplayTitle(session) })}
            />
          ))}
        </div>
      </div>

      <ConfirmModal
        open={deleteTarget?.kind === 'workspace'}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}
        title="删除这个工作空间？"
        description={deleteTarget ? `「${deleteTarget.title}」及其工作会一并移除。` : undefined}
        confirmLabel="删除空间"
        busy={busy}
        onConfirm={() => { void confirmDelete() }}
      />
      <ConfirmModal
        open={deleteTarget?.kind === 'session'}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}
        title="删除这个工作？"
        description={deleteTarget ? `「${deleteTarget.title}」的对话记录不可恢复。` : undefined}
        confirmLabel="删除工作"
        busy={busy}
        onConfirm={() => { void confirmDelete() }}
      />
    </aside>
  )
}

function WorkRow({ session, active, renaming, onOpen, onStartRename, onRename, onFinishRename, onDelete }: {
  session: AgentSession
  active: boolean
  renaming: boolean
  onOpen: () => void
  onStartRename: () => void
  onRename: (title: string) => void
  onFinishRename: () => void
  onDelete: () => void
}) {
  const [draft, setDraft] = useState(sessionDisplayTitle(session))
  const status = workSessionStatus(session)
  const rowRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!renaming) setDraft(sessionDisplayTitle(session))
  }, [renaming, session])

  const commit = () => {
    const title = draft.trim()
    if (title && title !== sessionDisplayTitle(session)) onRename(title)
    onFinishRename()
  }

  if (renaming) {
    return (
      <div ref={rowRef} className="wb-ws-work-row is-renaming">
        <input
          className="ui-input wb-ws-work-rename"
          autoFocus
          value={draft}
          aria-label="工作名称"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commit()
            if (event.key === 'Escape') { setDraft(sessionDisplayTitle(session)); onFinishRename() }
          }}
          onBlur={commit}
        />
      </div>
    )
  }

  return (
    <div
      ref={rowRef}
      role="listitem"
      className={cn('wb-ws-work-row', active && 'is-active')}
    >
      <button type="button" className="wb-ws-work-main" title={sessionDisplayTitle(session)} onClick={onOpen}>
        <span className={cn('wb-ws-work-dot', `is-${status}`)} aria-hidden="true">
          {status === 'running' ? <Loader2 size={10} className="ui-spin" /> : null}
        </span>
        <span className="wb-ws-work-title">{sessionDisplayTitle(session)}</span>
        <span className="wb-ws-work-time">{relativeTimeLabel(session.updatedAt)}</span>
      </button>
      <span className="wb-ws-work-status" title={WORK_SESSION_STATUS_META[status].label}>
        <ChevronRight size={12} aria-hidden="true" />
      </span>
      <Menu>
        <MenuTrigger asChild>
          <button type="button" className="wb-ws-work-more" aria-label="工作操作" title="更多">
            <MoreHorizontal size={14} />
          </button>
        </MenuTrigger>
        <MenuContent align="end">
          <MenuItem icon={<Pencil size={14} />} onSelect={onStartRename}>重命名</MenuItem>
          <MenuSeparator />
          <MenuItem icon={<Trash2 size={14} />} danger disabled={session.status === 'running'} onSelect={onDelete}>
            删除
          </MenuItem>
        </MenuContent>
      </Menu>
    </div>
  )
}
