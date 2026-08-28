import TestRenderer, { act } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { HighRiskImportReview } from '../src/renderer/src/components/HighRiskImportReview'

vi.mock('../src/renderer/src/i18n/LocaleContext', () => ({
  useLocale: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('../src/renderer/src/state/toast', () => ({
  showToast: vi.fn(),
}))

describe('HighRiskImportReview', () => {
  let renderer: TestRenderer.ReactTestRenderer | null = null

  afterEach(() => {
    renderer?.unmount()
    renderer = null
    Reflect.deleteProperty(globalThis, 'window')
  })

  it('emphasizes skipping and treats accepting as the high-risk action', async () => {
    const resolveHighRiskReview = vi.fn().mockResolvedValue({ imported: 0, failed: 0 })
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        nxcore: {
          files: {
            listHighRiskReviews: vi.fn().mockResolvedValue({
              items: [{
                id: 'review-1',
                origin: 'auto-scan',
                sourceLabel: 'Downloads',
                fileCount: 30,
                createdAt: '2026-08-28T00:00:00.000Z',
              }],
            }),
            onHighRiskReviewsChanged: vi.fn(() => vi.fn()),
            resolveHighRiskReview,
          },
        },
      },
    })

    await act(async () => {
      renderer = TestRenderer.create(<HighRiskImportReview />)
      await Promise.resolve()
    })

    const actions = renderer.root.findByProps({ className: 'high-risk-import-review-actions' })
    const buttons = actions.findAllByType('button')
    expect(buttons.map((button) => button.props.className)).toEqual([
      'high-risk-import-review-skip',
      'high-risk-import-review-accept',
    ])

    await act(async () => {
      buttons[0]!.props.onClick()
      await Promise.resolve()
    })
    expect(resolveHighRiskReview).toHaveBeenCalledWith('review-1', false)
  })
})
