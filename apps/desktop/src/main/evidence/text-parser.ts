export type EvidenceBlockKind = 'heading' | 'paragraph'

export interface ParsedEvidenceBlock {
  kind: EvidenceBlockKind
  ordinal: number
  parentOrdinal: number | null
  headingLevel: number | null
  headingPath: string[]
  startLine: number
  endLine: number
  startOffset: number
  endOffset: number
  text: string
}

interface TextLine {
  number: number
  startOffset: number
  endOffset: number
  text: string
}

interface HeadingContext {
  level: number
  title: string
  ordinal: number
}

const ATX_HEADING = /^ {0,3}(#{1,6})(?:[\t ]+|$)(.*)$/
const SETEXT_HEADING = /^ {0,3}(=+|-+)[\t ]*$/
const FENCE = /^ {0,3}(`{3,}|~{3,})/

function splitLines(text: string): TextLine[] {
  const lines: TextLine[] = []
  let lineStart = 0
  let lineNumber = 1

  while (lineStart < text.length) {
    let lineEnd = lineStart
    while (lineEnd < text.length && text[lineEnd] !== '\n' && text[lineEnd] !== '\r') {
      lineEnd += 1
    }
    lines.push({
      number: lineNumber,
      startOffset: lineStart,
      endOffset: lineEnd,
      text: text.slice(lineStart, lineEnd),
    })
    if (text[lineEnd] === '\r' && text[lineEnd + 1] === '\n') lineEnd += 2
    else if (lineEnd < text.length) lineEnd += 1
    lineStart = lineEnd
    lineNumber += 1
  }

  if (text.length === 0 || text.endsWith('\n') || text.endsWith('\r')) {
    lines.push({
      number: lineNumber,
      startOffset: text.length,
      endOffset: text.length,
      text: '',
    })
  }
  return lines
}

function paragraphBlock(
  paragraphLines: TextLine[],
  ordinal: number,
  headings: HeadingContext[],
): ParsedEvidenceBlock | null {
  const firstContent = paragraphLines.findIndex((line) => line.text.trim().length > 0)
  let lastContent = paragraphLines.length - 1
  while (lastContent >= 0 && paragraphLines[lastContent].text.trim().length === 0) {
    lastContent -= 1
  }
  if (firstContent < 0 || lastContent < firstContent) return null

  const selected = paragraphLines.slice(firstContent, lastContent + 1)
  const first = selected[0]
  const last = selected[selected.length - 1]
  return {
    kind: 'paragraph',
    ordinal,
    parentOrdinal: headings.at(-1)?.ordinal ?? null,
    headingLevel: null,
    headingPath: headings.map((heading) => heading.title),
    startLine: first.number,
    endLine: last.number,
    startOffset: first.startOffset,
    endOffset: last.endOffset,
    text: selected.map((line) => line.text).join('\n').trim(),
  }
}

function headingTitle(raw: string): string {
  return raw.replace(/[\t ]+#+[\t ]*$/, '').trim()
}

export function parseMarkdown(text: string): ParsedEvidenceBlock[] {
  const lines = splitLines(text)
  const blocks: ParsedEvidenceBlock[] = []
  const headings: HeadingContext[] = []
  let paragraphLines: TextLine[] = []
  let fenceMarker: string | null = null

  const flushParagraph = () => {
    const block = paragraphBlock(paragraphLines, blocks.length, headings)
    if (block) blocks.push(block)
    paragraphLines = []
  }

  const addHeading = (line: TextLine, level: number, title: string, endLine = line) => {
    flushParagraph()
    while (headings.length > 0 && headings[headings.length - 1].level >= level) headings.pop()
    const block: ParsedEvidenceBlock = {
      kind: 'heading',
      ordinal: blocks.length,
      parentOrdinal: headings.at(-1)?.ordinal ?? null,
      headingLevel: level,
      headingPath: [...headings.map((heading) => heading.title), title],
      startLine: line.number,
      endLine: endLine.number,
      startOffset: line.startOffset,
      endOffset: endLine.endOffset,
      text: title,
    }
    blocks.push(block)
    headings.push({ level, title, ordinal: block.ordinal })
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const fence = line.text.match(FENCE)
    if (fence) {
      const marker = fence[1][0]
      if (fenceMarker === marker) fenceMarker = null
      else if (!fenceMarker) fenceMarker = marker
      paragraphLines.push(line)
      continue
    }

    if (!fenceMarker) {
      const atx = line.text.match(ATX_HEADING)
      if (atx) {
        const title = headingTitle(atx[2])
        if (title) addHeading(line, atx[1].length, title)
        continue
      }

      const nextLine = lines[index + 1]
      const setext = nextLine?.text.match(SETEXT_HEADING)
      if (line.text.trim() && setext) {
        addHeading(line, setext[1][0] === '=' ? 1 : 2, line.text.trim(), nextLine)
        index += 1
        continue
      }

      if (!line.text.trim()) {
        flushParagraph()
        continue
      }
    }
    paragraphLines.push(line)
  }
  flushParagraph()
  return blocks
}

export function parsePlainText(text: string): ParsedEvidenceBlock[] {
  const blocks: ParsedEvidenceBlock[] = []
  let paragraphLines: TextLine[] = []

  const flushParagraph = () => {
    const block = paragraphBlock(paragraphLines, blocks.length, [])
    if (block) blocks.push(block)
    paragraphLines = []
  }

  for (const line of splitLines(text)) {
    if (!line.text.trim()) flushParagraph()
    else paragraphLines.push(line)
  }
  flushParagraph()
  return blocks
}
