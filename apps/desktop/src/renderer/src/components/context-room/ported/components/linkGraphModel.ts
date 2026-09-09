import type { RoomDocument, TiptapJsonContent } from '@nxcore/agent-contract'
import { documentBodyContent, tiptapText } from '@nxcore/document-model'

import type { ContextRoomRecord } from '../types'

const BLOCK_INDEX_MARK_NODE = 'blockIndexMark'

/** 安全上限（防极端规模冻结画布），非内容策划：正常 Room 应全量展示。 */
export const LINK_GRAPH_DOCUMENT_LIMIT = 120
export const LINK_GRAPH_MEMORY_LIMIT = 300
export const LINK_GRAPH_BLOCK_LIMIT = 600
/** 文本块节点标签/描述的文本预览长度。 */
const BLOCK_LABEL_CHARS = 14
const BLOCK_DESCRIPTION_CHARS = 200

export const LINK_GRAPH_ROOT_ID = 'link:root'

/** 文档节点 id / 记忆节点 id（chip 跳转聚焦按此寻址）。 */
export const linkGraphDocumentNodeId = (documentId: string) => `doc:${documentId}`
export const linkGraphMemoryNodeId = (memoryId: string) => `memory:${memoryId}`
export const linkGraphBlockNodeId = (documentId: string, blockId: string) => `block:${documentId}:${blockId}`

export interface LinkGraphEdge {
  id: string
  kind: 'document' | 'memory'
  /** 挂标文档与段落块（段落无稳定 id 时 sourceBlockId 为空，边锚到文档节点）。 */
  sourceDocumentId: string
  sourceBlockId: string | null
  /** document 类：目标文档块；memory 类：目标记忆。 */
  targetDocumentId: string
  targetBlockId: string | null
  targetMemoryId: string
  /** 同 (源块, 目标) 重复标记计数。 */
  count: number
  label: string
}

export interface LinkGraphNode {
  id: string
  kind: 'root' | 'document' | 'memory' | 'block'
  documentId: string | null
  memoryId: string | null
  /** block 节点：所属文档。 */
  parentDocumentId: string | null
  blockId: string | null
  label: string
  description: string
  /** 悬空：目标文档/块/记忆已不在本 Room。 */
  stale: boolean
}

export interface LinkGraphData {
  rootId: string
  nodes: LinkGraphNode[]
  edges: LinkGraphEdge[]
  totals: {
    documents: number
    memories: number
    links: number
    dangling: number
  }
}

interface CollectedMark {
  kind: 'document' | 'memory'
  targetRoomId: string
  targetDocumentId: string
  targetBlockId: string
  targetMemoryId: string
  label: string
  paragraphBlockId: string | null
}

/** 收集一篇文档里全部 blockIndexMark（含宿主顶层段落 id，供定位）。 */
export function collectDocumentIndexMarks(content: TiptapJsonContent): CollectedMark[] {
  const marks: CollectedMark[] = []
  for (const top of documentBodyContent(content).content ?? []) {
    const paragraphBlockId = typeof top.attrs?.id === 'string' && top.attrs.id ? top.attrs.id : null
    const visit = (node: TiptapJsonContent): void => {
      if (node.type === BLOCK_INDEX_MARK_NODE) {
        const attrs = node.attrs ?? {}
        marks.push({
          kind: attrs.kind === 'memory' ? 'memory' : 'document',
          targetRoomId: typeof attrs.targetRoomId === 'string' ? attrs.targetRoomId : '',
          targetDocumentId: typeof attrs.targetDocumentId === 'string' ? attrs.targetDocumentId : '',
          targetBlockId: typeof attrs.targetBlockId === 'string' ? attrs.targetBlockId : '',
          targetMemoryId: typeof attrs.targetMemoryId === 'string' ? attrs.targetMemoryId : '',
          label: typeof attrs.fallbackTitle === 'string' ? attrs.fallbackTitle : '',
          paragraphBlockId,
        })
        return
      }
      ;(node.content ?? []).forEach(visit)
    }
    visit(top)
  }
  return marks
}

/** 顶层块 id → 文本预览（块节点标签与目标块存在性判定共用）。 */
function topLevelBlockTexts(document: RoomDocument): Map<string, string> {
  const texts = new Map<string, string>()
  for (const top of documentBodyContent(document.contentJson).content ?? []) {
    const blockId = typeof top.attrs?.id === 'string' && top.attrs.id ? top.attrs.id : null
    if (!blockId) continue
    texts.set(blockId, tiptapText(top).replace(/\s+/g, ' ').trim())
  }
  return texts
}

function blockLabel(text: string, fallback: string): string {
  if (text) return text.length > BLOCK_LABEL_CHARS ? `${text.slice(0, BLOCK_LABEL_CHARS)}…` : text
  return fallback || '文本块'
}

function memoryNodeLabel(memory: ContextRoomRecord['memoryItems'][number]): string {
  if (memory.type) return memory.type
  return memory.content.replace(/\s+/g, ' ').trim().slice(0, 16)
}

/**
 * Room 建联图谱（块级星系模型）：文档与记忆为中心节点，带建联的文本块是
 * 环绕所属文档的卫星节点；边为 块→目标块（跨文档）与 块→记忆。
 * 纯读侧投影——遍历 Room 文档 content，不依赖服务端：
 * - 跨 Room 标记整条跳过；
 * - 宿主块（挂标段落）与目标块（被引用段落，按目标文档 content 解析）都进图；
 * - 目标文档/块/记忆不在本 Room → 悬空节点（灰显，标题回退 fallback/回收站）。
 */
export function buildLinkGraphData(
  room: Pick<ContextRoomRecord, 'id' | 'title' | 'memoryItems'>,
  documents: RoomDocument[],
  trashedDocuments: RoomDocument[] = [],
): LinkGraphData {
  const liveDocs = documents.slice(0, LINK_GRAPH_DOCUMENT_LIMIT)
  const docsById = new Map(liveDocs.map((document) => [document.id, document]))
  const docTextsById = new Map(liveDocs.map((document) => [document.id, topLevelBlockTexts(document)]))
  const trashedById = new Map(trashedDocuments.map((document) => [document.id, document]))
  const memoryById = new Map(room.memoryItems.map((memory) => [memory.id, memory]))

  const nodes = new Map<string, LinkGraphNode>()
  const edges: LinkGraphEdge[] = []
  const edgeByPair = new Map<string, LinkGraphEdge>()
  /** 文档 → 其场内块 id 集合（含宿主块与目标块），决定轨道场成员。 */
  const blocksByDoc = new Map<string, Set<string>>()
  let linkCount = 0
  let danglingCount = 0

  const ensureDocNode = (documentId: string, label: string, stale: boolean): LinkGraphNode | null => {
    const id = linkGraphDocumentNodeId(documentId)
    const existing = nodes.get(id)
    if (existing) return existing
    if (nodes.size >= 1 + LINK_GRAPH_DOCUMENT_LIMIT + LINK_GRAPH_MEMORY_LIMIT + LINK_GRAPH_BLOCK_LIMIT) return null
    const node: LinkGraphNode = {
      id, kind: 'document', documentId, memoryId: null, parentDocumentId: null, blockId: null,
      label, description: label, stale,
    }
    nodes.set(id, node)
    return node
  }
  const ensureBlockNode = (
    documentId: string,
    blockId: string,
    text: string,
    fallbackLabel: string,
    stale: boolean,
  ): LinkGraphNode | null => {
    const id = linkGraphBlockNodeId(documentId, blockId)
    const existing = nodes.get(id)
    if (existing) {
      if (stale === false) existing.stale = false
      return existing
    }
    if (!ensureDocNode(documentId, docsById.get(documentId)?.title ?? trashedById.get(documentId)?.title ?? '', !docsById.has(documentId))) return null
    const node: LinkGraphNode = {
      id, kind: 'block', documentId: null, memoryId: null,
      parentDocumentId: documentId, blockId,
      label: blockLabel(text, fallbackLabel),
      description: text.slice(0, BLOCK_DESCRIPTION_CHARS) || fallbackLabel,
      stale,
    }
    nodes.set(id, node)
    let blocks = blocksByDoc.get(documentId)
    if (!blocks) {
      blocks = new Set()
      blocksByDoc.set(documentId, blocks)
    }
    blocks.add(blockId)
    return node
  }
  const ensureMemoryNode = (memoryId: string, label: string, description: string, stale: boolean): LinkGraphNode | null => {
    const id = linkGraphMemoryNodeId(memoryId)
    const existing = nodes.get(id)
    if (existing) return existing
    const node: LinkGraphNode = {
      id, kind: 'memory', documentId: null, memoryId, parentDocumentId: null, blockId: null,
      label, description, stale,
    }
    nodes.set(id, node)
    return node
  }

  for (const document of liveDocs) ensureDocNode(document.id, document.title, false)

  for (const document of liveDocs) {
    for (const mark of collectDocumentIndexMarks(document.contentJson)) {
      if (mark.targetRoomId !== room.id) continue
      // 宿主块节点（挂标段落）。
      if (mark.paragraphBlockId) {
        const hostText = docTextsById.get(document.id)?.get(mark.paragraphBlockId) ?? ''
        ensureBlockNode(document.id, mark.paragraphBlockId, hostText, mark.label, false)
      }

      if (mark.kind === 'memory') {
        if (!mark.targetMemoryId) continue
        const memory = memoryById.get(mark.targetMemoryId)
        if (!memory) {
          danglingCount += 1
          ensureMemoryNode(mark.targetMemoryId, mark.label || '记忆', mark.label, true)
        } else {
          linkCount += 1
          ensureMemoryNode(memory.id, memoryNodeLabel(memory), memory.content.replace(/\s+/g, ' ').trim().slice(0, BLOCK_DESCRIPTION_CHARS), false)
        }
        const pairKey = `${document.id}|${mark.paragraphBlockId ?? ''}|mem|${mark.targetMemoryId}`
        const existing = edgeByPair.get(pairKey)
        if (existing) existing.count += 1
        else edgeByPair.set(pairKey, {
          id: `edge:${document.id}:${mark.paragraphBlockId ?? ''}:mem:${mark.targetMemoryId}`,
          kind: 'memory',
          sourceDocumentId: document.id,
          sourceBlockId: mark.paragraphBlockId,
          targetDocumentId: '',
          targetBlockId: null,
          targetMemoryId: mark.targetMemoryId,
          count: 1,
          label: mark.label,
        })
        continue
      }

      if (!mark.targetDocumentId) continue
      const targetDoc = docsById.get(mark.targetDocumentId)
      if (!targetDoc) {
        danglingCount += 1
        // 目标文档已不在本 Room：悬空文档节点 + 悬空目标块入其场。
        ensureDocNode(mark.targetDocumentId, mark.label || trashedById.get(mark.targetDocumentId)?.title || '文档', true)
        if (mark.targetBlockId) {
          ensureBlockNode(mark.targetDocumentId, mark.targetBlockId, '', mark.label, true)
        }
      } else if (!mark.targetBlockId) {
        // 目标是整篇文档（无块 id）：连到文档节点。
        linkCount += 1
      } else {
        const targetText = docTextsById.get(targetDoc.id)?.get(mark.targetBlockId)
        if (targetText === undefined) {
          // 文档在但块没了：悬空块进目标文档场。
          danglingCount += 1
          ensureBlockNode(targetDoc.id, mark.targetBlockId, '', mark.label, true)
        } else {
          linkCount += 1
          ensureBlockNode(targetDoc.id, mark.targetBlockId, targetText, mark.label, false)
        }
      }
      const pairKey = `${document.id}|${mark.paragraphBlockId ?? ''}|doc|${mark.targetDocumentId}|${mark.targetBlockId}`
      const existing = edgeByPair.get(pairKey)
      if (existing) existing.count += 1
      else edgeByPair.set(pairKey, {
        id: `edge:${document.id}:${mark.paragraphBlockId ?? ''}:doc:${mark.targetDocumentId}:${mark.targetBlockId}`,
        kind: 'document',
        sourceDocumentId: document.id,
        sourceBlockId: mark.paragraphBlockId,
        targetDocumentId: mark.targetDocumentId,
        targetBlockId: mark.targetBlockId || null,
        targetMemoryId: '',
        count: 1,
        label: mark.label,
      })
    }
  }

  const root: LinkGraphNode = {
    id: LINK_GRAPH_ROOT_ID, kind: 'root', documentId: null, memoryId: null,
    parentDocumentId: null, blockId: null, label: room.title, description: room.title, stale: false,
  }
  const nodeList: LinkGraphNode[] = [root]
  const docNodes: LinkGraphNode[] = []
  const memoryNodes: LinkGraphNode[] = []
  const blockNodes: LinkGraphNode[] = []
  for (const node of nodes.values()) {
    if (node.kind === 'document') docNodes.push(node)
    else if (node.kind === 'memory') memoryNodes.push(node)
    else blockNodes.push(node)
  }
  // 输出顺序：根 → 文档（含悬空文档）→ 块 → 记忆；块紧跟文档便于轨道场就近布置。
  nodeList.push(...docNodes.slice(0, LINK_GRAPH_DOCUMENT_LIMIT))
  nodeList.push(...blockNodes.slice(0, LINK_GRAPH_BLOCK_LIMIT))
  nodeList.push(...memoryNodes.slice(0, LINK_GRAPH_MEMORY_LIMIT))

  return {
    rootId: LINK_GRAPH_ROOT_ID,
    nodes: nodeList,
    edges: [...edgeByPair.values()],
    totals: {
      documents: documents.length,
      memories: room.memoryItems.length,
      links: linkCount,
      dangling: danglingCount,
    },
  }
}

/** 文档 → 其场内块 id 集合（含宿主块与目标块），决定轨道场成员。 */
export function linkGraphBlocksByDocument(data: LinkGraphData): Map<string, string[]> {
  const blocks = new Map<string, string[]>()
  for (const node of data.nodes) {
    if (node.kind !== 'block' || !node.parentDocumentId || !node.blockId) continue
    blocks.set(node.parentDocumentId, [...(blocks.get(node.parentDocumentId) ?? []), node.blockId])
  }
  return blocks
}

/** 图谱筛选：全部 / 仅文档间建联 / 仅文档↔记忆建联。 */
export type LinkGraphFilter = 'all' | 'documents' | 'memories'

/**
 * 读侧筛选：按边类型保留子图。中心节点（根/文档）保留作结构锚点；
 * 仅文档模式剔除记忆节点，仅记忆模式剔除悬空文档节点（其挂点边已被过滤）；
 * 块节点只保留参与过滤后边的（场半径随之自动收缩）。
 */
export function filterLinkGraphData(data: LinkGraphData, filter: LinkGraphFilter): LinkGraphData {
  if (filter === 'all') return data
  const keepKind: LinkGraphEdge['kind'] = filter === 'documents' ? 'document' : 'memory'
  const edges = data.edges.filter((edge) => edge.kind === keepKind)
  const keepBlocks = new Set<string>()
  for (const edge of edges) {
    if (edge.sourceBlockId) keepBlocks.add(`${edge.sourceDocumentId}|${edge.sourceBlockId}`)
    if (edge.kind === 'document' && edge.targetBlockId) {
      keepBlocks.add(`${edge.targetDocumentId}|${edge.targetBlockId}`)
    }
  }
  const nodes = data.nodes.filter((node) => {
    if (node.kind === 'root') return true
    if (node.kind === 'document') return filter === 'documents' || !node.stale
    if (node.kind === 'memory') return filter === 'memories'
    return keepBlocks.has(`${node.parentDocumentId ?? ''}|${node.blockId ?? ''}`)
  })
  return { ...data, nodes, edges }
}
