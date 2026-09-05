import type { AgentActiveDocumentContext, RoomDocument } from '@nxcore/agent-contract'

export interface AgentDocumentSelectionItem {
  documentId: string
  roomId: string
  title: string
  version?: number
  status?: string
}

export interface AgentDocumentSelectionResult {
  documents: AgentDocumentSelectionItem[]
  selectionRequired: true
}

export interface AgentDocumentSelectionSubmission {
  document: AgentDocumentSelectionItem
  originalPrompt: string
  toolId: string
}

export interface AgentDocumentSelectionRunRequest {
  prompt: string
  activeDocument: AgentActiveDocumentContext
}

export interface PendingAgentDocumentSelection {
  documents: AgentDocumentSelectionItem[]
  originalPrompt: string
  toolId: string
  runId: string
}

interface DocumentSelectionToolLike {
  id: string
  runId: string
  name: string
  status: string
  result?: unknown
  startedAt: string
  completedAt?: string
}

interface DocumentSelectionMessageLike {
  runId: string
  role: string
  content: string
  createdAt: string
}

function record(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    try {
      return record(JSON.parse(value))
    } catch {
      return null
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function documentsFrom(value: unknown): AgentDocumentSelectionItem[] | null {
  if (!Array.isArray(value)) return null
  const documents: AgentDocumentSelectionItem[] = []
  const seen = new Set<string>()
  for (const item of value) {
    const candidate = record(item)
    const documentIdValue = candidate?.documentId ?? candidate?.id
    const documentId = typeof documentIdValue === 'string' ? documentIdValue.trim() : ''
    const roomId = typeof candidate?.roomId === 'string' ? candidate.roomId.trim() : ''
    const title = typeof candidate?.title === 'string' ? candidate.title.trim() : ''
    if (!documentId || !roomId || !title || seen.has(documentId)) continue
    seen.add(documentId)
    const version = typeof candidate?.version === 'number'
      && Number.isInteger(candidate.version)
      && candidate.version >= 0
      ? candidate.version
      : undefined
    const status = typeof candidate?.status === 'string' && candidate.status.trim()
      ? candidate.status.trim()
      : undefined
    documents.push({
      documentId,
      roomId,
      title,
      ...(version !== undefined ? { version } : {}),
      ...(status ? { status } : {}),
    })
  }
  return documents
}

export function parseAgentDocumentSelectionResult(result: unknown): AgentDocumentSelectionResult | null {
  const root = record(result)
  if (!root) return null
  const contentResult = Array.isArray(root.content)
    ? root.content.map((item) => record(item)).find((item) => typeof item?.text === 'string')?.text
    : undefined
  const candidates = [root.details, root.structuredContent, root, contentResult]
  for (const value of candidates) {
    const candidate = record(value)
    if (candidate?.selectionRequired !== true) continue
    const documents = documentsFrom(candidate.documents)
    if (documents) return { documents, selectionRequired: true }
  }
  return null
}

function timestamp(value: string | undefined): number {
  const parsed = value ? Date.parse(value) : Number.NaN
  return Number.isFinite(parsed) ? parsed : 0
}

export function findPendingAgentDocumentSelection(
  tools: DocumentSelectionToolLike[],
  messages: DocumentSelectionMessageLike[],
  dismissedToolIds: ReadonlySet<string>,
): PendingAgentDocumentSelection | null {
  const candidates = tools
    .filter((tool) => tool.name === 'context_room_document_list' && tool.status === 'completed')
    .flatMap((tool) => {
      const result = parseAgentDocumentSelectionResult(tool.result)
      // 空列表不弹卡片：没有可选对象时弹"选择要编辑的文档"只会造成困惑
      // （也覆盖修复前入库的旧结果——其候选缺 roomId，解析后恒为空）
      return result && result.documents.length > 0 ? [{ tool, result }] : []
    })
    .sort((left, right) => (
      timestamp(right.tool.completedAt ?? right.tool.startedAt)
      - timestamp(left.tool.completedAt ?? left.tool.startedAt)
    ))
  const latest = candidates[0]
  if (!latest || dismissedToolIds.has(latest.tool.id)) return null

  const completedAt = timestamp(latest.tool.completedAt ?? latest.tool.startedAt)
  const hasLaterUserMessage = messages.some((message) => (
    message.role === 'user' && timestamp(message.createdAt) > completedAt
  ))
  if (hasLaterUserMessage) return null

  const originalPrompt = [...messages]
    .reverse()
    .find((message) => message.role === 'user' && message.runId === latest.tool.runId)
    ?.content.trim()
  if (!originalPrompt) return null

  return {
    documents: latest.result.documents,
    originalPrompt,
    toolId: latest.tool.id,
    runId: latest.tool.runId,
  }
}

export function buildAgentDocumentSelectionRunRequest(
  originalPrompt: string,
  document: RoomDocument,
): AgentDocumentSelectionRunRequest {
  return {
    prompt: originalPrompt.trim(),
    activeDocument: {
      roomId: document.roomId,
      documentId: document.id,
      title: document.title,
      version: document.version,
      defaultAnchor: 'end',
    },
  }
}
