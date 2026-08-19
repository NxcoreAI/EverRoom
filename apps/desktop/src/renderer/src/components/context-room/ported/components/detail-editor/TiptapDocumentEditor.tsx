import type { RoomDocument, TiptapJsonContent } from '@nxcore/agent-contract'
import Image from '@tiptap/extension-image'
import TaskItem from '@tiptap/extension-task-item'
import TaskList from '@tiptap/extension-task-list'
import { TableKit } from '@tiptap/extension-table'
import TableOfContents, { type TableOfContentData } from '@tiptap/extension-table-of-contents'
import { Markdown } from '@tiptap/markdown'
import { TextSelection } from '@tiptap/pm/state'
import { EditorContent, useEditor, type Editor, type JSONContent } from '@tiptap/react'
import { Placeholder } from '@tiptap/extensions'
import StarterKit from '@tiptap/starter-kit'
import { LoaderCircle } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { stripDocumentTitle } from '@nxcore/document-model'

import { useRoomDocumentsState } from '../../../RoomDocumentsProvider'
import { cursorAnchorCandidateFromEditorState } from '@/components/agent/activeDocumentContext'
import { useActiveDocument } from '@/state/ActiveDocumentContext'
import { writeTextToClipboard } from '@/lib/systemClipboard'
import type { ContextRoomRecord, ContextRoomResource } from '../../types'
import { TiptapBlockHandle } from './TiptapBlockHandle'
import { TiptapBubbleToolbar } from './TiptapBubbleToolbar'
import { TiptapContentScale } from './TiptapContentScale'
import { TiptapDocumentActions } from './TiptapDocumentActions'
import { TiptapSlashCommandMenu } from './TiptapSlashCommandMenu'
import { TiptapTableControls } from './TiptapTableControls'
import {
  DocumentCursorCompletionExtension,
  useDocumentCursorCompletion,
} from './DocumentCursorCompletion'
import { ensureStableBlockIds, StableBlockIds } from './StableBlockIds'
import { useDocumentEditorOperations, useDocumentOperations } from '../../../operations'
import {
  clearDocumentOperationReview,
  DocumentOperationReviewExtension,
  showDocumentOperationReview,
} from '../../../operations/DocumentOperationReviewExtension'
import { DocumentOperationReviewToolbar } from '../../../operations/DocumentOperationReviewToolbar'
import { nextDocumentReviewReveal } from '../../../operations/documentReviewState'
import {
  clearDocumentContinuation,
  DocumentContinuationExtension,
  showDocumentContinuation,
} from '../../../operations/DocumentContinuationExtension'
import { DocumentContinuationToolbar } from '../../../operations/DocumentContinuationToolbar'
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
import { DOCUMENT_HEADING_LEVELS } from './documentHeadingLevels'
import {
  DOCUMENT_IMAGE_RESIZE_OPTIONS,
  hasEmbeddedDocumentImages,
  localizeDocumentImages,
} from './documentImageAssets'
import {
  AppliedSequenceTracker,
  assignStableBlockIds,
  countTiptapTextCharacters,
  documentStreamCharactersPerFrame,
  documentStreamRevealDelay,
  isAgentDocumentAwaitingContent,
  isEmptyTiptapParagraph,
  MarkdownBlockBuffer,
  operationStreamChunksToApply,
  revealTiptapNode,
  tiptapTextContent,
} from './markdownStream'
import {
  operationStreamBaselineKind,
  operationStreamNeedsPresentation,
} from './operationStreamState'
import { useTransientEditorInteractions } from './useTransientEditorInteractions'
import {
  setEditorContentPreservingView,
  shouldApplyBackendDocumentSnapshot,
} from './documentEditorSync'
import {
  DocumentBlockReference,
  insertDocumentBlockReference,
} from './DocumentBlockReference'
import { DocumentBlockReferencePicker } from './DocumentBlockReferencePicker'
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
import {
  loadDocumentCursorCompletionSettings,
  onDocumentCursorCompletionSettingsChanged,
} from '@/state/documentCursorCompletionSettings'
import './TiptapDocumentEditor.css'

interface StreamState {
  buffer: MarkdownBlockBuffer
  ordinal: number
  sequences: AppliedSequenceTracker
  processed: Set<string>
  scheduled: Set<string>
  queue: Promise<void>
  closed: boolean
  operationBaselineEstablished: boolean
}

const streamStateGlobal = globalThis as typeof globalThis & {
  __everroomDocumentStreamStates?: Map<string, StreamState>
}
const streamStates = streamStateGlobal.__everroomDocumentStreamStates ?? new Map<string, StreamState>()
streamStateGlobal.__everroomDocumentStreamStates = streamStates

function streamStateFor(operationId: string, editor: Editor): StreamState {
  let state = streamStates.get(operationId)
  if (!state) {
    state = {
      buffer: new MarkdownBlockBuffer(),
      ordinal: editor.getJSON().content?.length ?? 0,
      sequences: new AppliedSequenceTracker(),
      processed: new Set(),
      scheduled: new Set(),
      queue: Promise.resolve(),
      closed: false,
      operationBaselineEstablished: false,
    }
    streamStates.set(operationId, state)
  }
  return state
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
  operationId: string,
  markdownBlocks: string[],
  applyingRemote: { current: boolean },
  shouldFollowStream: () => boolean,
  followStream: () => void,
): Promise<boolean> {
  const nodes: TiptapJsonContent[] = []
  for (const markdown of markdownBlocks) {
    const parsed = editor.storage.markdown.manager.parse(markdown) as TiptapJsonContent
    const parsedNodes = (parsed.content ?? []).filter((node) => !isEmptyTiptapParagraph(node))
    const stable = assignStableBlockIds(parsedNodes, operationId, state.ordinal)
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
  onBackendDocumentChange,
  onDeleteDocument,
  focusedBlockId,
  documentFocusRequestId,
}: {
  room: ContextRoomRecord
  resource?: ContextRoomResource | null
  backendDocument: RoomDocument | null
  onBackendDocumentChange: (document: RoomDocument) => void
  onDeleteDocument?: (document: RoomDocument) => Promise<void>
  focusedBlockId?: string | null
  documentFocusRequestId?: number | null
}) {
  const documentId = resource?.kind === 'cloud-doc' ? resource.binding.docId : room.cloudDoc.docId
  const persistedName = backendDocument?.title ?? resource?.name ?? room.cloudDoc.title ?? room.title
  const initialDraft = useState(() => readDocumentDraftRecord(documentId))[0]
  const canRecoverInitialDraft = !backendDocument?.activeTransactionId
    && shouldRecoverDocumentDraft(initialDraft, backendDocument)
  const initialDocument = useState(() => {
    const source = canRecoverInitialDraft
      ? initialDraft!.content
      : backendDocument?.contentJson ?? readDocumentDraft(documentId) ?? createRoomDocumentContent(room, persistedName)
    return stripDocumentTitle(source as TiptapJsonContent)
  })[0]
  const initialContent = initialDocument.content as JSONContent
  const initializedBackendDocument = useState(() => backendDocument)[0]
  const [documentName, setDocumentName] = useState(
    backendDocument?.title || initialDraft?.title || initialDocument.legacyTitle || persistedName,
  )
  const documentNameRef = useRef(documentName)
  documentNameRef.current = documentName
  const titleInputRef = useRef<HTMLTextAreaElement>(null)
  const saveTimer = useRef<number | null>(null)
  const saveInFlight = useRef(false)
  const pendingSave = useRef<{ contentJson: TiptapJsonContent; title: string; revision: number } | null>(null)
  const editRevision = useRef(0)
  const persistedEditRevision = useRef(0)
  const recoveringDraft = useRef(canRecoverInitialDraft)
  const recoverySaveScheduled = useRef(false)
  const applyingRemote = useRef(false)
  const backendRef = useRef(backendDocument)
  const onBackendChangeRef = useRef(onBackendDocumentChange)
  const versionRef = useRef(backendDocument?.version ?? 0)
  const importedRef = useRef(Boolean(backendDocument))
  const revealedAtomicOperationId = useRef<string | null>(null)
  const revealedContinuationOperationId = useRef<string | null>(null)
  const handledBlockFocusKey = useRef<string | null>(null)
  const [saveState, setSaveState] = useState(backendDocument?.status === 'draft' ? 'Agent 正在写入' : '已保存')
  const [tableOfContents, setTableOfContents] = useState<TableOfContentData>([])
  const [blockDragging, setBlockDragging] = useState(false)
  const [referencePickerOpen, setReferencePickerOpen] = useState(false)
  const [cursorCompletionEnabled, setCursorCompletionEnabled] = useState(
    () => loadDocumentCursorCompletionSettings().enabled,
  )
  const roomDocuments = useRoomDocumentsState()
  const { activateDocument } = useActiveDocument()
  const { setOperationPresentationPending } = useDocumentOperations()
  const documentOperations = useDocumentEditorOperations(documentId)
  const streamingDocument = documentOperations.streamingDocument
  const [settledStreamingOperationId, setSettledStreamingOperationId] = useState<string | null>(null)
  const activeStreamingOperationIds = useRef(new Set<string>())
  if (streamingDocument?.active) activeStreamingOperationIds.current.add(streamingDocument.operationId)
  const streamingOperationWasActive = streamingDocument
    ? activeStreamingOperationIds.current.has(streamingDocument.operationId)
    : false
  const initializedStreamBaselineKind = streamingDocument
    ? operationStreamBaselineKind(
        streamingDocument,
        documentId,
        initializedBackendDocument,
        streamingOperationWasActive,
      )
    : null
  const operationStreamPending = operationStreamNeedsPresentation(
    streamingDocument,
    settledStreamingOperationId,
    initializedStreamBaselineKind,
    streamingOperationWasActive,
  )
  const presentingStream = operationStreamPending
  const presentingStreamRef = useRef(presentingStream)
  presentingStreamRef.current = presentingStream
  const writing = Boolean(backendDocument?.activeTransactionId) || presentingStream

  useEffect(() => {
    const operationId = streamingDocument?.operationId
    if (!operationId) return
    setOperationPresentationPending(operationId, operationStreamPending)
    return () => setOperationPresentationPending(operationId, false)
  }, [operationStreamPending, setOperationPresentationPending, streamingDocument?.operationId])

  if (!backendDocument) {
    backendRef.current = null
  } else if (!backendRef.current || backendDocument.version >= backendRef.current.version) {
    // A delayed parent render must not roll the save base back after a newer
    // save response has already been received locally.
    backendRef.current = backendDocument
  }
  onBackendChangeRef.current = onBackendDocumentChange

  useEffect(() => {
    if (!backendDocument?.title || document.activeElement === titleInputRef.current) return
    setDocumentName(backendDocument.title)
  }, [backendDocument?.title])

  useEffect(() => {
    if (!streamingDocument?.title || document.activeElement === titleInputRef.current) return
    setDocumentName(streamingDocument.title)
  }, [streamingDocument?.title])

  const persistPendingSave = useCallback(async (): Promise<void> => {
    if (saveInFlight.current) return
    saveInFlight.current = true
    try {
      while (pendingSave.current) {
        const pending = pendingSave.current
        const documents = window.nxcore?.documents
        const currentDocument = backendRef.current
        if (!documents || !importedRef.current || !currentDocument) {
          setSaveState(writeDocumentDraft(documentId, pending.contentJson, versionRef.current, pending.title) ? '已保存草稿' : '仅本次会话')
          return
        }
        if (currentDocument.activeTransactionId || presentingStreamRef.current) return

        pendingSave.current = null
        try {
          const updated = await documents.save(documentId, {
            baseVersion: versionRef.current,
            title: pending.title,
            contentJson: pending.contentJson,
          })
          versionRef.current = updated.version
          persistedEditRevision.current = Math.max(
            persistedEditRevision.current,
            pending.revision,
          )
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
            if (nextPending) writeDocumentDraft(documentId, nextPending.contentJson, updated.version, nextPending.title)
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
  }, [documentId])

  const flushDocumentVersion = useCallback(async (): Promise<number> => {
    if (saveTimer.current !== null) {
      window.clearTimeout(saveTimer.current)
      saveTimer.current = null
    }
    while (saveInFlight.current) await wait(10)
    if (pendingSave.current) await persistPendingSave()
    while (saveInFlight.current) await wait(10)
    if (pendingSave.current) throw new Error('文档尚未保存，请稍后重试。')
    return versionRef.current
  }, [persistPendingSave])

  const queueDocumentSave = (
    contentJson: TiptapJsonContent,
    delay = 300,
    title = documentNameRef.current,
  ): void => {
    const revision = ++editRevision.current
    pendingSave.current = { contentJson, title, revision }
    writeDocumentDraft(documentId, contentJson, versionRef.current, title)
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
        heading: { levels: [...DOCUMENT_HEADING_LEVELS] },
        link: {
          openOnClick: false,
          autolink: true,
          defaultProtocol: 'https',
          protocols: ['everroom'],
        },
      }),
      TaskList,
      TaskItem.configure({ nested: true }),
      TableKit.configure({ table: { resizable: true } }),
      Image.configure({
        allowBase64: false,
        resize: DOCUMENT_IMAGE_RESIZE_OPTIONS,
      }),
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
      DocumentOperationReviewExtension,
      DocumentContinuationExtension,
      SelectionRewritePreviewExtension,
      DocumentCursorCompletionExtension,
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
      if (currentDocument?.activeTransactionId || presentingStreamRef.current) return
      if (ensureStableBlockIds(currentEditor)) return
      queueDocumentSave(currentEditor.getJSON() as TiptapJsonContent)
    },
    onCreate: ({ editor: currentEditor }) => {
      ensureStableBlockIds(currentEditor)
    },
  }, [documentId])
  const visibleReviewOperation = documentOperations.atomicDiff?.review
  const visibleContinuationOperation = documentOperations.continuation?.review
  const editorLocked = writing || documentOperations.locked
  const selectionRewrite = useTiptapSelectionRewrite({
    editor,
    roomId: room.id,
    documentId,
    documentName,
    prepareDocument: flushDocumentVersion,
    onDocumentApplied: (document) => {
      applyingRemote.current = true
      try {
        versionRef.current = document.version
        backendRef.current = document
        onBackendChangeRef.current(document)
      } finally {
        applyingRemote.current = false
      }
    },
    externallyLocked: editorLocked,
  })
  const cursorCompletionRunning = useDocumentCursorCompletion({
    editor,
    roomId: room.id,
    documentName,
    enabled: Boolean(editor
      && !editorLocked
      && cursorCompletionEnabled
      && !documentOperations.completionBlocked
      && !selectionRewrite.preview),
  })
  const editorInteractions = useTransientEditorInteractions(editor, selectionRewrite.cancel)

  useEffect(() => onDocumentCursorCompletionSettingsChanged((settings) => {
    setCursorCompletionEnabled(settings.enabled)
  }), [])

  useEffect(() => {
    if (!editor) return
    const atomicDiff = documentOperations.atomicDiff
    if (!atomicDiff) {
      clearDocumentOperationReview(editor)
      if (!visibleReviewOperation) {
        revealedAtomicOperationId.current = nextDocumentReviewReveal(
          revealedAtomicOperationId.current,
          null,
        ).operationId
      }
      return
    }
    const reveal = nextDocumentReviewReveal(revealedAtomicOperationId.current, atomicDiff.review.id)
    revealedAtomicOperationId.current = reveal.operationId
    showDocumentOperationReview(
      editor,
      atomicDiff.review,
      atomicDiff.decisions,
      atomicDiff.markdownDrafts,
      atomicDiff.currentItemId,
      atomicDiff.busy,
      reveal.autoReveal,
      async (hunkId, decision) => {
        documentOperations.commands.decideAtomicDiffItem(hunkId, decision)
      },
      async () => {
        documentOperations.commands.acceptAllAtomicDiffItems()
      },
      documentOperations.commands.updateAtomicDiffItemDraft,
    )
    if (atomicDiff.review.status !== 'awaiting_review' && atomicDiff.review.status !== 'conflicted') {
      documentOperations.commands.closeAtomicDiff()
    }
  }, [documentOperations.atomicDiff, documentOperations.commands, editor, visibleReviewOperation])

  useEffect(() => {
    const continuation = documentOperations.continuation
    if (!editor || !continuation) {
      if (editor) clearDocumentContinuation(editor)
      if (!visibleContinuationOperation) {
        revealedContinuationOperationId.current = nextDocumentReviewReveal(
          revealedContinuationOperationId.current,
          null,
        ).operationId
      }
      return
    }
    const reveal = nextDocumentReviewReveal(
      revealedContinuationOperationId.current,
      continuation.review.id,
    )
    revealedContinuationOperationId.current = reveal.operationId
    showDocumentContinuation(
      editor,
      continuation.items,
      continuation.currentItemId,
      continuation.decisions,
      continuation.markdownDrafts,
      continuation.busy,
      reveal.autoReveal,
      async (blockIds) => {
        await documentOperations.commands.acceptContinuationItems(blockIds)
      },
      async () => {
        await documentOperations.commands.acceptAllContinuationItems()
      },
      async (blockIds, feedback) => {
        await documentOperations.commands.requestContinuationRevision(blockIds, feedback)
      },
      documentOperations.commands.updateContinuationItemDraft,
    )
  }, [
    documentOperations.commands,
    documentOperations.continuation,
    editor,
    visibleContinuationOperation,
  ])

  useEffect(() => {
    if (!editor) return
    if (editor.isEditable === editorLocked) editor.setEditable(!editorLocked, false)
    if (editorLocked) setReferencePickerOpen(false)
  }, [editor, editorLocked])

  useEffect(() => {
    if (!editor || !backendDocument || backendDocument.deletedAt) return
    const handle = activateDocument({
      roomId: room.id,
      documentId,
      title: documentName,
      version: backendDocument.version,
      getCursorAnchorCandidate: () => cursorAnchorCandidateFromEditorState(editor.state),
      flush: async () => {
        const version = await flushDocumentVersion()
        return { title: backendRef.current?.title ?? documentName, version }
      },
    })
    return handle.deactivate
  }, [activateDocument, backendDocument, documentId, documentName, editor, flushDocumentVersion, room.id])

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
      await writeTextToClipboard(url)
      showToast({ title: '已复制块引用', message: '可粘贴到同一 Room 的文档中。' })
    } catch {
      showToast({ title: '复制失败', message: '请检查剪贴板权限。' })
    }
  }, [documentId, documentName, room.id])

  useEffect(() => {
    if (!editor || backendDocument || importedRef.current || streamingDocument) return
    const documents = window.nxcore?.documents
    if (!documents) return
    importedRef.current = true
    const importDocument = async () => {
      let contentJson = stripDocumentTitle(
        (readDocumentDraft(documentId) ?? editor.getJSON()) as TiptapJsonContent,
      ).content
      if (hasEmbeddedDocumentImages(contentJson)) {
        const localized = await localizeDocumentImages(contentJson, documentId, documents.storeImage)
        if (localized.unsupported > 0) throw new Error('文档包含无法迁移的旧图片。')
        contentJson = localized.content
        applyingRemote.current = true
        try {
          setEditorContentPreservingView(editor, contentJson)
        } finally {
          applyingRemote.current = false
        }
      }
      return documents.import({ id: documentId, roomId: room.id, title: documentName, contentJson })
    }
    void importDocument()
      .then((imported) => {
        versionRef.current = imported.version
        backendRef.current = imported
        onBackendChangeRef.current(imported)
        if (pendingSave.current) {
          writeDocumentDraft(documentId, pendingSave.current.contentJson, imported.version, pendingSave.current.title)
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
  }, [backendDocument, documentId, documentName, editor, room.id, streamingDocument])

  useEffect(() => {
    if (!editor || !streamingDocument) return
    const operationId = streamingDocument.operationId
    const state = streamStateFor(operationId, editor)
    const baselineFromAuthoritativeDocument = !state.operationBaselineEstablished
      && initializedStreamBaselineKind !== null
    state.operationBaselineEstablished = true
    const chunks = operationStreamChunksToApply(
      streamingDocument.chunks,
      state.sequences,
      baselineFromAuthoritativeDocument,
    )
    for (const chunk of chunks) {
      const itemKey = `operation-item:${chunk.id}`
      if (state.processed.has(itemKey) || state.scheduled.has(itemKey)) continue
      state.scheduled.add(itemKey)
      state.queue = state.queue.then(async () => {
        if (state.closed || state.sequences.has(chunk.sequence)) {
          state.processed.add(itemKey)
          state.scheduled.delete(itemKey)
          return
        }
        const completed = await insertMarkdownBlocks(
          editor,
          state,
          operationId,
          state.buffer.append(chunk.markdown),
          applyingRemote,
          editorInteractions.shouldFollowDocumentStream,
          editorInteractions.followDocumentStream,
        )
        if (!completed) {
          state.scheduled.delete(itemKey)
          return
        }
        state.sequences.record(chunk.sequence)
        state.processed.add(itemKey)
        state.scheduled.delete(itemKey)
      }).catch((error: unknown) => {
        state.scheduled.delete(itemKey)
        setSaveState(error instanceof Error ? error.message : '流式写入失败')
      })
    }

    const completionKey = `operation-completed:${operationId}`
    if (streamingDocument.status === 'completed'
      && baselineFromAuthoritativeDocument
      && initializedStreamBaselineKind === 'historical-completion') {
      state.buffer.reset()
      state.closed = true
      state.processed.add(completionKey)
      setSettledStreamingOperationId(operationId)
      return
    }
    if (streamingDocument.status === 'completed'
      && !state.processed.has(completionKey)
      && !state.scheduled.has(completionKey)) {
      state.scheduled.add(completionKey)
      state.queue = state.queue.then(async () => {
        const completed = await insertMarkdownBlocks(
          editor,
          state,
          operationId,
          state.buffer.append('', true),
          applyingRemote,
          editorInteractions.shouldFollowDocumentStream,
          editorInteractions.followDocumentStream,
        )
        if (!completed) {
          state.scheduled.delete(completionKey)
          return
        }
        state.buffer.reset()
        state.closed = true
        state.processed.add(completionKey)
        state.scheduled.delete(completionKey)
        setSettledStreamingOperationId(operationId)
      }).catch((error: unknown) => {
        state.scheduled.delete(completionKey)
        setSaveState(error instanceof Error ? error.message : '流式写入失败')
      })
    } else if (!streamingDocument.active && streamingDocument.status !== 'completed') {
      state.buffer.reset()
      state.closed = true
    }
  }, [
    editor,
    editorInteractions.followDocumentStream,
    editorInteractions.shouldFollowDocumentStream,
    initializedStreamBaselineKind,
    streamingDocument,
  ])

  useEffect(() => {
    if (!editor) return
    const locked = writing || Boolean(visibleReviewOperation) || Boolean(visibleContinuationOperation)
    if (editor.isEditable === locked) editor.setEditable(!locked, false)
    setSaveState(writing
      ? 'Agent 正在写入'
      : visibleContinuationOperation
        ? 'Agent 正在续写'
        : visibleReviewOperation ? '正在审阅改动' : '已保存')
    if (!backendDocument) return
    importedRef.current = true
    if (!locked && recoveringDraft.current) {
      if (!recoverySaveScheduled.current) {
        recoverySaveScheduled.current = true
        queueDocumentSave(editor.getJSON() as TiptapJsonContent, 0)
      }
      return
    }
    const canApplyBackendSnapshot = shouldApplyBackendDocumentSnapshot({
      incomingVersion: backendDocument.version,
      currentVersion: versionRef.current,
      editRevision: editRevision.current,
      persistedEditRevision: persistedEditRevision.current,
      saveInFlight: saveInFlight.current,
      hasPendingSave: pendingSave.current !== null,
      composing: editor.view.composing,
    })
    if (!canApplyBackendSnapshot) return
    versionRef.current = backendDocument.version
    if (!recoveringDraft.current
      && !writing
      && !sameContent(editor.getJSON(), stripDocumentTitle(backendDocument.contentJson).content)) {
      applyingRemote.current = true
      try {
        setEditorContentPreservingView(
          editor,
          stripDocumentTitle(backendDocument.contentJson).content,
        )
      } finally {
        applyingRemote.current = false
      }
    }
  }, [backendDocument, editor, presentingStream, visibleContinuationOperation, visibleReviewOperation, writing])

  useEffect(() => {
    if (!editor || editor.isDestroyed) return
    const documents = window.nxcore?.documents
    if (!documents) return
    let cancelled = false
    const migrate = async () => {
      for (let attempt = 0; attempt < 3 && !cancelled && !editor.isDestroyed; attempt += 1) {
        const source = editor.getJSON() as TiptapJsonContent
        if (!hasEmbeddedDocumentImages(source)) return
        const localized = await localizeDocumentImages(source, documentId, documents.storeImage)
        if (cancelled || editor.isDestroyed) return
        if (!sameContent(source, editor.getJSON() as TiptapJsonContent)) continue
        if (localized.localized > 0) {
          applyingRemote.current = true
          try {
            setEditorContentPreservingView(editor, localized.content)
          } finally {
            applyingRemote.current = false
          }
          queueDocumentSave(localized.content, 0)
        }
        if (localized.unsupported > 0) {
          showToast({ title: '部分旧图片无法迁移', message: '请重新插入不受支持的图片。' })
        }
        return
      }
    }
    void migrate().catch((error: unknown) => {
      if (!cancelled) {
        showToast({
          title: '旧图片迁移失败',
          message: error instanceof Error ? error.message : '请稍后重试。',
        })
      }
    })
    return () => { cancelled = true }
  }, [backendDocument?.version, documentId, editor])

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

  useEffect(() => () => {
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current)
    const currentDocument = backendRef.current
    if (!editor) return
    const contentJson = editor.getJSON() as TiptapJsonContent
    if (!currentDocument && !importedRef.current) {
      writeDocumentDraft(documentId, contentJson, versionRef.current, documentName)
      return
    }
    if (pendingSave.current && !currentDocument?.activeTransactionId) {
      writeDocumentDraft(documentId, contentJson, versionRef.current, documentName)
      void persistPendingSave()
    }
  }, [documentId, documentName, editor])

  useEffect(() => () => {
    if (!streamingDocument) return
    const state = streamStates.get(streamingDocument.operationId)
    if (state) state.closed = true
    streamStates.delete(streamingDocument.operationId)
  }, [streamingDocument?.operationId])

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
        writeDocumentDraft(documentId, pending.contentJson, versionRef.current, pending.title)
        setSaveState('删除失败，草稿已保留')
      }
      throw error
    }
  }

  const awaitingFirstContent = isAgentDocumentAwaitingContent(backendDocument)
    || Boolean(operationStreamPending && streamingDocument?.chunks.length === 0)
  return (
    <div
      className="context-room-embedded-cloud-doc context-room-tiptap-editor"
      data-block-dragging={String(blockDragging)}
      data-agent-writing={String(writing)}
      data-continuation-active={String(Boolean(visibleContinuationOperation))}
    >
      <div className="context-room-embedded-doc-status">
        <b>{saveState}</b>
        {cursorCompletionRunning ? (
          <div
            className="context-room-cursor-completion-banner"
            role="status"
            aria-live="polite"
          >
            <LoaderCircle aria-hidden="true" />
            <span>agent思考中....</span>
          </div>
        ) : null}
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
      {visibleReviewOperation ? (
        <DocumentOperationReviewToolbar
          review={visibleReviewOperation}
          decisions={documentOperations.atomicDiff!.decisions}
          busy={documentOperations.atomicDiff?.busy ?? false}
          error={documentOperations.atomicDiff?.error}
          onClose={documentOperations.commands.closeAtomicDiff}
        />
      ) : null}
      {visibleContinuationOperation ? (
        <DocumentContinuationToolbar
          busy={documentOperations.continuation?.busy ?? false}
          error={documentOperations.continuation?.error}
          onClose={documentOperations.commands.closeContinuation}
        />
      ) : null}
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
      >
        <div className="context-room-document-title-block">
          <textarea
            ref={titleInputRef}
            className="context-room-document-title-input"
            aria-label="文档标题"
            value={documentName}
            disabled={editorLocked}
            maxLength={120}
            rows={1}
            onChange={(event) => setDocumentName(event.target.value.replace(/[\r\n]+/g, ' '))}
            onBlur={() => {
              if (!editor || editorLocked) return
              const title = documentName.trim() || '无标题文档'
              if (title !== documentName) setDocumentName(title)
              queueDocumentSave(editor.getJSON() as TiptapJsonContent, 0, title)
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return
              event.preventDefault()
              event.currentTarget.blur()
            }}
          />
        </div>
        <EditorContent editor={editor} />
      </div>
      {editor && !editorLocked ? (
        <>
          <TiptapBubbleToolbar
            editor={editor}
            documentId={documentId}
            onAskAi={selectionRewrite.requestRewrite}
          />
          <TiptapBlockHandle
            editor={editor}
            onDraggingChange={handleBlockDraggingChange}
            onCopyBlockReference={copyBlockReference}
          />
          <TiptapSlashCommandMenu
            editor={editor}
            documentId={documentId}
            onRequestBlockReference={() => setReferencePickerOpen(true)}
          />
          <TiptapTableControls editor={editor} />
        </>
      ) : null}
      <TiptapSelectionRewritePreview
        preview={selectionRewrite.preview}
        onAccept={selectionRewrite.accept}
        onCancel={selectionRewrite.cancel}
        onChange={selectionRewrite.updateReplacementText}
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
