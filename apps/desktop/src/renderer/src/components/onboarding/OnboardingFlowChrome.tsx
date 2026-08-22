import { ChevronRight, Languages } from 'lucide-react'
import type { ReactNode } from 'react'

import { ProductBrand } from '@/components/ui/ProductBrand'
import { useLocale } from '@/i18n/LocaleContext'
import './OnboardingFlowChrome.css'

export type OnboardingFlowStage = 'idle' | 'memory' | 'room' | 'folder' | 'ready'

interface OnboardingFlowChromeProps {
  stage: OnboardingFlowStage
  onStageChange: (stage: OnboardingFlowStage) => void
  children: ReactNode
}

export function OnboardingFlowChrome({ stage, onStageChange, children }: OnboardingFlowChromeProps) {
  const { locale, setLocale, t } = useLocale()
  const item = (value: Exclude<OnboardingFlowStage, 'idle'>, label: string) => (
    <button type="button" className="onboarding-flow-stage" data-state={stage === value ? 'active' : stageOrder(stage) > stageOrder(value) ? 'complete' : 'upcoming'} onClick={() => onStageChange(value)}>
      {label}
    </button>
  )
  return (
    <div className="onboarding-flow-chrome" data-stage={stage}>
      <header className="onboarding-flow-header drag-region">
        <ProductBrand className="onboarding-flow-brand" />
        <div className="onboarding-flow-language no-drag">
          <Languages aria-hidden="true" />
          <button type="button" data-active={locale === 'zh-CN'} onClick={() => setLocale('zh-CN')}>中文</button>
          <button type="button" data-active={locale === 'en-US'} onClick={() => setLocale('en-US')}>EN</button>
        </div>
      </header>
      <nav className="onboarding-flow-sequence" aria-label={t('surface:settings.folderGuide.eyebrow')}>
        {item('folder', t('surface:settings.folderGuide.eyebrow'))}
        <ChevronRight aria-hidden="true" />
        {item('memory', t('memory:onboarding.memorySetup'))}
        <ChevronRight aria-hidden="true" />
        {item('room', t('contextRoom:onboarding.eyebrow'))}
        <ChevronRight aria-hidden="true" />
        {item('ready', t('surface:settings.folderGuide.readyTitle'))}
      </nav>
      <main className="onboarding-flow-content">{children}</main>
    </div>
  )
}

function stageOrder(stage: OnboardingFlowStage): number {
  return stage === 'idle' ? -1 : ({ folder: 0, memory: 1, room: 2, ready: 3 })[stage]
}
