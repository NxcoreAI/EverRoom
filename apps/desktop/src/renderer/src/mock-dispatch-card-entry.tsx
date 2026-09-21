// 临时入口：纯浏览器验证 local_agent_dispatch 任务卡中英文渲染与「查看全文」（验证后删除）。
import { useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { AgentEvent } from '@nxcore/agent-contract'

import { AgentExecutionTimeline } from './components/agent/AgentExecutionTimeline'
import { reduceAgentRunActivity } from './components/agent/agentRunActivity'
import { LocaleProvider, useLocale } from './i18n/LocaleContext'
import '@/styles/tokens.css'
import './styles.css'

const runId = 'run-mock'
const sessionId = 'session-mock'

const details = {
  agentId: 'codex:/usr/local/bin/codex',
  provider: 'codex',
  displayName: 'Codex',
  taskId: 'dispatch-1',
  runId: 'sub-run-1',
  assignment: '评审该实现的风险点，输出结论与依据。',
  sharedGoal: '完成技术评审与说明改写',
  constraints: ['只关注正确性与安全', '结论需给出证据位置'],
  materials: [
    { id: 'transcript', kind: 'transcript', title: '最近对话', chars: 320, truncated: false, agentOutput: false, sourceDispatchId: null },
    { id: 'selection', kind: 'selection', title: '选区（Home）', chars: 1_540, truncated: false, agentOutput: false, sourceDispatchId: null },
    { id: 'attachment:spec.md', kind: 'attachment', title: 'spec.md', chars: 4_120, truncated: true, agentOutput: false, sourceDispatchId: null },
    { id: 'note:0', kind: 'note', title: '方案要点', chars: 680, truncated: false, agentOutput: false, sourceDispatchId: null },
  ],
  priorOutputs: [],
  packageVersion: 1,
  packageDigest: 'a'.repeat(64),
  durationMs: 95_000,
  status: 'completed',
  resultPreview: '评审结论：整体风险可控。鉴权中间件的会话令牌存储需要按新合规要求调整，详见第 3 节；其余模块未见阻断性问题。',
}

const followUpDetails = {
  agentId: 'claude:/usr/local/bin/claude',
  provider: 'claude',
  displayName: 'Claude Code',
  taskId: 'dispatch-2',
  runId: 'sub-run-2',
  assignment: '依据评审意见改写实现说明。',
  sharedGoal: '完成技术评审与说明改写',
  constraints: [],
  materials: [
    { id: 'transcript', kind: 'transcript', title: '最近对话', chars: 520, truncated: false, agentOutput: false, sourceDispatchId: null },
    { id: 'agent_output:dispatch-1', kind: 'agent_output', title: 'Codex 的任务产出', chars: 2_300, truncated: false, agentOutput: true, sourceDispatchId: 'dispatch-1' },
  ],
  priorOutputs: [{ taskId: 'dispatch-1', displayName: 'Codex', chars: 2_300 }],
  packageVersion: 2,
  packageDigest: 'b'.repeat(64),
  durationMs: 30_000,
  status: 'completed',
  resultPreview: '已按评审意见改写第 3 节，补充合规说明与迁移步骤，全文见下。',
}

const events: AgentEvent[] = [
  { id: 'e1', sessionId, runId, seq: 1, type: 'run.started', occurredAt: '2026-09-20T10:00:00.000Z', payload: {} },
  {
    id: 'e2', sessionId, runId, seq: 2, type: 'tool.requested', occurredAt: '2026-09-20T10:00:01.000Z',
    payload: {
      toolCallId: 'call-1', name: 'local_agent_dispatch',
      args: { agentId: 'codex:/usr/local/bin/codex', assignment: '评审该实现的风险点，输出结论与依据。' },
    },
  },
  { id: 'e3', sessionId, runId, seq: 3, type: 'tool.started', occurredAt: '2026-09-20T10:00:02.000Z', payload: { toolCallId: 'call-1' } },
  {
    id: 'e4', sessionId, runId, seq: 4, type: 'tool.completed', occurredAt: '2026-09-20T10:01:37.000Z',
    payload: { toolCallId: 'call-1', result: { content: '评审结论：风险可控。\n\n[local_agent_dispatch_task_id:dispatch-1]', details } },
  },
  {
    id: 'e5', sessionId, runId, seq: 5, type: 'tool.requested', occurredAt: '2026-09-20T10:01:38.000Z',
    payload: {
      toolCallId: 'call-2', name: 'local_agent_dispatch',
      args: { agentId: 'claude:/usr/local/bin/claude', assignment: '依据评审意见改写实现说明。', priorTaskOutputs: [{ taskId: 'dispatch-1', usage: '作为改写依据' }] },
    },
  },
  { id: 'e6', sessionId, runId, seq: 6, type: 'tool.started', occurredAt: '2026-09-20T10:01:39.000Z', payload: { toolCallId: 'call-2' } },
  {
    id: 'e7', sessionId, runId, seq: 7, type: 'tool.completed', occurredAt: '2026-09-20T10:02:09.000Z',
    payload: { toolCallId: 'call-2', result: { content: '已改写完成。\n\n[local_agent_dispatch_task_id:dispatch-2]', details: followUpDetails } },
  },
  {
    id: 'e8', sessionId, runId, seq: 8, type: 'tool.requested', occurredAt: '2026-09-20T10:02:10.000Z',
    payload: {
      toolCallId: 'call-3', name: 'local_agent_dispatch',
      args: { agentId: 'openclaw:/usr/local/bin/openclaw', assignment: '核对迁移步骤与本机脚本一致性。' },
    },
  },
  { id: 'e9', sessionId, runId, seq: 9, type: 'tool.started', occurredAt: '2026-09-20T10:02:11.000Z', payload: { toolCallId: 'call-3' } },
]

const fullTexts: Record<string, string> = {
  'dispatch-1': [
    '评审结论：整体风险可控。',
    '',
    '一、鉴权中间件：会话令牌落盘方式与新合规要求不符（第 3 节），建议改为 local-secret-cipher 静态加密后存储，迁移需保留旧格式读取兼容一个版本。',
    '二、网关响应 schema：新增字段必须同步 TypeBox 响应声明，否则 HTTP 层静默剥字段（已有先例），本次新端点已逐字段写全。',
    '三、并发分发上限 3 对本机资源占用可控；超时 10 分钟覆盖绝大多数 CLI 子任务。',
  ].join('\n'),
  'dispatch-2': '改写后的实现说明全文（mock）……',
}

;(window as { nxcore?: unknown }).nxcore = {
  locale: { system: 'zh-CN', set: () => undefined, getSystem: async () => 'zh-CN' },
  agent: {
    getLocalAgentDispatch: async (_sessionId: string, taskId: string) => ({
      id: taskId,
      sessionId: _sessionId,
      resultText: fullTexts[taskId] ?? null,
    }),
  },
}

function Stage() {
  const { locale, setLocale } = useLocale()
  const activity = useMemo(() => reduceAgentRunActivity(events), [])
  const [showThird, setShowThird] = useState(true)
  return (
    <div style={{ width: 760, margin: '32px auto', background: '#fff', padding: 20 }}>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <button type="button" onClick={() => setLocale('zh-CN')}>中文</button>
        <button type="button" onClick={() => setLocale('en-US')}>English</button>
        <button type="button" onClick={() => setShowThird((value) => !value)}>
          {locale === 'zh-CN' ? '切换进行中步骤' : 'Toggle running step'}
        </button>
      </div>
      <AgentExecutionTimeline
        activity={showThird ? activity : { ...activity, steps: activity.steps.slice(0, 2) }}
        runStartedAt="2026-09-20T10:00:00.000Z"
        runCompletedAt={showThird ? undefined : '2026-09-20T10:02:09.000Z'}
        sessionId={sessionId}
      />
    </div>
  )
}

createRoot(document.getElementById('mock-root')!).render(
  <LocaleProvider>
    <Stage />
  </LocaleProvider>,
)
