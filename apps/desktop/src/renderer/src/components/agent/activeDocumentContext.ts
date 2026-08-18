import type {
  AgentActiveDocumentContext,
  AgentDocumentCursorAnchor,
} from '@nxcore/agent-contract'

export interface ActiveDocumentDescriptor {
  roomId: string
  documentId: string
  title: string
  version: number
  cursorAnchorCandidate?: AgentDocumentCursorAnchor | null
}

export type ActiveDocumentAnchorMode = 'auto' | 'end' | 'cursor'

export interface BuildActiveDocumentContextOptions {
  anchorMode?: ActiveDocumentAnchorMode
}

interface ProseMirrorNodeLike {
  attrs?: Record<string, unknown> | null
  textContent: string
}

export interface CursorAnchorEditorStateLike {
  selection: {
    empty: boolean
    from: number
    to: number
    $from: {
      depth: number
      node(depth: number): ProseMirrorNodeLike
      start(depth: number): number
    }
  }
  doc: {
    textBetween(from: number, to: number, blockSeparator?: string, leafText?: string): string
  }
}

const currentPositionPatterns = [
  /(?:当前位置|当前光标|光标处|光标位置)(?:开始|继续|接着|续写|往下写|写|插入|补充)?/u,
  /(?:从|在)(?:当前)?(?:光标|这里|此处|当前位置)(?:处|位置)?(?:开始|继续|接着|续写|往下写|写|插入|补充)/u,
  /(?:这里|此处)(?:开始|继续|接着|续写|往下写|插入|补充)/u,
  /\b(?:at|from)\s+(?:the\s+)?(?:current\s+)?(?:cursor|caret|position|here)\b/iu,
]

function cleanString(value: string): string {
  return value.trim()
}

export function normalizeCursorAnchorCandidate(
  candidate: AgentDocumentCursorAnchor | null | undefined,
): AgentDocumentCursorAnchor | undefined {
  const blockId = typeof candidate?.blockId === 'string' ? cleanString(candidate.blockId) : ''
  if (!blockId || typeof candidate?.offset !== 'number' || !Number.isFinite(candidate.offset)) return undefined
  return {
    blockId,
    offset: Math.max(0, Math.floor(candidate.offset)),
    affinity: 'after',
  }
}

export function createCursorAnchorCandidate(
  blockId: string,
  offset: number,
): AgentDocumentCursorAnchor | undefined {
  return normalizeCursorAnchorCandidate({ blockId, offset, affinity: 'after' })
}

/**
 * Creates the structured anchor from a collapsed ProseMirror selection. The
 * deepest block carrying a stable blockId wins, which keeps list-item and
 * nested paragraph anchors deterministic.
 */
export function cursorAnchorCandidateFromEditorState(
  state: CursorAnchorEditorStateLike,
): AgentDocumentCursorAnchor | undefined {
  const { selection } = state
  if (!selection.empty || selection.from !== selection.to) return undefined

  for (let depth = selection.$from.depth; depth > 0; depth -= 1) {
    const node = selection.$from.node(depth)
    const rawBlockId = node.attrs?.id ?? node.attrs?.blockId
    const blockId = typeof rawBlockId === 'string' ? rawBlockId.trim() : ''
    if (!blockId) continue
    const contentStart = selection.$from.start(depth)
    const cursorPosition = Math.max(contentStart, selection.from)
    const textBeforeCursor = state.doc.textBetween(contentStart, cursorPosition, '', '\ufffc')
    return createCursorAnchorCandidate(blockId, Math.min(textBeforeCursor.length, node.textContent.length))
  }
  return undefined
}

export function hasExplicitCurrentPositionIntent(prompt: string): boolean {
  const normalized = prompt.trim()
  return Boolean(normalized) && currentPositionPatterns.some((pattern) => pattern.test(normalized))
}

export function buildActiveDocumentRunContext(
  descriptor: ActiveDocumentDescriptor | null | undefined,
  prompt: string,
  options: BuildActiveDocumentContextOptions = {},
): AgentActiveDocumentContext | null {
  if (!descriptor) return null
  const roomId = cleanString(descriptor.roomId)
  const documentId = cleanString(descriptor.documentId)
  const title = cleanString(descriptor.title)
  if (!roomId || !documentId || !title || !Number.isInteger(descriptor.version) || descriptor.version < 0) {
    return null
  }

  const context: AgentActiveDocumentContext = {
    roomId,
    documentId,
    title,
    version: descriptor.version,
    defaultAnchor: 'end',
  }
  const anchorMode = options.anchorMode ?? 'auto'
  const shouldUseCursor = anchorMode === 'cursor'
    || (anchorMode === 'auto' && hasExplicitCurrentPositionIntent(prompt))
  const cursorAnchorCandidate = shouldUseCursor
    ? normalizeCursorAnchorCandidate(descriptor.cursorAnchorCandidate)
    : undefined
  return cursorAnchorCandidate ? { ...context, cursorAnchorCandidate } : context
}
