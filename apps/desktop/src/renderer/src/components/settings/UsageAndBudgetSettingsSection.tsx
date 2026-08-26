import { useState } from 'react'

import { useLocale } from '@/i18n/LocaleContext'
import { ExternalCallBudgetSettingsSection } from './ExternalCallBudgetSettingsSection'
import { TokenUsageSettingsSection } from './TokenUsageSettingsSection'

export function UsageAndBudgetSettingsSection() {
  const { t } = useLocale()
  const [view, setView] = useState<'tokens' | 'external'>('tokens')

  return <>
    <div className="usage-budget-switcher segmented-control" aria-label={t('surface:settings.usageAndBudgets')}>
      <button type="button" data-active={String(view === 'tokens')} onClick={() => setView('tokens')}>{t('surface:settings.modelTokenUsage')}</button>
      <button type="button" data-active={String(view === 'external')} onClick={() => setView('external')}>{t('surface:settings.externalCalls')}</button>
    </div>
    {view === 'tokens' ? <TokenUsageSettingsSection /> : <ExternalCallBudgetSettingsSection />}
  </>
}
