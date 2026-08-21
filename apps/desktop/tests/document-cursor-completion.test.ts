import { undo } from '@tiptap/pm/history'
import { EditorState, TextSelection, type Plugin, type Transaction } from '@tiptap/pm/state'
import type { DecorationSet, EditorView } from '@tiptap/pm/view'
import { Editor } from '@tiptap/react'
import TaskItem from '@tiptap/extension-task-item'
import TaskList from '@tiptap/extension-task-list'
import StarterKit from '@tiptap/starter-kit'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/renderer/src/components/context-room/ported/components/detail-editor/documentCursorCompletionAgent', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/renderer/src/components/context-room/ported/components/detail-editor/documentCursorCompletionAgent')>(),
  streamDocumentCursorCompletion: vi.fn().mockResolvedValue({ text: '补全结果', replaceCharacters: 0 }),
}))

vi.mock('../src/renderer/src/i18n/LocaleContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/renderer/src/i18n/LocaleContext')>()
  return {
    ...actual,
    useLocale: () => ({
      locale: 'zh-CN',
      setLocale: vi.fn(),
      t: (message: string, values?: Record<string, string | number>) => actual.translate('zh-CN', message, values),
      formatNumber: (value: number) => value.toLocaleString('zh-CN'),
      formatDate: (value: Date | number | string, options?: Intl.DateTimeFormatOptions) => (
        new Intl.DateTimeFormat('zh-CN', options).format(new Date(value))
      ),
    }),
  }
})

import {
  currentDocumentCursorCompletion,
  documentCursorCompletionContext,
  DocumentCursorCompletionExtension,
  showDocumentCursorCompletion,
  useDocumentCursorCompletion,
} from '../src/renderer/src/components/context-room/ported/components/detail-editor/DocumentCursorCompletion'
import {
  clearDocumentCursorCompletionDiagnostics,
  documentCursorCompletionSnippet,
  readDocumentCursorCompletionDiagnostics,
  recordDocumentCursorCompletionDiagnostic,
} from '../src/renderer/src/components/context-room/ported/components/detail-editor/DocumentCursorCompletionDiagnostics'
import { streamDocumentCursorCompletion } from '../src/renderer/src/components/context-room/ported/components/detail-editor/documentCursorCompletionAgent'

const editors: Editor[] = []

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

interface CompletionHarness {
  editor: Editor
  plugin: Plugin
  transactions: Transaction[]
  view: EditorView
  state: () => EditorState
}

const paragraphContent = {
  type: 'doc',
  content: [{
    type: 'paragraph',
    content: [{ type: 'text', text: '已有正文' }],
  }],
}

function lastNonEmptyTextblockEnd(doc: EditorState['doc']): number {
  let position = 1
  doc.descendants((node, nodePosition) => {
    if (node.isTextblock && node.textContent) position = nodePosition + node.nodeSize - 1
  })
  return position
}

function createHarness(content: Record<string, unknown> = paragraphContent): CompletionHarness {
  const editor = new Editor({
    extensions: [StarterKit, DocumentCursorCompletionExtension],
    content,
  })
  editors.push(editor)
  let state = EditorState.create({
    schema: editor.schema,
    doc: editor.state.doc,
    plugins: editor.extensionManager.plugins,
  })
  state = state.apply(state.tr)
  state = state.apply(state.tr.setSelection(
    TextSelection.create(state.doc, lastNonEmptyTextblockEnd(state.doc)),
  ))
  const plugin = state.plugins.find(({ spec }) =>
    spec.key?.key.includes('documentCursorCompletion'))
  if (!plugin) {
    throw new Error(`Document cursor completion plugin is missing: ${state.plugins
      .map(({ spec }) => spec.key?.key ?? 'anonymous')
      .join(', ')}`)
  }
  const transactions: Transaction[] = []
  const view = {
    get state() {
      return state
    },
    composing: false,
    dispatch(transaction: Transaction) {
      transactions.push(transaction)
      state = state.apply(transaction)
    },
  } as unknown as EditorView
  return { editor, plugin, transactions, view, state: () => state }
}

function keyEvent(key: string, overrides: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return {
    key,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    isComposing: false,
    preventDefault: vi.fn(),
    ...overrides,
  } as unknown as KeyboardEvent
}

function showCompletion(harness: CompletionHarness, text: string, replaceFrom?: number): void {
  harness.view.dispatch(harness.state().tr.setMeta(harness.plugin.spec.key!, {
    position: harness.state().selection.from,
    text,
    ...(replaceFrom !== undefined ? { replaceFrom } : {}),
  }))
}

function currentCompletion(harness: CompletionHarness): unknown {
  return harness.plugin.spec.key?.getState(harness.state()) ?? null
}

function handleKeyDown(
  harness: CompletionHarness,
  event: KeyboardEvent,
  view = harness.view,
): boolean {
  return harness.plugin.props.handleKeyDown?.call(harness.plugin, view, event) === true
}

afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  clearDocumentCursorCompletionDiagnostics()
})

describe('document cursor completion diagnostics', () => {
  it('keeps a bounded in-memory history and protects diagnostic metadata', () => {
    for (let index = 0; index < 260; index += 1) {
      recordDocumentCursorCompletionDiagnostic('request.completed', {
        event: 'cannot-overwrite-event',
        sequence: -1,
        index,
      })
    }

    const entries = readDocumentCursorCompletionDiagnostics()
    expect(entries).toHaveLength(250)
    expect(entries[0]).toMatchObject({ event: 'request.completed', index: 10 })
    expect(entries.at(-1)).toMatchObject({ event: 'request.completed', index: 259 })
    expect(entries.every((entry) => entry.sequence > 0)).toBe(true)
  })

  it('truncates text snippets and forwards structured entries to desktop diagnostics', () => {
    const log = vi.fn()
    vi.stubGlobal('window', { nxcore: { diagnostics: { log } } })

    const snippet = documentCursorCompletionSnippet(`  ${'补'.repeat(130)}  `)
    const entry = recordDocumentCursorCompletionDiagnostic('suggestion.shown', { snippet })

    expect(Array.from(snippet)).toHaveLength(123)
    expect(snippet.endsWith('...')).toBe(true)
    expect(log).toHaveBeenCalledWith({
      module: 'document-cursor-completion',
      level: 'info',
      event: entry,
    })
  })
})

describe('DocumentCursorCompletionExtension', () => {
  it('shows a ghost decoration without changing document content or requesting scroll', () => {
    const harness = createHarness()
    const position = harness.state().selection.from
    const before = harness.state().doc

    showCompletion(harness, '，这是补全文本。')

    expect(harness.state().doc.eq(before)).toBe(true)
    expect(currentCompletion(harness)).toEqual({
      position,
      text: '，这是补全文本。',
    })
    const decorations = harness.plugin.props.decorations?.call(
      harness.plugin,
      harness.state(),
    ) as DecorationSet
    expect(decorations.find()).toHaveLength(1)
    expect(decorations.find()[0]).toMatchObject({ from: position, to: position })
    expect(decorations.find()[0]?.spec).toMatchObject({
      side: 1,
      ignoreSelection: true,
      relaxedSide: true,
    })
    expect(harness.transactions).toHaveLength(1)
    expect(harness.transactions[0].docChanged).toBe(false)
    expect(harness.transactions[0].selectionSet).toBe(false)
    expect(harness.transactions[0].scrolledIntoView).toBe(false)
  })

  it('does not render a ghost while the editor is composing', () => {
    const harness = createHarness()
    const position = harness.state().selection.from
    Object.defineProperty(harness.editor.view, 'composing', {
      configurable: true,
      value: true,
    })

    showDocumentCursorCompletion(harness.editor, {
      position,
      text: '输入法期间不显示',
    })

    expect(currentCompletion(harness)).toBeNull()
  })

  it('accepts with one transaction and one undo restores only the completion', () => {
    const harness = createHarness()
    harness.view.dispatch(harness.state().tr.insertText('刚输入'))
    const beforeAcceptance = harness.state().doc
    showCompletion(harness, '，这是补全。')
    harness.transactions.splice(0)
    const event = keyEvent('Tab')

    expect(handleKeyDown(harness, event)).toBe(true)

    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(harness.state().doc.textContent).toBe('已有正文刚输入，这是补全。')
    expect(currentCompletion(harness)).toBeNull()
    expect(harness.transactions).toHaveLength(1)
    expect(harness.transactions[0].docChanged).toBe(true)
    expect(harness.transactions[0].steps).toHaveLength(1)
    expect(harness.transactions[0].scrolledIntoView).toBe(false)

    expect(undo(harness.state(), harness.view.dispatch)).toBe(true)
    expect(harness.state().doc.eq(beforeAcceptance)).toBe(true)
  })

  it('consumes only the overlapping ghost prefix when the user keeps typing', () => {
    const harness = createHarness()
    const originalPosition = harness.state().selection.from
    showCompletion(harness, 'tion test()')

    harness.view.dispatch(harness.state().tr.insertText('t'))

    expect(harness.state().doc.textContent).toBe('已有正文t')
    expect(currentCompletion(harness)).toEqual({
      position: originalPosition + 1,
      text: 'ion test()',
    })

    harness.view.dispatch(harness.state().tr.insertText('x'))
    expect(harness.state().doc.textContent).toBe('已有正文tx')
    expect(currentCompletion(harness)).toBeNull()
  })

  it('accepts multiline code inside the same code block with one undo', () => {
    const harness = createHarness({
      type: 'doc',
      content: [{
        type: 'codeBlock',
        attrs: { language: 'typescript' },
        content: [{ type: 'text', text: 'const value = 1' }],
      }],
    })
    const beforeAcceptance = harness.state().doc
    showCompletion(harness, '\n  return value')
    expect(currentCompletion(harness)).toMatchObject({ text: '\n  return value' })
    harness.transactions.splice(0)

    expect(handleKeyDown(harness, keyEvent('Tab'))).toBe(true)

    expect(harness.state().doc.firstChild?.type.name).toBe('codeBlock')
    expect(harness.state().doc.firstChild?.textContent).toBe('const value = 1\n  return value')
    expect(harness.transactions).toHaveLength(1)
    expect(harness.transactions[0].steps).toHaveLength(1)
    expect(undo(harness.state(), harness.view.dispatch)).toBe(true)
    expect(harness.state().doc.eq(beforeAcceptance)).toBe(true)
  })

  it('accepts inline list text without creating another list item', () => {
    const harness = createHarness({
      type: 'doc',
      content: [{
        type: 'bulletList',
        content: [{
          type: 'listItem',
          content: [{
            type: 'paragraph',
            content: [{ type: 'text', text: '第一项' }],
          }],
        }],
      }],
    })
    showCompletion(harness, '，补充说明')
    expect(currentCompletion(harness)).toMatchObject({ text: '，补充说明' })

    expect(handleKeyDown(harness, keyEvent('Tab'))).toBe(true)

    const list = harness.state().doc.firstChild
    expect(list?.type.name).toBe('bulletList')
    expect(list?.childCount).toBe(1)
    expect(list?.firstChild?.type.name).toBe('listItem')
    expect(list?.firstChild?.textContent).toBe('第一项，补充说明')
  })

  it('keeps active rich-text marks when accepting the ghost', () => {
    const harness = createHarness({
      type: 'doc',
      content: [{
        type: 'paragraph',
        content: [{ type: 'text', marks: [{ type: 'bold' }], text: '重点内容' }],
      }],
    })
    showCompletion(harness, '继续补全')

    expect(handleKeyDown(harness, keyEvent('Tab'))).toBe(true)

    const textNode = harness.state().doc.firstChild?.firstChild
    expect(textNode?.text).toBe('重点内容继续补全')
    expect(textNode?.marks.map((mark) => mark.type.name)).toContain('bold')
  })

  it('strikes the wrong suffix and replaces it with one undoable transaction', () => {
    const harness = createHarness()
    const position = harness.state().selection.from
    const beforeAcceptance = harness.state().doc
    showCompletion(harness, '修正', position - 2)

    const decorations = harness.plugin.props.decorations?.call(
      harness.plugin,
      harness.state(),
    ) as DecorationSet
    expect(decorations.find()).toHaveLength(2)
    expect(decorations.find(position - 2, position)[0]).toMatchObject({
      from: position - 2,
      to: position,
    })
    harness.transactions.splice(0)

    expect(handleKeyDown(harness, keyEvent('Tab'))).toBe(true)
    expect(harness.state().doc.textContent).toBe('已有修正')
    expect(harness.transactions).toHaveLength(1)
    expect(harness.transactions[0].steps).toHaveLength(1)
    expect(undo(harness.state(), harness.view.dispatch)).toBe(true)
    expect(harness.state().doc.eq(beforeAcceptance)).toBe(true)
  })

  it('clears the suggestion on Escape without changing the document', () => {
    const harness = createHarness()
    const before = harness.state().doc
    showCompletion(harness, '，这是补全。')
    const event = keyEvent('Escape')

    expect(handleKeyDown(harness, event)).toBe(true)

    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(currentCompletion(harness)).toBeNull()
    expect(harness.state().doc.eq(before)).toBe(true)
  })

  it('does not intercept Tab when there is no suggestion', () => {
    const harness = createHarness()
    const event = keyEvent('Tab')

    expect(handleKeyDown(harness, event)).toBe(false)

    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(harness.transactions).toHaveLength(0)
  })

  it('does not accept a suggestion while an input method is composing', () => {
    const harness = createHarness()
    showCompletion(harness, '，这是补全。')
    const event = keyEvent('Tab', { isComposing: true })
    const view = {
      state: harness.state(),
      composing: true,
      dispatch: vi.fn(),
    } as unknown as EditorView

    expect(handleKeyDown(harness, event, view)).toBe(false)

    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(view.dispatch).not.toHaveBeenCalled()
    expect(currentCompletion(harness)).not.toBeNull()
  })

  it('does not consume Escape while an input method is composing', () => {
    const harness = createHarness()
    showCompletion(harness, '，这是补全。')
    const event = keyEvent('Escape', { isComposing: true })
    const view = {
      state: harness.state(),
      composing: true,
      dispatch: vi.fn(),
    } as unknown as EditorView

    expect(handleKeyDown(harness, event, view)).toBe(false)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(view.dispatch).not.toHaveBeenCalled()
    expect(currentCompletion(harness)).not.toBeNull()
  })

  it('clears the ghost on navigation keys without blocking cursor movement', () => {
    const harness = createHarness()
    showCompletion(harness, '，这是补全。')
    const event = keyEvent('ArrowLeft')

    expect(handleKeyDown(harness, event)).toBe(false)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(currentCompletion(harness)).toBeNull()
  })
})

function createContextEditor(
  content: Record<string, unknown>,
  extensions: Array<typeof TaskList | typeof TaskItem> = [],
): Editor {
  const editor = new Editor({
    extensions: [StarterKit, ...extensions, DocumentCursorCompletionExtension],
    content,
  })
  editors.push(editor)
  editor.view.updateState(EditorState.create({
    schema: editor.schema,
    doc: editor.state.doc,
    selection: TextSelection.create(editor.state.doc, lastNonEmptyTextblockEnd(editor.state.doc)),
    plugins: editor.extensionManager.plugins,
  }))
  return editor
}

describe('document cursor completion format context', () => {
  it('captures code language and the current code line prefix', () => {
    const editor = createContextEditor({
      type: 'doc',
      content: [{
        type: 'codeBlock',
        attrs: { language: 'typescript' },
        content: [{ type: 'text', text: 'function value() {\n  ret' }],
      }],
    })

    expect(documentCursorCompletionContext(editor)).toMatchObject({
      blockType: 'codeBlock',
      blockPrefix: 'function value() {\n  ret',
      formatContext: {
        ancestorTypes: ['doc', 'codeBlock'],
        activeMarks: [],
        codeLanguage: 'typescript',
        codeLinePrefix: '  ret',
      },
    })
  })

  it('captures the nearest nested list and its depth without changing the block type', () => {
    const editor = createContextEditor({
      type: 'doc',
      content: [{
        type: 'orderedList',
        attrs: { start: 3 },
        content: [{
          type: 'listItem',
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: '父条目' }] },
            {
              type: 'bulletList',
              content: [{
                type: 'listItem',
                content: [{
                  type: 'paragraph',
                  content: [{ type: 'text', text: '子条目内容' }],
                }],
              }],
            },
          ],
        }],
      }],
    })

    expect(documentCursorCompletionContext(editor)).toMatchObject({
      blockType: 'paragraph',
      formatContext: {
        ancestorTypes: ['doc', 'orderedList', 'listItem', 'bulletList', 'listItem', 'paragraph'],
        list: { type: 'bulletList', depth: 2, itemType: 'listItem' },
      },
    })
  })

  it('captures task state and heading marks from schema nodes', () => {
    const taskEditor = createContextEditor({
      type: 'doc',
      content: [{
        type: 'taskList',
        content: [{
          type: 'taskItem',
          attrs: { checked: true },
          content: [{
            type: 'paragraph',
            content: [{ type: 'text', text: '已经完成任务' }],
          }],
        }],
      }],
    }, [TaskList, TaskItem])
    expect(documentCursorCompletionContext(taskEditor)?.formatContext.list).toEqual({
      type: 'taskList',
      depth: 1,
      itemType: 'taskItem',
      checked: true,
    })

    const headingEditor = createContextEditor({
      type: 'doc',
      content: [{
        type: 'heading',
        attrs: { level: 2 },
        content: [{ type: 'text', marks: [{ type: 'code' }], text: '接口设计' }],
      }],
    })
    expect(documentCursorCompletionContext(headingEditor)).toMatchObject({
      blockType: 'heading',
      formatContext: {
        ancestorTypes: ['doc', 'heading'],
        activeMarks: ['code'],
        headingLevel: 2,
      },
    })
  })

  it('captures a bounded schema-aware snapshot around the current block', () => {
    const editor = createContextEditor({
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: '背景' }] },
        { type: 'paragraph', content: [{ type: 'text', text: '当前段落内容' }] },
      ],
    })

    expect(documentCursorCompletionContext(editor)?.nearbyBlocks).toEqual([
      expect.objectContaining({
        relation: 'previous',
        type: 'heading',
        text: '背景',
        ancestorTypes: ['doc', 'heading'],
        attrs: expect.objectContaining({ level: 2 }),
      }),
      expect.objectContaining({
        relation: 'current',
        type: 'paragraph',
        text: '当前段落内容',
        ancestorTypes: ['doc', 'paragraph'],
      }),
    ])
  })

  it('collects only the three nearest text blocks in each direction', () => {
    const editor = createContextEditor({
      type: 'doc',
      content: [
        ...Array.from({ length: 5 }, (_, index) => ({
          type: 'paragraph',
          content: [{ type: 'text', text: `前${String(index)}` }],
        })),
        { type: 'paragraph', content: [{ type: 'text', text: '当前' }] },
        ...Array.from({ length: 5 }, (_, index) => ({
          type: 'paragraph',
          content: [{ type: 'text', text: `后${String(index)}` }],
        })),
      ],
    })
    let currentPosition = 1
    editor.state.doc.descendants((node, position) => {
      if (node.isTextblock && node.textContent === '当前') currentPosition = position + node.nodeSize - 1
    })
    editor.view.updateState(editor.state.apply(editor.state.tr.setSelection(
      TextSelection.create(editor.state.doc, currentPosition),
    )))

    expect(documentCursorCompletionContext(editor)?.nearbyBlocks.map(({ relation, text }) => ({
      relation,
      text,
    }))).toEqual([
      { relation: 'previous', text: '前2' },
      { relation: 'previous', text: '前3' },
      { relation: 'previous', text: '前4' },
      { relation: 'current', text: '当前' },
      { relation: 'next', text: '后0' },
      { relation: 'next', text: '后1' },
      { relation: 'next', text: '后2' },
    ])
  })

  it('keeps the current block suffix separate for FIM completion', () => {
    const editor = createContextEditor({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: '前半后半' }] }],
    })
    editor.view.updateState(editor.state.apply(editor.state.tr.setSelection(
      TextSelection.create(editor.state.doc, 3),
    )))

    expect(documentCursorCompletionContext(editor)).toMatchObject({
      blockPrefix: '前半',
      blockSuffix: '后半',
      contextAfter: '后半',
    })
  })
})

class MockInputEvent extends Event {
  data: string | null
  inputType: string
  isComposing: boolean

  constructor(type: string, init: { data?: string; inputType?: string; isComposing?: boolean } = {}) {
    super(type)
    this.data = init.data ?? null
    this.inputType = init.inputType ?? ''
    this.isComposing = init.isComposing ?? false
  }
}

class MockCompositionEvent extends Event {
  data: string

  constructor(type: string, init: { data?: string } = {}) {
    super(type)
    this.data = init.data ?? ''
  }
}

class MockKeyboardEvent extends Event {
  key: string
  isComposing: boolean

  constructor(type: string, init: { key: string; isComposing?: boolean }) {
    super(type)
    this.key = init.key
    this.isComposing = init.isComposing ?? false
  }
}

function createHookEditor(
  initialContent: string | Record<string, unknown> = '已有正文',
) {
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
    insertText: (text: string) => view.dispatch(state.tr.insertText(text)),
    deleteBackward: (count = 1) => {
      const end = state.selection.from
      view.dispatch(state.tr.delete(Math.max(1, end - count), end))
    },
    moveSelection: () => view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, 1))),
    moveSelectionTo: (position: number) => view.dispatch(
      state.tr.setSelection(TextSelection.create(state.doc, position)),
    ),
    selectCurrentTextBlock: () => view.dispatch(state.tr.setSelection(TextSelection.create(
      state.doc,
      state.selection.$from.start(),
      state.selection.$from.end(),
    ))),
    deleteSelection: () => view.dispatch(state.tr.deleteSelection()),
  }
}

function CompletionHook({ editor, enabled = true }: { editor: Editor; enabled?: boolean }) {
  const running = useDocumentCursorCompletion({
    editor,
    roomId: 'room-1',
    documentName: '测试文档',
    enabled,
  })
  return React.createElement('span', { 'data-running': running })
}

describe('useDocumentCursorCompletion input method commits', () => {
  function setup(initialContent: string | Record<string, unknown> = '已有正文') {
    vi.useFakeTimers()
    vi.stubGlobal('InputEvent', MockInputEvent)
    vi.stubGlobal('CompositionEvent', MockCompositionEvent)
    vi.stubGlobal('window', {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
      nxcore: { cursorCompletionAgent: {} },
    })
    vi.mocked(streamDocumentCursorCompletion).mockResolvedValue({ text: '补全结果', replaceCharacters: 0 })
    const hookEditor = createHookEditor(initialContent)
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(React.createElement(CompletionHook, {
        editor: hookEditor.editor,
      }))
    })
    return {
      ...hookEditor,
      renderer,
      isRunning: () => renderer.root.findByType('span').props['data-running'] === true,
    }
  }

  function typeText(dom: EventTarget, insertText: (text: string) => void, text: string) {
    dom.dispatchEvent(new MockInputEvent('beforeinput', { data: text, inputType: 'insertText' }))
    insertText(text)
    dom.dispatchEvent(new MockInputEvent('input', { data: text, inputType: 'insertText' }))
  }

  it('requests a completion after exactly two normally typed characters and 700ms', async () => {
    const { dom, insertText, renderer } = setup()

    typeText(dom, insertText, '普通')
    await act(async () => { await vi.advanceTimersByTimeAsync(699) })
    expect(streamDocumentCursorCompletion).not.toHaveBeenCalled()
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })

    expect(streamDocumentCursorCompletion).toHaveBeenCalledTimes(1)
    expect(vi.mocked(streamDocumentCursorCompletion).mock.calls[0]?.[1]).toMatchObject({
      blockType: 'paragraph',
      blockSuffix: '',
      formatContext: {
        ancestorTypes: ['doc', 'paragraph'],
        activeMarks: [],
      },
      nearbyBlocks: [expect.objectContaining({
        relation: 'current',
        type: 'paragraph',
        text: '已有正文普通',
      })],
    })
    act(() => renderer.unmount())
  })

  it('reports running only while an active completion request is in flight', async () => {
    const pending = deferred<{ text: string; replaceCharacters: number }>()
    const { dom, insertText, isRunning, renderer } = setup()
    vi.mocked(streamDocumentCursorCompletion).mockImplementation(() => pending.promise)

    expect(isRunning()).toBe(false)
    typeText(dom, insertText, '普通')
    await act(async () => { await vi.advanceTimersByTimeAsync(699) })
    expect(isRunning()).toBe(false)

    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(isRunning()).toBe(true)

    await act(async () => {
      pending.resolve({ text: '补全结果', replaceCharacters: 0 })
      await pending.promise
      await Promise.resolve()
    })
    expect(isRunning()).toBe(false)
    const diagnostics = readDocumentCursorCompletionDiagnostics()
    const started = diagnostics.find((entry) => entry.event === 'request.started')
    expect(started).toMatchObject({ trigger: 'typing', blockType: 'paragraph' })
    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: 'request.completed',
      requestId: started?.requestId,
      suggestion: '补全结果',
    }))
    act(() => renderer.unmount())
  })

  it('stops reporting running as soon as an active request is cancelled', async () => {
    const pending = deferred<{ text: string; replaceCharacters: number }>()
    const { dom, insertText, isRunning, renderer } = setup()
    vi.mocked(streamDocumentCursorCompletion).mockImplementation(() => pending.promise)

    typeText(dom, insertText, '普通')
    await act(async () => { await vi.advanceTimersByTimeAsync(700) })
    expect(isRunning()).toBe(true)

    act(() => dom.dispatchEvent(new Event('pointerdown')))
    expect(isRunning()).toBe(false)
    expect(readDocumentCursorCompletionDiagnostics()).toContainEqual(expect.objectContaining({
      event: 'request.cancelled',
      reason: 'pointer_down',
    }))

    await act(async () => {
      pending.resolve({ text: '迟到的补全结果', replaceCharacters: 0 })
      await pending.promise
      await Promise.resolve()
    })
    expect(isRunning()).toBe(false)
    act(() => renderer.unmount())
  })

  it('cancels the active request and clears its ghost when disabled', async () => {
    const pending = deferred<{ text: string; replaceCharacters: number }>()
    let onSuggestion: ((suggestion: { text: string; replaceCharacters: number }) => void) | null = null
    let signal: AbortSignal | null = null
    const { dom, editor, insertText, isRunning, renderer } = setup()
    vi.mocked(streamDocumentCursorCompletion).mockImplementation((_api, _input, options) => {
      onSuggestion = options.onSuggestion
      signal = options.signal
      return pending.promise
    })

    typeText(dom, insertText, '普通')
    await act(async () => { await vi.advanceTimersByTimeAsync(700) })
    act(() => onSuggestion?.({ text: '补全内容', replaceCharacters: 0 }))
    expect(isRunning()).toBe(true)
    expect(currentDocumentCursorCompletion(editor)).not.toBeNull()

    act(() => renderer.update(React.createElement(CompletionHook, { editor, enabled: false })))

    expect(signal?.aborted).toBe(true)
    expect(isRunning()).toBe(false)
    expect(currentDocumentCursorCompletion(editor)).toBeNull()
    pending.reject(new DOMException('cancelled', 'AbortError'))
    await act(async () => { await Promise.resolve() })
    act(() => renderer.unmount())
  })

  it('can trigger after two characters in a new empty paragraph', async () => {
    const { dom, insertText, renderer } = setup('')

    typeText(dom, insertText, '文档')
    await act(async () => { await vi.advanceTimersByTimeAsync(700) })

    expect(streamDocumentCursorCompletion).toHaveBeenCalledTimes(1)
    act(() => renderer.unmount())
  })

  it('reuses an in-flight FIM request when new input overlaps its prefix', async () => {
    const pending = deferred<{ text: string; replaceCharacters: number }>()
    let onSuggestion: ((suggestion: { text: string; replaceCharacters: number }) => void) | null = null
    let signal: AbortSignal | null = null
    const { dom, editor, insertText, renderer } = setup()
    vi.mocked(streamDocumentCursorCompletion).mockImplementation((_api, _input, options) => {
      onSuggestion = options.onSuggestion
      signal = options.signal
      return pending.promise
    })

    typeText(dom, insertText, 'func')
    await act(async () => { await vi.advanceTimersByTimeAsync(700) })
    typeText(dom, insertText, 't')

    expect(signal?.aborted).toBe(false)
    act(() => onSuggestion?.({ text: 'tion test() {', replaceCharacters: 0 }))
    expect(currentDocumentCursorCompletion(editor)).toEqual({
      position: editor.state.selection.from,
      text: 'ion test() {',
    })

    await act(async () => {
      pending.resolve({ text: 'tion test() {', replaceCharacters: 0 })
      await pending.promise
      await Promise.resolve()
    })
    act(() => renderer.unmount())
  })

  it('keeps streaming when the user types past a fully consumed partial ghost', async () => {
    const pending = deferred<{ text: string; replaceCharacters: number }>()
    let onSuggestion: ((suggestion: { text: string; replaceCharacters: number }) => void) | null = null
    let signal: AbortSignal | null = null
    const { dom, editor, insertText, renderer } = setup()
    vi.mocked(streamDocumentCursorCompletion).mockImplementation((_api, _input, options) => {
      onSuggestion = options.onSuggestion
      signal = options.signal
      return pending.promise
    })

    typeText(dom, insertText, 'func')
    await act(async () => { await vi.advanceTimersByTimeAsync(700) })
    act(() => onSuggestion?.({ text: 't', replaceCharacters: 0 }))
    typeText(dom, insertText, 't')
    typeText(dom, insertText, 'i')

    expect(signal?.aborted).toBe(false)
    act(() => onSuggestion?.({ text: 'tion test()', replaceCharacters: 0 }))
    expect(currentDocumentCursorCompletion(editor)).toEqual({
      position: editor.state.selection.from,
      text: 'on test()',
    })

    pending.reject(new DOMException('cancelled', 'AbortError'))
    await act(async () => { await Promise.resolve() })
    act(() => renderer.unmount())
  })

  it('aborts an in-flight request when typed text conflicts with a visible ghost', async () => {
    const pending = deferred<{ text: string; replaceCharacters: number }>()
    let onSuggestion: ((suggestion: { text: string; replaceCharacters: number }) => void) | null = null
    let signal: AbortSignal | null = null
    const { dom, insertText, renderer } = setup()
    vi.mocked(streamDocumentCursorCompletion).mockImplementation((_api, _input, options) => {
      onSuggestion = options.onSuggestion
      signal = options.signal
      return pending.promise
    })

    typeText(dom, insertText, '普通')
    await act(async () => { await vi.advanceTimersByTimeAsync(700) })
    act(() => onSuggestion?.({ text: 'tion', replaceCharacters: 0 }))
    typeText(dom, insertText, 'x')

    expect(signal?.aborted).toBe(true)
    pending.reject(new DOMException('cancelled', 'AbortError'))
    await act(async () => { await Promise.resolve() })
    act(() => renderer.unmount())
  })

  it('maps only a locally verified typo correction to the preceding token', async () => {
    const { dom, editor, insertText, renderer } = setup()
    vi.mocked(streamDocumentCursorCompletion).mockResolvedValue({
      text: 'function()',
      replaceCharacters: 8,
    })

    typeText(dom, insertText, 'fucntion')
    await act(async () => { await vi.advanceTimersByTimeAsync(700) })

    const position = editor.state.selection.from
    expect(currentDocumentCursorCompletion(editor)).toEqual({
      position,
      text: 'function()',
      replaceFrom: position - 8,
    })
    act(() => renderer.unmount())
  })

  it('keeps a Chinese semantic continuation insertion-only even if replacement is requested', async () => {
    const { dom, editor, insertText, renderer } = setup()
    vi.mocked(streamDocumentCursorCompletion).mockResolvedValue({
      text: '错误',
      replaceCharacters: 10,
    })

    typeText(dom, insertText, '这有助于在编译时捕获潜在')
    await act(async () => { await vi.advanceTimersByTimeAsync(700) })

    expect(currentDocumentCursorCompletion(editor)).toEqual({
      position: editor.state.selection.from,
      text: '错误',
    })
    act(() => renderer.unmount())
  })

  it('does not request a completion after one normally typed character pauses', async () => {
    const { dom, insertText, renderer } = setup()

    typeText(dom, insertText, '单')
    await act(async () => { await vi.advanceTimersByTimeAsync(700) })

    expect(streamDocumentCursorCompletion).not.toHaveBeenCalled()
    act(() => renderer.unmount())
  })

  it('requests a completion after the cursor rests at an unfinished block end', async () => {
    const { editor, moveSelectionTo, renderer } = setup('这是一段还没写完')
    const end = editor.state.doc.content.size - 1

    moveSelectionTo(2)
    moveSelectionTo(end)
    await act(async () => { await vi.advanceTimersByTimeAsync(699) })
    expect(streamDocumentCursorCompletion).not.toHaveBeenCalled()
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })

    expect(streamDocumentCursorCompletion).toHaveBeenCalledTimes(1)
    expect(vi.mocked(streamDocumentCursorCompletion).mock.calls[0]?.[1]).toMatchObject({
      blockPrefix: '这是一段还没写完',
      blockSuffix: '',
    })
    act(() => renderer.unmount())
  })

  it('does not request after moving to the end of a completed sentence', async () => {
    const { editor, moveSelectionTo, renderer } = setup('这是一段完整内容。')
    const end = editor.state.doc.content.size - 1

    moveSelectionTo(2)
    moveSelectionTo(end)
    await act(async () => { await vi.advanceTimersByTimeAsync(700) })

    expect(streamDocumentCursorCompletion).not.toHaveBeenCalled()
    act(() => renderer.unmount())
  })

  it('requests FIM completion after one character is inserted in the middle', async () => {
    const { dom, insertText, moveSelectionTo, renderer } = setup('前半段后半段')
    moveSelectionTo(4)

    typeText(dom, insertText, '补')
    await act(async () => { await vi.advanceTimersByTimeAsync(700) })

    expect(streamDocumentCursorCompletion).toHaveBeenCalledTimes(1)
    expect(vi.mocked(streamDocumentCursorCompletion).mock.calls[0]?.[1]).toMatchObject({
      blockPrefix: '前半段补',
      blockSuffix: '后半段',
      contextAfter: expect.stringContaining('后半段'),
    })
    act(() => renderer.unmount())
  })

  it('requests FIM completion when the cursor rests at a natural gap in a block', async () => {
    const { moveSelectionTo, renderer } = setup('前半段，后半段')
    moveSelectionTo(5)
    await act(async () => { await vi.advanceTimersByTimeAsync(700) })

    expect(streamDocumentCursorCompletion).toHaveBeenCalledTimes(1)
    expect(vi.mocked(streamDocumentCursorCompletion).mock.calls[0]?.[1]).toMatchObject({
      blockPrefix: '前半段，',
      blockSuffix: '后半段',
    })
    act(() => renderer.unmount())
  })

  it('requests a completion after manually deleting part of the current sentence', async () => {
    const { deleteBackward, dom, renderer } = setup()

    deleteBackward(1)
    dom.dispatchEvent(new MockInputEvent('input', {
      inputType: 'deleteContentBackward',
    }))
    await act(async () => { await vi.advanceTimersByTimeAsync(699) })
    expect(streamDocumentCursorCompletion).not.toHaveBeenCalled()
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })

    expect(streamDocumentCursorCompletion).toHaveBeenCalledTimes(1)
    act(() => renderer.unmount())
  })

  it('requests completion after a long selection leaves the current block empty', async () => {
    const { deleteSelection, dom, selectCurrentTextBlock, renderer } = setup({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: '前文提供补全上下文。' }] },
        { type: 'paragraph', content: [{ type: 'text', text: '这一整段会被选中删除' }] },
      ],
    })

    selectCurrentTextBlock()
    dom.dispatchEvent(new MockInputEvent('beforeinput', {
      inputType: 'deleteContentBackward',
    }))
    deleteSelection()
    dom.dispatchEvent(new MockInputEvent('input', {
      inputType: 'deleteContentBackward',
    }))
    await act(async () => { await vi.advanceTimersByTimeAsync(700) })

    expect(streamDocumentCursorCompletion).toHaveBeenCalledTimes(1)
    expect(vi.mocked(streamDocumentCursorCompletion).mock.calls[0]?.[1]).toMatchObject({
      blockPrefix: '',
      blockSuffix: '',
      contextBefore: expect.stringContaining('前文提供补全上下文。'),
      nearbyBlocks: [
        expect.objectContaining({ relation: 'previous', text: '前文提供补全上下文。' }),
        expect.objectContaining({ relation: 'current', text: '' }),
      ],
    })
    act(() => renderer.unmount())
  })

  it('requests completion when ProseMirror deletes a mouse-dragged selection on keydown', async () => {
    const { deleteSelection, dom, selectCurrentTextBlock, renderer } = setup({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: '前文提供补全上下文。' }] },
        { type: 'paragraph', content: [{ type: 'text', text: '鼠标拖选这一整段' }] },
      ],
    })

    dom.dispatchEvent(new Event('pointerdown'))
    selectCurrentTextBlock()
    dom.dispatchEvent(new MockKeyboardEvent('keydown', { key: 'Backspace' }))
    deleteSelection()
    await act(async () => { await vi.advanceTimersByTimeAsync(700) })

    expect(streamDocumentCursorCompletion).toHaveBeenCalledTimes(1)
    expect(vi.mocked(streamDocumentCursorCompletion).mock.calls[0]?.[1]).toMatchObject({
      blockPrefix: '',
      blockSuffix: '',
      contextBefore: expect.stringContaining('前文提供补全上下文。'),
    })
    act(() => renderer.unmount())
  })

  it('does not schedule completion for a programmatic selection deletion', async () => {
    const { deleteSelection, selectCurrentTextBlock, renderer } = setup('程序化删除不应触发')

    selectCurrentTextBlock()
    deleteSelection()
    await act(async () => { await vi.advanceTimersByTimeAsync(700) })

    expect(streamDocumentCursorCompletion).not.toHaveBeenCalled()
    act(() => renderer.unmount())
  })

  it('does not treat undo or input-method replacement as a manual deletion trigger', async () => {
    const { deleteBackward, dom, renderer } = setup()

    deleteBackward(1)
    dom.dispatchEvent(new MockInputEvent('input', { inputType: 'historyUndo' }))
    dom.dispatchEvent(new MockInputEvent('input', { inputType: 'deleteByComposition' }))
    await act(async () => { await vi.advanceTimersByTimeAsync(700) })

    expect(streamDocumentCursorCompletion).not.toHaveBeenCalled()
    act(() => renderer.unmount())
  })

  it('counts the final composition input once after the document transaction', async () => {
    const { dom, insertText, renderer } = setup()

    dom.dispatchEvent(new Event('compositionstart'))
    dom.dispatchEvent(new MockCompositionEvent('compositionend', { data: '中文' }))
    insertText('中文')
    dom.dispatchEvent(new MockInputEvent('input', { data: '中文', inputType: 'insertText' }))
    await act(async () => { await vi.advanceTimersByTimeAsync(700) })

    expect(streamDocumentCursorCompletion).toHaveBeenCalledTimes(1)
    act(() => renderer.unmount())
  })

  it('uses the zero-delay fallback when no final composition input arrives', async () => {
    const { dom, insertText, renderer } = setup()

    dom.dispatchEvent(new Event('compositionstart'))
    dom.dispatchEvent(new MockCompositionEvent('compositionend', { data: '中文' }))
    insertText('中文')
    await act(async () => { await vi.advanceTimersByTimeAsync(700) })

    expect(streamDocumentCursorCompletion).toHaveBeenCalledTimes(1)
    act(() => renderer.unmount())
  })

  it('does not count the same final composition input twice', async () => {
    const { dom, insertText, renderer } = setup()

    dom.dispatchEvent(new Event('compositionstart'))
    dom.dispatchEvent(new MockCompositionEvent('compositionend', { data: '中' }))
    insertText('中')
    dom.dispatchEvent(new MockInputEvent('input', { data: '中', inputType: 'insertText' }))
    await act(async () => { await vi.advanceTimersByTimeAsync(700) })

    expect(streamDocumentCursorCompletion).not.toHaveBeenCalled()
    act(() => renderer.unmount())
  })

  it('ignores a late final input after the fallback already counted the commit', async () => {
    const { dom, insertText, renderer } = setup()

    dom.dispatchEvent(new Event('compositionstart'))
    dom.dispatchEvent(new MockCompositionEvent('compositionend', { data: '中' }))
    insertText('中')
    await act(async () => { await vi.advanceTimersToNextTimerAsync() })
    dom.dispatchEvent(new MockInputEvent('input', { data: '中', inputType: 'insertText' }))
    await act(async () => { await vi.advanceTimersByTimeAsync(700) })

    expect(streamDocumentCursorCompletion).not.toHaveBeenCalled()
    act(() => renderer.unmount())
  })

  it.each(['focusout', 'pointerdown', 'selection transaction', 'document transaction'] as const)(
    'aborts an active request on %s and ignores its late result',
    async (cancellation) => {
      const pending = deferred<{ text: string; replaceCharacters: number }>()
      let signal: AbortSignal | null = null
      const { dom, editor, insertText, moveSelection, renderer } = setup()
      vi.mocked(streamDocumentCursorCompletion).mockImplementation((_api, _input, options) => {
        signal = options.signal
        return pending.promise
      })
      typeText(dom, insertText, '普通')
      await act(async () => { await vi.advanceTimersByTimeAsync(700) })
      expect(streamDocumentCursorCompletion).toHaveBeenCalledTimes(1)
      expect(signal?.aborted).toBe(false)

      if (cancellation === 'selection transaction') moveSelection()
      else if (cancellation === 'document transaction') insertText('变化')
      else dom.dispatchEvent(new Event(cancellation))

      expect(signal?.aborted).toBe(true)
      await act(async () => {
        pending.resolve({ text: '迟到的补全结果', replaceCharacters: 0 })
        await pending.promise
        await Promise.resolve()
      })
      expect(currentDocumentCursorCompletion(editor)).toBeNull()
      act(() => renderer.unmount())
    },
  )
})
