// OCR 行几何聚类：把 Vision 逐行观察按坐标归成文本块并排阅读顺序。
// Vision box 为归一化坐标（原点左下），这里先翻到左上原点、换算像素，再做行合并与块聚合。

import type { VisionOcrLine } from '../vision-ocr/vision-ocr-client'

export interface TextBlock {
  text: string
  lines: string[]
}

export interface ClusteredFrame {
  /** 阅读顺序的全部行文本（块内自上而下，块间按块序）。 */
  orderedLines: string[]
  blocks: TextBlock[]
}

const ROW_JOIN_GAP_FACTOR = 1.5
const ROW_BAND_OVERLAP_RATIO = 0.5
const BLOCK_ROW_GAP_FACTOR = 0.9
const BLOCK_ROW_OVERLAP_RATIO = 0.3
const BLOCK_ROW_HEIGHT_RATIO_MAX = 2.8

interface Rect {
  left: number
  top: number
  right: number
  bottom: number
}

interface Row {
  rect: Rect
  parts: { rect: Rect; text: string }[]
}

function verticalOverlap(a: Rect, b: Rect): number {
  return Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
}

function horizontalOverlap(a: Rect, b: Rect): number {
  return Math.min(a.right, b.right) - Math.max(a.left, b.left)
}

function unionRect(a: Rect, b: Rect): Rect {
  return {
    left: Math.min(a.left, b.left),
    top: Math.min(a.top, b.top),
    right: Math.max(a.right, b.right),
    bottom: Math.max(a.bottom, b.bottom),
  }
}

function isCjkChar(ch: string | undefined): boolean {
  if (!ch) return false
  const code = ch.codePointAt(0) ?? 0
  return code >= 0x3000 && code <= 0x9fff
}

function joinText(left: string, right: string): string {
  if (left.length === 0 || right.length === 0) return left + right
  if (isCjkChar(left.at(-1)) || isCjkChar(right.at(0))) return left + right
  return `${left} ${right}`
}

function rowText(row: Row): string {
  return row.parts.map((part) => part.text).reduce(joinText)
}

/** 同一文本行内水平相邻的 Vision 观测合并；不同栏（间距大）保持分离。 */
function mergeRows(items: { rect: Rect; text: string }[]): Row[] {
  const rows: Row[] = []
  for (const item of items) {
    let target: Row | null = null
    for (const row of rows) {
      const smaller = Math.min(row.rect.bottom - row.rect.top, item.rect.bottom - item.rect.top)
      const overlap = verticalOverlap(row.rect, item.rect)
      if (overlap < ROW_BAND_OVERLAP_RATIO * smaller) continue
      const gap = Math.max(row.rect.left - item.rect.right, item.rect.left - row.rect.right)
      if (gap > ROW_JOIN_GAP_FACTOR * smaller) continue
      target = row
      break
    }
    if (target) {
      target.parts.push({ rect: item.rect, text: item.text })
      target.parts.sort((a, b) => a.rect.left - b.rect.left)
      target.rect = unionRect(target.rect, item.rect)
    } else {
      rows.push({ rect: { ...item.rect }, parts: [{ rect: item.rect, text: item.text }] })
    }
  }
  return rows
}

/** 阅读顺序：块顶边为主；垂直交叠大的并排块（左右栏）按左边排。 */
function sortBlocksReadingOrder(blocks: { rect: Rect; lines: string[] }[]): void {
  blocks.sort((a, b) => {
    const overlap = Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.top, b.rect.top)
    const shorter = Math.min(a.rect.bottom - a.rect.top, b.rect.bottom - b.rect.top)
    if (overlap >= 0.5 * shorter) return a.rect.left - b.rect.left
    return a.rect.top - b.rect.top
  })
}

export function clusterOcrLines(
  lines: VisionOcrLine[],
  size: { width: number; height: number },
): ClusteredFrame {
  const width = Math.max(1, size.width)
  const height = Math.max(1, size.height)
  const items = lines
    .filter((line) => line.text.trim().length > 0)
    .map((line) => {
      const [nx, ny, nw, nh] = line.box
      const w = Math.max(1, nw * width)
      const h = Math.max(1, nh * height)
      const left = nx * width
      const top = (1 - ny - nh) * height
      return { rect: { left, top, right: left + w, bottom: top + h } as Rect, text: line.text.trim() }
    })
  if (items.length === 0) return { orderedLines: [], blocks: [] }

  const rows = mergeRows(items).sort(
    (a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left,
  )

  const blocks: { rect: Rect; lines: string[] }[] = []
  for (const row of rows) {
    const previous = blocks.at(-1)
    const rowHeight = row.rect.bottom - row.rect.top
    if (previous) {
      const previousHeight = previous.rect.bottom - previous.rect.top
      const gap = row.rect.top - previous.rect.bottom
      const overlap = horizontalOverlap(previous.rect, row.rect)
      const narrower = Math.min(previous.rect.right - previous.rect.left, row.rect.right - row.rect.left)
      const sameBlock =
        gap <= BLOCK_ROW_GAP_FACTOR * ((rowHeight + previousHeight) / 2) &&
        overlap >= BLOCK_ROW_OVERLAP_RATIO * narrower &&
        Math.max(rowHeight, previousHeight) / Math.min(rowHeight, previousHeight) <= BLOCK_ROW_HEIGHT_RATIO_MAX
      if (sameBlock) {
        previous.lines.push(rowText(row))
        previous.rect = unionRect(previous.rect, row.rect)
        continue
      }
    }
    blocks.push({ rect: { ...row.rect }, lines: [rowText(row)] })
  }
  sortBlocksReadingOrder(blocks)

  const textBlocks: TextBlock[] = blocks.map((block) => ({
    text: block.lines.join('\n'),
    lines: block.lines,
  }))
  return {
    orderedLines: textBlocks.flatMap((block) => block.lines),
    blocks: textBlocks,
  }
}

/** 挑出包含新行的块文本，供区间累积文本块。 */
export function blocksWithNewLines(blocks: TextBlock[], newLines: string[]): string[] {
  const wanted = new Set(newLines)
  return blocks.filter((block) => block.lines.some((line) => wanted.has(line))).map((block) => block.text)
}
