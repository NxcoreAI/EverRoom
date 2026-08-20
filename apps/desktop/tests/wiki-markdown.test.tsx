import TestRenderer, { act } from 'react-test-renderer'
import { afterEach, describe, expect, it } from 'vitest'

import { MarkdownBody, stripFrontmatter } from '../src/renderer/src/components/context-room/ported/components/detail-panels/MarkdownBody'

describe('Wiki Markdown', () => {
  let renderer: TestRenderer.ReactTestRenderer | null = null

  afterEach(() => {
    renderer?.unmount()
    renderer = null
  })

  it('renders inline Markdown and GFM syntax instead of showing source markers', () => {
    act(() => {
      renderer = TestRenderer.create(
        <MarkdownBody markdown={[
          '# 页面标题',
          '',
          '**重点**、*补充*与`代码`',
          '',
          '- [x] 已完成',
          '',
          '| 字段 | 值 |',
          '| --- | --- |',
          '| 状态 | ~~旧值~~ |',
        ].join('\n')} />,
      )
    })

    expect(renderer!.root.findByType('h3').children).toContain('页面标题')
    expect(renderer!.root.findByType('strong').children).toContain('重点')
    expect(renderer!.root.findByType('em').children).toContain('补充')
    expect(renderer!.root.findByType('code').children).toContain('代码')
    expect(renderer!.root.findAllByType('table')).toHaveLength(1)
    expect(renderer!.root.findAllByType('del')).toHaveLength(1)
    expect(renderer!.root.findByType('input').props).toMatchObject({ type: 'checkbox', checked: true, disabled: true })
    expect(JSON.stringify(renderer!.toJSON())).not.toContain('**重点**')
  })

  it('removes Knowledge Service frontmatter before rendering', () => {
    const markdown = '---\ntitle: Page\ntags:\n  - wiki\n---\n\n# 正文'

    expect(stripFrontmatter(markdown)).toBe('# 正文')

    act(() => {
      renderer = TestRenderer.create(<MarkdownBody markdown={markdown} />)
    })

    expect(renderer!.root.findByType('h3').children).toContain('正文')
    expect(JSON.stringify(renderer!.toJSON())).not.toContain('title: Page')
  })

  it('opens rendered links outside the app and leaves raw HTML inert', () => {
    act(() => {
      renderer = TestRenderer.create(
        <MarkdownBody markdown={'[来源](https://example.com)\n\n<script>alert("x")</script>'} />,
      )
    })

    expect(renderer!.root.findByType('a').props).toMatchObject({
      href: 'https://example.com',
      target: '_blank',
      rel: 'noreferrer noopener',
    })
    expect(renderer!.root.findAllByType('script')).toHaveLength(0)
  })
})
