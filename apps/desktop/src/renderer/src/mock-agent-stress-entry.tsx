// Browser stress harness for the agent chat view (temporary, like other mock-* entries).
// Replaces window.nxcore.agent with a scripted mock; drive with window.__driveStorm().
import { StrictMode, useMemo } from 'react'
import { createRoot } from 'react-dom/client'

import type { AgentEvent, AgentSession, AgentSessionSnapshot } from '@nxcore/agent-contract'
import { LocaleProvider } from './i18n/LocaleContext'
import { ContextRoomStateProvider } from './components/context-room/ContextRoomStateProvider'
import { RoomDocumentsProvider } from './components/context-room/RoomDocumentsProvider'
import { desktopOperationBridge, DocumentOperationProvider } from './components/context-room/operations'
import { AgentChatView } from './components/agent/AgentChatView'
import { useAgentSession } from './components/agent/useAgentSession'

import '@/styles/tokens.css'
import './styles.css'
import './components/agent/AgentChat.css'

const SESSION_ID = 'stress-session'
const HISTORY_RUNS = 24
const TOOL_RESULT_CHARS = 12_000
const STORM_TOOLS = 10
const STORM_TOOL_RESULT_CHARS = 15_000
const STORM_DELTA_MS = 20
const STORM_DELTA_BURST = 5
const STORM_DELTA_TOTAL = 1_500

function bigJson(seed: number, chars: number): string {
  const items: string[] = []
  let total = 2
  while (total < chars) {
    const text = `item ${seed}-${items.length}: ${'内容'.repeat(40)}`
    items.push(JSON.stringify({ id: `i-${seed}-${items.length}`, title: text, score: 0.5 }))
    total += text.length
  }
  return '{"results":[' + items.join(',') + ']}'
}

function markdownAnswer(index: number): string {
  const paras = Array.from({ length: 6 }, (_, i) => (
    `第 ${i + 1} 段：**要点 ${index}-${i}**，` + '这是用于压力测试的正文，包含标点；'.repeat(6)
  ))
  const list = Array.from({ length: 10 }, (_, i) => (
    `- 列表项 ${index}-${i}：` + '展开说明该要点。'.repeat(4) + '\n'
  )).join('')
  const table = [
    '| 项目 | 说明 | 状态 |',
    '| --- | --- | --- |',
    ...Array.from({ length: 8 }, (_, i) => `| 条目 ${i} | 说明文本 | 完成 |`),
  ].join('\n')
  return ['### 结论 ' + index, ...paras, list, table].join('\n\n')
}

// ---- mock window.nxcore.agent ----
type Frame = { type: 'ready'; sessionId: string; lastEventSeq: number } | { type: 'event'; event: AgentEvent }
type Listener = (frame: Frame) => void

const base = (window as unknown as { nxcore?: Record<string, unknown> }).nxcore ?? {}
const listeners = new Set<Listener>()
let seq = 1

function mkEvent(type: AgentEvent['type'], runId: string, payload: unknown): AgentEvent {
  seq += 1
  return {
    id: `stress-e${seq}`,
    sessionId: SESSION_ID,
    runId,
    seq,
    type,
    occurredAt: new Date().toISOString(),
    payload,
  }
}

const historyByRun = new Map<string, AgentEvent[]>()
const historyMessages: AgentSessionSnapshot['messages'] = []

for (let i = 0; i < HISTORY_RUNS; i += 1) {
  const runId = `hist-run-${i}`
  const prompt = `历史问题 ${i}：帮我梳理格式映射自愈部分。`
  const answer = markdownAnswer(i)
  const events: AgentEvent[] = [
    mkEvent('run.accepted', runId, { prompt }),
    mkEvent('run.started', runId, {}),
  ]
  for (let t = 0; t < 3; t += 1) {
    const toolCallId = `${runId}-tool-${t}`
    const name = t === 0 ? 'context_room_list' : 'web_search'
    events.push(
      mkEvent('tool.requested', runId, { toolCallId, name, args: { query: `要点 ${i}-${t}` } }),
      mkEvent('tool.started', runId, { toolCallId, name, args: { query: `要点 ${i}-${t}` } }),
      mkEvent('tool.completed', runId, { toolCallId, result: bigJson(i * 3 + t, TOOL_RESULT_CHARS) }),
    )
  }
  events.push(
    mkEvent('message.started', runId, {}),
    mkEvent('message.completed', runId, { content: answer }),
    mkEvent('run.completed', runId, {}),
  )
  historyByRun.set(runId, events)
  historyMessages.push(
    {
      id: `hist-user-${i}`,
      sessionId: SESSION_ID,
      runId,
      role: 'user' as const,
      authorAgentId: null,
      content: prompt,
      createdAt: new Date(Date.now() - (HISTORY_RUNS - i) * 60_000).toISOString(),
    },
    {
      id: `hist-asst-${i}`,
      sessionId: SESSION_ID,
      runId,
      role: 'assistant' as const,
      authorAgentId: null,
      content: answer,
      createdAt: new Date(Date.now() - (HISTORY_RUNS - i) * 60_000).toISOString(),
    },
  )
}

const nowIso = new Date().toISOString()
const stressSession: AgentSession = {
  id: SESSION_ID,
  roomId: null,
  pageLabel: 'Agent',
  runtimeId: 'stress-runtime',
  title: '压力复现',
  status: 'idle',
  createdAt: nowIso,
  updatedAt: nowIso,
  activeAgentId: 'main',
}

const snapshot: AgentSessionSnapshot = {
  session: stressSession,
  participants: [],
  activeRun: null,
  messages: historyMessages,
  lastEventSeq: seq,
}

const stressAgent = {
  listSessions: async () => [stressSession],
  createSession: async () => stressSession,
  getSession: async () => snapshot,
  getEvents: async (_sid: string, runId: string, _after: number) => historyByRun.get(runId) ?? [],
  listSessionLinks: async () => [],
  subscribe: async () => ({}),
  unsubscribe: async () => ({}),
  onEvent: (listener: Listener) => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  },
  startRun: async () => { throw new Error('use window.__driveStorm() in stress harness') },
  cancelRun: async () => ({}),
  resolveApproval: async () => ({}),
  getPermissionMode: async () => 'default',
  setPermissionMode: async () => ({}),
}

const baseContextRooms = (base.contextRooms ?? {}) as Record<string, unknown>
window.nxcore = {
  ...base,
  agent: stressAgent,
  contextRooms: {
    ...baseContextRooms,
    listRunSubagentInvocations: async () => [],
    listSubagentInvocationEvents: async () => [],
  },
} as unknown as typeof window.nxcore

// ---- storm driver ----
declare global {
  interface Window {
    __driveStorm: () => void
    __driveStormFast: () => void
    __stormDone: boolean
  }
}

let stormSeqBase = 1_000_000
window.__driveStorm = () => driveStorm(false)

window.__driveStormFast = () => driveStorm(true)

function driveStorm(fast: boolean) {
  window.__stormDone = false
  const runId = fast ? 'stress-fast-run' : 'stress-live-run'
  const emit = (type: AgentEvent['type'], payload: unknown) => {
    stormSeqBase += 1
    const event: AgentEvent = {
      id: `storm-${stormSeqBase}`,
      sessionId: SESSION_ID,
      runId,
      seq: stormSeqBase,
      type,
      occurredAt: new Date().toISOString(),
      payload,
    }
    for (const listener of listeners) listener({ type: 'event', event })
  }

  emit('run.accepted', { prompt: '压力测试：查邮件并汇总要点，多调用一些工具。' })
  emit('run.started', {})
  const names = ['context_room_list', 'context_room_document_read', 'web_search']
  for (let t = 0; t < STORM_TOOLS; t += 1) {
    const toolCallId = `${runId}-t${t}`
    const name = names[t % names.length]
    emit('tool.requested', { toolCallId, name, args: { query: `压力查询 ${t}` } })
    emit('tool.started', { toolCallId, name, args: { query: `压力查询 ${t}` } })
    if (fast) {
      emit('tool.completed', { toolCallId, result: bigJson(5000 + t, STORM_TOOL_RESULT_CHARS) })
    } else {
      window.setTimeout(() => emit('tool.completed', { toolCallId, result: bigJson(5000 + t, STORM_TOOL_RESULT_CHARS) }), 200 * (t + 1))
    }
  }
  const startStreaming = () => {
    emit('message.started', {})
    const answer = markdownAnswer(99)
    // ~19KB 的长回答（贴近真实「多工具长回答」场景），12 字一片按 20ms/5 片推送
    const full = Array.from({ length: 5 }, () => answer + '\n\n').join('')
    const chunkSize = 12
    let sent = 0
    const totalChunks = Math.ceil(full.length / chunkSize)
    const step = () => {
      // 快进模式分 20 拍打完（隐藏标签页定时器被节流到 1s/拍，仍可在 20s 内测完）
      const burst = fast ? Math.max(1, Math.ceil(totalChunks / 20)) : STORM_DELTA_BURST
      for (let b = 0; b < burst; b += 1) {
        const piece = full.slice(sent * chunkSize, (sent + 1) * chunkSize)
        if (!piece) break
        emit('message.delta', { delta: piece })
        sent += 1
      }
      if (sent < totalChunks) {
        window.setTimeout(step, STORM_DELTA_MS)
      } else {
        emit('message.completed', { content: full })
        emit('run.completed', {})
        window.__stormDone = true
      }
    }
    step()
  }
  if (fast) startStreaming()
  else window.setTimeout(startStreaming, 2_500)
}

// ---- harness UI ----
function StressHarness() {
  const operationBridge = useMemo(() => desktopOperationBridge(), [])
  const s = useAgentSession('Agent', null, [])
  return (
    <DocumentOperationProvider operationBridge={operationBridge} onDocumentApplied={() => {}}>
    <AgentChatView
      activeDocument={null}
      activeRunId={s.activeRunId}
      agentIdByRun={s.agentIdByRun}
      agentNamesById={{}}
      activityByRun={s.activityByRun}
      availableRooms={[{ id: 'room-1', title: '产品调研' }]}
      composer={null}
      currentSessionId={s.sessionId}
      draftHasContent={false}
      error={s.error}
      loading={s.loading}
      messages={s.messages}
      pendingApprovals={s.pendingApprovals}
      onRejectDocumentIntent={() => {}}
      onRetryPrompt={() => {}}
      onOpenSessionLink={() => {}}
      onResolveApproval={() => {}}
      onSelectDocument={() => {}}
      onSelectPrompt={() => {}}
      onSelectRoom={async () => {}}
      pendingNavigationByRun={{}}
      reasoningByRun={s.reasoningByRun}
      runCompletedAtByRun={s.runCompletedAtByRun}
      runStartedAtByRun={s.runStartedAtByRun}
      resolvingApprovalIds={s.resolvingApprovalIds}
      scopeReady={s.scopeReady}
      sessionLinks={[]}
      submitting={false}
      toolCallsByRun={s.toolCallsByRun}
    />
    </DocumentOperationProvider>
  )
}

createRoot(document.getElementById('mock-root')!).render(
  <StrictMode>
    <LocaleProvider>
      <ContextRoomStateProvider>
        <RoomDocumentsProvider>
          <StressHarness />
        </RoomDocumentsProvider>
      </ContextRoomStateProvider>
    </LocaleProvider>
  </StrictMode>,
)
