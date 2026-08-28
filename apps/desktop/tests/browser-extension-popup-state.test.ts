import { describe, expect, it } from 'vitest'

import { captureStatusKey, progressStates, retryStatusKey } from '../../browser-extension/popup-state.js'

describe('browser extension popup state', () => {
  it('advances completed stages without marking future work', () => {
    expect(progressStates(['extract', 'save', 'images', 'done'], 'images')).toEqual([
      'done', 'done', 'active', '',
    ])
  })

  it('reports partial image uploads and retry outcomes explicitly', () => {
    expect(captureStatusKey({ ok: true, capture: { failedAssetCount: 2 } })).toBe('savedPartial')
    expect(captureStatusKey({ ok: true, capture: { failedAssetCount: 0 } })).toBe('saved')
    expect(captureStatusKey({ ok: false })).toBe('saveFailed')
    expect(retryStatusKey({ ok: true })).toBe('retryFinished')
    expect(retryStatusKey({ ok: false })).toBe('retryFailed')
  })
})
