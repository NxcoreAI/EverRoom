import { Activity, FileText, MessagesSquare, Sparkles, UserRound } from 'lucide-react'

import type { MemoryOverviewDto } from '../../../../../shared/memory'
import { useLocale } from '@/i18n/LocaleContext'
import type { MemoryTabId } from './useMemoryData'
import { formatDate } from './useMemoryData'

const TYPE_LABELS: Record<string, string> = {
  episodic: '情景',
  persona: '人格',
  instruction: '指令',
}

function PipelineBadge({ label, stage }: { label: string; stage: { queued: number; running: number; idle: boolean } | null }) {
  const { t } = useLocale()
  if (!stage) return null
  const busy = stage.running > 0
  const pending = stage.queued > 0
  return (
    <span className="mem-pipeline-chip" data-state={busy ? 'running' : pending ? 'queued' : 'idle'}>
      {label}
      {busy ? t('提炼中 {count}', { count: stage.running }) : pending ? t('排队 {count}', { count: stage.queued }) : t('空闲')}
    </span>
  )
}

export function MemoryOverviewPane({ overview, onNavigate }: {
  overview: MemoryOverviewDto
  onNavigate: (tab: MemoryTabId) => void
}) {
  const { locale, t } = useLocale()
  const cards: Array<{
    tab: MemoryTabId
    icon: typeof Activity
    level: string
    title: string
    value: string
    detail: string
  }> = [
    {
      tab: 'conversation',
      icon: MessagesSquare,
      level: 'L0',
      title: t('对话'),
      value: overview.l0 ? String(overview.l0.total) : '—',
      detail: t('与 AI 助手的历史对话，自动沉淀'),
    },
    {
      tab: 'atomic',
      icon: Sparkles,
      level: 'L1',
      title: t('原子记忆'),
      value: overview.l1 ? String(overview.l1.total) : '—',
      detail: overview.l1
        ? t('情景 {episodic} · 人格 {persona} · 指令 {instruction}', overview.l1.byType)
        : t('从对话中提炼的事实与偏好'),
    },
    {
      tab: 'scenario',
      icon: FileText,
      level: 'L2',
      title: t('场景'),
      value: overview.l2 ? String(overview.l2.total) : '—',
      detail: t('按主题归档的场景文档'),
    },
    {
      tab: 'core',
      icon: UserRound,
      level: 'L3',
      title: t('画像'),
      value: t(overview.l3?.exists ? '已生成' : '未生成'),
      detail: overview.l3?.exists && overview.l3.updatedAt
        ? t('更新于 {time}', { time: formatDate(overview.l3.updatedAt, locale) })
        : t('随着对话积累自动生成'),
    },
  ]

  const pipelineBusy = overview.pipeline
    && ((overview.pipeline.l1?.running ?? 0) > 0 || (overview.pipeline.l2?.running ?? 0) > 0 || (overview.pipeline.l3?.running ?? 0) > 0)
  const pipelineQueued = overview.pipeline
    && ((overview.pipeline.l1?.queued ?? 0) > 0 || (overview.pipeline.l2?.queued ?? 0) > 0 || (overview.pipeline.l3?.queued ?? 0) > 0)

  return (
    <div className="mem-overview">
      <section className="mem-cards">
        {cards.map((card) => (
          <button key={card.tab} type="button" className="mem-card" onClick={() => onNavigate(card.tab)}>
            <span className="mem-card-icon"><card.icon aria-hidden="true" strokeWidth={1.7} /></span>
            <span className="mem-card-level">{card.level}</span>
            <strong className="mem-card-value">{card.value}</strong>
            <span className="mem-card-title">{card.title}</span>
            <small className="mem-card-detail">{card.detail}</small>
          </button>
        ))}
      </section>
      {overview.pipeline ? (
        <section className="mem-pipeline">
          <span className="mem-pipeline-label">
            <Activity aria-hidden="true" strokeWidth={1.7} />
            {t('记忆提炼管道')}
          </span>
          <span className="mem-pipeline-state" data-state={pipelineBusy ? 'running' : pipelineQueued ? 'queued' : 'idle'}>
            {t(pipelineBusy ? '正在提炼新记忆' : pipelineQueued ? '有会话等待提炼' : '空闲，无待处理会话')}
          </span>
          <PipelineBadge label="L1" stage={overview.pipeline.l1} />
          <PipelineBadge label="L2" stage={overview.pipeline.l2} />
          <PipelineBadge label="L3" stage={overview.pipeline.l3} />
        </section>
      ) : null}
      <section className="mem-explain">
        <h3>{t('记忆是如何工作的')}</h3>
        <ol>
          <li><strong>{t('L0 对话')}</strong>{t('：每轮与 AI 助手的对话自动写入 MemoryCore。')}</li>
          <li><strong>{t('L1 原子记忆')}</strong>{t('：服务端异步提炼出情景（{episodic}）、人格（{persona}）、指令（{instruction}）三类原子事实。', { episodic: t(TYPE_LABELS.episodic), persona: t(TYPE_LABELS.persona), instruction: t(TYPE_LABELS.instruction) })}</li>
          <li><strong>{t('L2 场景')}</strong>{t('：相关记忆按主题归档为场景文档。')}</li>
          <li><strong>{t('L3 画像')}</strong>{t('：跨场景沉淀出的长期用户画像，每轮对话前自动注入 AI 上下文。')}</li>
        </ol>
      </section>
    </div>
  )
}
