import { describe, expect, it } from 'vitest'
import { resolveSectionHeadingPos } from './scaleMarkerNavigation'

function fakeDoc(nodes: Array<{ type: string; attrs: Record<string, unknown> }>) {
  return {
    descendants(callback: (node: { type: { name: string }; attrs: Record<string, unknown> }, pos: number) => boolean | void) {
      nodes.forEach((node, index) => {
        callback({ type: { name: node.type }, attrs: node.attrs }, index * 4)
      })
    },
  }
}

describe('resolveSectionHeadingPos', () => {
  it('resolves the latest position by data-toc-id or id', () => {
    const doc = fakeDoc([
      { type: 'paragraph', attrs: {} },
      { type: 'heading', attrs: { 'data-toc-id': 'toc-a', id: 'block-a' } },
      { type: 'paragraph', attrs: {} },
      { type: 'heading', attrs: { id: 'block-b' } },
    ])
    expect(resolveSectionHeadingPos(doc as never, 'toc-a', 99)).toBe(4)
    expect(resolveSectionHeadingPos(doc as never, 'block-b', 99)).toBe(12)
  })

  it('ignores non-heading nodes carrying the same id', () => {
    const doc = fakeDoc([
      { type: 'paragraph', attrs: { id: 'x' } },
      { type: 'heading', attrs: { id: 'x' } },
    ])
    expect(resolveSectionHeadingPos(doc as never, 'x', 99)).toBe(4)
  })

  it('falls back to the TOC pos when the id no longer exists', () => {
    const doc = fakeDoc([{ type: 'paragraph', attrs: {} }])
    expect(resolveSectionHeadingPos(doc as never, 'gone', 42)).toBe(42)
  })
})
