import type { DocumentEvent, RoomDocument, TiptapJsonContent } from '@nxcore/agent-contract'
import TaskItem from '@tiptap/extension-task-item'
import TaskList from '@tiptap/extension-task-list'
import TableOfContents, { type TableOfContentData } from '@tiptap/extension-table-of-contents'
import { Markdown } from '@tiptap/markdown'
import { TextSelection } from '@tiptap/pm/state'
import { EditorContent, Extension, useEditor, type Editor, type JSONContent } from '@tiptap/react'
import { Placeholder } from '@tiptap/extensions'
import StarterKit from '@tiptap/starter-kit'
import { LoaderCircle } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { useRoomDocumentsState } from '../../../RoomDocumentsProvider'
import type { ContextRoomRecord, ContextRoomResource } from '../../types'
import { TiptapBlockHandle } from './TiptapBlockHandle'
import { TiptapBubbleToolbar } from './TiptapBubbleToolbar'
import { TiptapContentScale } from './TiptapContentScale'
import { TiptapSlashCommandMenu } from './TiptapSlashCommandMenu'
import {
  SelectionRewritePreviewExtension,
  TiptapSelectionRewritePreview,
  useTiptapSelectionRewrite,
} from './TiptapSelectionRewrite'
import {
  createRoomDocumentContent,
  readDocumentDraft,
  readDocumentDraftRecord,
  removeDocumentDraft,
  shouldRecoverDocumentDraft,
  writeDocumentDraft,
} from './documentDraftStorage'
import {
  AppliedSequenceTracker,
  assignStableBlockIds,
  countTiptapTextCharacters,
  documentStreamCharactersPerFrame,
  documentStreamRevealDelay,
  isAgentDocumentAwaitingContent,
  isEmptyTiptapParagraph,
  MarkdownBlockBuffer,
  revealTiptapNode,
  tiptapTextContent,
} from './markdownStream'
import { useTransientEditorInteractions } from './useTransientEditorInteractions'
import './TiptapDocumentEditor.css'

const StableBlockIds = Extension.create({
  name: 'stableBlockIds',
  addGlobalAttributes() {
    return [{
      types: ['paragraph', 'heading', 'bulletList', 'orderedList', 'taskList', 'blockquote', 'codeBlock', 'horizontalRule'],
      attributes: {
        id: {
          default: null,
          parseHTML: (element) => element.getAttribute('data-block-id'),
          renderHTML: (attributes) => attributes.id ? { 'data-block-id': String(attributes.id) } : {},
        },
      },
    }]
  },
})

interface StreamState {
  buffer: MarkdownBlockBuffer
  ordinal: number
  sequences: AppliedSequenceTracker
  processed: Set<string>
  scheduled: Set<string>
  queue: Promise<void>
  closed: boolean
}

const streamStateGlobal = globalThis as typeof globalThis & {
  __everroomDocumentStreamStates?: Map<string, StreamState>
}
const streamStates = streamStateGlobal.__everroomDocumentStreamStates ?? new Map<string, StreamState>()
streamStateGlobal.__everroomDocumentStreamStates = streamStates

function eventNumber(event: DocumentEvent, key: 'sequence' | 'finalSequence'): number | null {
  if (!event.payload || typeof event.payload !== 'object') return null
  const value = (event.payload as Record<string, unknown>)[key]
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null
}

function eventText(event: DocumentEvent): string | null {
  if (!event.payload || typeof event.payload !== 'object') return null
  const value = (event.payload as Record<string, unknown>).text
  return typeof value === 'string' ? value : null
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds))
}

function sameContent(left: TiptapJsonContent, right: TiptapJsonContent): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

async function insertMarkdownBlocks(
  editor: Editor,
  state: StreamState,
  transactionId: string,
  markdownBlocks: string[],
  applyingRemote: { current: boolean },
  shouldFollowStream: () => boolean,
  followStream: () => void,
): Promise<boolean> {
  const nodes: TiptapJsonContent[] = []
  for (const markdown of markdownBlocks) {
    const parsed = editor.storage.markdown.manager.parse(markdown) as TiptapJsonContent
    const parsedNodes = (parsed.content ?? []).filter((node) => !isEmptyTiptapParagraph(node))
    const stable = assignStableBlockIds(parsedNodes, transactionId, state.ordinal)
    state.ordinal = stable.nextOrdinal
    nodes.push(...stable.nodes)
  }

  const totalCharacters = nodes.reduce(
    (total, node) => total + countTiptapTextCharacters(node),
    0,
  )
  const charactersPerFrame = documentStreamCharactersPerFrame(totalCharacters)

  for (const node of nodes) {
    if (state.closed || editor.isDestroyed) return false
    const nodeCharacters = countTiptapTextCharacters(node)
    const nodeText = Array.from(tiptapTextContent(node))
    const initialDocumentSize = editor.state.doc.content.size
    const json = editor.getJSON()
    const trailingNode = editor.state.doc.lastChild
    const replaceTrailingParagraph = isEmptyTiptapParagraph(json.content?.at(-1))
    const previewFrom = replaceTrailingParagraph && trailingNode
      ? initialDocumentSize - trailingNode.nodeSize
      : initialDocumentSize
    let previewTo = initialDocumentSize
    const frameCount = Math.max(1, Math.ceil(nodeCharacters / charactersPerFrame))

    for (let frame = 1; frame <= frameCount; frame += 1) {
      if (state.closed || editor.isDestroyed) return false
      const revealedCharacters = Math.min(nodeCharacters, frame * charactersPerFrame)
      const previousCharacters = Math.max(0, (frame - 1) * charactersPerFrame)
      const preview = revealTiptapNode(node, revealedCharacters)
      const proseMirrorNode = editor.schema.nodeFromJSON(preview as JSONContent)
      applyingRemote.current = true
      try {
        const transaction = editor.state.tr
          .replaceWith(previewFrom, previewTo, proseMirrorNode)
          .setMeta('preventUpdate', true)
        if (frame > 1) transaction.setMeta('addToHistory', false)
        const followingStream = shouldFollowStream()
        if (followingStream && editor.view.hasFocus()) {
          transaction
            .setSelection(TextSelection.atEnd(transaction.doc))
            .scrollIntoView()
        }
        editor.view.dispatch(transaction)
        if (followingStream) followStream()
        previewTo = previewFrom + proseMirrorNode.nodeSize
      } finally {
        applyingRemote.current = false
      }
      const revealedText = nodeText.slice(previousCharacters, revealedCharacters).join('')
      await wait(documentStreamRevealDelay(
        frame === frameCount ? `${revealedText}\n` : revealedText,
      ))
    }
  }
  return true
}

export function TiptapDocumentEditor({
  room,
  resource,
  backendDocument,
  events,
  onBackendDocumentChange,
}: {
  room: ContextRoomRecord
  resource?: ContextRoomResource | null
  backendDocument: RoomDocument | null
  events: DocumentEvent[]
  onBackendDocumentChange: (document: RoomDocument) => void
}) {
  const documentId = resource?.kind === 'cloud-doc' ? resource.binding.docId : room.cloudDoc.docId
  const documentName = backendDocument?.title ?? resource?.name ?? room.cloudDoc.title ?? room.title
  const initialDraft = useState(() => readDocumentDraftRecord(documentId))[0]
  const canRecoverInitialDraft = !backendDocument?.activeTransactionId
    && shouldRecoverDocumentDraft(initialDraft, backendDocument)
  const initialContent = useState<JSONContent>(() => (
    canRecoverInitialDraft
      ? initialDraft!.content
      : backendDocument?.contentJson ?? readDocumentDraft(documentId) ?? createRoomDocumentContent(room, documentName)
  ))[0]
  const saveTimer = useRef<number | null>(null)
  const saveInFlight = useRef(false)
  const pendingSave = useRef<{ contentJson: TiptapJsonContent; revision: number } | null>(null)
  const editRevision = useRef(0)
  const recoveringDraft = useRef(canRecoverInitialDraft)
  const recoverySaveScheduled = useRef(false)
  const applyingRemote = useRef(false)
  const backendRef = useRef(backendDocument)
  const onBackendChangeRef = useRef(onBackendDocumentChange)
  const versionRef = useRef(backendDocument?.version ?? 0)
  const importedRef = useRef(Boolean(backendDocument))
  const [saveState, setSaveState] = useState(backendDocument?.status === 'draft' ? 'Agent 正在写入' : '已保存')
  const [tableOfContents, setTableOfContents] = useState<TableOfContentData>([])
  const [blockDragging, setBlockDragging] = useState(false)
  const { dismissDocumentPresentation, registerVisibleDocument } = useRoomDocumentsState()
  const presentingStream = events.some(
    (event) => event.type === 'document.appended' || event.type === 'document.commit-requested',
  )
  const writing = Boolean(backendDocument?.activeTransactionId) || presentingStream

  backendRef.current = backendDocument
  onBackendChangeRef.current = onBackendDocumentChange

  const persistPendingSave = async (): Promise<void> => {
    if (saveInFlight.current) return
    saveInFlight.current = true
    try {
      while (pendingSave.current) {
        const pending = pendingSave.current
        const documents = window.nxcore?.documents
        const currentDocument = backendRef.current
        if (!documents || !importedRef.current || !currentDocument) {
          setSaveState(writeDocumentDraft(documentId, pending.contentJson, versionRef.current) ? '已保存草稿' : '仅本次会话')
          return
        }
        if (currentDocument.activeTransactionId) return

        pendingSave.current = null
        try {
          const updated = await documents.save(documentId, {
            baseVersion: versionRef.current,
            contentJson: pending.contentJson,
          })
          versionRef.current = updated.version
          backendRef.current = updated
          onBackendChangeRef.current(updated)
          recoveringDraft.current = false
          recoverySaveScheduled.current = false
          if (editRevision.current === pending.revision) {
            removeDocumentDraft(documentId)
            setSaveState('已保存')
          } else {
            const nextPending = pendingSave.current as { contentJson: TiptapJsonContent; revision: number } | null
            if (nextPending) writeDocumentDraft(documentId, nextPending.contentJson, updated.version)
          }
        } catch (error) {
          const nextPending = pendingSave.current as { contentJson: TiptapJsonContent; revision: number } | null
          if (!nextPending || nextPending.revision < pending.revision) {
            pendingSave.current = pending
          }
          setSaveState(error instanceof Error && error.message.includes('version') ? '版本冲突，草稿已保留' : '保存失败，草稿已保留')
          return
        }
      }
    } finally {
      saveInFlight.current = false
    }
  }

  const queueDocumentSave = (contentJson: TiptapJsonContent, delay = 300): void => {
    const revision = ++editRevision.current
    pendingSave.current = { contentJson, revision }
    writeDocumentDraft(documentId, contentJson, versionRef.current)
    setSaveState('正在保存...')
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => {
      saveTimer.current = null
      void persistPendingSave()
    }, delay)
  }

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        dropcursor: { class: 'context-room-tiptap-dropcursor', color: false, width: 2 },
        heading: { levels: [1, 2, 3] },
        link: { openOnClick: false, autolink: true, defaultProtocol: 'https' },
      }),
      TaskList,
      TaskItem.configure({ nested: true }),
      StableBlockIds,
      SelectionRewritePreviewExtension,
      Markdown,
      TableOfContents.configure({
        scrollParent: () => document.querySelector<HTMLElement>('.context-room-tiptap-scroll') ?? window,
        onUpdate: setTableOfContents,
      }),
      Placeholder.configure({
        placeholder: ({ node }) => node.type.name === 'heading' ? '标题' : "输入 '/' 插入内容",
        includeChildren: true,
      }),
    ],
    content: initialContent,
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class: 'context-room-tiptap-content',
        'aria-label': 'Room 文档编辑器',
        spellcheck: 'true',
      },
    },
    onUpdate: ({ editor: currentEditor }) => {
      if (applyingRemote.current) return
      const currentDocument = backendRef.current
      if (currentDocument?.activeTransactionId) return
      queueDocumentSave(currentEditor.getJSON() as TiptapJsonContent)
    },
  }, [documentId])
  const selectionRewrite = useTiptapSelectionRewrite({
    editor,
    roomId: room.id,
    documentId,
    documentName,
    externallyLocked: writing,
  })
  const editorInteractions = useTransientEditorInteractions(editor, selectionRewrite.cancel)

  useEffect(
    () => registerVisibleDocument(documentId),
    [documentId, registerVisibleDocument],
  )

  useEffect(() => {
    if (!editor || backendDocument || importedRef.current) return
    const documents = window.nxcore?.documents
    if (!documents) return
    importedRef.current = true
    const contentJson = (readDocumentDraft(documentId) ?? editor.getJSON()) as TiptapJsonContent
    void documents.import({ id: documentId, roomId: room.id, title: documentName, contentJson })
      .then((imported) => {
        versionRef.current = imported.version
        backendRef.current = imported
        onBackendChangeRef.current(imported)
        if (pendingSave.current) {
          writeDocumentDraft(documentId, pendingSave.current.contentJson, imported.version)
          void persistPendingSave()
        } else {
          removeDocumentDraft(documentId)
          setSaveState('已保存')
        }
      })
      .catch(() => {
        importedRef.current = false
        setSaveState('导入失败')
      })
  }, [backendDocument, documentId, documentName, editor, room.id])

  useEffect(() => {
    if (!editor || !backendDocument) return
    versionRef.current = backendDocument.version
    importedRef.current = true
    const writing = Boolean(backendDocument.activeTransactionId) || presentingStream
    if (editor.isEditable === writing) editor.setEditable(!writing, false)
    setSaveState(writing ? 'Agent 正在写入' : '已保存')
    if (!writing && recoveringDraft.current) {
      if (!recoverySaveScheduled.current) {
        recoverySaveScheduled.current = true
        queueDocumentSave(editor.getJSON() as TiptapJsonContent, 0)
      }
      return
    }
    if (
      !recoveringDraft.current
      && !presentingStream
      && !sameContent(editor.getJSON(), backendDocument.contentJson)
    ) {
      applyingRemote.current = true
      try {
        editor.commands.setContent(backendDocument.contentJson, { emitUpdate: false })
      } finally {
        applyingRemote.current = false
      }
    }
  }, [backendDocument, editor, presentingStream])

  useEffect(() => {
    if (!editor) return
    for (const event of events) {
      const transactionId = event.transactionId
      if (!transactionId) continue
      let state = streamStates.get(transactionId)
      if (!state) {
        state = {
          buffer: new MarkdownBlockBuffer(),
          ordinal: editor.getJSON().content?.length ?? 0,
          sequences: new AppliedSequenceTracker(),
          processed: new Set(),
          scheduled: new Set(),
          queue: Promise.resolve(),
          closed: false,
        }
        streamStates.set(transactionId, state)
      }
      if (state.processed.has(event.id) || state.scheduled.has(event.id)) continue
      state.scheduled.add(event.id)
      state.queue = state.queue.then(async () => {
        if (state!.closed && (
          event.type === 'document.appended' || event.type === 'document.commit-requested'
        )) {
          state!.processed.add(event.id)
          state!.scheduled.delete(event.id)
          return
        }
        if (event.type === 'document.appended') {
          const sequence = eventNumber(event, 'sequence')
          const text = eventText(event)
          if (sequence === null || text === null) throw new Error('Invalid document append event')
          if (!state!.sequences.has(sequence)) {
            const completed = await insertMarkdownBlocks(
              editor,
              state!,
              transactionId,
              state!.buffer.append(text),
              applyingRemote,
              editorInteractions.shouldFollowDocumentStream,
              editorInteractions.followDocumentStream,
            )
            if (!completed) {
              state!.scheduled.delete(event.id)
              return
            }
            state!.sequences.record(sequence)
          }
          const contentJson = editor.getJSON() as TiptapJsonContent
          const currentDocument = backendRef.current
          if (currentDocument?.activeTransactionId === transactionId) {
            const updated = { ...currentDocument, contentJson, updatedAt: new Date().toISOString() }
            backendRef.current = updated
            onBackendChangeRef.current(updated)
          }
        } else if (event.type === 'document.commit-requested') {
          const finalSequence = eventNumber(event, 'finalSequence')
          if (finalSequence === null) throw new Error('Invalid document commit event')
          const completed = await insertMarkdownBlocks(
            editor,
            state!,
            transactionId,
            state!.buffer.append('', true),
            applyingRemote,
            editorInteractions.shouldFollowDocumentStream,
            editorInteractions.followDocumentStream,
          )
          if (!completed) {
            state!.scheduled.delete(event.id)
            return
          }
          const contentJson = editor.getJSON() as TiptapJsonContent
          const currentDocument = backendRef.current
          if (currentDocument?.activeTransactionId === transactionId) {
            const updated = { ...currentDocument, contentJson, updatedAt: new Date().toISOString() }
            backendRef.current = updated
            onBackendChangeRef.current(updated)
          }
        } else if (event.type === 'document.aborted') {
          state!.buffer.reset()
          state!.closed = true
          if (!editor.isEditable) editor.setEditable(true, false)
          dismissDocumentPresentation(event.documentId, transactionId)
        } else if (event.type === 'document.committed') {
          state!.buffer.reset()
          state!.closed = true
          if (!editor.isEditable) editor.setEditable(true, false)
          dismissDocumentPresentation(event.documentId, transactionId)
        }
        state!.processed.add(event.id)
        state!.scheduled.delete(event.id)
      }).catch((error: unknown) => {
        state!.scheduled.delete(event.id)
        setSaveState(error instanceof Error ? error.message : '流式写入失败')
      })
    }
  }, [
    dismissDocumentPresentation,
    editor,
    editorInteractions.followDocumentStream,
    editorInteractions.shouldFollowDocumentStream,
    events,
  ])

  useEffect(() => () => {
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current)
    const currentDocument = backendRef.current
    if (!editor) return
    const contentJson = editor.getJSON() as TiptapJsonContent
    if (!currentDocument && !importedRef.current) {
      writeDocumentDraft(documentId, contentJson, versionRef.current)
      return
    }
    if (pendingSave.current && !currentDocument?.activeTransactionId) {
      writeDocumentDraft(documentId, contentJson, versionRef.current)
      void persistPendingSave()
    }
  }, [documentId, editor])

  useEffect(() => () => {
    const transactionId = backendRef.current?.activeTransactionId
    if (!transactionId) return
    const state = streamStates.get(transactionId)
    if (state) state.closed = true
    streamStates.delete(transactionId)
  }, [documentId])

  const handleBlockDraggingChange = (dragging: boolean) => {
    setBlockDragging(dragging)
    if (!dragging && editor && !editor.isDestroyed) editor.view.dom.dispatchEvent(new Event('dragend'))
  }

  const awaitingFirstContent = isAgentDocumentAwaitingContent(backendDocument)
  return (
    <div
      className="context-room-embedded-cloud-doc context-room-tiptap-editor"
      data-block-dragging={String(blockDragging)}
      data-agent-writing={String(writing)}
    >
      <div className="context-room-embedded-doc-status">
        <b>{saveState}</b>
        <em>{documentName}</em>
      </div>
      {awaitingFirstContent ? (
        <div className="context-room-agent-write-overlay" role="status" aria-live="polite">
          <span>
            <LoaderCircle aria-hidden="true" />
            <strong>Agent 正在写入内容</strong>
          </span>
        </div>
      ) : null}
      <div
        ref={editorInteractions.scrollRef}
        className="context-room-tiptap-scroll"
        data-scrolling={String(editorInteractions.scrolling)}
      >
        <EditorContent editor={editor} />
      </div>
      {editor && !writing ? (
        <>
          <TiptapBubbleToolbar
            editor={editor}
            onAskAi={selectionRewrite.requestRewrite}
          />
          <TiptapBlockHandle editor={editor} onDraggingChange={handleBlockDraggingChange} />
          <TiptapSlashCommandMenu editor={editor} />
        </>
      ) : null}
      <TiptapSelectionRewritePreview
        preview={selectionRewrite.preview}
        onAccept={selectionRewrite.accept}
        onCancel={selectionRewrite.cancel}
        onRetry={selectionRewrite.retry}
      />
      {editor ? <TiptapContentScale items={tableOfContents} /> : null}
    </div>
  )
}
