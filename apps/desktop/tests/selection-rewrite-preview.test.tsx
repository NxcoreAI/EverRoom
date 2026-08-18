import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { TiptapSelectionRewritePreview } from '../src/renderer/src/components/context-room/ported/components/detail-editor/TiptapSelectionRewrite'

type Preview = NonNullable<React.ComponentProps<typeof TiptapSelectionRewritePreview>['preview']>

function preview(overrides: Partial<Preview> = {}): Preview {
  return {
    from: 1,
    to: 5,
    originalText: '原始内容',
    replacementText: '候选内容',
    registeredReplacementText: '候选内容',
    instruction: '重写',
    formatContext: { blockType: 'paragraph', ancestorTypes: ['paragraph'] },
    phase: 'ready',
    error: null,
    sessionId: 'session-1',
    runId: 'run-1',
    operationId: 'operation-1',
    revision: 1,
    left: 20,
    top: 30,
    ...overrides,
  }
}

describe('TiptapSelectionRewritePreview', () => {
  let renderer: TestRenderer.ReactTestRenderer | null = null

  afterEach(() => {
    renderer?.unmount()
    renderer = null
  })

  it('allows editing a ready candidate without accepting it', () => {
    const onAccept = vi.fn()
    const onChange = vi.fn()
    act(() => {
      renderer = TestRenderer.create(
        <TiptapSelectionRewritePreview
          preview={preview()}
          onAccept={onAccept}
          onCancel={vi.fn()}
          onChange={onChange}
          onRetry={vi.fn()}
        />,
      )
    })

    const textarea = renderer.root.findByProps({ 'aria-label': '编辑重写内容' })
    expect(textarea.props.value).toBe('候选内容')
    expect(textarea.props.disabled).toBe(false)

    act(() => textarea.props.onChange({ target: { value: '用户编辑后的 **Markdown**' } }))

    expect(onChange).toHaveBeenCalledWith('用户编辑后的 **Markdown**')
    expect(onAccept).not.toHaveBeenCalled()
  })

  it('keeps the editor available after clearing a candidate and disables apply', () => {
    act(() => {
      renderer = TestRenderer.create(
        <TiptapSelectionRewritePreview
          preview={preview({ replacementText: '' })}
          onAccept={vi.fn()}
          onCancel={vi.fn()}
          onChange={vi.fn()}
          onRetry={vi.fn()}
        />,
      )
    })

    expect(renderer.root.findByProps({ 'aria-label': '编辑重写内容' }).props.value).toBe('')
    expect(renderer.root.findByProps({ 'aria-label': '应用重写' }).props.disabled).toBe(true)
  })

  it('keeps streamed and submitting candidates read-only', () => {
    act(() => {
      renderer = TestRenderer.create(
        <TiptapSelectionRewritePreview
          preview={preview({ phase: 'requesting', registeredReplacementText: null })}
          onAccept={vi.fn()}
          onCancel={vi.fn()}
          onChange={vi.fn()}
          onRetry={vi.fn()}
        />,
      )
    })
    expect(renderer.root.findByType('textarea').props.disabled).toBe(true)

    act(() => {
      renderer!.update(
        <TiptapSelectionRewritePreview
          preview={preview({ phase: 'submitting' })}
          onAccept={vi.fn()}
          onCancel={vi.fn()}
          onChange={vi.fn()}
          onRetry={vi.fn()}
        />,
      )
    })
    expect(renderer.root.findByType('textarea').props.disabled).toBe(true)
    expect(renderer.root.findAllByProps({ 'aria-label': '应用重写' })).toHaveLength(0)
  })
})
