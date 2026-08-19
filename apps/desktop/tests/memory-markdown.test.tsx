import TestRenderer, { act } from 'react-test-renderer'
import { afterEach, describe, expect, it } from 'vitest'

import { MemoryMarkdown } from '../src/renderer/src/components/pages/memory/MemoryMarkdown'

describe('MemoryMarkdown', () => {
  let renderer: TestRenderer.ReactTestRenderer | null = null

  afterEach(() => {
    renderer?.unmount()
    renderer = null
  })

  it('renders common Markdown and GFM structures', () => {
    act(() => {
      renderer = TestRenderer.create(
        <MemoryMarkdown markdown={[
          '# 标题',
          '',
          '**重点**与`代码`',
          '',
          '- [x] 已完成',
          '',
          '| 字段 | 值 |',
          '| --- | --- |',
          '| 状态 | ~~旧值~~ |',
          '',
          '```ts',
          'const ready = true',
          '```',
        ].join('\n')} />,
      )
    })

    expect(renderer!.root.findByType('h1').children).toContain('标题')
    expect(renderer!.root.findByType('strong').children).toContain('重点')
    expect(renderer!.root.findAllByType('table')).toHaveLength(1)
    expect(renderer!.root.findAllByType('del')).toHaveLength(1)
    expect(renderer!.root.findByType('input').props).toMatchObject({ type: 'checkbox', checked: true, disabled: true })
    expect(renderer!.root.findByType('pre').findByType('code').children.join('')).toContain('const ready = true')
  })

  it('opens rendered links outside the app with safe relationship attributes', () => {
    act(() => {
      renderer = TestRenderer.create(<MemoryMarkdown markdown="[来源](https://example.com)" compact />)
    })

    expect(renderer!.root.findByType('a').props).toMatchObject({
      href: 'https://example.com',
      target: '_blank',
      rel: 'noreferrer noopener',
    })
    expect(renderer!.root.findByProps({ className: 'mem-markdown-body is-compact' })).toBeTruthy()
  })

  it('does not render raw HTML from memory content', () => {
    act(() => {
      renderer = TestRenderer.create(<MemoryMarkdown markdown={'<script>alert("x")</script>'} />)
    })

    expect(renderer!.root.findAllByType('script')).toHaveLength(0)
    expect(renderer!.toJSON()).toMatchObject({ children: ['<script>alert("x")</script>'] })
  })
})
