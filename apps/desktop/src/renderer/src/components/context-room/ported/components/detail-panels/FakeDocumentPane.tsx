import { ChevronLeft, ChevronRight, FileSpreadsheet, FileText, Folder, FolderOpen, Search } from 'lucide-react'
import { useMemo, useState } from 'react'

import { createContextRoomResourceLibrary } from '../../resources'
import type { ContextRoomRecord, ContextRoomResource } from '../../types'
import { TiptapDocumentEditor } from '../detail-editor/TiptapDocumentEditor'

export function FakeDocumentPane({
  room,
  selectedId,
  onSelect,
  onBackToLibrary,
}: {
  room: ContextRoomRecord
  selectedId: string | null
  onSelect: (resource: ContextRoomResource) => void
  onBackToLibrary: () => void
}) {
  const library = useMemo(() => createContextRoomResourceLibrary(room), [room])
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState(() => new Set(library.folders.map((folder) => folder.id)))
  const normalized = query.trim().toLowerCase()
  const selected = library.resources.find((resource) => resource.id === selectedId) ?? library.resources[0]

  return (
    <>
      <aside className="context-room-workspace-middle">
        <div className="context-room-resource-tree">
          <label>
            <Search aria-hidden="true" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索 Room 内文档..."
              aria-label="搜索 Room 内文档"
            />
          </label>
          <div className="context-room-resource-scroll" role="tree" aria-label="Room 资源">
            {library.folders.map((folder) => {
              const resources = library.resources.filter((resource) =>
                resource.folderId === folder.id && (!normalized || resource.name.toLowerCase().includes(normalized)),
              )
              if (normalized && !resources.length) return null
              const open = expanded.has(folder.id)
              return (
                <section key={folder.id}>
                  <button
                    type="button"
                    className="context-room-resource-folder"
                    aria-expanded={open}
                    onClick={() => setExpanded((current) => {
                      const next = new Set(current)
                      if (next.has(folder.id)) next.delete(folder.id)
                      else next.add(folder.id)
                      return next
                    })}
                  >
                    <ChevronRight aria-hidden="true" className={open ? 'is-open' : ''} />
                    {open ? <FolderOpen aria-hidden="true" /> : <Folder aria-hidden="true" />}
                    <span>{folder.name}</span>
                    <small>{resources.length}</small>
                  </button>
                  {open ? resources.map((resource) => (
                    <button
                      type="button"
                      role="treeitem"
                      aria-selected={selected?.id === resource.id}
                      key={resource.id}
                      className={`context-room-resource-item${selected?.id === resource.id ? ' is-selected' : ''}`}
                      onClick={() => onSelect(resource)}
                    >
                      {resource.kind === 'office-file' && resource.format === 'xlsx'
                        ? <FileSpreadsheet aria-hidden="true" />
                        : <FileText aria-hidden="true" />}
                      <span><b>{resource.name}</b><small>{resource.updatedAt}</small></span>
                    </button>
                  )) : null}
                </section>
              )}
            )}
          </div>
        </div>
      </aside>
      <div className="context-room-middle-divider" aria-hidden="true" />
      <section className="context-room-workspace-content">
        <button type="button" className="context-room-mobile-back" onClick={onBackToLibrary}>
          <ChevronLeft aria-hidden="true" />返回文档
        </button>
        <FakeDocumentContent room={room} resource={selected} />
      </section>
    </>
  )
}

export function FakeDocumentContent({
  room,
  resource,
}: {
  room: ContextRoomRecord
  resource?: ContextRoomResource | null
}) {
  const documentId = resource?.kind === 'cloud-doc' ? resource.binding.docId : room.cloudDoc.docId
  return <TiptapDocumentEditor key={documentId} room={room} resource={resource} />
}
