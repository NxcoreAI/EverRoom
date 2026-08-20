import { Check, ChevronRight, CircleDashed, Clock3 } from 'lucide-react'

import { PageHeader } from './PageHeader'
import { useLocale } from '@/i18n/LocaleContext'

const TASKS = [
  ['进行中', '搭建前端样式框架', 'Nex', '当前'],
  ['待开始', '接入本地文件连接器', '未分配', 'P0'],
  ['已完成', '确定开源版工程边界', 'Codex', '今天'],
] as const

export function TasksPage() {
  const { t } = useLocale()
  return (
    <div className="page">
      <PageHeader title={t('任务')} description={t('查看 Agent 的执行范围、进度与产物。')} action={t('新建任务')} />
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
