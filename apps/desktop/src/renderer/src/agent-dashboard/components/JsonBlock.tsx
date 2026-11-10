/** JSON / 文本查看器：带 token 着色 + 折叠长文本，下钻抽屉与工具面板共用。 */
import { memo, useMemo, useState } from 'react'

import './json-block.css'

const MAX_CHARS = 120_000

type TokenKind = 'key' | 'string' | 'number' | 'literal' | 'punct' | 'plain'

interface Token {
  kind: TokenKind
  text: string
}

const TOKEN_PATTERN = /("(?:\\.|[^"\\])*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b|([{}[\],:])/g

function tokenize(text: string): Token[] {
  const tokens: Token[] = []
  let cursor = 0
  TOKEN_PATTERN.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = TOKEN_PATTERN.exec(text)) !== null) {
    if (match.index > cursor) tokens.push({ kind: 'plain', text: text.slice(cursor, match.index) })
    if (match[1] !== undefined) {
      tokens.push({ kind: match[2] ? 'key' : 'string', text: match[1] })
      if (match[2]) tokens.push({ kind: 'punct', text: match[2] })
    } else if (match[3] !== undefined) {
      tokens.push({ kind: 'number', text: match[3] })
    } else if (match[4] !== undefined) {
      tokens.push({ kind: 'literal', text: match[4] })
    } else if (match[5] !== undefined) {
      tokens.push({ kind: 'punct', text: match[5] })
    }
    cursor = TOKEN_PATTERN.lastIndex
  }
  if (cursor < text.length) tokens.push({ kind: 'plain', text: text.slice(cursor) })
  return tokens
}

function stringify(value: unknown): { text: string; truncated: boolean; isJson: boolean } {
  if (value === null || value === undefined) return { text: '', truncated: false, isJson: false }
  if (typeof value === 'string') {
    // 形如 JSON 的字符串（工具参数常被二次序列化）先尝试展开，展开失败原样展示。
    const trimmed = value.trim()
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const parsed: unknown = JSON.parse(trimmed)
        const pretty = JSON.stringify(parsed, null, 2)
        return clip(pretty, true)
      } catch {
        return clip(value, false)
      }
    }
    return clip(value, false)
  }
  try {
    const pretty = JSON.stringify(value, null, 2)
    return clip(pretty ?? String(value), true)
  } catch {
    return clip(String(value), false)
  }
}

function clip(text: string, isJson: boolean): { text: string; truncated: boolean; isJson: boolean } {
  if (text.length <= MAX_CHARS) return { text, truncated: false, isJson }
  return { text: text.slice(0, MAX_CHARS), truncated: true, isJson }
}

export const JsonBlock = memo(function JsonBlock({
  value,
  emptyText = '（无内容）',
  maxHeight = 260,
  wrap = false,
}: {
  value: unknown
  emptyText?: string
  maxHeight?: number
  wrap?: boolean
}) {
  const [expanded, setExpanded] = useState(false)
  const { text, truncated, isJson } = useMemo(() => stringify(value), [value])
  const tokens = useMemo(() => (isJson ? tokenize(text) : []), [text, isJson])

  if (!text) return <div className="json-empty">{emptyText}</div>
  const long = text.length > 2_400
  const shown = long && !expanded ? `${text.slice(0, 2_400)}\n…` : text

  return (
    <div className="json-block">
      <pre
        className={wrap ? 'json-pre json-pre-wrap' : 'json-pre'}
        style={{ maxHeight: expanded ? Math.max(maxHeight * 3, 640) : maxHeight }}
      >
        {isJson && !long
          ? tokens.map((token, index) => (
              <span key={index} className={`json-tok json-tok-${token.kind}`}>{token.text}</span>
            ))
          : shown}
      </pre>
      {(truncated || long) && (
        <div className="json-foot">
          <span className="json-note">
            {truncated ? `内容超过 ${Math.round(MAX_CHARS / 1000)}k 字符，已截断` : `共 ${text.length.toLocaleString()} 字符`}
          </span>
          {long && (
            <button type="button" className="json-toggle" onClick={() => setExpanded((value) => !value)}>
              {expanded ? '收起' : '展开全文'}
            </button>
          )}
        </div>
      )}
    </div>
  )
})
