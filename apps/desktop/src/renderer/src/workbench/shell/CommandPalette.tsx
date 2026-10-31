import * as Dialog from '@radix-ui/react-dialog'
import { Command } from 'cmdk'
import {
  Clock,
  FileText,
  FolderOpen,
  LayoutGrid,
  Search,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { fetchRealFiles, type RealOfficeFile } from '@/office-proto/data'
import { FileTypeIcon } from '@/office-proto/pages/parts'

import { useWorkbenchStore } from '../state/store'
import { HOME_PAGES, relativeTimeLabel, sessionDisplayTitle } from '../types'
import { Spinner } from '../ui/primitives'
import './palette.css'

/**
 * ⌘K 命令面板：搜索并跳转工作空间 / 工作会话 / 文件库文件 / 主页入口。
 * 数据全部来自已加载的 store 与真实文件库（打开时拉一次最近 40 个文件）。
 */
export function CommandPalette() {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [files, setFiles] = useState<RealOfficeFile[] | null>(null)

  const workspaces = useWorkbenchStore((state) => state.workspaces)
  const sessions = useWorkbenchStore((state) => state.sessions)
  const openHome = useWorkbenchStore((state) => state.openHome)
  const openWorkspaceTab = useWorkbenchStore((state) => state.openWorkspaceTab)
  const openFileTab = useWorkbenchStore((state) => state.openFileTab)

  useEffect(() => {
    const show = () => setOpen(true)
    window.addEventListener('everroom:workbench-search', show)
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setOpen((current) => !current)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('everroom:workbench-search', show)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    setQuery('')
    if (files) return
    void fetchRealFiles(40).then((result) => {
      setFiles(result?.items ?? [])
    })
  }, [files, open])

  const orderedWorkspaces = useMemo(
    () => [...workspaces].sort((left, right) => Date.parse(right.lastOpenedAt) - Date.parse(left.lastOpenedAt)),
    [workspaces],
  )
  const recentSessions = useMemo(
    () => [...sessions].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt)),
    [sessions],
  )

  const close = () => setOpen(false)

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="wb-palette-overlay" />
        <Dialog.Content className="wb-palette" aria-label="命令面板">
          <Dialog.Title className="wb-palette-title">搜索与跳转</Dialog.Title>
          <Command label="命令面板" shouldFilter>
            <div className="wb-palette-input">
              <Search size={15} aria-hidden="true" />
              <Command.Input
                autoFocus
                value={query}
                onValueChange={setQuery}
                placeholder="搜索工作空间、工作或文件…"
              />
              <kbd>esc</kbd>
            </div>
            <Command.List className="wb-palette-list">
              <Command.Empty className="wb-palette-empty">没有匹配项</Command.Empty>

              <Command.Group heading="主页">
                {HOME_PAGES.map((page) => (
                  <Command.Item
                    key={page.key}
                    value={`主页 ${page.label}`}
                    onSelect={() => { openHome(page.key); close() }}
                  >
                    <span className="wb-palette-icon" aria-hidden="true"><Clock size={15} /></span>
                    <span className="wb-palette-label">主页 · {page.label}</span>
                  </Command.Item>
                ))}
              </Command.Group>

              <Command.Group heading="项目空间">
                {orderedWorkspaces.map((workspace) => (
                  <Command.Item
                    key={workspace.id}
                    value={`空间 ${workspace.name} ${workspace.path ?? ''}`}
                    onSelect={() => { openWorkspaceTab(workspace.id); close() }}
                  >
                    <span className="wb-palette-icon" aria-hidden="true"><LayoutGrid size={15} /></span>
                    <span className="wb-palette-label">{workspace.name}</span>
                    <span className="wb-palette-meta">{workspace.path ?? '应用托管空间'}</span>
                  </Command.Item>
                ))}
              </Command.Group>

              <Command.Group heading="工作">
                {recentSessions.slice(0, 12).map((session) => {
                  const workspace = workspaces.find((item) => item.id === session.workspaceId)
                  return (
                    <Command.Item
                      key={session.id}
                      value={`工作 ${sessionDisplayTitle(session)} ${workspace?.name ?? ''}`}
                      onSelect={() => {
                        if (session.workspaceId) openWorkspaceTab(session.workspaceId, { kind: 'session', sessionId: session.id })
                        close()
                      }}
                    >
                      <span className="wb-palette-icon" aria-hidden="true"><FolderOpen size={15} /></span>
                      <span className="wb-palette-label">{sessionDisplayTitle(session)}</span>
                      <span className="wb-palette-meta">
                        {workspace?.name ?? '工作空间'} · {relativeTimeLabel(session.updatedAt)}
                      </span>
                    </Command.Item>
                  )
                })}
              </Command.Group>

              <Command.Group heading="文件">
                {files === null ? (
                  <div className="wb-palette-loading"><Spinner size={13} /> 正在读取文件库…</div>
                ) : files.length === 0 ? (
                  <div className="wb-palette-loading">文件库暂无文件</div>
                ) : files.map((item) => (
                  <Command.Item
                    key={item.file.id}
                    value={`文件 ${item.file.name} ${item.catalog.sourceLabel}`}
                    onSelect={() => { openFileTab(item.file); close() }}
                  >
                    <span className="wb-palette-icon" aria-hidden="true">
                      <FileTypeIcon kind={item.file.kind} size={17} />
                    </span>
                    <span className="wb-palette-label">{item.file.name}</span>
                    <span className="wb-palette-meta">{item.catalog.sourceLabel}</span>
                  </Command.Item>
                ))}
              </Command.Group>

              {files === null ? null : (
                <Command.Item
                  value="文件库 所有文件"
                  onSelect={() => { openHome('files'); close() }}
                >
                  <span className="wb-palette-icon" aria-hidden="true"><FileText size={15} /></span>
                  <span className="wb-palette-label">在「所有文件」中继续浏览</span>
                </Command.Item>
              )}
            </Command.List>
          </Command>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
