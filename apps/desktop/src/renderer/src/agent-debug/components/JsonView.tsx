import { memo, useMemo, type ReactNode } from 'react'

/** JSON 文本：单色，仅 key 使用 muted；超过 240KB 截断展示。 */
const MAX_CHARS = 240_000

function stringify(value: unknown): { text: string; truncated: boolean } {
  let text: string
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    text = String(value)
  }
  if (text.length > MAX_CHARS) return { text: text.slice(0, MAX_CHARS), truncated: true }
  return { text, truncated: false }
}

const KEY_PATTERN = /("(?:\\.|[^"\\])*")(\s*:)/g

function renderMonochrome(text: string): ReactNode[] {
  const nodes: ReactNode[] = []
  let cursor = 0
  let key = 0
  KEY_PATTERN.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = KEY_PATTERN.exec(text)) !== null) {
    if (match.index > cursor) nodes.push(text.slice(cursor, match.index))
    nodes.push(<span key={key++} className="json-key">{match[1]}</span>, match[2])
    cursor = KEY_PATTERN.lastIndex
  }
  if (cursor < text.length) nodes.push(text.slice(cursor))
  return nodes
}

export const JsonView = memo(function JsonView({ value, emptyText = '（空）' }: {
  value: unknown
  emptyText?: string
}) {
  const { text, truncated } = useMemo(() => stringify(value), [value])
  const nodes = useMemo(() => renderMonochrome(text), [text])
  if (!text) return <span className="tl-empty">{emptyText}</span>
  return (
    <pre className="json-pre">
      {nodes}
      {truncated ? '\n…（已截断）' : null}
    </pre>
  )
})
