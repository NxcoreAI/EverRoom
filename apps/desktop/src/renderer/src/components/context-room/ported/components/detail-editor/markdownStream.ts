import type { TiptapJsonContent } from '@nxcore/agent-contract'

const STREAM_CHARACTERS_PER_FRAME = 24
const STREAM_FRAME_DELAY_MIN_MS = 12
const STREAM_FRAME_DELAY_JITTER_MS = 9
const STREAM_NEWLINE_PAUSE_MS = 8
const STREAM_BLOCK_DELAY_MAX_MS = 180

export function documentStreamRevealDelay(
  markdown: string,
  random: () => number = Math.random,
): number {
  const frameCount = Math.max(1, Math.ceil(markdown.length / STREAM_CHARACTERS_PER_FRAME))
  const randomValue = Math.max(0, Math.min(0.999999, random()))
  const frameDelay = STREAM_FRAME_DELAY_MIN_MS
    + Math.floor(randomValue * STREAM_FRAME_DELAY_JITTER_MS)
  const structuralPause = markdown.endsWith('\n') ? STREAM_NEWLINE_PAUSE_MS : 0
  return Math.min(STREAM_BLOCK_DELAY_MAX_MS, frameCount * frameDelay + structuralPause)
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
