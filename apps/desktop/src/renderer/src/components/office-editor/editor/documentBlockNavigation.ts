import type { DocumentBlockReferenceInput } from '@nxcore/agent-contract'
import { Extension, type Editor } from '@tiptap/react'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'

export const OPEN_DOCUMENT_BLOCK_EVENT = 'everroom:open-document-block'

/** 跳转链路诊断:App→详情→编辑器各环节落到 desktop-*.log 的 document-focus 模块。 */
export function logDocumentFocusDiagnostic(event: Record<string, unknown>): void {
  try {
    window.nxcore?.diagnostics?.log({ module: 'document-focus', level: 'info', event })
  } catch {
    // 诊断失败不影响跳转。
  }
}

export function requestDocumentBlockNavigation(target: DocumentBlockReferenceInput): void {
  window.dispatchEvent(new CustomEvent<DocumentBlockReferenceInput>(OPEN_DOCUMENT_BLOCK_EVENT, { detail: target }))
}

export function onDocumentBlockNavigation(
  listener: (target: DocumentBlockReferenceInput) => void,
): () => void {
  const handle = (event: Event) => listener((event as CustomEvent<DocumentBlockReferenceInput>).detail)
  window.addEventListener(OPEN_DOCUMENT_BLOCK_EVENT, handle)
  return () => window.removeEventListener(OPEN_DOCUMENT_BLOCK_EVENT, handle)
}

export interface DocumentBlockNavigationPlan {
  requestKey: string
  handledKey: string | null
  shouldOpenDocument: boolean
  shouldFocusBlock: boolean
  documentUnavailable: boolean
}

export type DocumentBlockFocusResult = 'focused' | 'block_missing' | 'editor_unavailable'

export function documentBlockNavigationKey(target: DocumentBlockReferenceInput): string {
  return `${target.roomId}\u0000${target.documentId}\u0000${target.blockId}`
}

export function documentBlockFocusRequestKey(
  documentId: string,
  blockId: string,
  requestId: number | null | undefined,
): string {
  return `${documentId}\u0000${blockId}\u0000${requestId ?? 'legacy'}`
}

export function planDocumentBlockNavigation(
  handledKey: string | null,
  target: DocumentBlockReferenceInput,
  currentRoomId: string | null,
  currentDocumentId: string | null,
  documentAvailable: boolean,
): DocumentBlockNavigationPlan {
  const requestKey = documentBlockNavigationKey(target)
  if (handledKey === requestKey) {
    return {
      requestKey,
      handledKey,
      shouldOpenDocument: false,
      shouldFocusBlock: false,
      documentUnavailable: false,
    }
  }
  if (!documentAvailable) {
    return {
      requestKey,
      handledKey: requestKey,
      shouldOpenDocument: false,
      shouldFocusBlock: false,
      documentUnavailable: true,
    }
  }
  const documentIsOpen = currentRoomId === target.roomId && currentDocumentId === target.documentId
  return {
    requestKey,
    handledKey: documentIsOpen ? requestKey : handledKey,
    shouldOpenDocument: !documentIsOpen,
    shouldFocusBlock: documentIsOpen,
    documentUnavailable: false,
  }
}

export function findDocumentBlockElement(
  editorRoot: ParentNode,
  blockId: string,
): HTMLElement | null {
  for (const element of editorRoot.querySelectorAll<HTMLElement>('[data-block-id]')) {
    if (element.getAttribute('data-block-id') === blockId) return element
  }
  return null
}

export const documentReferenceFlashPluginKey = new PluginKey<DocumentReferenceFlashState | null>('documentReferenceFlash')

interface DocumentReferenceFlashState {
  id: number
  decorations: DecorationSet
}

let documentReferenceFlashSequence = 0

/** 引用跳转闪烁插件：decoration 挂类，PM 重绘会自动补回类名，不怕目标节点 DOM 被替换。 */
export function documentReferenceFlashExtension(): Extension {
  return Extension.create({
    name: 'documentReferenceFlash',
    addProseMirrorPlugins() {
      return [
        new Plugin<DocumentReferenceFlashState | null>({
          key: documentReferenceFlashPluginKey,
          state: {
            init: () => null,
            apply: (tr, value) => {
              const meta = tr.getMeta(documentReferenceFlashPluginKey) as DocumentReferenceFlashState | null | undefined
              if (meta !== undefined) return meta
              return value ? { ...value, decorations: value.decorations.map(tr.mapping, tr.doc) } : null
            },
          },
          props: {
            decorations: (state) => documentReferenceFlashPluginKey.getState(state)?.decorations ?? null,
          },
        }),
      ]
    },
  })
}

export interface DocumentBlockFocusOptions {
  flashDurationMs?: number
  onFlashEnd?: () => void
}

export function flashDocumentBlock(
  editor: Editor,
  blockId: string,
  options: DocumentBlockFocusOptions = {},
): DocumentBlockFocusResult {
  if (editor.isDestroyed) return 'editor_unavailable'
  const block = findDocumentBlockElement(editor.view.dom, blockId)
  if (!block) return 'block_missing'
  block.scrollIntoView({ block: 'center', behavior: 'smooth' })

  const nodeRange = resolveBlockNodeRange(editor, block, blockId)
  if (!nodeRange) return 'block_missing'
  const decoration = Decoration.node(nodeRange.from, nodeRange.to, {
    class: 'context-room-reference-flash-target',
  })
  const id = ++documentReferenceFlashSequence
  const state: DocumentReferenceFlashState = {
    id,
    decorations: DecorationSet.create(editor.state.doc, [decoration]),
  }
  // 同步先清后挂（两次 dispatch 间无绘制）：重跳同一块时类名重新落地，动画才会重启。
  editor.view.dispatch(editor.state.tr.setMeta(documentReferenceFlashPluginKey, null))
  editor.view.dispatch(editor.state.tr.setMeta(documentReferenceFlashPluginKey, state))
  const duration = options.flashDurationMs ?? 1_800
  window.setTimeout(() => {
    if (editor.isDestroyed) return
    // 只清自己这一轮（id 校验）：后续跳转或事务 map 过的 state 不误清。
    if (documentReferenceFlashPluginKey.getState(editor.state)?.id !== id) return
    editor.view.dispatch(editor.state.tr.setMeta(documentReferenceFlashPluginKey, null))
    options.onFlashEnd?.()
  }, duration)
  return 'focused'
}

function resolveBlockNodeRange(
  editor: Editor,
  block: HTMLElement,
  blockId: string,
): { from: number; to: number } | null {
  try {
    const inside = editor.view.posAtDOM(block, 0)
    const $pos = editor.state.doc.resolve(inside)
    for (let depth = $pos.depth; depth > 0; depth--) {
      if ($pos.node(depth).attrs?.id === blockId) {
        const from = $pos.before(depth)
        return { from, to: from + $pos.node(depth).nodeSize }
      }
    }
  } catch {
    return null
  }
  return null
}
