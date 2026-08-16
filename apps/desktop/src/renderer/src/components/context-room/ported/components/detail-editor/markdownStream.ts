import type { RoomDocument, TiptapJsonContent } from '@nxcore/agent-contract'

const STREAM_CHARACTERS_PER_FRAME = 2
const STREAM_MAX_FRAMES_PER_APPEND = 800
const STREAM_FRAME_DELAY_MIN_MS = 42
const STREAM_FRAME_DELAY_JITTER_MS = 19
const STREAM_CLAUSE_PAUSE_MS = 35
const STREAM_SENTENCE_PAUSE_MS = 85
const STREAM_NEWLINE_PAUSE_MS = 120

function textCharacters(text: string): string[] {
  return Array.from(text)
}

export function tiptapTextContent(node: TiptapJsonContent): string {
  if (typeof node.text === 'string') return node.text
  return node.content?.map(tiptapTextContent).join('') ?? ''
}

export function countTiptapTextCharacters(node: TiptapJsonContent): number {
  return textCharacters(tiptapTextContent(node)).length
}

export function hasVisibleTiptapContent(node: TiptapJsonContent): boolean {
  if (typeof node.text === 'string' && node.text.trim().length > 0) return true
  if (node.type === 'horizontalRule' || node.type === 'image') return true
  return node.content?.some(hasVisibleTiptapContent) ?? false
}

export function isAgentDocumentAwaitingContent(
  document: Pick<RoomDocument, 'activeTransactionId' | 'contentJson' | 'status'> | null,
): boolean {
  return Boolean(
    document?.status === 'draft'
    && document.activeTransactionId
    && !hasVisibleTiptapContent(document.contentJson),
  )
}

export function isEmptyTiptapParagraph(node: TiptapJsonContent | undefined): boolean {
  return node?.type === 'paragraph' && (node.content?.length ?? 0) === 0
}

function cloneTiptapNode(node: TiptapJsonContent): TiptapJsonContent {
  return {
    ...node,
    ...(node.attrs ? { attrs: { ...node.attrs } } : {}),
    ...(node.marks ? {
      marks: node.marks.map((mark) => ({
        ...mark,
        ...(mark.attrs ? { attrs: { ...mark.attrs } } : {}),
      })),
    } : {}),
    ...(node.content ? { content: node.content.map(cloneTiptapNode) } : {}),
  }
}

export function revealTiptapNode(
  node: TiptapJsonContent,
  characterLimit: number,
): TiptapJsonContent {
  const totalCharacters = countTiptapTextCharacters(node)
  const safeLimit = Math.max(0, Math.floor(characterLimit))
  if (totalCharacters === 0 || safeLimit >= totalCharacters) return cloneTiptapNode(node)

  if (typeof node.text === 'string') {
    return { ...cloneTiptapNode(node), text: textCharacters(node.text).slice(0, safeLimit).join('') }
  }

  let remaining = safeLimit
  const content: TiptapJsonContent[] = []
  for (const child of node.content ?? []) {
    if (remaining <= 0) break
    const childCharacters = countTiptapTextCharacters(child)
    content.push(revealTiptapNode(child, remaining))
    remaining -= Math.min(remaining, childCharacters)
  }
  return { ...cloneTiptapNode(node), content }
}

export function documentStreamCharactersPerFrame(totalCharacters: number): number {
  return Math.max(
    STREAM_CHARACTERS_PER_FRAME,
    Math.ceil(Math.max(0, totalCharacters) / STREAM_MAX_FRAMES_PER_APPEND),
  )
}

export function documentStreamRevealDelay(
  revealedText: string,
  random: () => number = Math.random,
): number {
  const randomValue = Math.max(0, Math.min(0.999999, random()))
  const frameDelay = STREAM_FRAME_DELAY_MIN_MS
    + Math.floor(randomValue * STREAM_FRAME_DELAY_JITTER_MS)
  if (/\n$/.test(revealedText)) return frameDelay + STREAM_NEWLINE_PAUSE_MS
  if (/[。！？.!?]$/.test(revealedText)) return frameDelay + STREAM_SENTENCE_PAUSE_MS
  if (/[，、；：,;:]$/.test(revealedText)) return frameDelay + STREAM_CLAUSE_PAUSE_MS
  return frameDelay
}

function isFence(line: string): string | null {
  const match = /^\s*(```+|~~~+)/.exec(line)
  return match?.[1]?.[0] ?? null
}

export class MarkdownBlockBuffer {
  private value = ''
  private trailingCarriageReturn = false

  append(chunk: string, final = false): string[] {
    let incoming = this.trailingCarriageReturn ? `\r${chunk}` : chunk
    this.trailingCarriageReturn = false
    if (!final && incoming.endsWith('\r')) {
      incoming = incoming.slice(0, -1)
      this.trailingCarriageReturn = true
    }
    this.value += incoming.replace(/\r\n?/g, '\n')
    if (final && this.trailingCarriageReturn) {
      this.value += '\n'
      this.trailingCarriageReturn = false
    }
    const blocks: string[] = []
    let start = 0
    let offset = 0
    let fence: string | null = null

    while (offset < this.value.length) {
      const newline = this.value.indexOf('\n', offset)
      if (newline < 0) break
      const end = newline + 1
      const line = this.value.slice(offset, newline)
      const marker = isFence(line)

      if (marker) {
        if (!fence) {
          if (offset > start && this.value.slice(start, offset).trim()) {
            blocks.push(this.value.slice(start, offset).trim())
            start = offset
          }
          fence = marker
        } else if (fence === marker) {
          fence = null
          blocks.push(this.value.slice(start, end).trim())
          start = end
        }
      } else if (!fence) {
        const heading = /^\s{0,3}#{1,6}\s+\S/.test(line)
        if (heading && offset > start && this.value.slice(start, offset).trim()) {
          blocks.push(this.value.slice(start, offset).trim())
          start = offset
        }
        if (heading || line.trim() === '') {
          const block = this.value.slice(start, end).trim()
          if (block) blocks.push(block)
          start = end
        }
      }
      offset = end
    }

    this.value = this.value.slice(start)
    if (final && this.value.trim()) {
      blocks.push(this.value.trim())
      this.value = ''
    }
    return blocks
  }

  reset(): void {
    this.value = ''
    this.trailingCarriageReturn = false
  }
}

export class AppliedSequenceTracker {
  private readonly sequences = new Set<number>()

  has(sequence: number): boolean {
    return this.sequences.has(sequence)
  }

  record(sequence: number): boolean {
    if (this.sequences.has(sequence)) return false
    this.sequences.add(sequence)
    return true
  }
}

export function eventsAfterLastDocumentTerminal<T extends { type: string }>(events: T[]): T[] {
  let terminalIndex = -1
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const type = events[index]?.type
    if (type === 'document.committed' || type === 'document.aborted') {
      terminalIndex = index
      break
    }
  }
  return terminalIndex >= 0 ? events.slice(terminalIndex) : events
}

export function assignStableBlockIds(
  nodes: TiptapJsonContent[],
  transactionId: string,
  startOrdinal: number,
): { nodes: TiptapJsonContent[]; nextOrdinal: number } {
  let ordinal = startOrdinal
  return {
    nodes: nodes.map((node) => ({
      ...node,
      attrs: { ...node.attrs, id: `${transactionId}:${String(ordinal++)}` },
    })),
    nextOrdinal: ordinal,
  }
}
