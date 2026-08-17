import type { DocumentEvent, RoomDocument, TiptapJsonContent } from '@nxcore/agent-contract'
import TaskItem from '@tiptap/extension-task-item'
import TaskList from '@tiptap/extension-task-list'
import TableOfContents, { type TableOfContentData } from '@tiptap/extension-table-of-contents'
import { Markdown } from '@tiptap/markdown'
import { TextSelection } from '@tiptap/pm/state'
import { EditorContent, useEditor, type Editor, type JSONContent } from '@tiptap/react'
import { Placeholder } from '@tiptap/extensions'
import StarterKit from '@tiptap/starter-kit'
import { LoaderCircle } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { documentTitleText, ensureDocumentTitle } from '@nxcore/document-model'

import { useRoomDocumentsState } from '../../../RoomDocumentsProvider'
import { cursorAnchorCandidateFromEditorState } from '@/components/agent/activeDocumentContext'
import { useActiveDocument } from '@/state/ActiveDocumentContext'
import type { ContextRoomRecord, ContextRoomResource } from '../../types'
import { TiptapBlockHandle } from './TiptapBlockHandle'
import { TiptapBubbleToolbar } from './TiptapBubbleToolbar'
import { TiptapContentScale } from './TiptapContentScale'
import { TiptapDocumentActions } from './TiptapDocumentActions'
import { TiptapSlashCommandMenu } from './TiptapSlashCommandMenu'
import { ensureStableBlockIds, StableBlockIds } from './StableBlockIds'
import { useDocumentPatches } from '../../../patches/DocumentPatchProvider'
import {
  clearDocumentPatchReview,
  DocumentPatchReviewExtension,
  showDocumentPatchReview,
} from '../../../patches/DocumentPatchReviewExtension'
import { DocumentPatchReviewToolbar } from '../../../patches/DocumentPatchReviewToolbar'
import {
  clearDocumentContinuation,
  DocumentContinuationExtension,
  showDocumentContinuation,
} from '../../../patches/DocumentContinuationExtension'
import { DocumentContinuationToolbar } from '../../../patches/DocumentContinuationToolbar'
import {
  pendingContinuationBlock,
  pendingContinuationBlocks,
} from '../../../patches/documentContinuationState'
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
import {
  DocumentBlockReference,
  insertDocumentBlockReference,
} from './DocumentBlockReference'
import { DocumentBlockReferencePicker } from './DocumentBlockReferencePicker'
import { DocumentTitle, DocumentWithTitle } from './DocumentTitle'
import {
  createEverroomBlockReferenceUrl,
  parseEverroomBlockReferenceUrl,
  parseSameRoomBlockReferenceLink,
} from './documentBlockReferenceLink'
import {
  documentBlockFocusRequestKey,
  focusDocumentBlock,
  requestDocumentBlockNavigation,
} from './documentBlockNavigation'
import { showToast } from '@/state/toast'
import './TiptapDocumentEditor.css'

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
  onDeleteDocument,
  focusedBlockId,
  documentFocusRequestId,
}: {
  room: ContextRoomRecord
  resource?: ContextRoomResource | null
  backendDocument: RoomDocument | null
  events: DocumentEvent[]
  onBackendDocumentChange: (document: RoomDocument) => void
  onDeleteDocument?: (document: RoomDocument) => Promise<void>
  focusedBlockId?: string | null
  documentFocusRequestId?: number | null
}) {
  const documentId = resource?.kind === 'cloud-doc' ? resource.binding.docId : room.cloudDoc.docId
  const documentName = backendDocument?.title ?? resource?.name ?? room.cloudDoc.title ?? room.title
  const initialDraft = useState(() => readDocumentDraftRecord(documentId))[0]
  const canRecoverInitialDraft = !backendDocument?.activeTransactionId
    && shouldRecoverDocumentDraft(initialDraft, backendDocument)
  const initialContent = useState<JSONContent>(() => {
    const source = canRecoverInitialDraft
      ? initialDraft!.content
      : backendDocument?.contentJson ?? readDocumentDraft(documentId) ?? createRoomDocumentContent(room, documentName)
    return ensureDocumentTitle(source as TiptapJsonContent, documentName).content as JSONContent
  })[0]
  const saveTimer = useRef<number | null>(null)
  const saveInFlight = useRef(false)
  const pendingSave = useRef<{ contentJson: TiptapJsonContent; title: string; revision: number } | null>(null)
  const editRevision = useRef(0)
  const recoveringDraft = useRef(canRecoverInitialDraft)
  const recoverySaveScheduled = useRef(false)
  const applyingRemote = useRef(false)
  const backendRef = useRef(backendDocument)
  const onBackendChangeRef = useRef(onBackendDocumentChange)
  const versionRef = useRef(backendDocument?.version ?? 0)
  const importedRef = useRef(Boolean(backendDocument))
  const revealedContinuationPatchId = useRef<string | null>(null)
  const handledBlockFocusKey = useRef<string | null>(null)
  const [saveState, setSaveState] = useState(backendDocument?.status === 'draft' ? 'Agent 正在写入' : '已保存')
  const [tableOfContents, setTableOfContents] = useState<TableOfContentData>([])
  const [blockDragging, setBlockDragging] = useState(false)
  const [referencePickerOpen, setReferencePickerOpen] = useState(false)
  const roomDocuments = useRoomDocumentsState()
  const { dismissDocumentPresentation, registerVisibleDocument } = roomDocuments
  const { activateDocument } = useActiveDocument()
  const {
    acceptAllContinuationBlocks,
    busyPatchIds,
    closeReview,
    continuationDecisionsByPatchId,
    continuationPatchIdByDocument,
    currentHunkId,
    decisionsByPatchId,
    decideContinuationBlock,
    fullPatchesById,
    reviewPatchId,
    setHunkDecision,
  } = useDocumentPatches()
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
            title: pending.title,
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
            const nextPending = pendingSave.current as {
              contentJson: TiptapJsonContent
              title: string
              revision: number
            } | null
            if (nextPending) writeDocumentDraft(documentId, nextPending.contentJson, updated.version)
          }
        } catch (error) {
          const nextPending = pendingSave.current as {
            contentJson: TiptapJsonContent
            title: string
            revision: number
          } | null
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

  const queueDocumentSave = (
    contentJson: TiptapJsonContent,
    delay = 300,
    title = documentTitleText(contentJson.content?.[0]) || backendRef.current?.title || documentName,
  ): void => {
    const revision = ++editRevision.current
    pendingSave.current = { contentJson, title, revision }
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
        document: false,
        dropcursor: { class: 'context-room-tiptap-dropcursor', color: false, width: 2 },
        heading: { levels: [1, 2, 3] },
        link: {
          openOnClick: false,
          autolink: true,
          defaultProtocol: 'https',
          protocols: ['everroom'],
        },
      }),
      DocumentWithTitle,
      DocumentTitle,
      TaskList,
      TaskItem.configure({ nested: true }),
      StableBlockIds.configure({ documentId }),
      DocumentBlockReference.configure({
        sourceRoomId: room.id,
        resolveReferences: async (input) => {
          const documents = window.nxcore?.documents
          if (!documents) throw new Error('文档引用服务不可用。')
          return documents.resolveBlockReferences(input)
        },
        onNavigate: (target, resolution) => {
          if (resolution && resolution.status !== 'available' && resolution.status !== 'block_missing') {
            showToast({ title: '引用暂时不可用', message: resolution.status === 'document_trashed' ? '目标文档在回收站中。' : '目标文档已不可用。' })
            return
          }
          requestDocumentBlockNavigation(target)
        },
      }),
      DocumentPatchReviewExtension,
      DocumentContinuationExtension,
      SelectionRewritePreviewExtension,
      Markdown,
      TableOfContents.configure({
        scrollParent: () => document.querySelector<HTMLElement>('.context-room-tiptap-scroll') ?? window,
        onUpdate: setTableOfContents,
      }),
      Placeholder.configure({
        placeholder: ({ node }) => node.type.name === 'documentTitle'
          ? '文档标题'
          : node.type.name === 'heading' ? '标题' : "输入 '/' 插入内容",
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
      handleDOMEvents: {
        click: (_view, event) => {
          const element = event.target instanceof Element ? event.target : null
          const anchor = element?.closest<HTMLAnchorElement>('a[href]')
          if (!anchor) return false
          const href = anchor.getAttribute('href') ?? ''
          const reference = parseSameRoomBlockReferenceLink(href, room.id)
          if (reference) {
            event.preventDefault()
            requestDocumentBlockNavigation(reference)
            return true
          }
          if (parseEverroomBlockReferenceUrl(href)) {
            event.preventDefault()
            showToast({ title: '无法打开块链接', message: '块链接只能在同一个 Room 内跳转。' })
            return true
          }
          return false
        },
      },
    },
    onUpdate: ({ editor: currentEditor }) => {
      if (applyingRemote.current) return
      const currentDocument = backendRef.current
      if (currentDocument?.activeTransactionId) return
      if (ensureStableBlockIds(currentEditor)) return
      queueDocumentSave(currentEditor.getJSON() as TiptapJsonContent)
    },
    onCreate: ({ editor: currentEditor }) => {
      ensureStableBlockIds(currentEditor)
    },
  }, [documentId])
  const reviewPatch = reviewPatchId ? fullPatchesById[reviewPatchId] : undefined
  const visibleReviewPatch = reviewPatch?.kind === 'edit' && reviewPatch.documentId === documentId
    ? reviewPatch
    : undefined
  const continuationPatchId = continuationPatchIdByDocument[documentId]
  const continuationPatch = continuationPatchId ? fullPatchesById[continuationPatchId] : undefined
  const continuationBlock = pendingContinuationBlock(continuationPatch)
  const continuationBlocks = useMemo(
    () => pendingContinuationBlocks(continuationPatch),
    [continuationPatch],
  )
  const visibleContinuationPatch = continuationPatch?.documentId === documentId && continuationBlock
    ? continuationPatch
    : undefined
  const editorLocked = writing || Boolean(visibleReviewPatch) || Boolean(visibleContinuationPatch)
  const selectionRewrite = useTiptapSelectionRewrite({
    editor,
    roomId: room.id,
    documentId,
    documentName,
    externallyLocked: editorLocked,
  })
  const editorInteractions = useTransientEditorInteractions(editor, selectionRewrite.cancel)

  useEffect(() => {
    if (!editor) return
    if (!visibleReviewPatch) {
      clearDocumentPatchReview(editor)
      return
    }
    showDocumentPatchReview(
      editor,
      visibleReviewPatch,
      decisionsByPatchId[visibleReviewPatch.id] ?? {},
      currentHunkId,
      busyPatchIds.has(visibleReviewPatch.id),
      async (hunkId, decision) => {
        setHunkDecision(visibleReviewPatch.id, hunkId, decision)
      },
      async () => {
        for (const hunk of visibleReviewPatch.hunks) {
          setHunkDecision(visibleReviewPatch.id, hunk.id, 'accepted')
        }
      },
    )
    if (visibleReviewPatch.status !== 'pending' && visibleReviewPatch.status !== 'conflicted') closeReview()
  }, [busyPatchIds, closeReview, currentHunkId, decisionsByPatchId, editor, setHunkDecision, visibleReviewPatch])

  useEffect(() => {
    if (!editor || !visibleContinuationPatch || !continuationBlock) {
      if (editor) clearDocumentContinuation(editor)
      if (!visibleContinuationPatch) revealedContinuationPatchId.current = null
      return
    }
    const autoReveal = revealedContinuationPatchId.current !== visibleContinuationPatch.id
    revealedContinuationPatchId.current = visibleContinuationPatch.id
    showDocumentContinuation(
      editor,
      continuationBlocks,
      continuationBlock.blockId,
      continuationDecisionsByPatchId[visibleContinuationPatch.id] ?? {},
      busyPatchIds.has(visibleContinuationPatch.id),
      autoReveal,
      async (blockId) => {
        decideContinuationBlock(visibleContinuationPatch.id, blockId, 'accepted')
      },
      async (blockId) => {
        decideContinuationBlock(visibleContinuationPatch.id, blockId, 'rejected')
      },
      async () => {
        await acceptAllContinuationBlocks(visibleContinuationPatch.id)
      },
    )
  }, [
    acceptAllContinuationBlocks,
    busyPatchIds,
    continuationBlock,
    continuationBlocks,
    continuationDecisionsByPatchId,
    decideContinuationBlock,
    editor,
    visibleContinuationPatch,
  ])

  useEffect(() => {
    if (!editor) return
    if (editor.isEditable === editorLocked) editor.setEditable(!editorLocked, false)
    if (editorLocked) setReferencePickerOpen(false)
  }, [editor, editorLocked])

  useEffect(() => {
    if (!currentHunkId || !visibleReviewPatch) return
    window.requestAnimationFrame(() => {
      const target = document.querySelector<HTMLElement>(
        `[data-patch-hunk-id="${CSS.escape(currentHunkId)}"]`,
      )
      target?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    })
  }, [currentHunkId, visibleReviewPatch])

  useEffect(() => {
    if (!editor || !backendDocument || backendDocument.deletedAt) return
    const handle = activateDocument({
      roomId: room.id,
      documentId,
      title: documentName,
      version: backendDocument.version,
      getCursorAnchorCandidate: () => cursorAnchorCandidateFromEditorState(editor.state),
      flush: async () => {
        if (saveTimer.current !== null) {
          window.clearTimeout(saveTimer.current)
          saveTimer.current = null
        }
        while (saveInFlight.current) await wait(10)
        if (pendingSave.current) await persistPendingSave()
        while (saveInFlight.current) await wait(10)
        if (pendingSave.current) throw new Error('文档尚未保存，请稍后重试。')
        return { title: backendRef.current?.title ?? documentName, version: versionRef.current }
      },
    })
    return handle.deactivate
  }, [activateDocument, backendDocument, documentId, documentName, editor, room.id])

  useEffect(
    () => registerVisibleDocument(documentId),
    [documentId, registerVisibleDocument],
  )

  const listDocumentBlocks = useCallback(async (targetDocumentId: string) => {
    const documents = window.nxcore?.documents
    if (!documents) throw new Error('文档块服务不可用。')
    return documents.listBlocks(targetDocumentId)
  }, [])

  const copyBlockReference = useCallback(async (blockId: string, textPreview: string) => {
    const url = createEverroomBlockReferenceUrl({
      roomId: room.id,
      documentId,
      blockId,
      fallbackTitle: documentName,
      fallbackPreview: textPreview,
    })
    try {
      await navigator.clipboard.writeText(url)
      showToast({ title: '已复制块引用', message: '可粘贴到同一 Room 的文档中。' })
    } catch {
      showToast({ title: '复制失败', message: '请检查剪贴板权限。' })
    }
  }, [documentId, documentName, room.id])

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
    const locked = writing || Boolean(visibleReviewPatch) || Boolean(visibleContinuationPatch)
    if (editor.isEditable === locked) editor.setEditable(!locked, false)
    setSaveState(writing
      ? 'Agent 正在写入'
      : visibleContinuationPatch
        ? 'Agent 正在续写'
        : visibleReviewPatch ? '正在审阅改动' : '已保存')
    if (!locked && recoveringDraft.current) {
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
  }, [backendDocument, editor, presentingStream, visibleContinuationPatch, visibleReviewPatch])

  useEffect(() => {
    if (!editor || !backendDocument || !focusedBlockId || editor.isDestroyed) return
    const requestKey = documentBlockFocusRequestKey(
      documentId,
      focusedBlockId,
      documentFocusRequestId,
    )
    if (handledBlockFocusKey.current === requestKey) return
    let cancelled = false
    const focus = async () => {
      const documents = window.nxcore?.documents
      if (!documents) return
      const resolve = () => documents.resolveBlockReferences({
        sourceRoomId: room.id,
        references: [{ roomId: room.id, documentId, blockId: focusedBlockId }],
      })
      let resolution = (await resolve()).resolutions[0]
      if (cancelled) return
      if (!resolution || resolution.status !== 'available') {
        handledBlockFocusKey.current = requestKey
        if (resolution?.status === 'block_missing') {
          showToast({ title: '引用块已失效', message: '原引用块已被删除或合并。' })
        }
        return
      }
      if ((resolution.version ?? 0) > backendDocument.version) return
      await new Promise<void>((resolveFrame) => window.requestAnimationFrame(() => resolveFrame()))
      if (cancelled) return
      const result = focusDocumentBlock(editor.view.dom, focusedBlockId)
      if (result === 'focused') {
        handledBlockFocusKey.current = requestKey
        return
      }
      resolution = (await resolve()).resolutions[0]
      if (cancelled) return
      if (resolution?.status === 'block_missing') {
        handledBlockFocusKey.current = requestKey
        showToast({ title: '引用块已失效', message: '原引用块已被删除或合并。' })
      }
    }
    void focus().catch(() => undefined)
    return () => { cancelled = true }
  }, [backendDocument, documentFocusRequestId, documentId, editor, focusedBlockId, room.id])

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

  const deleteCurrentDocument = async (document: RoomDocument): Promise<void> => {
    if (!onDeleteDocument) return
    const pending = pendingSave.current
    if (saveTimer.current !== null) {
      window.clearTimeout(saveTimer.current)
      saveTimer.current = null
    }
    pendingSave.current = null
    removeDocumentDraft(documentId)
    try {
      await onDeleteDocument(document)
    } catch (error) {
      if (pending) {
        pendingSave.current = pending
        writeDocumentDraft(documentId, pending.contentJson, versionRef.current)
        setSaveState('删除失败，草稿已保留')
      }
      throw error
    }
  }

  const awaitingFirstContent = isAgentDocumentAwaitingContent(backendDocument)
  return (
    <div
      className="context-room-embedded-cloud-doc context-room-tiptap-editor"
      data-block-dragging={String(blockDragging)}
      data-agent-writing={String(writing)}
      data-continuation-active={String(Boolean(visibleContinuationPatch))}
    >
      <div className="context-room-embedded-doc-status">
        <b>{saveState}</b>
        <strong className="context-room-document-title" aria-label="文档标题">{documentName}</strong>
        {editor ? (
          <TiptapDocumentActions
            editor={editor}
            documentName={documentName}
            backendDocument={backendDocument}
            writing={writing}
            saving={saveState === '正在保存...'}
            onDeleteDocument={onDeleteDocument ? deleteCurrentDocument : undefined}
          />
        ) : null}
      </div>
      {visibleReviewPatch ? <DocumentPatchReviewToolbar patch={visibleReviewPatch} /> : null}
      {visibleContinuationPatch ? <DocumentContinuationToolbar patch={visibleContinuationPatch} /> : null}
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
      {editor && !editorLocked ? (
        <>
          <TiptapBubbleToolbar
            editor={editor}
            onAskAi={selectionRewrite.requestRewrite}
          />
          <TiptapBlockHandle
            editor={editor}
            onDraggingChange={handleBlockDraggingChange}
            onCopyBlockReference={copyBlockReference}
          />
          <TiptapSlashCommandMenu editor={editor} onRequestBlockReference={() => setReferencePickerOpen(true)} />
        </>
      ) : null}
      <TiptapSelectionRewritePreview
        preview={selectionRewrite.preview}
        onAccept={selectionRewrite.accept}
        onCancel={selectionRewrite.cancel}
        onRetry={selectionRewrite.retry}
      />
      {editor ? <TiptapContentScale items={tableOfContents} /> : null}
      {editor && referencePickerOpen && !editorLocked ? (
        <DocumentBlockReferencePicker
          roomId={room.id}
          currentDocumentId={documentId}
          documents={roomDocuments.documentsByRoom[room.id] ?? []}
          listBlocks={listDocumentBlocks}
          onClose={() => setReferencePickerOpen(false)}
          onSelect={(reference) => {
            insertDocumentBlockReference(editor, reference)
            setReferencePickerOpen(false)
          }}
        />
      ) : null}
    </div>
  )
}
