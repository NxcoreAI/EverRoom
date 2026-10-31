import type { AgentWorkspace } from '@nxcore/agent-contract'
import { LayoutGrid, Pencil, Plus, Trash2 } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'

import { useWorkbenchStore } from '../state/store'
import { relativeTimeLabel } from '../types'
import { Badge, Button, EmptyState, IconButton, PageHeader, TextInput } from '../ui/primitives'
import { ConfirmModal } from '../ui/modal'
import { workbenchToast } from '../shell/toast'
import { requestNewSpace } from './parts'
import { cn } from '../ui/cn'

function firstLine(value: string | null | undefined): string {
  const text = value?.trim()
  if (!text) return ''
  return text.split(/\r?\n/, 1)[0] ?? ''
}

/** 一行摘要：描述优先，其次目标，最后本地目录。 */
function summaryOf(workspace: AgentWorkspace): string {
  return firstLine(workspace.description)
    || ((workspace.goals ?? []).length > 0 ? `目标：${(workspace.goals ?? []).join(' · ')}` : '')
    || workspace.path
    || '应用托管空间'
}

/** 项目空间页：真实 workspace 网格 + 搜索 + 新建 / 行内重命名 / 删除确认。 */
export function SpacesPage() {
  const workspaces = useWorkbenchStore((state) => state.workspaces)
  const sessions = useWorkbenchStore((state) => state.sessions)
  const openWorkspaceTab = useWorkbenchStore((state) => state.openWorkspaceTab)
  const renameWorkspace = useWorkbenchStore((state) => state.renameWorkspace)
  const deleteWorkspace = useWorkbenchStore((state) => state.deleteWorkspace)

  const [query, setQuery] = useState('')
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [pendingDelete, setPendingDelete] = useState<AgentWorkspace | null>(null)
  const renameCommittedRef = useRef(false)

  const sessionCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const session of sessions) {
      if (!session.workspaceId) continue
      counts.set(session.workspaceId, (counts.get(session.workspaceId) ?? 0) + 1)
    }
    return counts
  }, [sessions])

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    if (!keyword) return workspaces
    return workspaces.filter((workspace) =>
      [workspace.name, workspace.description ?? '', ...(workspace.goals ?? []), workspace.path ?? '']
        .some((field) => field.toLowerCase().includes(keyword)))
  }, [query, workspaces])

  const startRename = (workspace: AgentWorkspace) => {
    renameCommittedRef.current = false
    setRenamingId(workspace.id)
    setRenameDraft(workspace.name)
  }

  const commitRename = async (workspace: AgentWorkspace) => {
    if (renameCommittedRef.current) return
    renameCommittedRef.current = true
    setRenamingId(null)
    const name = renameDraft.trim()
    if (!name || name === workspace.name) return
    const ok = await renameWorkspace(workspace.id, name)
    workbenchToast(ok ? '已重命名项目空间' : '重命名失败')
  }

  const totalSessions = sessions.filter((session) => session.workspaceId).length

  return (
    <div className="wb-home-scroll">
      <PageHeader
        eyebrow="工作区"
        title="项目空间"
        subtitle={`${workspaces.length} 个项目空间 · ${totalSessions} 项工作；点开进入独立标签页。`}
        actions={(
          <Button variant="primary" icon={<Plus size={15} />} onClick={requestNewSpace}>
            新建项目空间
          </Button>
        )}
      />

      {workspaces.length > 0 ? (
        <div className="wb-home-toolbar">
          <label className="wb-home-search">
            <TextInput
              type="search"
              aria-label="搜索项目空间"
              placeholder="搜索空间名称、描述或目标"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <span className="wb-home-toolbar-meta">
            {query.trim() ? `匹配 ${filtered.length} / ${workspaces.length}` : `${workspaces.length} 个空间`}
          </span>
        </div>
      ) : null}

      {workspaces.length === 0 ? (
        <EmptyState
          icon={<LayoutGrid size={18} />}
          title="还没有项目空间"
          description="一个项目空间装一个项目的资料、工作与产物；创建后进入三步引导。"
          action={<Button variant="primary" size="sm" icon={<Plus size={13} />} onClick={requestNewSpace}>新建项目空间</Button>}
        />
      ) : filtered.length === 0 ? (
        <div className="wb-home-empty">没有匹配的空间 · 试试别的关键词。</div>
      ) : (
        <div className="wb-home-space-grid">
          {filtered.map((workspace) => {
            const renaming = renamingId === workspace.id
            const count = sessionCounts.get(workspace.id) ?? 0
            return (
              <article key={workspace.id} className={cn('wb-home-space-tile', renaming && 'is-renaming')}>
                <div className="wb-home-space-tile-head">
                  {renaming ? (
                    <div className="wb-home-space-open is-static">
                      <span className="wb-home-space-icon" aria-hidden="true"><LayoutGrid size={17} /></span>
                      <span className="wb-home-space-main">
                        <TextInput
                          className="wb-home-rename-input"
                          aria-label="空间名称"
                          autoFocus
                          value={renameDraft}
                          maxLength={120}
                          onChange={(event) => setRenameDraft(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              event.preventDefault()
                              void commitRename(workspace)
                            } else if (event.key === 'Escape') {
                              event.preventDefault()
                              renameCommittedRef.current = true
                              setRenamingId(null)
                            }
                          }}
                          onBlur={() => { void commitRename(workspace) }}
                        />
                        <span>{workspace.path ?? '应用托管空间'}</span>
                      </span>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="wb-home-space-open"
                      onClick={() => openWorkspaceTab(workspace.id)}
                      title={`打开「${workspace.name}」`}
                    >
                      <span className="wb-home-space-icon" aria-hidden="true"><LayoutGrid size={17} /></span>
                      <span className="wb-home-space-main">
                        <span className="wb-home-space-name">
                          <span className="wb-home-truncate">{workspace.name}</span>
                          {workspace.kind === 'default' ? <Badge tone="neutral">默认</Badge> : null}
                        </span>
                        <span>{summaryOf(workspace)}</span>
                      </span>
                    </button>
                  )}
                </div>
                <div className="wb-home-space-tile-foot">
                  <span className="wb-home-space-tile-meta">
                    {count} 项工作
                    {' · '}
                    {relativeTimeLabel(workspace.lastOpenedAt) || '未打开'}
                  </span>
                  <span className="wb-home-space-tile-actions">
                    <IconButton
                      label={`重命名 ${workspace.name}`}
                      size="sm"
                      icon={<Pencil size={13} />}
                      onClick={() => startRename(workspace)}
                    />
                    {workspace.kind !== 'default' ? (
                      <IconButton
                        label={`删除 ${workspace.name}`}
                        size="sm"
                        tone="danger"
                        icon={<Trash2 size={13} />}
                        onClick={() => setPendingDelete(workspace)}
                      />
                    ) : null}
                  </span>
                </div>
              </article>
            )
          })}
          <button type="button" className="wb-home-space-tile is-new" onClick={requestNewSpace}>
            <span className="wb-home-space-tile-head">
              <span className="wb-home-space-icon" aria-hidden="true"><Plus size={17} /></span>
              <span className="wb-home-space-main">
                <strong>新建项目空间</strong>
                <span>装一个项目的资料、工作与产物</span>
              </span>
            </span>
          </button>
        </div>
      )}

      <ConfirmModal
        open={pendingDelete !== null}
        onOpenChange={(open) => { if (!open) setPendingDelete(null) }}
        title={`删除项目空间「${pendingDelete?.name ?? ''}」？`}
        description="空间下的工作会移回默认空间；删除后资料与产物不会再按这个空间归类。"
        confirmLabel="删除空间"
        onConfirm={() => {
          const target = pendingDelete
          setPendingDelete(null)
          if (!target) return
          void deleteWorkspace(target.id).then((ok) => {
            workbenchToast(ok ? '已删除项目空间' : '删除失败')
          })
        }}
      />
    </div>
  )
}
