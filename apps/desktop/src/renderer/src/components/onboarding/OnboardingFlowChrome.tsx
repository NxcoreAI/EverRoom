import { Check, ChevronRight, Languages } from 'lucide-react'
import type { ReactNode } from 'react'

import { ProductBrand } from '@/components/ui/ProductBrand'
import { useLocale } from '@/i18n/LocaleContext'
import './OnboardingFlowChrome.css'

export type OnboardingFlowStage = 'idle' | 'memory' | 'room' | 'folder' | 'ready'
export type CompletedOnboardingStage = Exclude<OnboardingFlowStage, 'idle' | 'ready'>

interface OnboardingFlowChromeProps {
  stage: OnboardingFlowStage
  completedStages?: ReadonlySet<CompletedOnboardingStage>
  onStageChange: (stage: OnboardingFlowStage) => void
  children: ReactNode
}

export function OnboardingFlowChrome({ stage, completedStages = new Set(), onStageChange, children }: OnboardingFlowChromeProps) {
  const { locale, preference, setLocale, t } = useLocale()
  const item = (value: Exclude<OnboardingFlowStage, 'idle'>, label: string) => {
    const state = onboardingFlowStageState(stage, value, completedStages)
    return (
      <button type="button" className="onboarding-flow-stage" data-state={state} onClick={() => onStageChange(value)}>
        {state === 'complete' ? <Check aria-hidden="true" /> : null}{label}
      </button>
    )
  }
  return (
    <div className="onboarding-flow-chrome" data-stage={stage}>
      <header className="onboarding-flow-header drag-region">
        <ProductBrand className="onboarding-flow-brand" />
        <div className="onboarding-flow-language no-drag">
          <Languages aria-hidden="true" />
          <button type="button" data-active={preference === 'system'} onClick={() => setLocale('system')}>{t('surface:settings.followSystem')}</button>
          <button type="button" data-active={preference === 'zh-CN'} onClick={() => setLocale('zh-CN')}>中文</button>
          <button type="button" data-active={preference === 'en-US'} onClick={() => setLocale('en-US')}>EN</button>
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

export function onboardingFlowStageState(
  activeStage: OnboardingFlowStage,
  stage: Exclude<OnboardingFlowStage, 'idle'>,
  completedStages: ReadonlySet<CompletedOnboardingStage>,
): 'active' | 'complete' | 'upcoming' {
  if (activeStage === stage) return 'active'
  if (stage !== 'ready' && completedStages.has(stage)) return 'complete'
  return 'upcoming'
}
