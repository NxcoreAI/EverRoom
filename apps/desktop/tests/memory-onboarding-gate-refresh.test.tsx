import TestRenderer, { act } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { MemoryOnboardingGate } from '../src/renderer/src/components/onboarding/MemoryOnboardingGate'
import { MEMORY_ONBOARDING_STORAGE_KEY } from '../src/renderer/src/components/onboarding/memoryOnboardingState'

function storage(initial: string | null = null) {
  let value = initial
  return {
    getItem: vi.fn((key: string) => key === MEMORY_ONBOARDING_STORAGE_KEY ? value : null),
    setItem: vi.fn((key: string, next: string) => {
      if (key === MEMORY_ONBOARDING_STORAGE_KEY) value = next
    }),
    removeItem: vi.fn((key: string) => {
      if (key === MEMORY_ONBOARDING_STORAGE_KEY) value = null
    }),
    value: () => value,
  }
}

function installWindow(localStorage: ReturnType<typeof storage>, memory: Record<string, unknown> = {}) {
  const onboardingFinished = vi.fn()
  vi.stubGlobal('window', {
    localStorage,
    sessionStorage: storage(),
    nxcore: {
      platform: 'darwin',
      memory: { ...memory, onboardingFinished },
    },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    setTimeout,
    clearTimeout,
  })
  vi.stubGlobal('navigator', { platform: 'MacIntel', userAgent: 'Electron' })
  return { onboardingFinished }
}

describe('MemoryOnboardingGate refresh behavior', () => {
  let renderer: TestRenderer.ReactTestRenderer | null = null

  afterEach(() => {
    renderer?.unmount()
    renderer = null
    vi.unstubAllGlobals()
  })

  it('stays in the app after a completed onboarding marker is restored', async () => {
    const marker = JSON.stringify({
      status: 'completed',
      requestId: 'request-1',
      sessionId: 'onboarding:request-1',
      capturedAt: '2026-08-24T10:00:00.000Z',
      memoryId: 'memory-1',
    })
    const localStorage = storage(marker)
    const overview = vi.fn()
    const { onboardingFinished } = installWindow(localStorage, { overview })

    await act(async () => {
      renderer = TestRenderer.create(
        <MemoryOnboardingGate>{() => <div>app-content</div>}</MemoryOnboardingGate>,
      )
    })

    expect(JSON.stringify(renderer!.toJSON())).toContain('app-content')
    expect(overview).not.toHaveBeenCalled()
    expect(onboardingFinished).toHaveBeenCalled()
  })

  it('persists acknowledgement when continuing with existing memory', async () => {
    const localStorage = storage()
    installWindow(localStorage, { overview: vi.fn().mockResolvedValue({ l0: { total: 1 }, l1: { total: 0 } }) })

    await act(async () => {
      renderer = TestRenderer.create(
        <MemoryOnboardingGate>{() => <div>app-content</div>}</MemoryOnboardingGate>,
      )
    })

    const ready = renderer!.root.findByProps({ className: 'memory-onboarding-ready' })
    await act(async () => {
      ready.findByProps({ className: 'memory-onboarding-primary' }).props.onClick()
    })

    expect(JSON.parse(localStorage.value()!)).toEqual({ status: 'skipped' })
    expect(JSON.stringify(renderer!.toJSON())).toContain('app-content')
  })

  it('restores a pending generation in the background after an app restart', async () => {
    const marker = JSON.stringify({
      status: 'pending',
      requestId: 'request-pending',
      sessionId: 'onboarding:request-pending',
      capturedAt: '2026-08-24T10:00:00.000Z',
    })
    const localStorage = storage(marker)
    const listAtomic = vi.fn(() => new Promise(() => undefined))
    const { onboardingFinished } = installWindow(localStorage, { listAtomic })

    await act(async () => {
      renderer = TestRenderer.create(
        <MemoryOnboardingGate>{() => <div>app-content</div>}</MemoryOnboardingGate>,
      )
    })

    expect(JSON.stringify(renderer!.toJSON())).toContain('app-content')
    expect(listAtomic).toHaveBeenCalled()
    expect(onboardingFinished).toHaveBeenCalled()
  })

  it('keeps a restored pending generation visible during the explicit memory stage', async () => {
    const marker = JSON.stringify({
      status: 'pending',
      requestId: 'request-pending',
      sessionId: 'onboarding:request-pending',
      capturedAt: '2026-08-24T10:00:00.000Z',
    })
    const localStorage = storage(marker)
    const listAtomic = vi.fn(() => new Promise(() => undefined))
    const { onboardingFinished } = installWindow(localStorage, { listAtomic })

    await act(async () => {
      renderer = TestRenderer.create(
        <MemoryOnboardingGate activeStage="memory">{() => <div>app-content</div>}</MemoryOnboardingGate>,
      )
    })

    expect(JSON.stringify(renderer!.toJSON())).toContain('memory-onboarding-generating')
    expect(JSON.stringify(renderer!.toJSON())).not.toContain('app-content')
    expect(listAtomic).toHaveBeenCalled()
    expect(onboardingFinished).not.toHaveBeenCalled()
  })
})
