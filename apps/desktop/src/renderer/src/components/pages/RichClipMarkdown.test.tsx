import TestRenderer, { act } from 'react-test-renderer'
import { describe, expect, it } from 'vitest'

import { RichClipMarkdown } from './RichClipMarkdown'

function renderedText(node: TestRenderer.ReactTestInstance): string {
  return node.children.map((child) => typeof child === 'string' ? child : renderedText(child)).join(' ')
}

describe('RichClipMarkdown', () => {
  it('preserves headings, GFM tables, code, and local clip images', async () => {
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(<RichClipMarkdown markdown={`---
title: "Clip"
---

# Heading

![Architecture](nxcore-clipper-asset://local/ref-architecture)

| Stage | State |
| --- | --- |
| Parse | ready |

1. Identify untested code

   \`\`\`text
   find functions without tests
   \`\`\`

2. Run and verify tests

\`\`\`ts
const ready = true
\`\`\`
`} />)
    })

    expect(renderer.root.findByType('h1').children).toEqual(['Heading'])
    expect(renderer.root.findByType('img').props.src).toBe('nxcore-clipper-asset://local/ref-architecture')
    expect(renderer.root.findAllByType('table')).toHaveLength(1)
    expect(renderer.root.findAllByType('ol')).toHaveLength(1)
    expect(renderer.root.findAllByType('li').map(renderedText)).toEqual(expect.arrayContaining([
      expect.stringContaining('Identify untested code'),
      expect.stringContaining('Run and verify tests'),
    ]))
    expect(renderer.root.findAllByType('code').map((node) => node.props.className)).toEqual(expect.arrayContaining(['language-text', 'language-ts']))
    expect(JSON.stringify(renderer.toJSON())).not.toContain('title: \\"Clip\\"')
  })

  it('renders an extracted image group as an ordered responsive grid', async () => {
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(<RichClipMarkdown markdown={`# Comparison

<!-- everroom:image-grid:start columns=2 -->
![Before](nxcore-clipper-asset://local/ref-before)
![After](nxcore-clipper-asset://local/ref-after)
<!-- everroom:image-grid:end -->
`} />)
    })

    const grid = renderer.root.find((node) => node.props.className === 'clip-image-grid')
    expect(grid.props['data-columns']).toBe(2)
    expect(grid.findAllByType('img').map((image) => image.props.src)).toEqual([
      'nxcore-clipper-asset://local/ref-before',
      'nxcore-clipper-asset://local/ref-after',
    ])
    expect(grid.findAllByType('figcaption').map((caption) => caption.children)).toEqual([['Before'], ['After']])
  })
})
