import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('gsap', () => ({
  default: {
    context: (callback: () => void) => {
      callback()
      return { revert: vi.fn() }
    },
    killTweensOf: vi.fn(),
    matchMedia: () => ({ add: vi.fn(), revert: vi.fn() }),
    timeline: () => ({ from: vi.fn(), fromTo: vi.fn() }),
    to: vi.fn(),
  },
}))

const translate = (key: string) => key

vi.mock('@/i18n/LocaleContext', () => ({
  useLocale: () => ({
    locale: 'zh-CN',
    t: translate,
  }),
}))

import { DiaryPage } from './DiaryPage'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => { resolve = complete })
  return { promise, resolve }
}

describe('DiaryPage loading state', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('shows the page skeleton until an empty diary request completes', async () => {
    const dayRequest = deferred<null>()
    vi.stubGlobal('window', {
      nxcore: {
        diary: {
          activeRun: vi.fn().mockResolvedValue(null),
          day: vi.fn().mockReturnValue(dayRequest.promise),
          days: vi.fn().mockResolvedValue([]),
        },
      },
    })

    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(<DiaryPage />)
      await Promise.resolve()
    })

    expect(renderer.root.findByProps({ className: 'page diary-skeleton-page' })).toBeTruthy()

    await act(async () => {
      dayRequest.resolve(null)
      await dayRequest.promise
      await Promise.resolve()
    })

    expect(renderer.root.findByProps({ className: 'page diary-page' })).toBeTruthy()
    expect(renderer.root.findByType('h1').children).toContain('diaryReality:diary.noDiaryEntryForThisDayYet')
  })
})
