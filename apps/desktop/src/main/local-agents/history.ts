import { readFile, readdir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type {
  LocalAgentHistoryConversation,
  LocalAgentInstallation,
  LocalAgentProvider,
} from '../../shared/local-agents'

const NATIVE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u

const INJECTED_CONTEXT = /^\s*<(?:environment_context|recommended_plugins|app-context|permissions instructions|command-name|command-message|local-command-caveat|ide_opened_file)>/u

function codexContentText(value: unknown, expectedType: 'input_text' | 'output_text'): string {
  if (!Array.isArray(value)) return ''
  return value
    .filter((item): item is { type: string; text: string } => Boolean(
      item && typeof item === 'object'
      && (item as { type?: unknown }).type === expectedType
      && typeof (item as { text?: unknown }).text === 'string',
    ))
    .map((item) => item.text)
    .filter((text) => !INJECTED_CONTEXT.test(text))
    .join('\n')
    .trim()
}

export function parseCodexHistoryJsonl(text: string): LocalAgentHistoryConversation | null {
  let sessionId = ''
  let title = ''
  const messages: LocalAgentHistoryConversation['messages'] = []
  for (const line of text.split(/\r?\n/u)) {
    if (!line.trim()) continue
    let event: { timestamp?: unknown; type?: unknown; payload?: unknown }
    try {
      event = JSON.parse(line) as typeof event
    } catch {
      continue
    }
    if (!event.payload || typeof event.payload !== 'object') continue
    const payload = event.payload as Record<string, unknown>
    if (event.type === 'session_meta') {
      sessionId = typeof payload.session_id === 'string' ? payload.session_id : sessionId
      continue
    }
    if (event.type !== 'response_item' || payload.type !== 'message') continue
    const role = payload.role
    if (role !== 'user' && role !== 'assistant') continue
    if (role === 'assistant' && payload.phase !== undefined && payload.phase !== 'final_answer') continue
    const content = codexContentText(payload.content, role === 'user' ? 'input_text' : 'output_text')
    if (!content) continue
    const timestamp = typeof event.timestamp === 'string' && !Number.isNaN(Date.parse(event.timestamp))
      ? new Date(event.timestamp).toISOString()
      : new Date(0).toISOString()
    messages.push({ role, content, timestamp })
    if (!title && role === 'user') title = content.replace(/\s+/gu, ' ').slice(0, 120)
  }
  if (!NATIVE_SESSION_ID.test(sessionId) || messages.length === 0) return null
  return { sessionId, title: title || 'Codex conversation', messages }
}

function claudeContentText(value: unknown): string {
  if (typeof value === 'string') return INJECTED_CONTEXT.test(value) ? '' : value.trim()
  if (!Array.isArray(value)) return ''
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const block = item as { type?: unknown; text?: unknown }
    return block.type === 'text' && typeof block.text === 'string' && !INJECTED_CONTEXT.test(block.text)
      ? [block.text]
      : []
  }).join('\n').trim()
}

export function parseClaudeHistoryJsonl(text: string): LocalAgentHistoryConversation | null {
  let sessionId = ''
  let summary = ''
  let title = ''
  const messages: LocalAgentHistoryConversation['messages'] = []
  for (const line of text.split(/\r?\n/u)) {
    if (!line.trim()) continue
    let event: Record<string, unknown>
    try {
      event = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    if (typeof event.sessionId === 'string') sessionId = event.sessionId
    if (event.type === 'summary' && typeof event.summary === 'string') {
      summary = event.summary.replace(/\s+/gu, ' ').trim().slice(0, 120)
      continue
    }
    if ((event.type !== 'user' && event.type !== 'assistant') || event.isSidechain === true) continue
    const message = event.message && typeof event.message === 'object'
      ? event.message as Record<string, unknown>
      : null
    if (!message) continue
    const role = event.type
    const content = claudeContentText(message.content)
    if (!content) continue
    const timestamp = typeof event.timestamp === 'string' && !Number.isNaN(Date.parse(event.timestamp))
      ? new Date(event.timestamp).toISOString()
      : new Date(0).toISOString()
    messages.push({ role, content, timestamp })
    if (!title && role === 'user') title = content.replace(/\s+/gu, ' ').slice(0, 120)
  }
  if (!NATIVE_SESSION_ID.test(sessionId) || messages.length === 0) return null
  return { sessionId, title: summary || title || 'Claude Code conversation', messages }
}

async function jsonlFiles(root: string, provider: LocalAgentProvider): Promise<string[]> {
  const roots = provider === 'codex'
    ? [join(root, 'sessions'), join(root, 'archived_sessions')]
    : provider === 'claude' ? [join(root, 'projects')] : []
  const files: Array<{ path: string; modifiedAt: number }> = []
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > 6) return
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      return
    }
    await Promise.all(entries.map(async (entry) => {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) return visit(path, depth + 1)
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) return
      const info = await stat(path).catch(() => null)
      if (info) files.push({ path, modifiedAt: info.mtimeMs })
    }))
  }
  for (const directory of roots) await visit(directory, 0)
  return files.sort((a, b) => b.modifiedAt - a.modifiedAt).map((file) => file.path)
}

export async function* streamLocalAgentHistory(agent: Pick<LocalAgentInstallation, 'provider' | 'historyPaths'>): AsyncGenerator<{ kind: 'conversation'; conversation: LocalAgentHistoryConversation } | { kind: 'skipped' }, void, void> {
  if (agent.provider !== 'codex' && agent.provider !== 'claude') {
    throw new Error('local_agent_history_adapter_unavailable')
  }
  const directoryName = agent.provider === 'codex' ? '.codex' : '.claude'
  const roots = agent.historyPaths.filter((path) => basename(path) === directoryName)
  const paths = [...new Set((await Promise.all(roots.map((root) => jsonlFiles(root, agent.provider)))).flat())]
  for (const path of paths) {
    const text = await readFile(path, 'utf8').catch(() => null)
    const conversation = text
      ? agent.provider === 'codex' ? parseCodexHistoryJsonl(text) : parseClaudeHistoryJsonl(text)
      : null
    if (conversation) yield { kind: 'conversation', conversation }
    else yield { kind: 'skipped' }
  }
}
