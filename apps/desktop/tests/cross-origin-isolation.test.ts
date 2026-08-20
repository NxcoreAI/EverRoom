import { describe, expect, it, vi } from 'vitest'

import {
  CROSS_ORIGIN_ISOLATION_HEADERS,
  installCrossOriginIsolation,
  isRendererResourceUrl,
} from '../src/main/cross-origin-isolation'

describe('desktop cross-origin isolation', () => {
  it('recognizes packaged file resources and only the configured development origin', () => {
    expect(isRendererResourceUrl('file:///Applications/EverRoom/renderer/index.html')).toBe(true)
    expect(isRendererResourceUrl('http://localhost:5180/src/main.tsx', 'http://localhost:5180'))
      .toBe(true)
    expect(isRendererResourceUrl('http://127.0.0.1:3000/v1/health', 'http://localhost:5180'))
      .toBe(false)
  })

  it('adds COOP and COEP without changing unrelated responses', () => {
    let listener: ((details: {
      url: string
      responseHeaders?: Record<string, string[]>
    }, callback: (response: { responseHeaders?: Record<string, string[]> }) => void) => void) | undefined
    const session = {
      webRequest: {
        onHeadersReceived: vi.fn((next) => { listener = next }),
      },
    }
    installCrossOriginIsolation(session as never, 'http://localhost:5180')

    const isolated = vi.fn()
    listener?.({
      url: 'http://localhost:5180/forceGraph.worker.js',
      responseHeaders: { 'Content-Type': ['text/javascript'] },
    }, isolated)
    expect(isolated).toHaveBeenCalledWith({
      responseHeaders: {
        'Content-Type': ['text/javascript'],
        ...CROSS_ORIGIN_ISOLATION_HEADERS,
      },
    })

    const unrelated = vi.fn()
    listener?.({
      url: 'http://127.0.0.1:3000/v1/health',
      responseHeaders: { Server: ['gateway'] },
    }, unrelated)
    expect(unrelated).toHaveBeenCalledWith({ responseHeaders: { Server: ['gateway'] } })
  })
})
