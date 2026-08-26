import { describe, expect, it } from 'vitest'

import { onboardingFlowStageState } from '../src/renderer/src/components/onboarding/OnboardingFlowChrome'

describe('onboarding flow stage state', () => {
  it('keeps completed steps highlighted after navigating backward', () => {
    const completed = new Set(['folder', 'memory'] as const)

    expect(onboardingFlowStageState('folder', 'folder', completed)).toBe('active')
    expect(onboardingFlowStageState('folder', 'memory', completed)).toBe('complete')
    expect(onboardingFlowStageState('folder', 'room', completed)).toBe('upcoming')
  })

  it('shows every finished setup step as complete on the ready page', () => {
    const completed = new Set(['folder', 'memory', 'room'] as const)

    expect(onboardingFlowStageState('ready', 'folder', completed)).toBe('complete')
    expect(onboardingFlowStageState('ready', 'memory', completed)).toBe('complete')
    expect(onboardingFlowStageState('ready', 'room', completed)).toBe('complete')
    expect(onboardingFlowStageState('ready', 'ready', completed)).toBe('active')
  })
})
