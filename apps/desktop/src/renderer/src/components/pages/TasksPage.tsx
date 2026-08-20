import { Check, ChevronRight, CircleDashed, Clock3 } from 'lucide-react'

import { PageHeader } from './PageHeader'
import { useLocale } from '@/i18n/LocaleContext'

const TASKS = [
  ['surface:tasks.inProgress', 'surface:tasks.buildFrontendStyleFramework', 'Nex', 'surface:tasks.now'],
  ['surface:tasks.notStarted', 'surface:tasks.connectLocalFileConnector', 'surface:tasks.unassigned', 'P0'],
  ['surface:tasks.completed', 'surface:tasks.defineOpenSourceEditionBoundaries', 'Codex', 'surface:tasks.today'],
] as const

export function TasksPage() {
  const { t } = useLocale()
  return (
    <div className="page">
      <PageHeader title={t('surface:tasks.tasks')} description={t('surface:tasks.trackAgentSScopeProgressAndOutput')} action={t('surface:tasks.newTask')} />
      <div className="task-board">
        {TASKS.map(([status, title, owner, time], index) => (
          <article key={title} className="task-row">
            <span className="task-state">
              {index === 0 ? <CircleDashed aria-hidden="true" strokeWidth={1.8} /> : index === 2 ? <Check aria-hidden="true" strokeWidth={1.8} /> : <Clock3 aria-hidden="true" strokeWidth={1.8} />}
            </span>
            <div><strong>{t(title)}</strong><small>{t(owner)}</small></div>
            <span className="quiet-label">{t(status)}</span><time>{t(time)}</time>
            <ChevronRight aria-hidden="true" strokeWidth={1.8} />
          </article>
        ))}
      </div>
    </div>
  )
}
