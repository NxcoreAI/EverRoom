import type { DocumentEvent, RoomDocument, TiptapJsonContent } from '@nxcore/agent-contract'
import TaskItem from '@tiptap/extension-task-item'
import TaskList from '@tiptap/extension-task-list'
import TableOfContents, { type TableOfContentData } from '@tiptap/extension-table-of-contents'
import { Markdown } from '@tiptap/markdown'
import { EditorContent, Extension, useEditor, type Editor, type JSONContent } from '@tiptap/react'
import { Placeholder } from '@tiptap/extensions'
import StarterKit from '@tiptap/starter-kit'
import { useEffect, useRef, useState } from 'react'

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
  removeDocumentDraft,
  writeDocumentDraft,
} from './documentDraftStorage'
import {
  AppliedSequenceTracker,
  assignStableBlockIds,
  documentStreamRevealDelay,
  MarkdownBlockBuffer,
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
}

const streamStates = new Map<string, StreamState>()

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
): Promise<void> {
  for (const markdown of markdownBlocks) {
    if (editor.isDestroyed) throw new Error('Editor closed while Agent was writing')
    const parsed = editor.storage.markdown.manager.parse(markdown) as TiptapJsonContent
    const stable = assignStableBlockIds(parsed.content ?? [], transactionId, state.ordinal)
    state.ordinal = stable.nextOrdinal
    const charactersPerNode = Math.max(1, Math.ceil(markdown.length / Math.max(1, stable.nodes.length)))
    for (const node of stable.nodes) {
      await wait(documentStreamRevealDelay('x'.repeat(charactersPerNode)))
      applyingRemote.current = true
      try {
        const json = editor.getJSON()
        const isEmpty = !editor.getText().trim() && (json.content?.length ?? 0) <= 1
        if (isEmpty) editor.commands.setContent({ type: 'doc', content: [node] }, { emitUpdate: false })
        else editor.commands.insertContentAt(editor.state.doc.content.size, node)
      } finally {
        applyingRemote.current = false
      }
    }
  }
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
  const initialContent = useState<JSONContent>(() => (
    backendDocument?.contentJson ?? readDocumentDraft(documentId) ?? createRoomDocumentContent(room, documentName)
  ))[0]
  const saveTimer = useRef<number | null>(null)
  const applyingRemote = useRef(false)
  const backendRef = useRef(backendDocument)
  const onBackendChangeRef = useRef(onBackendDocumentChange)
  const versionRef = useRef(backendDocument?.version ?? 0)
  const importedRef = useRef(Boolean(backendDocument))
  const [saveState, setSaveState] = useState(backendDocument?.status === 'draft' ? 'Agent 正在写入' : '已保存')
  const [tableOfContents, setTableOfContents] = useState<TableOfContentData>([])
  const [blockDragging, setBlockDragging] = useState(false)

  backendRef.current = backendDocument
  onBackendChangeRef.current = onBackendDocumentChange

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
      setSaveState('正在保存...')
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current)
      saveTimer.current = window.setTimeout(() => {
        const contentJson = currentEditor.getJSON()
        const documents = window.nxcore?.documents
        if (!documents || !importedRef.current || !backendRef.current) {
          setSaveState(writeDocumentDraft(documentId, contentJson) ? '已保存' : '仅本次会话')
          return
        }
        const baseVersion = versionRef.current
        void documents.save(documentId, { baseVersion, contentJson }).then((updated) => {
          versionRef.current = updated.version
          backendRef.current = updated
          onBackendChangeRef.current(updated)
          setSaveState('已保存')
        }).catch((error: unknown) => {
          setSaveState(error instanceof Error && error.message.includes('version') ? '版本冲突' : '保存失败')
        })
      }, 300)
    },
  }, [documentId])

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
        removeDocumentDraft(documentId)
        onBackendChangeRef.current(imported)
        setSaveState('已保存')
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
    const writing = Boolean(backendDocument.activeTransactionId)
    editor.setEditable(!writing)
    setSaveState(writing ? 'Agent 正在写入' : '已保存')
    if (!writing && !sameContent(editor.getJSON(), backendDocument.contentJson)) {
      applyingRemote.current = true
      try {
        editor.commands.setContent(backendDocument.contentJson, { emitUpdate: false })
      } finally {
        applyingRemote.current = false
      }
    }
  }, [backendDocument, editor])

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
        }
        streamStates.set(transactionId, state)
      }
      if (state.processed.has(event.id) || state.scheduled.has(event.id)) continue
      state.scheduled.add(event.id)
      state.queue = state.queue.then(async () => {
        if (event.type === 'document.appended') {
          const sequence = eventNumber(event, 'sequence')
          const text = eventText(event)
          if (sequence === null || text === null) throw new Error('Invalid document append event')
          if (!state!.sequences.has(sequence)) {
            await insertMarkdownBlocks(editor, state!, transactionId, state!.buffer.append(text), applyingRemote)
            state!.sequences.record(sequence)
          }
          const contentJson = editor.getJSON() as TiptapJsonContent
          const currentDocument = backendRef.current
          if (currentDocument?.activeTransactionId === transactionId) {
            const updated = { ...currentDocument, contentJson, updatedAt: new Date().toISOString() }
            backendRef.current = updated
            onBackendChangeRef.current(updated)
          }
          await window.nxcore?.documents.acknowledge(transactionId, {
            sequence,
            contentJson,
          })
        } else if (event.type === 'document.commit-requested') {
          const finalSequence = eventNumber(event, 'finalSequence')
          if (finalSequence === null) throw new Error('Invalid document commit event')
          await insertMarkdownBlocks(editor, state!, transactionId, state!.buffer.append('', true), applyingRemote)
          const contentJson = editor.getJSON() as TiptapJsonContent
          const currentDocument = backendRef.current
          if (currentDocument?.activeTransactionId === transactionId) {
            const updated = { ...currentDocument, contentJson, updatedAt: new Date().toISOString() }
            backendRef.current = updated
            onBackendChangeRef.current(updated)
          }
          await window.nxcore?.documents.acknowledge(transactionId, {
            sequence: finalSequence,
            contentJson,
          })
        } else if (event.type === 'document.aborted') {
          state!.buffer.reset()
          editor.setEditable(true)
        } else if (event.type === 'document.committed') {
          state!.buffer.reset()
          editor.setEditable(true)
        }
        state!.processed.add(event.id)
        state!.scheduled.delete(event.id)
      }).catch((error: unknown) => {
        state!.scheduled.delete(event.id)
        setSaveState(error instanceof Error ? error.message : '流式写入失败')
      })
    }
  }, [editor, events])

  useEffect(() => () => {
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current)
    const currentDocument = backendRef.current
    if (editor && !currentDocument && !importedRef.current) writeDocumentDraft(documentId, editor.getJSON())
  }, [documentId, editor])

  const handleBlockDraggingChange = (dragging: boolean) => {
    setBlockDragging(dragging)
    if (!dragging && editor && !editor.isDestroyed) editor.view.dom.dispatchEvent(new Event('dragend'))
  }

  const writing = Boolean(backendDocument?.activeTransactionId)
  const selectionRewrite = useTiptapSelectionRewrite({
    editor,
    roomId: room.id,
    documentName,
    externallyLocked: writing,
  })
  const editorInteractions = useTransientEditorInteractions(editor)
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
            dragging={blockDragging}
            selecting={editorInteractions.selecting}
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
