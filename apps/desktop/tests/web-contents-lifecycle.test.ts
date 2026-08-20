import { EventEmitter } from 'node:events'
import type { WebContents } from 'electron'
import { describe, expect, it, vi } from 'vitest'

import { WebContentsLifecycle } from '../src/main/gateway/web-contents-lifecycle'

describe('WebContentsLifecycle', () => {
  it('registers one destroyed listener across repeated subscriptions', () => {
    const contents = new EventEmitter() as WebContents
    const lifecycle = new WebContentsLifecycle()
    const onDestroyed = vi.fn()

    for (let index = 0; index < 20; index += 1) lifecycle.observe(contents, onDestroyed)

    expect(contents.listenerCount('destroyed')).toBe(1)
    contents.emit('destroyed')
    expect(onDestroyed).toHaveBeenCalledOnce()
    expect(contents.listenerCount('destroyed')).toBe(0)
  })
})
