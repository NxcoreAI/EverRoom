import type {
  DocumentOperation,
  DocumentOperationCommandInput,
  DocumentOperationCommandResult,
  DocumentOperationItem,
} from '@nxcore/agent-contract'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  DocumentOperationProvider,
  type DocumentOperationContextValue,
  useDocumentOperations,
} from '../src/renderer/src/components/context-room/operations/DocumentOperationProvider'
import { useDocumentEditorOperations } from '../src/renderer/src/components/context-room/operations/useDocumentEditorOperations'
import { DocumentContinuationActions } from '../src/renderer/src/components/context-room/operations/DocumentContinuationExtension'
import type { OperationBridge } from '../src/renderer/src/components/context-room/operations/types'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function item(id: string, sequence: number, status: DocumentOperationItem['status'] = 'pending'):
DocumentOperationItem {
  return {
    id,
    operationId: 'operation-1',
    sequence,
    operation: 'insert',
    target: { at: 'end' },
    before: [],
    after: [{ type: 'paragraph', content: [{ type: 'text', text: id }] }],
    markdown: id,
    contentHash: `hash-${id}`,
    status,
    appliedVersion: status === 'applied' ? sequence + 1 : null,
    createdAt: '2026-08-17T00:00:00.000Z',
    updatedAt: '2026-08-17T00:00:00.000Z',
  }
}

function operation(overrides: Partial<DocumentOperation> = {}): DocumentOperation {
  return {
    id: 'operation-1',
    capabilityId: 'document.continue',
    capabilityVersion: 1,
    interactionMode: 'incremental_review',
    presenterKey: 'continuation',
    roomId: 'room-1',
    documentId: 'doc-1',
    documentTitle: '计划',
    sessionId: 'session-1',
    runId: 'run-1',
    baseVersion: 1,
    status: 'awaiting_review',
    revision: 1,
    summary: '继续写作',
    conflictVersion: null,
    error: null,
    expiresAt: null,
    createdAt: '2026-08-17T00:00:00.000Z',
    updatedAt: '2026-08-17T00:00:00.000Z',
    completedAt: null,
    input: {},
    result: null,
    items: [item('item-1', 1), item('item-2', 2)],
    ...overrides,
  }
}

function bridge(detail: DocumentOperation, command: OperationBridge['command']): OperationBridge {
  return {
    list: vi.fn().mockResolvedValue([detail]),
    get: vi.fn().mockResolvedValue(detail),
    command,
  }
}

async function flush(): Promise<void> {
  await act(async () => { await Promise.resolve() })
}

describe('DocumentOperationProvider React state machine', () => {
  let renderer: TestRenderer.ReactTestRenderer | null = null

  beforeEach(() => {
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })
    vi.stubGlobal('crypto', { randomUUID: vi.fn(() => 'command-id') })
  })

  afterEach(() => {
    renderer?.unmount()
    renderer = null
    vi.unstubAllGlobals()
  })

  it('opens feedback only from the disagree action and submits a revision request', async () => {
    const onAccept = vi.fn().mockResolvedValue(undefined)
    const onAcceptAll = vi.fn().mockResolvedValue(undefined)
    const onRevise = vi.fn().mockResolvedValue(undefined)
    await act(async () => {
      renderer = TestRenderer.create(
        <DocumentContinuationActions
          busy={false}
          onAccept={onAccept}
          onAcceptAll={onAcceptAll}
          onRevise={onRevise}
        />,
      )
    })

    const actionButtons = renderer.root.findAllByType('button')
    expect(actionButtons.map((button) => button.props['aria-label'])).toEqual([
      '同意当前这块',
      '同意后面所有续写',
      '不同意并提出修改意见',
    ])
    expect(renderer.root.findAllByType('textarea')).toHaveLength(0)

    act(() => actionButtons[2]!.props.onClick({ stopPropagation: vi.fn() }))
    const textarea = renderer.root.findByType('textarea')
    act(() => textarea.props.onChange({ target: { value: '增加一个失败案例' } }))
    await act(async () => {
      await renderer!.root.findByType('form').props.onSubmit({ preventDefault: vi.fn() })
    })

    expect(onRevise).toHaveBeenCalledWith('增加一个失败案例')
    expect(onAccept).not.toHaveBeenCalled()
    expect(onAcceptAll).not.toHaveBeenCalled()
  })

  it('allows requesting a different continuation without entering feedback', async () => {
    const onRevise = vi.fn().mockResolvedValue(undefined)
    await act(async () => {
      renderer = TestRenderer.create(
        <DocumentContinuationActions
          busy={false}
          onAccept={vi.fn()}
          onAcceptAll={vi.fn()}
          onRevise={onRevise}
        />,
      )
    })
    act(() => renderer!.root.findAllByType('button')[2]!.props.onClick({ stopPropagation: vi.fn() }))
    const submit = renderer.root.findAllByType('button')
      .find((button) => button.props['aria-label'] === '按意见重新续写')
    expect(submit?.props.disabled).toBe(false)
    await act(async () => {
      await renderer!.root.findByType('form').props.onSubmit({ preventDefault: vi.fn() })
    })
    expect(onRevise).toHaveBeenCalledWith('')
  })

  it('deduplicates same-tick commands and uses the latest revision for the next continuation item', async () => {
    let current = operation()
    const first = deferred<DocumentOperationCommandResult | null>()
    const command = vi.fn((_: string, input: DocumentOperationCommandInput) => {
      if (input.payload?.itemId === 'item-1') return first.promise
      current = operation({
        revision: 3,
        baseVersion: 3,
        items: [item('item-1', 1, 'applied'), item('item-2', 2, 'applied')],
      })
      return Promise.resolve({ operation: current, duplicate: false })
    })
    const api = bridge(current, command)
    let context!: DocumentOperationContextValue
    const Consumer = () => { context = useDocumentOperations(); return null }

    await act(async () => {
      renderer = TestRenderer.create(<DocumentOperationProvider operationBridge={api}><Consumer /></DocumentOperationProvider>)
    })
    await flush()

    let firstResult!: Promise<DocumentOperation | null>
    let duplicateResult!: Promise<DocumentOperation | null>
    act(() => {
      context.setDecision('operation-1', 'item-1', 'accepted')
      firstResult = context.execute('operation-1', 'item.accept', { itemId: 'item-1' })
      duplicateResult = context.execute('operation-1', 'item.accept', { itemId: 'item-1' })
    })
    expect(command).toHaveBeenCalledTimes(1)
    expect(context.entriesById['operation-1']).toMatchObject({ busy: true, decisions: { 'item-1': 'accepted' } })
    first.resolve({ operation: operation({
      revision: 2,
      baseVersion: 2,
      items: [item('item-1', 1, 'applied'), item('item-2', 2)],
    }), duplicate: false })
    await act(async () => { await Promise.all([firstResult, duplicateResult]) })

    await act(async () => { await context.execute('operation-1', 'item.accept', { itemId: 'item-2' }) })
    expect(command).toHaveBeenNthCalledWith(2, 'operation-1', expect.objectContaining({
      expectedRevision: 2,
      type: 'item.accept',
      payload: { itemId: 'item-2' },
    }))
    expect(context.entriesById['operation-1']).toMatchObject({
      revision: 3,
      busy: false,
      decisions: { 'item-1': 'accepted' },
      error: undefined,
    })
  })

  it('refreshes on 409, retains decisions, and retries with the refreshed revision', async () => {
    const conflicted = operation({ revision: 4, status: 'conflicted', conflictVersion: 2 })
    const get = vi.fn().mockResolvedValueOnce(operation()).mockResolvedValueOnce(conflicted)
    const command = vi.fn()
      .mockRejectedValueOnce({ response: { status: 409 } })
      .mockResolvedValueOnce({ operation: operation({ revision: 5 }), duplicate: false })
    const api: OperationBridge = {
      list: vi.fn().mockResolvedValue([operation()]),
      get,
      command,
    }
    let context!: DocumentOperationContextValue
    const Consumer = () => { context = useDocumentOperations(); return null }

    await act(async () => {
      renderer = TestRenderer.create(<DocumentOperationProvider operationBridge={api}><Consumer /></DocumentOperationProvider>)
    })
    await flush()
    act(() => context.setDecision('operation-1', 'item-1', 'rejected'))

    await act(async () => { await context.execute('operation-1', 'item.reject', { itemId: 'item-1' }) })
    expect(get).toHaveBeenCalledTimes(2)
    expect(context.entriesById['operation-1']).toMatchObject({
      revision: 4,
      busy: false,
      decisions: { 'item-1': 'rejected' },
    })
    await act(async () => { await context.execute('operation-1', 'item.reject', { itemId: 'item-1' }) })
    expect(command).toHaveBeenNthCalledWith(2, 'operation-1', expect.objectContaining({ expectedRevision: 4 }))
    expect(context.entriesById['operation-1']).toMatchObject({
      revision: 5,
      busy: false,
      decisions: { 'item-1': 'rejected' },
      error: undefined,
    })
  })

  it('starts selection rewrite operations and returns the authoritative command document', async () => {
    const started = operation({
      capabilityId: 'document.selection-rewrite',
      interactionMode: 'preview_replace',
      presenterKey: 'selection-rewrite',
    })
    const document = {
      id: 'doc-1',
      roomId: 'room-1',
      title: '计划',
      contentJson: { type: 'doc' as const, content: [] },
      contentSchemaVersion: 3,
      version: 2,
      status: 'active' as const,
      activeTransactionId: null,
      deletedAt: null,
      createdAt: '2026-08-17T00:00:00.000Z',
      updatedAt: '2026-08-17T00:00:01.000Z',
    }
    const api: OperationBridge = {
      list: vi.fn().mockResolvedValue([]),
      start: vi.fn().mockResolvedValue(started),
      get: vi.fn().mockResolvedValue(started),
      command: vi.fn().mockResolvedValue({
        operation: { ...started, status: 'completed', revision: 2 },
        document,
      }),
    }
    const onDocumentApplied = vi.fn()
    let context!: DocumentOperationContextValue
    const Consumer = () => { context = useDocumentOperations(); return null }

    await act(async () => {
      renderer = TestRenderer.create(
        <DocumentOperationProvider operationBridge={api} onDocumentApplied={onDocumentApplied}>
          <Consumer />
        </DocumentOperationProvider>,
      )
    })
    await flush()
    await act(async () => {
      await context.start({
        capabilityId: 'document.selection-rewrite',
        context: { roomId: 'room-1', documentId: 'doc-1', sessionId: 'session-1', runId: 'run-1' },
        input: { baseVersion: 1 },
      })
    })
    expect(context.entriesById['operation-1']).toMatchObject({ revision: 1 })

    let result: DocumentOperationCommandResult | null = null
    await act(async () => { result = await context.executeResult('operation-1', 'review.apply') })
    expect(result).toMatchObject({ document: { id: 'doc-1', version: 2 } })
    expect(onDocumentApplied).toHaveBeenCalledWith(document)
  })

  it('unmounts completed/rejected presenters and lets the next review regain focus', async () => {
    let current = operation({ capabilityId: 'document.edit', presenterKey: 'atomic-diff', interactionMode: 'atomic_review' })
    let notify: ((id: string) => void) | null = null
    const api: OperationBridge = {
      list: vi.fn().mockImplementation(async () => [current]),
      get: vi.fn().mockImplementation(async () => current),
      command: vi.fn().mockResolvedValue(null),
      subscribe: (listener) => { notify = listener; return () => { notify = null } },
    }
    let context!: DocumentOperationContextValue
    let editorState!: ReturnType<typeof useDocumentEditorOperations>
    const Consumer = () => {
      context = useDocumentOperations()
      editorState = useDocumentEditorOperations('doc-1')
      return null
    }

    await act(async () => {
      renderer = TestRenderer.create(<DocumentOperationProvider operationBridge={api}><Consumer /></DocumentOperationProvider>)
    })
    await flush()
    expect(editorState.atomicDiff?.review.id).toBe('operation-1')
    expect(editorState.locked).toBe(true)

    current = operation({
      capabilityId: 'document.edit',
      presenterKey: 'atomic-diff',
      interactionMode: 'atomic_review',
      status: 'conflicted',
      revision: 2,
    })
    await act(async () => { notify?.('operation-1'); await Promise.resolve() })
    expect(editorState.atomicDiff?.review.status).toBe('conflicted')
    expect(editorState.locked).toBe(true)

    current = { ...current, status: 'completed', revision: 3 }
    await act(async () => { notify?.('operation-1'); await Promise.resolve() })
    expect(editorState.atomicDiff).toBeNull()
    expect(editorState.locked).toBe(false)

    current = operation({
      id: 'operation-2',
      capabilityId: 'document.edit',
      presenterKey: 'atomic-diff',
      interactionMode: 'atomic_review',
      revision: 1,
      updatedAt: '2026-08-17T00:00:02.000Z',
      items: [item('item-3', 1)],
    })
    await act(async () => {
      await context.refresh()
      await context.load('operation-2')
    })
    expect(editorState.atomicDiff?.review.id).toBe('operation-2')
    expect(editorState.atomicDiff?.currentItemId).toBe('item-3')

    current = { ...current, status: 'rejected', revision: 2 }
    await act(async () => { notify?.('operation-2'); await Promise.resolve() })
    expect(editorState.atomicDiff).toBeNull()
    expect(editorState.locked).toBe(false)
  })

  it('closes stale continuation candidates and starts a feedback-guided Agent run', async () => {
    const current = operation()
    const closed = operation({
      status: 'rejected',
      revision: 2,
      baseVersion: 4,
      items: [item('item-1', 1, 'rejected'), item('item-2', 2, 'rejected')],
    })
    const command = vi.fn().mockResolvedValue({ operation: closed, duplicate: false })
    const startRun = vi.fn().mockResolvedValue({})
    const getEvents = vi.fn().mockResolvedValue([{ seq: 1, type: 'run.completed' }])
    Object.assign(window, { nxcore: { agent: { getEvents, startRun } } })
    const api = bridge(current, command)
    let editorState!: ReturnType<typeof useDocumentEditorOperations>
    const Consumer = () => {
      editorState = useDocumentEditorOperations('doc-1')
      return null
    }

    await act(async () => {
      renderer = TestRenderer.create(
        <DocumentOperationProvider operationBridge={api}><Consumer /></DocumentOperationProvider>,
      )
    })
    await flush()

    await act(async () => {
      await editorState.commands.requestContinuationRevision('item-1', '  加入一个失败案例  ')
    })

    expect(command).toHaveBeenCalledWith('operation-1', expect.objectContaining({
      type: 'review.close',
      expectedRevision: 1,
    }))
    expect(startRun).toHaveBeenCalledWith('session-1', expect.objectContaining({
      prompt: expect.stringContaining('<feedback>\n加入一个失败案例\n</feedback>'),
      context: {
        selectedRoomId: 'room-1',
        activeDocument: {
          roomId: 'room-1',
          documentId: 'doc-1',
          title: '计划',
          version: 4,
          defaultAnchor: 'end',
        },
      },
    }))
    expect(getEvents).toHaveBeenCalledWith('session-1', 'run-1', 0)
  })

  it('keeps patch markdown drafts across operation refreshes and sends only editable overrides', async () => {
    const deleteItem: DocumentOperationItem = {
      ...item('item-2', 2),
      operation: 'delete',
      before: [{ type: 'paragraph', content: [{ type: 'text', text: 'remove me' }] }],
      after: [],
      markdown: '',
    }
    let current = operation({
      capabilityId: 'document.edit',
      presenterKey: 'atomic-diff',
      interactionMode: 'atomic_review',
      items: [item('item-1', 1), deleteItem],
    })
    let notify: ((id: string) => void) | null = null
    const command = vi.fn().mockImplementation(async () => ({
      operation: { ...current, status: 'completed', revision: current.revision + 1 },
      duplicate: false,
    }))
    const api: OperationBridge = {
      list: vi.fn().mockImplementation(async () => [current]),
      get: vi.fn().mockImplementation(async () => current),
      command,
      subscribe: (listener) => { notify = listener; return () => { notify = null } },
    }
    let editorState!: ReturnType<typeof useDocumentEditorOperations>
    const Consumer = () => { editorState = useDocumentEditorOperations('doc-1'); return null }

    await act(async () => {
      renderer = TestRenderer.create(
        <DocumentOperationProvider operationBridge={api}><Consumer /></DocumentOperationProvider>,
      )
    })
    await flush()

    act(() => {
      editorState.commands.updateAtomicDiffItemDraft('item-1', '用户编辑后的 **Markdown**')
      editorState.commands.updateAtomicDiffItemDraft('item-2', '删除项不能被覆盖')
    })
    expect(editorState.atomicDiff?.markdownDrafts).toEqual({ 'item-1': '用户编辑后的 **Markdown**' })

    current = { ...current, revision: 2, updatedAt: '2026-08-17T00:00:02.000Z' }
    await act(async () => { notify?.('operation-1'); await Promise.resolve() })
    expect(editorState.atomicDiff?.markdownDrafts).toEqual({ 'item-1': '用户编辑后的 **Markdown**' })

    act(() => editorState.commands.acceptAllAtomicDiffItems())
    await vi.waitFor(() => expect(command).toHaveBeenCalledTimes(1))
    expect(command).toHaveBeenCalledWith('operation-1', expect.objectContaining({
      expectedRevision: 2,
      type: 'review.apply',
      payload: {
        acceptedItemIds: ['item-1', 'item-2'],
        replacementMarkdownByItemId: { 'item-1': '用户编辑后的 **Markdown**' },
      },
    }))
  })

  it('accepts edited continuation blocks with overrides and leaves untouched blocks authoritative', async () => {
    let current = operation()
    const command = vi.fn().mockImplementation(async (_: string, input: DocumentOperationCommandInput) => {
      if (input.payload?.itemId === 'item-1') {
        current = operation({
          revision: 2,
          baseVersion: 2,
          items: [item('item-1', 1, 'applied'), item('item-2', 2)],
        })
      } else {
        current = operation({
          revision: 3,
          baseVersion: 3,
          status: 'completed',
          items: [item('item-1', 1, 'applied'), item('item-2', 2, 'applied')],
        })
      }
      return { operation: current, duplicate: false }
    })
    const api = bridge(current, command)
    let editorState!: ReturnType<typeof useDocumentEditorOperations>
    const Consumer = () => { editorState = useDocumentEditorOperations('doc-1'); return null }

    await act(async () => {
      renderer = TestRenderer.create(
        <DocumentOperationProvider operationBridge={api}><Consumer /></DocumentOperationProvider>,
      )
    })
    await flush()
    act(() => editorState.commands.updateContinuationItemDraft('item-1', '改过的第一段'))

    await act(async () => { await editorState.commands.acceptAllContinuationItems() })

    expect(command).toHaveBeenNthCalledWith(1, 'operation-1', expect.objectContaining({
      expectedRevision: 1,
      type: 'item.accept',
      payload: { itemId: 'item-1', replacementMarkdown: '改过的第一段' },
    }))
    expect(command).toHaveBeenNthCalledWith(2, 'operation-1', expect.objectContaining({
      expectedRevision: 2,
      type: 'item.accept',
      payload: { itemId: 'item-2' },
    }))
  })

  it('does not send a continuation override when the user accepts without editing', async () => {
    const current = operation({ items: [item('item-1', 1)] })
    const command = vi.fn().mockResolvedValue({
      operation: operation({ status: 'completed', revision: 2, items: [item('item-1', 1, 'applied')] }),
      duplicate: false,
    })
    const api = bridge(current, command)
    let editorState!: ReturnType<typeof useDocumentEditorOperations>
    const Consumer = () => { editorState = useDocumentEditorOperations('doc-1'); return null }

    await act(async () => {
      renderer = TestRenderer.create(
        <DocumentOperationProvider operationBridge={api}><Consumer /></DocumentOperationProvider>,
      )
    })
    await flush()
    act(() => editorState.commands.decideContinuationItem('item-1', 'accepted'))
    await vi.waitFor(() => expect(command).toHaveBeenCalledTimes(1))

    expect(command).toHaveBeenCalledWith('operation-1', expect.objectContaining({
      type: 'item.accept',
      payload: { itemId: 'item-1' },
    }))
  })

  it('presents ordered streaming chunks for a draft document before the document row exists', async () => {
    const streamItem = (id: string, sequence: number, markdown: string): DocumentOperationItem => ({
      ...item(id, sequence),
      operation: 'stream_chunk',
      target: null,
      before: [],
      after: [],
      markdown,
    })
    let current = operation({
      capabilityId: 'document.create',
      interactionMode: 'streaming_commit',
      presenterKey: 'streaming-document',
      documentId: null,
      documentTitle: '流式草稿',
      status: 'running',
      input: { draftDocumentId: 'draft-doc-1' },
      items: [
        streamItem('chunk-2', 2, '第二段'),
        item('ignored-edit-item', 3),
        streamItem('chunk-1', 1, '第一段'),
      ],
    })
    let notify: ((id: string) => void) | null = null
    const api: OperationBridge = {
      list: vi.fn().mockImplementation(async () => [current]),
      get: vi.fn().mockImplementation(async () => current),
      command: vi.fn().mockResolvedValue(null),
      subscribe: (listener) => { notify = listener; return () => { notify = null } },
    }
    let editorState!: ReturnType<typeof useDocumentEditorOperations>
    const Consumer = () => {
      editorState = useDocumentEditorOperations('draft-doc-1')
      return null
    }

    await act(async () => {
      renderer = TestRenderer.create(
        <DocumentOperationProvider operationBridge={api}><Consumer /></DocumentOperationProvider>,
      )
    })
    await flush()

    expect(editorState.streamingDocument).toMatchObject({
      operationId: 'operation-1',
      title: '流式草稿',
      status: 'running',
      active: true,
      chunks: [
        { id: 'chunk-1', sequence: 1, markdown: '第一段' },
        { id: 'chunk-2', sequence: 2, markdown: '第二段' },
      ],
    })
    expect(editorState.locked).toBe(true)

    current = {
      ...current,
      documentId: 'draft-doc-1',
      status: 'completed',
      revision: 2,
      updatedAt: '2026-08-17T00:00:02.000Z',
    }
    await act(async () => { notify?.('operation-1'); await Promise.resolve() })
    expect(editorState.streamingDocument).toMatchObject({
      status: 'completed',
      active: false,
      revision: 2,
    })
    expect(editorState.locked).toBe(false)
  })
})
