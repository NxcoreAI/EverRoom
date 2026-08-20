import { Activity, FileText, MessagesSquare, Sparkles, UserRound } from 'lucide-react'
import type { MemoryOverviewDto } from '../../../../../shared/memory'
import { useLocale } from '@/i18n/LocaleContext'
import type { MemoryTabId } from './useMemoryData'
import { formatDate } from './useMemoryData'

const TYPE_LABELS: Record<string, string> = {
  episodic: 'memory:memoryOverview.episodic',
  persona: 'memory:memoryOverview.persona',
  instruction: 'memory:memoryOverview.instruction',
}

function PipelineBadge({ label, stage }: { label: string; stage: { queued: number; running: number; idle: boolean } | null }) {
  const { t } = useLocale()
  if (!stage) return null
  const busy = stage.running > 0
  const pending = stage.queued > 0
  return (
    <span className="mem-pipeline-chip" data-state={busy ? 'running' : pending ? 'queued' : 'idle'}>
      {label}
      {busy ? t('memory:memoryOverview.countRefining', { count: stage.running }) : pending ? t('memory:memoryOverview.countQueued', { count: stage.queued }) : t('memory:memoryOverview.idle')}
    </span>
  )
}

export function MemoryOverviewPane({ overview, onNavigate, onStartOnboarding }: {
  overview: MemoryOverviewDto
  onNavigate: (tab: MemoryTabId) => void
  onStartOnboarding?: () => void
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
      title: t('memory:memoryOverview.conversations'),
      value: overview.l0 ? String(overview.l0.total) : '—',
      detail: t('memory:memoryOverview.conversationHistoryWithTheAiAssistantSavedAutomatically'),
    },
    {
      tab: 'atomic',
      icon: Sparkles,
      level: 'L1',
      title: t('memory:memoryOverview.atomicMemory'),
      value: overview.l1 ? String(overview.l1.total) : '—',
      detail: overview.l1
        ? t('memory:memoryOverview.episodicEpisodicPersonaPersonaInstructionInstruction', overview.l1.byType)
        : t('memory:memoryOverview.factsAndPreferencesExtractedFromConversations'),
    },
    {
      tab: 'scenario',
      icon: FileText,
      level: 'L2',
      title: t('memory:memoryOverview.scenarios'),
      value: overview.l2 ? String(overview.l2.total) : '—',
      detail: t('memory:memoryOverview.scenarioDocumentsOrganizedByTopic'),
    },
    {
      tab: 'core',
      icon: UserRound,
      level: 'L3',
      title: t('memory:memoryOverview.profile'),
      value: t(overview.l3?.exists ? 'memory:memoryOverview.generated' : 'memory:memoryOverview.notGenerated'),
      detail: overview.l3?.exists && overview.l3.updatedAt
        ? t('memory:memoryOverview.updatedTime', { time: formatDate(overview.l3.updatedAt, locale) })
        : t('memory:memoryOverview.generatedAutomaticallyAsConversationsAccumulate'),
    },
  ]

  const pipelineBusy = overview.pipeline
    && ((overview.pipeline.l1?.running ?? 0) > 0 || (overview.pipeline.l2?.running ?? 0) > 0 || (overview.pipeline.l3?.running ?? 0) > 0)
  const pipelineQueued = overview.pipeline
    && ((overview.pipeline.l1?.queued ?? 0) > 0 || (overview.pipeline.l2?.queued ?? 0) > 0 || (overview.pipeline.l3?.queued ?? 0) > 0)

  return (
    <div className="mem-overview">
      {(overview.l0?.total ?? 0) === 0 && (overview.l1?.total ?? 0) === 0 && onStartOnboarding ? (
        <section className="mem-first-memory">
          <span className="mem-first-memory-icon"><Sparkles aria-hidden="true" strokeWidth={1.7} /></span>
          <div>
            <strong>{t('memory:onboarding.emptyTitle')}</strong>
            <p>{t('memory:onboarding.emptyBody')}</p>
          </div>
          <button type="button" onClick={onStartOnboarding}>{t('memory:onboarding.emptyAction')}</button>
        </section>
      ) : null}
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
            {t('memory:memoryOverview.memoryRefinementPipeline')}
          </span>
          <span className="mem-pipeline-state" data-state={pipelineBusy ? 'running' : pipelineQueued ? 'queued' : 'idle'}>
            {t(pipelineBusy ? 'memory:memoryOverview.pipelineRunning' : pipelineQueued ? 'memory:memoryOverview.pipelineQueued' : 'memory:memoryOverview.pipelineIdle')}
          </span>
          <PipelineBadge label="L1" stage={overview.pipeline.l1} />
          <PipelineBadge label="L2" stage={overview.pipeline.l2} />
          <PipelineBadge label="L3" stage={overview.pipeline.l3} />
        </section>
      ) : null}
      <section className="mem-explain">
        <h3>{t('memory:memoryOverview.howMemoryWorks')}</h3>
        <ol>
          <li><strong>{t('memory:memoryOverview.l0Conversations')}</strong>{t('memory:memoryOverview.everyConversationWithTheAiAssistantIsWritten')}</li>
          <li><strong>{t('memory:memoryOverview.l1AtomicMemories')}</strong>{t('memory:memoryOverview.theServiceAsynchronouslyExtractsEpisodicEpisodicPersonaPersona', { episodic: t(TYPE_LABELS.episodic), persona: t(TYPE_LABELS.persona), instruction: t(TYPE_LABELS.instruction) })}</li>
          <li><strong>{t('memory:memoryOverview.l2Scenarios')}</strong>{t('memory:memoryOverview.relatedMemoriesAreOrganizedIntoScenarioDocumentsBy')}</li>
          <li><strong>{t('memory:memoryOverview.l3Profile')}</strong>{t('memory:memoryOverview.aLongTermProfileBuiltAcrossScenariosAnd')}</li>
        </ol>
      </section>
    </div>
  )
}
