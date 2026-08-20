import { PowerOff, RefreshCw, Unplug } from 'lucide-react'
import { useLocale } from '@/i18n/LocaleContext'

import { memoryFailureText, type MemoryFailure } from './useMemoryData'

export function MemoryDisabledView() {
  const { t } = useLocale()
  return (
    <div className="mem-status" data-kind="disabled">
      <PowerOff aria-hidden="true" strokeWidth={1.6} />
      <h2>{t('memory:memoryStatusViews.memoryServiceIsDisabled')}</h2>
      <p>
        {t('memory:memoryStatusViews.everroomUsesTencentdbAgentMemoryMemorycoreToBuild')}
        {t('memory:memoryStatusViews.configure')} <code>NXCORE_MEMORY_ENABLED=true</code> {t('memory:memoryStatusViews.andPointItToARunningMemorycoreInstance')}
      </p>
    </div>
  )
}

export function MemoryUnreachableView({ failure, onRetry }: {
  failure: MemoryFailure
  onRetry: () => void
}) {
  const { t } = useLocale()
  return (
    <div className="mem-status" data-kind="unreachable">
      <Unplug aria-hidden="true" strokeWidth={1.6} />
      <h2>{t('memory:memoryStatusViews.unableToConnect')}</h2>
      <p>{memoryFailureText(failure, t)} {t('memory:memoryStatusViews.memorycoreRunsAsASeparateProcessAndMay')}</p>
      <button type="button" className="mem-retry" onClick={onRetry}>
        <RefreshCw aria-hidden="true" strokeWidth={1.8} />{t('memory:memoryStatusViews.retry')}
      </button>
    </div>
  )
}

export function MemoryEmptyView({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="mem-status" data-kind="empty">
      <h2>{title}</h2>
      {hint ? <p>{hint}</p> : null}
    </div>
  )
}
