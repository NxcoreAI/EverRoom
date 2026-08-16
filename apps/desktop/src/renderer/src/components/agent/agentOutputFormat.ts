export type AgentOutputBlock =
  | { type: 'paragraph'; text: string }
  | { type: 'list'; ordered: boolean; items: string[] }

function cleanInlineFormatting(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\*\*|__|~~|`+/g, '')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/_([^_\n]+)_/g, '$1')
    .trim()
}

export function formatAgentOutput(content: string): AgentOutputBlock[] {
  const blocks: AgentOutputBlock[] = []
  let paragraph: string[] = []
  let list: Extract<AgentOutputBlock, { type: 'list' }> | null = null

  const flushParagraph = () => {
    const text = cleanInlineFormatting(paragraph.join('\n'))
    if (text) blocks.push({ type: 'paragraph', text })
    paragraph = []
  }
  const flushList = () => {
    if (list?.items.length) blocks.push(list)
    list = null
  }

  for (const rawLine of content.replace(/\r\n?/g, '\n').split('\n')) {
    if (/^\s*(?:```|~~~)/.test(rawLine) || /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(rawLine)) {
      continue
    }

    const line = rawLine.replace(/^\s{0,3}#{1,6}\s+/, '').replace(/^\s{0,3}>\s?/, '')
    const unordered = /^\s*[-+*\u2022\u00b7]\s+(.+)$/.exec(line)
    const ordered = /^\s*(?:\d{1,3}[.)]\s+|\d{1,3}\u3001\s*)(.+)$/.exec(line)
    const item = unordered?.[1] ?? ordered?.[1]

    if (item !== undefined) {
      flushParagraph()
      const isOrdered = ordered !== null
      if (!list || list.ordered !== isOrdered) {
        flushList()
        list = { type: 'list', ordered: isOrdered, items: [] }
      }
      const text = cleanInlineFormatting(item)
      if (text) list.items.push(text)
      continue
    }

    if (!line.trim()) {
      flushParagraph()
      flushList()
      continue
    }

    flushList()
    paragraph.push(line)
  }

  flushParagraph()
  flushList()
  return blocks
}
