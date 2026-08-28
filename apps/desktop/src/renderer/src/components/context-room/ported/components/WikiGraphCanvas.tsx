import { useMemo, useRef } from 'react'

import type { KnowledgeWikiGraphDto } from '../../../../../../shared/knowledge'
import {
  PixiForceGraphCanvas,
  type PixiForceGraphCanvasHandle,
  type PixiForceGraphCanvasNode,
  type PixiForceGraphEdge,
  useForceGraphLayout,
} from '@/components/graph'
import { useLocale } from '../../../../i18n/LocaleContext'

/** 详情面板小视口：布局稳定后只居中、不缩小；收敛期间相机逐帧跟随内容。 */
const SETTLE_FIT = { minScale: 1, follow: true }

function nodeRadius(node: KnowledgeWikiGraphDto['nodes'][number]) {
  return Math.min(28, 18 + node.inLinks * 2)
}

function initialPositions(count: number) {
  const positions = new Float32Array(count * 2)
  for (let index = 0; index < count; index += 1) {
    const angle = index * Math.PI * (3 - Math.sqrt(5))
    const distance = 130 * Math.sqrt(index / Math.max(1, count - 1))
    positions[index * 2] = 320 + Math.cos(angle) * distance
    positions[index * 2 + 1] = 210 + Math.sin(angle) * distance
  }
  return positions
}

/** Wiki 内链图谱：Worker 计算 d3-force，画布只读取 SharedArrayBuffer 坐标。 */
export function WikiGraphCanvas({ graph, selectedPath, onSelectPage }: {
  graph: KnowledgeWikiGraphDto
  selectedPath: string | null
  onSelectPage: (path: string) => void
}) {
  const { t } = useLocale()
  const canvasRef = useRef<PixiForceGraphCanvasHandle>(null)
  const nodeIndex = useMemo(
    () => new Map(graph.nodes.map((node, index) => [node.id, index])),
    [graph.nodes],
  )
  const pathById = useMemo(
    () => new Map(graph.nodes.map((node) => [node.id, node.path])),
    [graph.nodes],
  )
  const nodes = useMemo<PixiForceGraphCanvasNode[]>(() => graph.nodes.map((node) => ({
    color: node.inLinks >= 2 ? 0x7799f9 : 0xaeb7c4,
    id: node.id,
    label: node.title,
    radius: nodeRadius(node),
  })), [graph.nodes])
  const edges = useMemo<PixiForceGraphEdge[]>(() => graph.edges.flatMap((edge) => {
    const source = nodeIndex.get(edge.source)
    const target = nodeIndex.get(edge.target)
    return source === undefined || target === undefined ? [] : [{ source, target }]
  }), [graph.edges, nodeIndex])
  const fallbackPositions = useMemo(() => initialPositions(nodes.length), [nodes.length])
  const layoutNodes = useMemo(
    () => graph.nodes.map((node) => ({ id: node.id, radius: nodeRadius(node) })),
    [graph.nodes],
  )
  const layout = useForceGraphLayout({
    nodes: layoutNodes,
    edges: graph.edges,
    label: 'Wiki force graph',
    canvasRef,
    settleFit: SETTLE_FIT,
  })
  const selectedId = selectedPath
    ? graph.nodes.find((node) => node.path === selectedPath)?.id ?? null
    : null

  return (
    <div className="context-room-graph-shell context-room-wiki-graph nx-graph-shell">
      <PixiForceGraphCanvas
        ref={canvasRef}
        ariaLabel={t('contextRoom:graphs.wikiCanvas')}
        centerOnMount
        className="context-room-graph-canvas"
        edges={edges}
        maskUntilStable
        nodes={nodes}
        positions={layout.positions ?? fallbackPositions}
        revision={layout.revision}
        selectedId={selectedId}
        onResize={layout.resize}
        onUserGesture={layout.cancelAutoFit}
        onDragNode={layout.drag}
        onReleaseNode={layout.release}
        onSelectNode={(nodeId) => {
          if (!nodeId) return
          const path = pathById.get(nodeId)
          if (path) onSelectPage(path)
        }}
      />
      <div className="context-room-visually-hidden" aria-label={t('contextRoom:graphs.wikiNodes')}>
        {graph.nodes.map((node) => (
          <button
            type="button"
            key={node.id}
            aria-label={t('contextRoom:graphs.wikiPageNode', { title: node.title, count: node.inLinks })}
            aria-pressed={node.path === selectedPath}
            onClick={() => onSelectPage(node.path)}
          >
            {t('contextRoom:graphs.viewWikiPage', { title: node.title })}
          </button>
        ))}
      </div>
    </div>
  )
}
