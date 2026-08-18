import { describe, expect, it } from 'vitest'

import {
  documentBlockFocusRequestKey,
  documentBlockNavigationKey,
  planDocumentBlockNavigation,
} from '../src/renderer/src/components/context-room/ported/components/detail-editor/documentBlockNavigation'

describe('document block navigation', () => {
  const target = { roomId: 'room-1', documentId: 'doc-1', blockId: 'block-1' }

  it('creates a fresh focus key for repeated clicks on the same block', () => {
    const firstClick = documentBlockFocusRequestKey('doc-1', 'block-1', 1)
    const repeatedClick = documentBlockFocusRequestKey('doc-1', 'block-1', 2)

    expect(repeatedClick).not.toBe(firstClick)
    expect(documentBlockFocusRequestKey('doc-1', 'block-1', 1)).toBe(firstClick)
  })

  it('opens the target document before trying to focus its block', () => {
    expect(planDocumentBlockNavigation(null, target, 'room-1', 'doc-2', true)).toEqual({
      requestKey: documentBlockNavigationKey(target),
      handledKey: null,
      shouldOpenDocument: true,
      shouldFocusBlock: false,
      documentUnavailable: false,
    })
  })

  it('focuses once the target document is visible and consumes the request', () => {
    const plan = planDocumentBlockNavigation(null, target, 'room-1', 'doc-1', true)
    expect(plan.shouldFocusBlock).toBe(true)
    expect(plan.shouldOpenDocument).toBe(false)
    expect(plan.handledKey).toBe(documentBlockNavigationKey(target))
    expect(planDocumentBlockNavigation(plan.handledKey, target, 'room-1', 'doc-1', true).shouldFocusBlock).toBe(false)
  })

  it('consumes a request whose document is unavailable without opening it', () => {
    const plan = planDocumentBlockNavigation(null, target, null, null, false)
    expect(plan.documentUnavailable).toBe(true)
    expect(plan.handledKey).toBe(documentBlockNavigationKey(target))
    expect(plan.shouldOpenDocument).toBe(false)
  })
})
