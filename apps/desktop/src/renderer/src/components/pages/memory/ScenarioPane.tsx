import { ChevronDown, ChevronRight, FileText, Folder } from 'lucide-react'
import { useMemo, useState } from 'react'

import type { MemoryScenarioEntryDto } from '../../../../../shared/memory'
import { MemoryMarkdown } from './MemoryMarkdown'
import { MemoryEmptyView } from './MemoryStatusViews'
import { formatDate, useAsyncData } from './useMemoryData'

interface ScenarioNode {
  name: string
  path: string
  isDirectory: boolean
  summary: string | null
  updatedAt: string
  children: Map<string, ScenarioNode>
}

function buildTree(entries: MemoryScenarioEntryDto[]): ScenarioNode {
  const root: ScenarioNode = { name: '', path: '', isDirectory: true, summary: null, updatedAt: '', children: new Map() }
  for (const entry of entries) {
    const segments = entry.path.split('/').filter(Boolean)
    let node = root
    for (let index = 0; index < segments.length; index += 1) {
      const name = segments[index]!
      const isLeaf = index === segments.length - 1 && !entry.path.endsWith('/')
      const path = `${segments.slice(0, index + 1).join('/')}${isLeaf ? '' : '/'}`
      let child = node.children.get(name)
      if (!child) {
        child = {
          name,
          path,
          isDirectory: !isLeaf,
          summary: isLeaf ? entry.summary ?? null : null,
          updatedAt: entry.updatedAt,
          children: new Map(),
        }
        node.children.set(name, child)
      } else if (isLeaf && entry.summary) {
        child.summary = entry.summary
        child.updatedAt = entry.updatedAt
      }
      node = child
    }
  }
  return root
}

function ScenarioTree({ root, selectedPath, onSelect }: {
  root: ScenarioNode
  selectedPath: string
  onSelect: (node: ScenarioNode) => void
}) {
  const children = [...root.children.values()].sort((a, b) =>
    Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name, 'zh-CN'))
  return (
    <ul>
      {children.map((child) => (
        <ScenarioTreeItem key={child.path} node={child} depth={0} selectedPath={selectedPath} onSelect={onSelect} />
      ))}
    </ul>
  )
}

function ScenarioTreeItem({ node, depth, selectedPath, onSelect }: {
  node: ScenarioNode
  depth: number
  selectedPath: string
  onSelect: (node: ScenarioNode) => void
}) {
  const [open, setOpen] = useState(depth < 1)
  const children = [...node.children.values()].sort((a, b) =>
    Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name, 'zh-CN'))
  return (
    <li>
      <button
        type="button"
        className="mem-scenario-node"
        style={{ paddingLeft: 8 + depth * 14 }}
        data-selected={node.path === selectedPath}
        data-directory={node.isDirectory}
        onClick={() => {
          if (node.isDirectory) setOpen((value) => !value)
          else onSelect(node)
        }}
        title={node.isDirectory ? node.path : node.summary ?? node.path}
      >
        {node.isDirectory ? (
          <>
            {open
              ? <ChevronDown aria-hidden="true" strokeWidth={1.8} className="mem-scenario-caret" />
              : <ChevronRight aria-hidden="true" strokeWidth={1.8} className="mem-scenario-caret" />}
            <Folder aria-hidden="true" strokeWidth={1.7} />
          </>
        ) : (
          <FileText aria-hidden="true" strokeWidth={1.7} />
        )}
        <span className="mem-scenario-name">{node.name}</span>
      </button>
      {node.isDirectory && open ? (
        <ul className="mem-scenario-children">
          {children.map((child) => (
            <ScenarioTreeItem key={child.path} node={child} depth={depth + 1} selectedPath={selectedPath} onSelect={onSelect} />
          ))}
        </ul>
      ) : null}
    </li>
  )
}

/** 场景正文里 MemoryCore 会附带 META 元数据块，阅读时剥离。 */
function stripMetaHeader(content: string): string {
  const match = /-*META-START-*\s*[\s\S]*?-*META-END-*\s*/.exec(content)
  return match ? content.slice(match[0].length).trimStart() : content
}

export function ScenarioPane() {
  const { data, failure, loading } = useAsyncData(() => window.nxcore!.memory.listScenarios())
  const [selectedPath, setSelectedPath] = useState('')
  const file = useAsyncData(
    () => selectedPath ? window.nxcore!.memory.readScenario(selectedPath) : Promise.resolve(null),
    [selectedPath],
  )

  const root = useMemo(() => buildTree(data?.entries ?? []), [data])
  const selectedEntry = (data?.entries ?? []).find((entry) => entry.path === selectedPath)

  if (failure) return <div className="mem-pane-error">{failure.message}</div>

  return (
    <div className="mem-scenario">
      <aside className="mem-scenario-tree">
        {loading ? <p className="mem-loading">加载中…</p> : null}
        {!loading && (data?.entries.length ?? 0) === 0 ? (
          <MemoryEmptyView title="暂无场景" hint="MemoryCore 会把相关记忆按主题归档为场景文档。" />
        ) : (
          <ScenarioTree root={root} selectedPath={selectedPath} onSelect={(node) => setSelectedPath(node.path)} />
        )}
      </aside>
      <section className="mem-scenario-viewer">
        {selectedPath ? (
          file.failure ? (
            <div className="mem-pane-error">{file.failure.message}</div>
          ) : file.loading ? (
            <p className="mem-loading">加载中…</p>
          ) : (
            <>
              <header>
                <strong>{selectedPath}</strong>
                {selectedEntry?.summary ? <small>{selectedEntry.summary}</small> : null}
                <small>更新于 {formatDate(file.data?.updatedAt || selectedEntry?.updatedAt)}</small>
              </header>
              {file.data?.content ? (
                <MemoryMarkdown markdown={stripMetaHeader(file.data.content)} />
              ) : (
                <MemoryEmptyView title="文件为空" />
              )}
            </>
          )
        ) : (
          <MemoryEmptyView title="选择左侧的场景文件" hint="场景（L2）是 MemoryCore 按主题归档的记忆文档。" />
        )}
      </section>
    </div>
  )
}
