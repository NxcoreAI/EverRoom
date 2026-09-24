// 临时入口：纯浏览器挂载 DocumentOverviewCard 各状态。外层复刻编辑器
// 真实骨架（.context-room-app token 作用域 + 标题块 + 正文列），保证速览卡
// 的对齐与配色在真实语境里验证（验证后删除）。
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { DocumentOverviewView } from '@nxcore/agent-contract'

import { DocumentOverviewCard } from './components/context-room/ported/components/detail-editor/DocumentOverviewCard'
import type { DocumentOverviewStatus } from './components/context-room/ported/components/detail-editor/useDocumentOverview'
import { LocaleProvider } from './i18n/LocaleContext'
import '@/styles/tokens.css'
import './styles.css'
import './components/context-room/ported/ContextRoom.css'

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

function CardFrame({ label, status, defaultExpanded = false }: { label: string; status: DocumentOverviewStatus; defaultExpanded?: boolean }) {
  const [expanded, setExpanded] = useState(defaultExpanded)
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

function BodySample() {
  return (
    <div
      style={{
        width: 'min(100%, 720px)',
        margin: '0 auto',
        padding: '0 clamp(24px, 8cqw, 72px) 80px',
        fontSize: 15,
        lineHeight: 1.75,
        color: 'var(--cr-text)',
      }}
    >
      <p style={{ margin: 0 }}>
        本季度架构演进以模块分层为主线，先完成渲染层与主进程之间的通信收敛，
        再将网关进程从桌面主进程里拆分出来。拆分后各进程职责单一，崩溃域互不影响，
        内存占用也随之下移。
      </p>
      <p style={{ margin: '12px 0 0' }}>
        下一阶段聚焦性能：编辑器大文档首屏、房间切换时的状态恢复，以及
        连接器同步的背压策略。
      </p>
    </div>
  )
}

createRoot(document.getElementById('mock-root')!).render(
  <LocaleProvider>
    <div
      className="context-room-app"
      style={{ width: 860, margin: '24px auto', boxShadow: '0 8px 30px rgba(0,0,0,.08)', borderRadius: 8, overflow: 'hidden' }}
    >
      <div className="context-room-document-title-block">
        <div className="context-room-document-title-input">产品周报：架构演进展望</div>
      </div>
      <CardFrame label="ready 收起" status={{ state: 'ready', view }} />
      <CardFrame label="ready 展开" status={{ state: 'ready', view }} defaultExpanded />
      <CardFrame label="stale 收起" status={{ state: 'stale', view }} />
      <CardFrame label="generating" status={{ state: 'generating', view: null }} />
      <CardFrame label="failed(error)" status={{ state: 'failed', kind: 'error' }} />
      <CardFrame label="too_short" status={{ state: 'ineligible', reason: 'too_short' }} />
      <BodySample />
    </div>
  </LocaleProvider>,
)
