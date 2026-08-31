/**
 * @vitest-environment happy-dom
 *
 * 键盘导航与补全调度的顺序性测试必须跑在 happy-dom 下：它的事件派发
 * 与 Chromium 一致按两段式执行（capture 段先于 bubble 段，段内注册序），
 * 才能忠实还原「PM 在它自己的 keydown（bubble，注册早于本 hook）里同步
 * dispatch 方向键选区事务」。vitest 默认的 node 环境里 EventTarget 是
 * Node 实现——按注册序调用监听、无视 capture 标志，顺序性用例在那里
 * 既不忠实也测不出回归。
 */
import { Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { EditorState, TextSelection, type Transaction } from '@tiptap/pm/state'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/renderer/src/components/context-room/ported/components/detail-editor/documentCursorCompletionAgent', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/renderer/src/components/context-room/ported/components/detail-editor/documentCursorCompletionAgent')>(),
  streamDocumentCursorCompletion: vi.fn().mockResolvedValue({ text: '补全结果', replaceCharacters: 0 }),
}))

import {
  DocumentCursorCompletionExtension,
  useDocumentCursorCompletion,
} from '../src/renderer/src/components/context-room/ported/components/detail-editor/DocumentCursorCompletion'
import { clearDocumentCursorCompletionDiagnostics } from '../src/renderer/src/components/context-room/ported/components/detail-editor/DocumentCursorCompletionDiagnostics'
import { streamDocumentCursorCompletion } from '../src/renderer/src/components/context-room/ported/components/detail-editor/documentCursorCompletionAgent'

const editors: Editor[] = []

class MockKeyboardEvent extends Event {
  key: string
  isComposing: boolean

  constructor(type: string, init: { key?: string; isComposing?: boolean; bubbles?: boolean } = {}) {
    super(type, init.bubbles ? { bubbles: true } : undefined)
    this.key = init.key ?? ''
    this.isComposing = init.isComposing ?? false
  }
}

function createHookEditor(initialContent: string | Record<string, unknown> = '已有正文') {
  const source = new Editor({
    extensions: [StarterKit, DocumentCursorCompletionExtension],
    content: typeof initialContent === 'string' ? {
      type: 'doc',
      content: [{
        type: 'paragraph',
        ...(initialContent ? { content: [{ type: 'text', text: initialContent }] } : {}),
      }],
    } : initialContent,
  })
  editors.push(source)
  let state = EditorState.create({
    schema: source.schema,
    doc: source.state.doc,
    selection: TextSelection.atEnd(source.state.doc),
    plugins: source.extensionManager.plugins,
  })
  const dom = new EventTarget()
  let transactionListener: ((event: { transaction: Transaction }) => void) | null = null
  const view = {
    dom,
    composing: false,
    hasFocus: () => true,
    get state() {
      return state
    },
    dispatch(transaction: Transaction) {
      state = state.apply(transaction)
      transactionListener?.({ transaction })
    },
  }
  const editor = {
    isDestroyed: false,
    isEditable: true,
    get state() {
      return state
    },
    view,
    on(event: string, listener: (event: { transaction: Transaction }) => void) {
      if (event === 'transaction') transactionListener = listener
      return editor
    },
    off(event: string, listener: (event: { transaction: Transaction }) => void) {
      if (event === 'transaction' && transactionListener === listener) transactionListener = null
      return editor
    },
  } as unknown as Editor
  return {
    dom,
    editor,
    moveSelectionTo: (position: number) => view.dispatch(
      state.tr.setSelection(TextSelection.create(state.doc, position)),
    ),
  }
}

function NavigationHook({ editor }: { editor: Editor }) {
  const running = useDocumentCursorCompletion({
    editor,
    roomId: 'room-1',
    documentName: '测试文档',
    enabled: true,
  })
  return React.createElement('span', { 'data-running': running })
}

afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  clearDocumentCursorCompletionDiagnostics()
})

describe('useDocumentCursorCompletion keyboard navigation ordering', () => {
  it('lets arrow-key moves request completion instead of cancelling the schedule', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('nxcore', { cursorCompletionAgent: {} })
    vi.mocked(streamDocumentCursorCompletion).mockResolvedValue({ text: '补全结果', replaceCharacters: 0 })
    const hookEditor = createHookEditor({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: '第一段正文内容' }] },
        { type: 'paragraph', content: [{ type: 'text', text: '第二段收尾' }] },
      ],
    })
    // 忠实还原 PM：方向键选区事务在 PM 的 keydown（bubble，注册早于
    // hook 的监听）里同步派发。hook 把导航清场放在 capture 则先于事务，
    // 放在 bubble（注册序晚于 PM）则会反手杀掉事务刚挂好的 cursor-move
    // 调度——方向键移动光标将永远无法触发补全。
    hookEditor.dom.addEventListener('keydown', () => {
      hookEditor.moveSelectionTo(hookEditor.editor.state.doc.resolve(1).end(1))
    })
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(React.createElement(NavigationHook, {
        editor: hookEditor.editor,
      }))
    })

    await act(async () => {
      hookEditor.dom.dispatchEvent(new MockKeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    })
    await act(async () => { await vi.advanceTimersByTimeAsync(700) })

    expect(streamDocumentCursorCompletion).toHaveBeenCalledTimes(1)
    expect(vi.mocked(streamDocumentCursorCompletion).mock.calls[0]?.[1]).toMatchObject({
      blockPrefix: '第一段正文内容',
      blockSuffix: '',
    })
    act(() => renderer.unmount())
  })

  it('clears a pending typing schedule when the arrow key does not move the selection', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('nxcore', { cursorCompletionAgent: {} })
    vi.mocked(streamDocumentCursorCompletion).mockResolvedValue({ text: '补全结果', replaceCharacters: 0 })
    const hookEditor = createHookEditor('已有正文')
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(React.createElement(NavigationHook, {
        editor: hookEditor.editor,
      }))
    })

    // 模拟一次 2 字符输入挂上调度，随后方向键未产生选区事务（如光标
    // 已在文档边界）——清场必须让滞留的调度不再触发。
    const tr = hookEditor.editor.state.tr
    tr.insertText('续写')
    act(() => {
      hookEditor.editor.view.dispatch(tr)
    })
    await act(async () => {
      hookEditor.dom.dispatchEvent(new MockKeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    })
    await act(async () => { await vi.advanceTimersByTimeAsync(700) })

    expect(streamDocumentCursorCompletion).not.toHaveBeenCalled()
    act(() => renderer.unmount())
  })
})
