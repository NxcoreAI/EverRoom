import type {
  DocumentBlockReferenceInput,
  DocumentBlockResolution,
  ResolveDocumentBlockReferencesInput,
  ResolveDocumentBlockReferencesResult,
} from '@nxcore/agent-contract'
import {
  Node,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  mergeAttributes,
  type Editor,
  type MarkdownToken,
  type NodeViewProps,
} from '@tiptap/react'
import { FileWarning, Link2, LoaderCircle } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocale } from '../../../../../i18n/LocaleContext'

import {
  DOCUMENT_BLOCK_REFERENCE_NODE,
  documentBlockReferenceToMarkdown,
  documentBlockResolutionLabel,
  isSameRoomBlockReference,
  parseDocumentBlockReferenceMarkdown,
  fromDocumentBlockReferenceNodeAttrs,
  toDocumentBlockReferenceNodeAttrs,
  type DocumentBlockReferenceAttrs,
  type DocumentBlockReferenceNodeAttrs,
} from './documentBlockReferenceLink'
import {
  DOCUMENT_BLOCK_REFERENCES_INVALIDATED_EVENT,
  documentBlockReferenceInvalidationMatches,
  invalidateDocumentBlockReferences,
  type DocumentBlockReferenceInvalidation,
} from './documentBlockReferenceInvalidation'
import { resolveDocumentBlockReference } from './documentBlockReferenceResolver'
import './DocumentBlockReference.css'

export {
  DOCUMENT_BLOCK_REFERENCES_INVALIDATED_EVENT,
  invalidateDocumentBlockReferences,
}
export type { DocumentBlockReferenceInvalidation }

export interface DocumentBlockReferenceOptions {
  sourceRoomId: string
  resolveReferences?: (
    input: ResolveDocumentBlockReferencesInput,
  ) => Promise<ResolveDocumentBlockReferencesResult>
  onNavigate?: (
    target: DocumentBlockReferenceInput,
    resolution: DocumentBlockResolution | null,
  ) => void
}

export function insertDocumentBlockReference(
  editor: Editor,
  attrs: DocumentBlockReferenceAttrs,
): boolean {
  return editor.chain().focus().insertContent({
    type: DOCUMENT_BLOCK_REFERENCE_NODE,
    attrs: toDocumentBlockReferenceNodeAttrs(attrs),
  }).run()
}

function invalidationMatches(
  detail: DocumentBlockReferenceInvalidation,
  reference: DocumentBlockReferenceAttrs,
): boolean {
  return documentBlockReferenceInvalidationMatches(detail, reference)
}

function attrsFromNodeView(node: NodeViewProps['node']): DocumentBlockReferenceAttrs {
  return fromDocumentBlockReferenceNodeAttrs({
    id: typeof node.attrs.id === 'string' ? node.attrs.id : null,
    targetRoomId: String(node.attrs.targetRoomId || ''),
    targetDocumentId: String(node.attrs.targetDocumentId || ''),
    targetBlockId: String(node.attrs.targetBlockId || ''),
    fallbackTitle: typeof node.attrs.fallbackTitle === 'string' ? node.attrs.fallbackTitle : null,
    fallbackPreview: typeof node.attrs.fallbackPreview === 'string' ? node.attrs.fallbackPreview : null,
  })
}

function DocumentBlockReferenceView(props: NodeViewProps) {
  const { t } = useLocale()
  const reference = attrsFromNodeView(props.node)
  const options = props.extension.options as DocumentBlockReferenceOptions
  const [resolution, setResolution] = useState<DocumentBlockResolution | null>(null)
  const [loading, setLoading] = useState(true)
  const resolveSequence = useRef(0)

  const resolve = useCallback(async () => {
    const sequence = ++resolveSequence.current
    if (!reference.roomId || !reference.documentId || !reference.blockId) {
      if (sequence === resolveSequence.current) {
        setLoading(false)
        setResolution(null)
      }
      return
    }
    if (!isSameRoomBlockReference(options.sourceRoomId, reference)) {
      if (sequence === resolveSequence.current) {
        setLoading(false)
        setResolution({
          roomId: reference.roomId,
          documentId: reference.documentId,
          blockId: reference.blockId,
          status: 'room_unavailable',
          title: null,
          textPreview: null,
          version: null,
        })
      }
      return
    }
    if (!options.resolveReferences) {
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const result = await resolveDocumentBlockReference(
        options.resolveReferences,
        options.sourceRoomId,
        reference,
      )
      if (sequence === resolveSequence.current) setResolution(result)
    } catch {
      if (sequence === resolveSequence.current) setResolution(null)
    } finally {
      if (sequence === resolveSequence.current) setLoading(false)
    }
  }, [
    options,
    reference.blockId,
    reference.documentId,
    reference.roomId,
  ])

  useEffect(() => {
    void resolve()
    const refreshOnFocus = () => void resolve()
    const refreshOnInvalidation = (event: Event) => {
      const detail = (event as CustomEvent<DocumentBlockReferenceInvalidation>).detail ?? {}
      if (invalidationMatches(detail, reference)) void resolve()
    }
    window.addEventListener('focus', refreshOnFocus)
    window.addEventListener(DOCUMENT_BLOCK_REFERENCES_INVALIDATED_EVENT, refreshOnInvalidation)
    return () => {
      resolveSequence.current += 1
      window.removeEventListener('focus', refreshOnFocus)
      window.removeEventListener(DOCUMENT_BLOCK_REFERENCES_INVALIDATED_EVENT, refreshOnInvalidation)
    }
  }, [reference.blockId, reference.documentId, reference.roomId, resolve])

  const available = resolution?.status === 'available'
  const title = resolution?.title || reference.fallbackTitle || t('引用的文档')
  const preview = resolution?.textPreview || reference.fallbackPreview || t('内容预览不可用')
  const canNavigate = Boolean(options.onNavigate)

  return (
    <NodeViewWrapper
      className="context-room-document-block-reference"
      data-status={resolution?.status ?? (loading ? 'loading' : 'unresolved')}
      data-block-id={reference.id || undefined}
      contentEditable={false}
    >
      <button
        type="button"
        disabled={!canNavigate}
        onClick={() => options.onNavigate?.(reference, resolution)}
        title={canNavigate ? t('打开引用位置') : undefined}
      >
        <span className="context-room-document-block-reference-icon" aria-hidden="true">
          {loading ? <LoaderCircle /> : available ? <Link2 /> : <FileWarning />}
        </span>
        <span>
          <strong>{title}</strong>
          <small>{preview}</small>
        </span>
        <em>{loading ? t('正在读取引用') : t(documentBlockResolutionLabel(resolution))}</em>
      </button>
    </NodeViewWrapper>
  )
}

export const DocumentBlockReference = Node.create<DocumentBlockReferenceOptions>({
  name: DOCUMENT_BLOCK_REFERENCE_NODE,
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,

  addOptions() {
    return { sourceRoomId: '' }
  },

  addAttributes() {
    return {
      id: { default: null },
      targetRoomId: { default: '' },
      targetDocumentId: { default: '' },
      targetBlockId: { default: '' },
      fallbackTitle: { default: null },
      fallbackPreview: { default: null },
    }
  },

  parseHTML() {
    return [{
      tag: '[data-document-block-reference]',
      getAttrs: (element) => {
        if (!(element instanceof HTMLElement)) return false
        return {
          id: element.getAttribute('data-block-id'),
          targetRoomId: element.getAttribute('data-room-id') || '',
          targetDocumentId: element.getAttribute('data-document-id') || '',
          targetBlockId: element.getAttribute('data-target-block-id') || '',
          fallbackTitle: element.getAttribute('data-fallback-title'),
          fallbackPreview: element.getAttribute('data-fallback-preview'),
        }
      },
    }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes({
      'data-document-block-reference': '',
      'data-block-id': HTMLAttributes.id || undefined,
      'data-room-id': HTMLAttributes.targetRoomId,
      'data-document-id': HTMLAttributes.targetDocumentId,
      'data-target-block-id': HTMLAttributes.targetBlockId,
      'data-fallback-title': HTMLAttributes.fallbackTitle || undefined,
      'data-fallback-preview': HTMLAttributes.fallbackPreview || undefined,
    })]
  },

  markdownTokenName: DOCUMENT_BLOCK_REFERENCE_NODE,

  markdownTokenizer: {
    name: DOCUMENT_BLOCK_REFERENCE_NODE,
    level: 'block',
    start: (source) => source.search(/^\s*\[[^\]]*\]\(everroom:\/\//m),
    tokenize(source) {
      const attrs = parseDocumentBlockReferenceMarkdown(source)
      if (!attrs) return undefined
      const raw = source.match(/^\s*\[((?:\\.|[^\]])*)\]\((everroom:\/\/[^\s)]+)(?:\s+["'][^)]*["'])?\)\s*(?:\r?\n|$)/)?.[0]
      if (!raw) return undefined
      return { type: DOCUMENT_BLOCK_REFERENCE_NODE, raw, attrs } as MarkdownToken
    },
  },

  parseMarkdown(token, helpers) {
    return helpers.createNode(
      DOCUMENT_BLOCK_REFERENCE_NODE,
      toDocumentBlockReferenceNodeAttrs(token.attrs as DocumentBlockReferenceAttrs),
      [],
    )
  },

  renderMarkdown(node) {
    return documentBlockReferenceToMarkdown(
      fromDocumentBlockReferenceNodeAttrs(node.attrs as DocumentBlockReferenceNodeAttrs),
    )
  },

  addNodeView() {
    return ReactNodeViewRenderer(DocumentBlockReferenceView)
  },
})
