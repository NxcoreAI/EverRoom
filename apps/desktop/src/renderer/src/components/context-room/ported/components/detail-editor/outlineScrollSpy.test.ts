import { describe, expect, it } from 'vitest'
import { computeOutlineActiveId } from './outlineScrollSpy'

describe('computeOutlineActiveId', () => {
  const items = [{ id: 'h1' }, { id: 'h2' }, { id: 'h3' }]

  it('文档开头：没有任何标题越过准线，无高亮', () => {
    const tops: Record<string, number | null> = { h1: 100, h2: 200, h3: 300 }
    expect(computeOutlineActiveId(items, (id) => tops[id] ?? null, 20)).toBeNull()
  })

  it('标题顶恰在阅读区顶缘：该标题即当前章节', () => {
    const tops: Record<string, number | null> = { h1: 20, h2: 120, h3: 220 }
    expect(computeOutlineActiveId(items, (id) => tops[id] ?? null, 20)).toBe('h1')
  })

  it('滚过第一节的段落深处：第一节保持高亮', () => {
    const tops: Record<string, number | null> = { h1: -300, h2: 200, h3: 300 }
    expect(computeOutlineActiveId(items, (id) => tops[id] ?? null, 20)).toBe('h1')
  })

  it('滚到第二节：第二节高亮、第一节失效', () => {
    const tops: Record<string, number> = { h1: -300, h2: 12, h3: 300 }
    expect(computeOutlineActiveId(items, (id) => tops[id] ?? null, 20)).toBe('h2')
  })

  it('滚过两节：最后一个越过准线的高亮', () => {
    const tops: Record<string, number> = { h1: -300, h2: -200, h3: 10 }
    expect(computeOutlineActiveId(items, (id) => tops[id] ?? null, 20)).toBe('h3')
  })

  it('DOM 未渲染的条目跳过、不中断后续判定', () => {
    const tops: Record<string, number | null> = { h1: -100, h2: null, h3: 5 }
    expect(computeOutlineActiveId(items, (id) => tops[id] ?? null, 20)).toBe('h3')
  })

  it('准线偏移可自定义', () => {
    const tops: Record<string, number | null> = { h1: 60, h2: 120 }
    expect(computeOutlineActiveId(items.slice(0, 2), (id) => tops[id] ?? null, 20, 40)).toBe('h1')
  })
})
