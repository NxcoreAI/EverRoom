export type DocumentCursorCompletionTrigger =
  | 'composition'
  | 'continued-typing'
  | 'cursor-move'
  | 'deletion'
  | 'middle-edit'
  | 'typing'

export interface DocumentCursorCompletionDiagnosticEntry {
  sequence: number
  time: string
  level: 'info' | 'warn' | 'error'
  event: string
  [key: string]: unknown
}

const HISTORY_LIMIT = 250
const diagnosticsGlobal = globalThis as typeof globalThis & {
  __nxcoreDocumentCursorCompletionHistory?: DocumentCursorCompletionDiagnosticEntry[]
  __nxcoreDocumentCursorCompletionSequence?: number
}

const history = diagnosticsGlobal.__nxcoreDocumentCursorCompletionHistory ?? []
diagnosticsGlobal.__nxcoreDocumentCursorCompletionHistory = history

export function documentCursorCompletionSnippet(value: string, limit = 120): string {
  const normalized = value.replace(/\s+/gu, ' ').trim()
  const characters = Array.from(normalized)
  return characters.length <= limit
    ? normalized
    : `${characters.slice(0, limit).join('')}...`
}

export function nextDocumentCursorCompletionRequestId(): string {
  const sequence = (diagnosticsGlobal.__nxcoreDocumentCursorCompletionSequence ?? 0) + 1
  diagnosticsGlobal.__nxcoreDocumentCursorCompletionSequence = sequence
  return `cursor-completion-${Date.now().toString(36)}-${sequence.toString(36)}`
}

export function recordDocumentCursorCompletionDiagnostic(
  event: string,
  detail: Record<string, unknown> = {},
  level: DocumentCursorCompletionDiagnosticEntry['level'] = 'info',
): DocumentCursorCompletionDiagnosticEntry {
  const sequence = (history.at(-1)?.sequence ?? 0) + 1
  const entry: DocumentCursorCompletionDiagnosticEntry = {
    ...detail,
    sequence,
    time: new Date().toISOString(),
    level,
    event,
  }
  history.push(entry)
  if (history.length > HISTORY_LIMIT) history.splice(0, history.length - HISTORY_LIMIT)
  if (typeof window !== 'undefined') {
    try {
      window.nxcore?.diagnostics?.log({
        module: 'document-cursor-completion',
        level,
        event: entry,
      })
    } catch {
      // Diagnostics must never interrupt editor input or completion handling.
    }
  }
  return entry
}

export function readDocumentCursorCompletionDiagnostics(): DocumentCursorCompletionDiagnosticEntry[] {
  return history.map((entry) => ({ ...entry }))
}

export function clearDocumentCursorCompletionDiagnostics(): void {
  history.splice(0)
}
