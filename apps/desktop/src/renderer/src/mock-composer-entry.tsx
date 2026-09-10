// 临时入口:纯浏览器单独挂载 AgentComposer(配合 /@mock/nxcore.js),验证 @本机 agent 点名交互(验证后删除)。
import { useState } from 'react'
import { createRoot } from 'react-dom/client'

import { LocaleProvider } from './i18n/LocaleContext'
import { AgentComposer } from './components/agent/AgentComposer'
import type { LocalAgentInstallation } from '@nxcore/agent-contract'
import '@/styles/tokens.css'
import './styles.css'
import './components/agent/AgentChat.css'

const localAgents: LocalAgentInstallation[] = [
  {
    id: 'codex:/usr/local/bin/codex',
    provider: 'codex',
    displayName: 'Codex',
    executablePath: '/usr/local/bin/codex',
    version: '0.2.0',
    status: 'verified',
    callable: true,
    invocationSupported: true,
    historyAvailable: true,
    historyPaths: ['~/.codex'],
    card: {
      name: 'Codex',
      description: 'OpenAI Codex CLI',
      version: '1.0.0',
      supportedInterfaces: [],
      capabilities: { streaming: true },
      defaultInputModes: ['text/plain'],
      defaultOutputModes: ['text/plain'],
      skills: [],
    },
    lastSeenAt: '2026-09-09T00:00:00.000Z',
  },
  {
    id: 'claude:/usr/local/bin/claude',
    provider: 'claude',
    displayName: 'Claude Code',
    executablePath: '/usr/local/bin/claude',
    version: '1.0.60',
    status: 'verified',
    callable: true,
    invocationSupported: true,
    historyAvailable: true,
    historyPaths: ['~/.claude'],
    card: {
      name: 'Claude Code',
      description: 'Anthropic Claude Code CLI',
      version: '1.0.0',
      supportedInterfaces: [],
      capabilities: { streaming: true },
      defaultInputModes: ['text/plain'],
      defaultOutputModes: ['text/plain'],
      skills: [],
    },
    lastSeenAt: '2026-09-09T00:00:00.000Z',
  },
  {
    id: 'openclaw:/opt/homebrew/bin/openclaw',
    provider: 'openclaw',
    displayName: 'OpenClaw',
    executablePath: '/opt/homebrew/bin/openclaw',
    version: null,
    status: 'verified',
    callable: true,
    invocationSupported: true,
    historyAvailable: false,
    historyPaths: [],
    card: {
      name: 'OpenClaw',
      description: 'OpenClaw CLI',
      version: '1.0.0',
      supportedInterfaces: [],
      capabilities: { streaming: true },
      defaultInputModes: ['text/plain'],
      defaultOutputModes: ['text/plain'],
      skills: [],
    },
    lastSeenAt: '2026-09-09T00:00:00.000Z',
  },
]

function ComposerHarness() {
  const [value, setValue] = useState('')
  const [log, setLog] = useState<string[]>([])
  return (
    <div style={{ width: 460, margin: '40px auto', padding: 16, border: '1px solid #ddd', borderRadius: 12 }}>
      <AgentComposer
        contextSummary="首页 · 未选择文本"
        contextItems={[]}
        hasSelectedText={false}
        resetKey={0}
        value={value}
        active={false}
        available
        loading={false}
        selectedExternalConversation={null}
        localAgents={localAgents}
        onChange={setValue}
        onSelectExternalConversation={() => setLog((current) => [...current, 'select conversation'])}
        onClearContext={() => {}}
        onRemoveContext={() => {}}
        onStop={() => {}}
        onSubmit={(_files, mentionedAgents) => setLog((current) => [
          ...current,
          `submit: "${value}" agents=${mentionedAgents.map((agent) => agent.id).join(',') || 'none'}`,
        ])}
      />
      <ul id="mock-log" style={{ marginTop: 12, fontSize: 12, color: '#666' }}>
        {log.map((entry, index) => <li key={index}>{entry}</li>)}
      </ul>
    </div>
  )
}

createRoot(document.getElementById('mock-root')!).render(
  <LocaleProvider>
    <ComposerHarness />
  </LocaleProvider>,
)
