import { Activity, FileText, MessagesSquare, Sparkles, UserRound } from 'lucide-react'

import type { MemoryOverviewDto } from '../../../../../shared/memory'
import type { MemoryTabId } from './useMemoryData'
import { formatDate } from './useMemoryData'

const TYPE_LABELS: Record<string, string> = {
  episodic: '情景',
  persona: '人格',
  instruction: '指令',
}

function PipelineBadge({ label, stage }: { label: string; stage: { queued: number; running: number; idle: boolean } | null }) {
  if (!stage) return null
  const busy = stage.running > 0
  const pending = stage.queued > 0
  return (
    <span className="mem-pipeline-chip" data-state={busy ? 'running' : pending ? 'queued' : 'idle'}>
      {label}
      {busy ? `提炼中 ${stage.running}` : pending ? `排队 ${stage.queued}` : '空闲'}
    </span>
  )
}

export function MemoryOverviewPane({ overview, onNavigate }: {
  overview: MemoryOverviewDto
  onNavigate: (tab: MemoryTabId) => void
}) {
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
      title: '对话',
      value: overview.l0 ? String(overview.l0.total) : '—',
      detail: '与 AI 助手的历史对话，自动沉淀',
    },
    {
      tab: 'atomic',
      icon: Sparkles,
      level: 'L1',
      title: '原子记忆',
      value: overview.l1 ? String(overview.l1.total) : '—',
      detail: overview.l1
        ? `情景 ${overview.l1.byType.episodic} · 人格 ${overview.l1.byType.persona} · 指令 ${overview.l1.byType.instruction}`
        : '从对话中提炼的事实与偏好',
    },
    {
      tab: 'scenario',
      icon: FileText,
      level: 'L2',
      title: '场景',
      value: overview.l2 ? String(overview.l2.total) : '—',
      detail: '按主题归档的场景文档',
    },
    {
      tab: 'core',
      icon: UserRound,
      level: 'L3',
      title: '画像',
      value: overview.l3?.exists ? '已生成' : '未生成',
      detail: overview.l3?.exists && overview.l3.updatedAt
        ? `更新于 ${formatDate(overview.l3.updatedAt)}`
        : '随着对话积累自动生成',
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
            记忆提炼管道
          </span>
          <span className="mem-pipeline-state" data-state={pipelineBusy ? 'running' : pipelineQueued ? 'queued' : 'idle'}>
            {pipelineBusy ? '正在提炼新记忆' : pipelineQueued ? '有会话等待提炼' : '空闲，无待处理会话'}
          </span>
          <PipelineBadge label="L1" stage={overview.pipeline.l1} />
          <PipelineBadge label="L2" stage={overview.pipeline.l2} />
          <PipelineBadge label="L3" stage={overview.pipeline.l3} />
        </section>
      ) : null}
      <section className="mem-explain">
        <h3>记忆是如何工作的</h3>
        <ol>
          <li><strong>L0 对话</strong>：每轮与 AI 助手的对话自动写入 MemoryCore。</li>
          <li><strong>L1 原子记忆</strong>：服务端异步提炼出情景（{TYPE_LABELS.episodic}）、人格（{TYPE_LABELS.persona}）、指令（{TYPE_LABELS.instruction}）三类原子事实。</li>
          <li><strong>L2 场景</strong>：相关记忆按主题归档为场景文档。</li>
          <li><strong>L3 画像</strong>：跨场景沉淀出的长期用户画像，每轮对话前自动注入 AI 上下文。</li>
        </ol>
      </section>
    </div>
  )
}
