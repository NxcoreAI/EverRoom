import { describe, expect, it } from 'vitest'

import { extractCurrentSection } from './currentSection'

interface FakeBlock {
  name: string
  level?: number
  text: string
}

interface FakeNodeView {
  type: { name: string }
  attrs: { level?: unknown } | null
  textContent: string
}

/** 最小结构化文档：块占 [offset, offset+text.length+2)，模拟 ProseMirror 的开合标签开销。 */
function fakeDoc(blocks: FakeBlock[]) {
  let pos = 0
  const placed = blocks.map((block) => {
    const start = pos
    pos += block.text.length + 2
    return { ...block, start }
  })
  return {
    forEach(callback: (node: FakeNodeView, offset: number, index: number) => void) {
      placed.forEach((block, index) => {
        callback(
          { type: { name: block.name }, attrs: block.level ? { level: block.level } : null, textContent: block.text },
          block.start,
          index,
        )
      })
    },
    textBetween(from: number, to: number, blockSeparator = '\n\n') {
      const parts = placed
        .filter((block) => block.start < to && block.start + block.text.length + 2 > from)
        .map((block) => block.text.slice(Math.max(0, from - block.start), Math.max(0, Math.min(block.text.length, to - block.start))))
        .filter((text) => text.length > 0)
      return parts.join(blockSeparator)
    },
    content: { size: pos },
  }
}

function docFixture() {
  return fakeDoc([
    { name: 'heading', level: 1, text: '一、背景' },
    { name: 'paragraph', text: '背景正文甲' },
    { name: 'heading', level: 1, text: '二、方案' },
    { name: 'paragraph', text: '方案正文乙' },
    { name: 'heading', level: 2, text: '子项' },
    { name: 'paragraph', text: '子项正文丙' },
    { name: 'heading', level: 1, text: '三、收尾' },
    { name: 'paragraph', text: '收尾正文丁' },
  ])
}

/** 块内首个文字字符的位置（跳过开标签）。 */
function inside(doc: ReturnType<typeof fakeDoc>, name: string, text: string): number {
  let found = -1
  doc.forEach((node, offset) => {
    if (found >= 0) return
    if (node.type.name === name && node.textContent === text) found = offset + 1
  })
  if (found < 0) throw new Error(`block not found: ${text}`)
  return found
}

describe('extractCurrentSection', () => {
  it('光标在第二节正文：heading=二、方案，正文覆盖到下一个同级标题为止（含小节）', () => {
    const doc = docFixture()
    const cursor = inside(doc, 'paragraph', '方案正文乙')
    const section = extractCurrentSection(doc as never, cursor)
    expect(section?.heading).toBe('二、方案')
    expect(section?.bodyText).toContain('方案正文乙')
    expect(section?.bodyText).toContain('子项')
    expect(section?.bodyText).toContain('子项正文丙')
    expect(section?.bodyText).not.toContain('背景正文甲')
    expect(section?.bodyText).not.toContain('三、收尾')
    expect(section?.bodyText).not.toContain('收尾正文丁')
  })

  it('光标在 h2 小节内：焦点=最内层小节，正文到下一个 h1 截止', () => {
    const doc = docFixture()
    const cursor = inside(doc, 'paragraph', '子项正文丙')
    const section = extractCurrentSection(doc as never, cursor)
    expect(section?.heading).toBe('子项')
    expect(section?.bodyText).toContain('子项正文丙')
    expect(section?.bodyText).not.toContain('三、收尾')
  })

  it('光标在最后一个标题的正文里：正文延伸到文末', () => {
    const doc = docFixture()
    const cursor = inside(doc, 'paragraph', '收尾正文丁')
    const section = extractCurrentSection(doc as never, cursor)
    expect(section?.heading).toBe('三、收尾')
    expect(section?.bodyText).toContain('收尾正文丁')
  })

  it('光标落在第一个标题之前：没有当前章节', () => {
    const doc = docFixture()
    expect(extractCurrentSection(doc as never, 0)).toBeNull()
  })

  it('当前标题文本为空：不算有效章节', () => {
    const doc = fakeDoc([
      { name: 'heading', level: 1, text: '' },
      { name: 'paragraph', text: '孤行正文' },
    ])
    const cursor = inside(doc, 'paragraph', '孤行正文')
    expect(extractCurrentSection(doc as never, cursor)).toBeNull()
  })

  it('整篇无标题：返回 null', () => {
    const doc = fakeDoc([{ name: 'paragraph', text: '无结构正文' }])
    const cursor = inside(doc, 'paragraph', '无结构正文')
    expect(extractCurrentSection(doc as never, cursor)).toBeNull()
  })
})
