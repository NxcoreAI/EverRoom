// @vitest-environment happy-dom
/**
 * FormattedAgentText（聊天气泡 Markdown 渲染）回归：提示词已解禁 GFM，
 * 渲染层必须真实支持这些特性，不能只是"样式存在"。
 *
 * 1) 粗体/斜体/行内代码/代码块/删除线 渲染为对应元素。
 * 2) GFM 表格渲染为 table/th/td。
 * 3) GFM task list 渲染为禁用 checkbox。
 * 4) 标题降级：# ~ ### 都渲染为 h4/h5（气泡内不撑布局）。
 * 5) 图片不渲染（img: () => null）。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

// 与 AgentChatView 相同的渲染配置（组件本身未导出，这里复刻同等配置做能力回归；
// 若 AgentChatView 的配置变化，此测试与真实渲染的差异会在 code review 显形）。
const agentMarkdownComponents = {
  h1: ({ children }: { children?: React.ReactNode }) => <h4>{children}</h4>,
  h2: ({ children }: { children?: React.ReactNode }) => <h4>{children}</h4>,
  h3: ({ children }: { children?: React.ReactNode }) => <h5>{children}</h5>,
  h4: ({ children }: { children?: React.ReactNode }) => <h6>{children}</h6>,
  h5: ({ children }: { children?: React.ReactNode }) => <h6>{children}</h6>,
  h6: ({ children }: { children?: React.ReactNode }) => <h6>{children}</h6>,
  a: ({ children, href }: { children?: React.ReactNode; href?: string }) => (
    <a href={href} target="_blank" rel="noreferrer noopener">{children}</a>
  ),
  img: () => null,
} as const

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => { root.unmount() })
  container.remove()
})

function renderMarkdown(content: string): void {
  void act(() => {
    root.render(
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={agentMarkdownComponents}>
        {content}
      </ReactMarkdown>,
    )
  })
}

describe('聊天气泡 Markdown 渲染能力（提示词解禁后的回归底线）', () => {
  it('粗体/斜体/行内代码/删除线渲染为对应元素', () => {
    renderMarkdown('**重点**、*语气*、`lark-cli im +messages-search`、~~旧口径~~')
    expect(container.querySelector('strong')?.textContent).toBe('重点')
    expect(container.querySelector('em')?.textContent).toBe('语气')
    expect(container.querySelector('code')?.textContent).toContain('messages-search')
    expect(container.querySelector('del')?.textContent).toBe('旧口径')
  })

  it('代码块渲染为 pre>code', () => {
    renderMarkdown('```\nlark-cli im +chat-list --as user\n```')
    const pre = container.querySelector('pre')
    expect(pre).not.toBeNull()
    expect(pre?.querySelector('code')?.textContent).toContain('chat-list')
  })

  it('GFM 表格渲染为 thead/th/td', () => {
    renderMarkdown('| 方案 | 页数 |\n| --- | --- |\n| A | 12 |')
    const table = container.querySelector('table')
    expect(table).not.toBeNull()
    expect(table?.querySelector('thead th')?.textContent).toBe('方案')
    const cells = Array.from(table?.querySelectorAll('tbody td') ?? [])
    expect(cells.map((cell) => cell.textContent)).toEqual(['A', '12'])
  })

  it('GFM task list 渲染为 checkbox', () => {
    renderMarkdown('- [x] 已核对口径\n- [ ] 待补信源')
    const boxes = container.querySelectorAll('input[type="checkbox"]')
    expect(boxes).toHaveLength(2)
    expect((boxes[0] as HTMLInputElement).checked).toBe(true)
    expect((boxes[1] as HTMLInputElement).checked).toBe(false)
  })

  it('标题降级：# 与 ## 渲染为 h4，### 渲染为 h5，不出现 h1/h2/h3', () => {
    renderMarkdown('# 大标题\n\n## 二级\n\n### 三级')
    expect(container.querySelector('h1')).toBeNull()
    expect(container.querySelector('h2')).toBeNull()
    expect(container.querySelector('h3')).toBeNull()
    expect(container.querySelectorAll('h4')).toHaveLength(2)
    expect(container.querySelector('h5')?.textContent).toBe('三级')
  })

  it('图片不渲染', () => {
    renderMarkdown('![说明](https://example.com/a.png)')
    expect(container.querySelector('img')).toBeNull()
  })

  it('链接带 _blank 与 noopener', () => {
    renderMarkdown('[文档](https://example.com/doc)')
    const anchor = container.querySelector('a')
    expect(anchor?.getAttribute('target')).toBe('_blank')
    expect(anchor?.getAttribute('rel')).toContain('noopener')
  })
})
