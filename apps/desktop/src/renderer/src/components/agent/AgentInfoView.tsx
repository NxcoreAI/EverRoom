import { Activity, Circle, FileText, LayoutPanelTop } from 'lucide-react'

import type { AgentView } from './AgentToolbar'
import { useLocale } from '@/i18n/LocaleContext'

export function AgentInfoView({
  activeRunId,
  connected,
  messageCount,
  pageLabel,
  view,
}: {
  activeRunId: string | null
  connected: boolean
  messageCount: number
  pageLabel: string
  view: Exclude<AgentView, 'chat'>
}) {
  const { t } = useLocale()
  if (view === 'context') {
    return (
      <section className="agent-detail-view" aria-label={t('当前上下文')}>
        <div className="agent-detail-heading">{t('本轮上下文')}</div>
        <div className="agent-detail-row">
          <span className="agent-detail-icon"><LayoutPanelTop aria-hidden="true" /></span>
          <span><strong>{pageLabel}</strong><small>{t('当前工作区')}</small></span>
        </div>
        <div className="agent-detail-row is-muted">
          <span className="agent-detail-icon"><FileText aria-hidden="true" /></span>
          <span><strong>{t('尚未选择来源')}</strong><small>{t('Agent 不会读取其他内容')}</small></span>
        </div>
      </section>
    )
  }

  return (
    <section className="agent-detail-view" aria-label={t('最近活动')}>
      <div className="agent-detail-heading">{t('最近活动')}</div>
      <div className="agent-detail-row">
        <span className="agent-detail-icon"><Activity aria-hidden="true" /></span>
        <span><strong>{t(activeRunId ? 'Agent 正在运行' : '工作区已就绪')}</strong><small>{t('{count} 条消息', { count: messageCount })}</small></span>
      </div>
      <div className="agent-detail-row is-muted">
        <span className="agent-detail-icon"><Circle aria-hidden="true" /></span>
        <span><strong>{t(connected ? 'Gateway 已连接' : '本地运行时')}</strong><small>{t(activeRunId ? '正在接收运行事件' : '等待下一项任务')}</small></span>
      </div>
    </section>
  )
}
