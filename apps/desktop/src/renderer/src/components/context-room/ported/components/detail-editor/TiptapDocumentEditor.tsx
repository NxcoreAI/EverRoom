import type { DocumentDiffResult, DocumentVersionSnapshot, RoomDocument, TiptapJsonContent } from '@nxcore/agent-contract'
import type { ResolveDocumentBlockReferencesInput } from '@nxcore/agent-contract'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import Image from '@tiptap/extension-image'
import TaskItem from '@tiptap/extension-task-item'
import TaskList from '@tiptap/extension-task-list'
import { TableKit } from '@tiptap/extension-table'
import TableOfContents, { type TableOfContentData } from '@tiptap/extension-table-of-contents'
import { DocumentExportStatus } from './DocumentExportStatus'
import { Markdown } from '@tiptap/markdown'
import { TextSelection } from '@tiptap/pm/state'
import { EditorContent, useEditor, type Editor, type JSONContent } from '@tiptap/react'
import { Placeholder } from '@tiptap/extensions'
import StarterKit from '@tiptap/starter-kit'
import { GitCompare, LoaderCircle, RotateCcw, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { stripDocumentTitle } from '@nxcore/document-model'

import { useRoomDocumentsState } from '../../../RoomDocumentsProvider'
import { cursorAnchorCandidateFromEditorState } from '@/components/agent/activeDocumentContext'
import { useActiveDocument } from '@/state/ActiveDocumentContext'
import { writeTextToClipboard } from '@/lib/systemClipboard'
import { useLocale } from '../../../../../i18n/LocaleContext'
import { uiText } from '../../adapters'
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
import { DocumentHistoryDiffView } from './DocumentHistoryDiffView'
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
  documentStreamRevealLimits,
  isAgentDocumentAwaitingContent,
  isEmptyTiptapParagraph,
  isEmptyTiptapTable,
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
import { BlockIndexMark } from './BlockIndexMark'
import { BlockIndexPicker } from './BlockIndexPicker'
import {
  insertBlockIndexMark,
  type BlockIndexTarget,
} from './blockIndexLink'
import { requestRoomMemoryNavigation } from './blockIndexNavigation'
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

function isDocumentConflict(error: unknown): boolean {
  return error instanceof Error && /DOCUMENT_CONFLICT|Document version has changed/i.test(error.message)
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
    const parsedNodes = (parsed.content ?? []).filter((node) => (
      !isEmptyTiptapParagraph(node) && !isEmptyTiptapTable(node)
    ))
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
    const nodeText = Array.from(tiptapTextContent(node))
    const initialDocumentSize = editor.state.doc.content.size
    const json = editor.getJSON()
    const trailingNode = editor.state.doc.lastChild
    const replaceTrailingParagraph = isEmptyTiptapParagraph(json.content?.at(-1))
    const previewFrom = replaceTrailingParagraph && trailingNode
      ? initialDocumentSize - trailingNode.nodeSize
      : initialDocumentSize
    let previewTo = initialDocumentSize
    const revealLimits = documentStreamRevealLimits(node, charactersPerFrame)

    for (let frameIndex = 0; frameIndex < revealLimits.length; frameIndex += 1) {
      if (state.closed || editor.isDestroyed) return false
      const revealedCharacters = revealLimits[frameIndex]!
      const previousCharacters = frameIndex === 0 ? 0 : revealLimits[frameIndex - 1]!
      const preview = revealTiptapNode(node, revealedCharacters)
      const proseMirrorNode = editor.schema.nodeFromJSON(preview as JSONContent)
      applyingRemote.current = true
      try {
        const transaction = editor.state.tr
          .replaceWith(previewFrom, previewTo, proseMirrorNode)
          .setMeta('preventUpdate', true)
        if (frameIndex > 0) transaction.setMeta('addToHistory', false)
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
        frameIndex === revealLimits.length - 1 ? `${revealedText}\n` : revealedText,
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
  const { locale, t } = useLocale()
  const documentId = resource?.kind === 'cloud-doc' ? resource.binding.docId : room.cloudDoc.docId
  const documentIdRef = useRef(documentId)
  documentIdRef.current = documentId
  // The editor instance is keyed on [documentId, locale]; room props would go
  // stale in extension options captured at creation, so read memory items live.
  const roomRef = useRef(room)
  roomRef.current = room
  const persistedName = backendDocument?.title ?? resource?.name ?? room.cloudDoc.title ?? room.title
  const initialDraft = useState(() => readDocumentDraftRecord(documentId))[0]
  const canRecoverInitialDraft = !backendDocument?.activeTransactionId
    && shouldRecoverDocumentDraft(initialDraft, backendDocument)
  const initialDocument = useState(() => {
    const source = canRecoverInitialDraft
      ? initialDraft!.content
      : backendDocument?.contentJson ?? readDocumentDraft(documentId) ?? createRoomDocumentContent(room, persistedName, t)
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
  const initializingEditor = useRef(true)
  const agentTransactionRef = useRef(backendDocument?.activeTransactionId ?? null)
  const agentSaveInvalidationRef = useRef(0)
  // 审阅期硬锁的保存闸（2026-09-03）：有 awaiting_review 提案时延迟用户保存，
  // 提案解决后由解锁 effect 补跑——防止防抖保存在提案落地 1 秒后把它挤成 conflicted。
  const editorLockedForReviewRef = useRef(false)
  const backendRef = useRef(backendDocument)
  const editorRef = useRef<Editor | null>(null)
  const onBackendChangeRef = useRef(onBackendDocumentChange)
  const versionRef = useRef(backendDocument?.version ?? 0)
  const appliedDocumentVersionRef = useRef(backendDocument?.version ?? 0)
  const importedRef = useRef(Boolean(backendDocument))
  const revealedAtomicOperationId = useRef<string | null>(null)
  const revealedContinuationOperationId = useRef<string | null>(null)
  const handledBlockFocusKey = useRef<string | null>(null)
  const [saveState, setSaveState] = useState(backendDocument?.status === 'draft' ? 'Agent 正在写入' : '已保存')
  const [historyView, setHistoryView] = useState<{ snapshot: DocumentVersionSnapshot; diff: DocumentDiffResult } | null>(null)
  const [restoringHistory, setRestoringHistory] = useState(false)
  const historyRestoreRequestRef = useRef(0)
  const [historyPanelCloseSignal, setHistoryPanelCloseSignal] = useState(0)
  const [historyRefreshSignal, setHistoryRefreshSignal] = useState(0)
  const showHistoryDiff = useCallback((snapshot: DocumentVersionSnapshot, diff: DocumentDiffResult) => {
    setHistoryView({ snapshot, diff })
  }, [])
  const clearHistoryDiff = useCallback(() => {
    setHistoryView(null)
  }, [])
  const closeHistoryDiff = useCallback(() => {
    setHistoryView(null)
    setHistoryPanelCloseSignal((value) => value + 1)
  }, [])
  const [tableOfContents, setTableOfContents] = useState<TableOfContentData>([])
  const [blockDragging, setBlockDragging] = useState(false)
  const [referencePickerOpen, setReferencePickerOpen] = useState(false)
  const [indexPickerOpen, setIndexPickerOpen] = useState(false)
  const pendingIndexHostBlockIdRef = useRef<string | null>(null)
  const [cursorCompletionEnabled, setCursorCompletionEnabled] = useState(
    () => loadDocumentCursorCompletionSettings().enabled,
  )
  const [cursorCompletionParagraphEnabled, setCursorCompletionParagraphEnabled] = useState(
    () => loadDocumentCursorCompletionSettings().paragraphEnabled,
  )
  const roomDocuments = useRoomDocumentsState()
  const { activateDocument } = useActiveDocument()
  const { appliedDocumentsById, setOperationPresentationPending } = useDocumentOperations()
  const documentOperations = useDocumentEditorOperations(documentId)
  const appliedDocument = appliedDocumentsById[documentId]
  const streamingDocument = documentOperations.streamingDocument
  const [settledStreamingOperationId, setSettledStreamingOperationId] = useState<string | null>(null)
  const activeStreamingOperationIds = useRef(new Set<string>())
  const completedStreamingOperationIds = useRef(new Set<string>())
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
        const saveInvalidationAtStart = agentSaveInvalidationRef.current
        const saveVersionAtStart = versionRef.current
        const documents = window.nxcore?.documents
        const currentDocument = backendRef.current
        if (!documents || !importedRef.current || !currentDocument) {
          setSaveState(writeDocumentDraft(documentId, pending.contentJson, versionRef.current, pending.title) ? '已保存草稿' : '仅本次会话')
          return
        }
        if (currentDocument.activeTransactionId || presentingStreamRef.current) return
        if (editorLockedForReviewRef.current) return

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
          if (agentSaveInvalidationRef.current !== saveInvalidationAtStart
            || (backendRef.current?.version ?? 0) > saveVersionAtStart) {
            // An Agent commit completed while this stale user save was in
            // flight. Its CAS conflict is expected; do not resurrect it.
            pendingSave.current = null
            if (backendRef.current) versionRef.current = backendRef.current.version
            removeDocumentDraft(documentId)
            setSaveState('已保存')
            return
          }
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
    if (pendingSave.current) throw new Error(t('contextRoom:tiptapDocumentEditor.documentNotSavedTryAgainLater'))
    return versionRef.current
  }, [persistPendingSave])

  const refreshAuthoritativeDocument = useCallback((document: RoomDocument): void => {
    versionRef.current = document.version
    backendRef.current = document
    onBackendChangeRef.current(document)
    setDocumentName(document.title)
    const currentEditor = editorRef.current
    if (!currentEditor || currentEditor.isDestroyed) return
    applyingRemote.current = true
    try {
      setEditorContentPreservingView(
        currentEditor,
        stripDocumentTitle(document.contentJson).content,
      )
    } finally {
      applyingRemote.current = false
    }
  }, [])

  const invalidatePendingSaveForAgentDocument = useCallback((document: RoomDocument): void => {
    appliedDocumentVersionRef.current = Math.max(appliedDocumentVersionRef.current, document.version)
    agentSaveInvalidationRef.current += 1
    if (saveTimer.current !== null) {
      window.clearTimeout(saveTimer.current)
      saveTimer.current = null
    }
    pendingSave.current = null
    versionRef.current = document.version
    backendRef.current = document
    persistedEditRevision.current = editRevision.current
    recoveringDraft.current = false
    recoverySaveScheduled.current = false
    removeDocumentDraft(documentId)
    onBackendChangeRef.current(document)
    setDocumentName(document.title)
    setSaveState('已保存')
  }, [documentId])

  const restoreHistoryVersion = useCallback(async (): Promise<void> => {
    const selectedHistory = historyView
    const documents = window.nxcore?.documents
    if (!selectedHistory || !documents || restoringHistory) return
    const requestDocumentId = documentId
    const requestId = historyRestoreRequestRef.current + 1
    historyRestoreRequestRef.current = requestId
    const isCurrentRequest = () => (
      historyRestoreRequestRef.current === requestId
      && documentIdRef.current === requestDocumentId
    )
    setRestoringHistory(true)
    try {
      // Finish a local debounce save before taking the CAS base version for restore.
      await flushDocumentVersion()
      if (!isCurrentRequest()) return
      const latest = await documents.get(documentId)
      if (!isCurrentRequest()) return
      refreshAuthoritativeDocument(latest)
      const restored = await documents.restoreVersion(
        documentId,
        selectedHistory.snapshot.version,
        latest.version,
      )
      if (!isCurrentRequest()) return
      setHistoryView(null)
      removeDocumentDraft(documentId)
      refreshAuthoritativeDocument(restored)
      setHistoryRefreshSignal((value) => value + 1)
      showToast({ title: t('contextRoom:documentHistory.restoreSucceeded', { version: selectedHistory.snapshot.version }), message: t('contextRoom:documentHistory.restoreCreatedVersion', { version: restored.version }) })
    } catch (error: unknown) {
      if (!isCurrentRequest()) return
      if (isDocumentConflict(error)) {
        try {
          const latest = await documents.get(documentId)
          if (!isCurrentRequest()) return
          refreshAuthoritativeDocument(latest)
          showToast({ title: t('contextRoom:documentHistory.documentUpdated'), message: t('contextRoom:documentHistory.refreshedBeforeRestore', { version: latest.version }) })
          return
        } catch {
          // Fall through to the regular error toast when refresh also fails.
        }
      }
      if (!isCurrentRequest()) return
      showToast({ title: t('contextRoom:documentHistory.restoreFailed'), message: error instanceof Error ? error.message : t('contextRoom:documentHistory.versionChangedRetry') })
    } finally {
      if (isCurrentRequest()) setRestoringHistory(false)
    }
  }, [documentId, flushDocumentVersion, historyView, refreshAuthoritativeDocument, restoringHistory, t])

  const queueDocumentSave = (
    contentJson: TiptapJsonContent,
    delay = 300,
    title = documentNameRef.current,
  ): void => {
    const currentDocument = backendRef.current
    const currentBody = currentDocument
      ? stripDocumentTitle(currentDocument.contentJson).content
      : null
    // ProseMirror extensions can emit a second update while applying a remote
    // transaction. Do not turn an unchanged snapshot into another CAS write.
    if (currentDocument
      && currentDocument.title === title
      && currentBody
      && sameContent(currentBody, contentJson)
      && !pendingSave.current
      && !saveInFlight.current) {
      return
    }
    if (pendingSave.current
      && pendingSave.current.title === title
      && sameContent(pendingSave.current.contentJson, contentJson)) {
      return
    }
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

  const resolveDocumentBlockReferences = useCallback(
    async (input: ResolveDocumentBlockReferencesInput) => {
      const documents = window.nxcore?.documents
      if (!documents) throw new Error(t('contextRoom:tiptapDocumentEditor.documentReferenceServiceUnavailable'))
      return documents.resolveBlockReferences(input)
    },
    [t],
  )

  const navigateDocumentBlockReference = useCallback((
    target: Parameters<typeof requestDocumentBlockNavigation>[0],
    resolution: { status: string } | null,
  ) => {
    if (resolution && resolution.status !== 'available' && resolution.status !== 'block_missing') {
      showToast({ title: t('contextRoom:tiptapDocumentEditor.referenceTemporarilyUnavailable'), message: t(resolution.status === 'document_trashed' ? 'contextRoom:tiptapDocumentEditor.theTargetDocumentIsInTrash' : 'contextRoom:tiptapDocumentEditor.theTargetDocumentIsUnavailable') })
      return
    }
    requestDocumentBlockNavigation(target)
  }, [t])

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
        resolveReferences: resolveDocumentBlockReferences,
        onNavigate: navigateDocumentBlockReference,
      }),
      BlockIndexMark.configure({
        sourceRoomId: room.id,
        resolveReferences: resolveDocumentBlockReferences,
        onNavigateDocument: navigateDocumentBlockReference,
        getMemoryItems: () => roomRef.current?.memoryItems ?? [],
        onNavigateMemory: (target) => requestRoomMemoryNavigation({
          roomId: target.roomId,
          memoryId: target.memoryId,
        }),
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
        placeholder: ({ node }) => node.type.name === 'heading'
          ? t('contextRoom:tiptapDocumentEditor.headingPlaceholder')
          : t('contextRoom:tiptapDocumentEditor.contentPlaceholder'),
        includeChildren: true,
      }),
    ],
    content: initialContent,
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class: 'context-room-tiptap-content',
        'aria-label': t('contextRoom:tiptapDocumentEditor.roomDocumentEditor'),
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
            showToast({ title: t('contextRoom:tiptapDocumentEditor.unableToOpenBlockLink'), message: t('contextRoom:tiptapDocumentEditor.blockLinksCanOnlyOpenWithinTheSame') })
            return true
          }
          return false
        },
      },
    },
    onUpdate: ({ editor: currentEditor }) => {
      if (applyingRemote.current || initializingEditor.current) return
      const currentDocument = backendRef.current
      if (currentDocument?.activeTransactionId || presentingStreamRef.current) return
      if (ensureStableBlockIds(currentEditor)) return
      queueDocumentSave(currentEditor.getJSON() as TiptapJsonContent)
    },
    onCreate: () => {
      // Gateway owns canonical block identity at import/commit time. The
      // initial mount must not mutate the document or create a new version.
      initializingEditor.current = false
    },
  }, [documentId, locale])
  const visibleReviewOperation = documentOperations.atomicDiff?.review
  const visibleContinuationOperation = documentOperations.continuation?.review
  const historyDiffActive = historyView !== null
  const editorLocked = writing || documentOperations.locked || historyDiffActive
  const selectionRewrite = useTiptapSelectionRewrite({
    editor,
    roomId: room.id,
    documentId,
    documentName,
    prepareDocument: flushDocumentVersion,
    onDocumentApplied: (document) => {
      invalidatePendingSaveForAgentDocument(document)
    },
    externallyLocked: editorLocked,
  })

  useEffect(() => {
    if (!appliedDocument || appliedDocument.version <= appliedDocumentVersionRef.current) return
    invalidatePendingSaveForAgentDocument(appliedDocument)
    const currentEditor = editorRef.current
    if (!currentEditor || currentEditor.isDestroyed) return
    applyingRemote.current = true
    try {
      setEditorContentPreservingView(
        currentEditor,
        stripDocumentTitle(appliedDocument.contentJson).content,
      )
    } finally {
      applyingRemote.current = false
    }
  }, [appliedDocument, invalidatePendingSaveForAgentDocument])
  editorRef.current = editor
  const cursorCompletionRunning = useDocumentCursorCompletion({
    editor,
    roomId: room.id,
    roomTitle: room.title,
    documentName,
    enabled: Boolean(editor
      && !editorLocked
      && cursorCompletionEnabled
      && !documentOperations.completionBlocked
      && !selectionRewrite.preview),
    paragraphEnabled: cursorCompletionParagraphEnabled,
  })
  const editorInteractions = useTransientEditorInteractions(editor, selectionRewrite.cancel)

  useEffect(() => {
    if (!editor || editor.isDestroyed) return
    editor.setEditable(!historyView && !writing && !documentOperations.locked)
    // 同步保存闸 + 解锁补跑：锁定期被延迟的用户保存在锁释放后按防抖节奏补存。
    const wasLocked = editorLockedForReviewRef.current
    editorLockedForReviewRef.current = documentOperations.locked
    if (wasLocked && !documentOperations.locked && pendingSave.current && saveTimer.current === null) {
      saveTimer.current = window.setTimeout(() => {
        saveTimer.current = null
        void persistPendingSave()
      }, 300)
    }
  }, [documentOperations.locked, editor, historyView, writing, persistPendingSave])

  useEffect(() => {
    historyRestoreRequestRef.current += 1
    setHistoryView(null)
    setRestoringHistory(false)
  }, [documentId])

  useEffect(() => {
    if (!historyView || !backendDocument || historyView.diff.toVersion === backendDocument.version) return
    setHistoryView(null)
  }, [backendDocument, historyView])

  useEffect(() => onDocumentCursorCompletionSettingsChanged((settings) => {
    setCursorCompletionEnabled(settings.enabled)
    setCursorCompletionParagraphEnabled(settings.paragraphEnabled)
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
    if (!backendDocument) return
    if (backendDocument.activeTransactionId) {
      agentTransactionRef.current = backendDocument.activeTransactionId
      return
    }
    if (!agentTransactionRef.current) return

    // A completed Agent transaction is already the authoritative commit. Any
    // debounce payload created while rendering its draft/stream is stale and
    // must not be submitted as a second user save against the old version.
    agentTransactionRef.current = null
    agentSaveInvalidationRef.current += 1
    if (saveTimer.current !== null) {
      window.clearTimeout(saveTimer.current)
      saveTimer.current = null
    }
    pendingSave.current = null
    versionRef.current = backendDocument.version
    persistedEditRevision.current = editRevision.current
    recoveringDraft.current = false
    recoverySaveScheduled.current = false
    removeDocumentDraft(documentId)
    setSaveState('已保存')
  }, [backendDocument, documentId])

  useEffect(() => {
    const operation = streamingDocument
    if (!operation || operation.status !== 'completed') return
    // Do not discard a normal user draft for an old completed operation. Only
    // an operation observed as active in this editor session can invalidate
    // the streamed save payload.
    if (!activeStreamingOperationIds.current.has(operation.operationId)) return
    if (completedStreamingOperationIds.current.has(operation.operationId)) return
    completedStreamingOperationIds.current.add(operation.operationId)
    agentSaveInvalidationRef.current += 1

    if (saveTimer.current !== null) {
      window.clearTimeout(saveTimer.current)
      saveTimer.current = null
    }
    pendingSave.current = null
    if (backendRef.current) versionRef.current = backendRef.current.version
    persistedEditRevision.current = editRevision.current
    recoveringDraft.current = false
    recoverySaveScheduled.current = false
    removeDocumentDraft(documentId)
    if (!writing) setSaveState('已保存')
  }, [documentId, streamingDocument, writing])

  useEffect(() => {
    if (!editor) return
    if (editor.isEditable === editorLocked) editor.setEditable(!editorLocked, false)
    if (editorLocked) {
      setReferencePickerOpen(false)
      setIndexPickerOpen(false)
    }
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
    if (!documents) throw new Error(t('contextRoom:tiptapDocumentEditor.documentBlockServiceUnavailable'))
    return documents.listBlocks(targetDocumentId)
  }, [])

  const openBlockIndexPicker = useCallback((node: ProseMirrorNode) => {
    pendingIndexHostBlockIdRef.current = typeof node.attrs?.id === 'string' ? node.attrs.id : null
    setIndexPickerOpen(true)
  }, [])

  const insertBlockIndexTarget = useCallback((target: BlockIndexTarget) => {
    const currentEditor = editorRef.current
    setIndexPickerOpen(false)
    if (!currentEditor || currentEditor.isDestroyed) return
    const hostBlockId = pendingIndexHostBlockIdRef.current
    let hostPos: number | null = null
    let hostNode: ProseMirrorNode | null = null
    if (hostBlockId) {
      currentEditor.state.doc.descendants((node, pos) => {
        if (hostNode) return false
        if (typeof node.attrs?.id === 'string' && node.attrs.id === hostBlockId) {
          hostPos = pos
          hostNode = node
          return false
        }
        return true
      })
    }
    if (!hostNode || hostPos == null) {
      // The host block vanished while the picker was open; fall back to the
      // textblock holding the current selection.
      const { $from } = currentEditor.state.selection
      if ($from.parent.isTextblock && $from.parent.type.name !== 'codeBlock') {
        hostNode = $from.parent
        hostPos = $from.before()
      }
    }
    const inserted = hostNode != null && hostPos != null
      && insertBlockIndexMark(currentEditor, hostPos, hostNode, target)
    if (!inserted) {
      showToast({
        title: t('contextRoom:blockIndexMark.cannotAttachHere'),
        message: t('contextRoom:blockIndexMark.cannotAttachHereDetail'),
      })
    }
  }, [t])

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
      showToast({ title: t('contextRoom:tiptapDocumentEditor.blockReferenceCopied'), message: t('contextRoom:tiptapDocumentEditor.youCanPasteItIntoADocumentIn') })
    } catch {
      showToast({ title: t('contextRoom:tiptapDocumentEditor.copyFailed'), message: t('contextRoom:tiptapDocumentEditor.checkClipboardPermissions') })
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
        if (localized.unsupported > 0) throw new Error(t('contextRoom:tiptapDocumentEditor.documentContainsUnsupportedLegacyImages'))
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
    const locked = editorLocked
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
  }, [backendDocument, editor, editorLocked, presentingStream, visibleContinuationOperation, visibleReviewOperation, writing])

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
          showToast({ title: t('contextRoom:tiptapDocumentEditor.someOlderImagesCouldNotBeMigrated'), message: t('contextRoom:tiptapDocumentEditor.reinsertUnsupportedImages') })
        }
        return
      }
    }
    void migrate().catch((error: unknown) => {
      if (!cancelled) {
        showToast({
          title: t('contextRoom:tiptapDocumentEditor.legacyImageMigrationFailed'),
          message: error instanceof Error ? error.message : t('contextRoom:tiptapDocumentEditor.tryAgainLater'),
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
          showToast({ title: t('contextRoom:tiptapDocumentEditor.referencedBlockIsUnavailable'), message: t('contextRoom:tiptapDocumentEditor.theOriginalBlockWasDeletedOrMerged') })
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
        showToast({ title: t('contextRoom:tiptapDocumentEditor.referencedBlockIsUnavailable'), message: t('contextRoom:tiptapDocumentEditor.theOriginalBlockWasDeletedOrMerged') })
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
        <b>{historyDiffActive ? t('contextRoom:documentHistory.viewing') : t(uiText(saveState))}</b>
        {cursorCompletionRunning ? (
          <div
            className="context-room-cursor-completion-banner"
            role="status"
            aria-live="polite"
          >
            <LoaderCircle aria-hidden="true" />
            <span>{t('contextRoom:tiptapDocumentEditor.agentThinking')}</span>
          </div>
        ) : null}
        <DocumentExportStatus documentId={documentId} />
        {editor ? (
          <TiptapDocumentActions
            editor={editor}
            documentName={documentName}
            backendDocument={backendDocument}
            writing={writing}
            saving={saveState === '正在保存...'}
            onDeleteDocument={onDeleteDocument ? deleteCurrentDocument : undefined}
            documentId={documentId}
            onShowDiff={showHistoryDiff}
            onClearDiff={clearHistoryDiff}
            onCloseDiff={closeHistoryDiff}
            historyPanelCloseSignal={historyPanelCloseSignal}
            historyRefreshSignal={historyRefreshSignal}
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
            <strong>{t('contextRoom:tiptapDocumentEditor.agentWritingContent')}</strong>
          </span>
        </div>
      ) : null}
      <div
        ref={editorInteractions.scrollRef}
        className="context-room-tiptap-scroll"
      >
        {historyView ? (
          <div className="context-room-history-diff-banner" role="status">
            <div className="context-room-history-diff-context">
              <span className="context-room-history-diff-context-icon"><GitCompare aria-hidden="true" /></span>
              <span><strong>{t('contextRoom:documentHistory.diffRange', { fromVersion: historyView.snapshot.version, toVersion: historyView.diff.toVersion })}</strong><small>{historyView.snapshot.title}</small></span>
            </div>
            <div className="context-room-history-diff-legend" aria-label={t('contextRoom:documentHistory.diffLegend')}>
              <span className="is-added"><i />{t('contextRoom:documentHistory.added')}</span>
              <span className="is-removed"><i />{t('contextRoom:documentHistory.removed')}</span>
            </div>
            <button className="context-room-history-diff-exit" type="button" onClick={closeHistoryDiff} title={t('contextRoom:documentHistory.exitDiff')}>
              <X aria-hidden="true" />{t('contextRoom:documentHistory.exitDiff')}
            </button>
            <button className="context-room-history-diff-restore" type="button" disabled={restoringHistory} onClick={() => void restoreHistoryVersion()}>
              <RotateCcw aria-hidden="true" />{t('contextRoom:documentHistory.restore')}
            </button>
          </div>
        ) : null}
        {historyView ? (
          editor ? (
            <DocumentHistoryDiffView
              editor={editor}
              snapshot={historyView.snapshot}
              diff={historyView.diff}
              currentTitle={backendDocument?.title ?? documentName}
              currentContent={backendDocument?.contentJson
                ? stripDocumentTitle(backendDocument.contentJson).content
                : undefined}
            />
          ) : null
        ) : (
          <>
            <div className="context-room-document-title-block">
              <textarea
                ref={titleInputRef}
                className="context-room-document-title-input"
                aria-label={t('contextRoom:tiptapDocumentEditor.documentTitle')}
                value={documentName}
                disabled={editorLocked}
                maxLength={120}
                rows={1}
                onChange={(event) => setDocumentName(event.target.value.replace(/[\r\n]+/g, ' '))}
                onBlur={() => {
                  if (!editor || editorLocked) return
                  const title = documentName.trim() || t('contextRoom:documentOperationCenter.untitledDocument')
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
          </>
        )}
        <div className={historyView ? 'context-room-history-editor-source' : undefined}>
          <EditorContent editor={editor} />
        </div>
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
            onAddMemoryIndex={openBlockIndexPicker}
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
      {editor && indexPickerOpen && !editorLocked ? (
        <BlockIndexPicker
          roomId={room.id}
          memoryItems={roomRef.current?.memoryItems ?? []}
          onSelect={insertBlockIndexTarget}
          onClose={() => setIndexPickerOpen(false)}
        />
      ) : null}
    </div>
  )
}
