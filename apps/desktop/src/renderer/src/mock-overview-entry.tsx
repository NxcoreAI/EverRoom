// 临时入口：纯浏览器挂载 DocumentOverviewCard 各状态，验证无标签无图标的极简样式（验证后删除）。
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { DocumentOverviewView } from '@nxcore/agent-contract'

import { DocumentOverviewCard } from './components/context-room/ported/components/detail-editor/DocumentOverviewCard'
import type { DocumentOverviewStatus } from './components/context-room/ported/components/detail-editor/useDocumentOverview'
import { LocaleProvider } from './i18n/LocaleContext'
import '@/styles/tokens.css'
import './styles.css'

const view: DocumentOverviewView = {
  documentId: 'd1',
  topic: '项目架构演进方案',
  points: ['模块分层重构完成', '网关进程拆分上线', '渲染层与主进程通信统一走桥接'],
  conclusion: '架构已趋于稳定，下一步聚焦性能。',
  generatedAtVersion: 3,
  generatedAt: '2026-09-19T10:00:00.000Z',
  eligible: true,
  reason: 'ok',
  aiAvailable: true,
}

function CardFrame({ label, status }: { label: string; status: DocumentOverviewStatus }) {
  const [expanded, setExpanded] = useState(status.state === 'ready' ? false : false)
  return (
    <div style={{ marginBottom: 28 }}>
      <div style={{ fontSize: 12, color: '#888', marginBottom: 6 }}>{label}</div>
      <DocumentOverviewCard
        status={status}
        expanded={expanded}
        onToggleExpanded={() => setExpanded((v) => !v)}
        onRegenerate={() => undefined}
        regenerateDisabled={false}
      />
    </div>
  )
}

function ExpandedCardFrame({ label, status }: { label: string; status: DocumentOverviewStatus }) {
  const [expanded, setExpanded] = useState(true)
  return (
    <div style={{ marginBottom: 28 }}>
      <div style={{ fontSize: 12, color: '#888', marginBottom: 6 }}>{label}</div>
      <DocumentOverviewCard
        status={status}
        expanded={expanded}
        onToggleExpanded={() => setExpanded((v) => !v)}
        onRegenerate={() => undefined}
        regenerateDisabled={false}
      />
    </div>
  )
}

createRoot(document.getElementById('mock-root')!).render(
  <LocaleProvider>
    <div style={{ width: 780, margin: '40px auto', containerType: 'inline-size', background: '#fff', padding: '20px 0' }}>
      <CardFrame label="ready 收起" status={{ state: 'ready', view }} />
      <ExpandedCardFrame label="ready 展开" status={{ state: 'ready', view }} />
      <CardFrame label="stale 收起" status={{ state: 'stale', view }} />
      <CardFrame label="generating" status={{ state: 'generating', view: null }} />
      <CardFrame label="failed(error)" status={{ state: 'failed', kind: 'error' }} />
      <CardFrame label="too_short" status={{ state: 'ineligible', reason: 'too_short' }} />
    </div>
  </LocaleProvider>,
)
