import { useEditorState, type Editor } from '@tiptap/react'
import { BubbleMenu } from '@tiptap/react/menus'
import { MessageSquarePlus } from 'lucide-react'
import { TextSelection } from '@tiptap/pm/state'
import {
  ArrowUp,
  Bold,
  Code2,
  Italic,
  Link2,
  Maximize2,
  Replace,
  RotateCcw,
  Sparkles,
  Strikethrough,
  TextCursorInput,
  Trash2,
  Underline,
  Unlink2,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useLocale } from '../../../../../i18n/LocaleContext'

import { showToast } from '../../../../../state/toast'
import { EditorIconButton } from './EditorIconButton'
import { DOCUMENT_IMAGE_ACCEPT, storeDocumentImageFile } from './documentImageAssets'
import { blockIndexTargetFromClipboardText } from './blockIndexLink'
import { handleBlockIndexPaste } from './BlockIndexMark'
import {
  clearSelectionRewritePromptDecoration,
  showSelectionRewritePromptDecoration,
} from './TiptapSelectionRewrite'

function normalizeLink(value: string): string | null {
  const link = value.trim()
  if (!link || /^(javascript|data):/i.test(link)) return null
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(link)) return `mailto:${link}`
  return /^[a-z][a-z\d+.-]*:/i.test(link) ? link : `https://${link}`
}

const IMAGE_PREVIEW_MIN_SCALE = 0.25
const IMAGE_PREVIEW_MAX_SCALE = 4
const IMAGE_PREVIEW_SCALE_STEP = 0.25

function clampImagePreviewScale(scale: number): number {
  return Math.min(IMAGE_PREVIEW_MAX_SCALE, Math.max(IMAGE_PREVIEW_MIN_SCALE, scale))
}

export function TiptapBubbleToolbar({
  editor,
  documentId,
  sourceRoomId,
  onAskAi,
}: {
  editor: Editor
  documentId: string
  sourceRoomId: string
  onAskAi: (instruction: string) => void
}) {
  const { t } = useLocale()
  const [linkOpen, setLinkOpen] = useState(false)
  const [commentOpen, setCommentOpen] = useState(false)
  const [commentDraft, setCommentDraft] = useState('')
  const [commentSubmitting, setCommentSubmitting] = useState(false)
  const commentSelectionRef = useRef<{ from: number; to: number; quotedText: string } | null>(null)
  const [linkValue, setLinkValue] = useState('')
  const [askAiOpen, setAskAiOpen] = useState(false)
  const [askAiInstruction, setAskAiInstruction] = useState('')
  const [imageAltOpen, setImageAltOpen] = useState(false)
  const [imageAltValue, setImageAltValue] = useState('')
  const [imagePreview, setImagePreview] = useState<{ src: string; alt: string } | null>(null)
  const [imagePreviewScale, setImagePreviewScale] = useState(1)
  const [imagePreviewSize, setImagePreviewSize] = useState<{ width: number; height: number } | null>(null)
  const askAiFormRef = useRef<HTMLFormElement>(null)
  const imageInputRef = useRef<HTMLInputElement>(null)
  const imagePositionRef = useRef<number | null>(null)
  const toolbarState = useEditorState({
    editor,
    selector: ({ editor: currentEditor }) => {
      const selection = currentEditor.state.selection

      return {
        askAiDisabled: !(selection instanceof TextSelection) ||
          selection.empty,
        boldActive: currentEditor.isActive('bold'),
        codeActive: currentEditor.isActive('code'),
        italicActive: currentEditor.isActive('italic'),
        imageActive: currentEditor.isActive('image'),
        imageHeight: currentEditor.getAttributes('image').height as number | null | undefined,
        imageSrc: currentEditor.getAttributes('image').src as string | null | undefined,
        imageWidth: currentEditor.getAttributes('image').width as number | null | undefined,
        linkActive: currentEditor.isActive('link'),
        strikeActive: currentEditor.isActive('strike'),
        underlineActive: currentEditor.isActive('underline'),
      }
    },
  })

  const openLink = () => {
    setLinkValue(editor.getAttributes('link').href ?? '')
    setLinkOpen((open) => !open)
  }

  const applyLink = () => {
    const raw = linkValue.trim()
    // 块/记忆链接不落文字链接——挂成索引 chip（复用粘贴路径的校验与 toast）。
    if (blockIndexTargetFromClipboardText(raw)) {
      handleBlockIndexPaste(
        editor.view,
        { clipboardData: { getData: (type: string) => (type === 'text/plain' ? raw : '') } },
        { sourceRoomId },
      )
      setLinkOpen(false)
      return
    }
    const href = normalizeLink(linkValue)
    if (!href) return
    editor.chain().focus().extendMarkRange('link').setLink({ href }).run()
    setLinkOpen(false)
  }

  const closeAskAi = () => {
    clearSelectionRewritePromptDecoration(editor)
    setAskAiOpen(false)
  }

  const updateSelectedImage = (attrs: Record<string, unknown>) => {
    const position = imagePositionRef.current
    const chain = editor.chain().focus()
    if (position !== null) chain.setNodeSelection(position)
    chain.updateAttributes('image', attrs).run()
  }

  const replaceImage = async (file: File) => {
    const documents = window.nxcore?.documents
    if (!documents) throw new Error(t('contextRoom:tiptapBubbleToolbar.theLocalImageServiceIsUnavailable'))
    const stored = await storeDocumentImageFile(file, documentId, documents.storeImage)
    updateSelectedImage({
      src: stored.src,
      alt: file.name.replace(/\.[^.]+$/, ''),
      width: null,
      height: null,
    })
  }

  const applyImageAlt = () => {
    updateSelectedImage({ alt: imageAltValue.trim() || null })
    setImageAltOpen(false)
  }

  const closeImagePreview = () => {
    setImagePreview(null)
    setImagePreviewScale(1)
    setImagePreviewSize(null)
  }

  const changeImagePreviewScale = (delta: number) => {
    setImagePreviewScale((scale) => clampImagePreviewScale(scale + delta))
  }

  const submitAskAi = () => {
    onAskAi(askAiInstruction)
    setAskAiInstruction('')
    setAskAiOpen(false)
  }

  useEffect(() => () => {
    clearSelectionRewritePromptDecoration(editor)
  }, [editor])

  useEffect(() => {
    const closeEditorsOnSelectionChange = () => {
      setLinkOpen(false)
      setImageAltOpen(false)
    }
    editor.on('selectionUpdate', closeEditorsOnSelectionChange)
    return () => {
      editor.off('selectionUpdate', closeEditorsOnSelectionChange)
    }
  }, [editor])

  useEffect(() => {
    if (!askAiOpen) return
    const closeForOutsidePointer = (event: PointerEvent) => {
      if (askAiFormRef.current?.contains(event.target as globalThis.Node)) return
      clearSelectionRewritePromptDecoration(editor)
      setAskAiOpen(false)
    }
    document.addEventListener('pointerdown', closeForOutsidePointer)
    return () => document.removeEventListener('pointerdown', closeForOutsidePointer)
  }, [askAiOpen, editor])

  useEffect(() => {
    if (!imagePreview) return
    const previousOverflow = document.body.style.overflow
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeImagePreview()
      if (event.key === '+' || event.key === '=') changeImagePreviewScale(IMAGE_PREVIEW_SCALE_STEP)
      if (event.key === '-') changeImagePreviewScale(-IMAGE_PREVIEW_SCALE_STEP)
      if (event.key === '0') setImagePreviewScale(1)
    }
    document.body.style.overflow = 'hidden'
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.body.style.overflow = previousOverflow
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [imagePreview])

  return (
    <>
      <BubbleMenu
        editor={editor}
        className="context-room-tiptap-bubble"
        shouldShow={({ editor: currentEditor }) => currentEditor.isActive('image') || (
          !currentEditor.state.selection.empty && !currentEditor.isActive('table')
        )}
      >
      <input
        ref={imageInputRef}
        type="file"
        accept={DOCUMENT_IMAGE_ACCEPT}
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.currentTarget.value = ''
          if (!file) return
          void replaceImage(file).catch((error: unknown) => {
            showToast({
              title: t('contextRoom:tiptapBubbleToolbar.unableToReplaceImage'),
              message: error instanceof Error ? error.message : t('contextRoom:tiptapBubbleToolbar.tryAgainLater'),
            })
          })
        }}
      />
      {!commentOpen || toolbarState.imageActive ? toolbarState.imageActive ? imageAltOpen ? (
        <form className="context-room-tiptap-bubble-link" onSubmit={(event) => { event.preventDefault(); applyImageAlt() }}>
          <input
            autoFocus
            aria-label={t('contextRoom:tiptapBubbleToolbar.imageAltText')}
            placeholder={t('contextRoom:tiptapBubbleToolbar.altText')}
            value={imageAltValue}
            onChange={(event) => setImageAltValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                setImageAltOpen(false)
              }
            }}
          />
          <button type="submit">{t('contextRoom:tiptapBubbleToolbar.apply')}</button>
        </form>
      ) : (
        <>
          <EditorIconButton
            label={t('contextRoom:tiptapBubbleToolbar.replaceImage')}
            onClick={() => {
              imagePositionRef.current = editor.state.selection.from
              imageInputRef.current?.click()
            }}
          ><Replace /></EditorIconButton>
          <EditorIconButton
            label={t('contextRoom:tiptapBubbleToolbar.altText')}
            onClick={() => {
              imagePositionRef.current = editor.state.selection.from
              setImageAltValue(String(editor.getAttributes('image').alt ?? ''))
              setImageAltOpen(true)
            }}
          ><TextCursorInput /></EditorIconButton>
          <EditorIconButton
            label={t('contextRoom:tiptapBubbleToolbar.openLargePreview')}
            disabled={!toolbarState.imageSrc}
            onClick={() => {
              const attributes = editor.getAttributes('image')
              if (typeof attributes.src !== 'string' || !attributes.src) return
              setImagePreviewScale(1)
              setImagePreviewSize(null)
              setImagePreview({
                src: attributes.src,
                alt: typeof attributes.alt === 'string' ? attributes.alt : '',
              })
            }}
          ><Maximize2 /></EditorIconButton>
          <EditorIconButton
            label={t('contextRoom:tiptapBubbleToolbar.restoreOriginalSize')}
            disabled={toolbarState.imageWidth == null && toolbarState.imageHeight == null}
            onClick={() => {
              imagePositionRef.current = editor.state.selection.from
              updateSelectedImage({ width: null, height: null })
            }}
          ><RotateCcw /></EditorIconButton>
          <span className="context-room-tiptap-bubble-divider" />
          <EditorIconButton
            label={t('contextRoom:tiptapBubbleToolbar.deleteImage')}
            onClick={() => editor.chain().focus().deleteSelection().run()}
          ><Trash2 /></EditorIconButton>
        </>
      ) : askAiOpen ? (
        <form ref={askAiFormRef} className="context-room-tiptap-bubble-ai" onSubmit={(event) => { event.preventDefault(); submitAskAi() }}>
          <Sparkles aria-hidden="true" />
          <input
            autoFocus
            aria-label={t('contextRoom:tiptapBubbleToolbar.rewriteInstructions')}
            placeholder={t('contextRoom:tiptapBubbleToolbar.howShouldThisBeRewritten')}
            value={askAiInstruction}
            onChange={(event) => setAskAiInstruction(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                closeAskAi()
              }
            }}
          />
          <button type="submit" aria-label={t('contextRoom:tiptapBubbleToolbar.startRewriting')} title={t('contextRoom:tiptapBubbleToolbar.startRewriting')}><ArrowUp /></button>
          <button type="button" aria-label={t('contextRoom:tiptapBubbleToolbar.close')} title={t('contextRoom:tiptapBubbleToolbar.close')} onClick={closeAskAi}><X /></button>
        </form>
      ) : linkOpen ? (
        <form className="context-room-tiptap-bubble-link" onSubmit={(event) => { event.preventDefault(); applyLink() }}>
          <input
            autoFocus
            aria-label={t('contextRoom:tiptapBubbleToolbar.linkUrl')}
            placeholder="https://"
            value={linkValue}
            onChange={(event) => setLinkValue(event.target.value)}
          />
          <button type="submit">{t('contextRoom:tiptapBubbleToolbar.apply')}</button>
          </form>
      ) : (
        <>
          <EditorIconButton label={t('contextRoom:tiptapBubbleToolbar.bold')} active={toolbarState.boldActive} onClick={() => editor.chain().focus().toggleBold().run()}><Bold /></EditorIconButton>
          <EditorIconButton label={t('contextRoom:tiptapBubbleToolbar.italic')} active={toolbarState.italicActive} onClick={() => editor.chain().focus().toggleItalic().run()}><Italic /></EditorIconButton>
          <EditorIconButton label={t('contextRoom:tiptapBubbleToolbar.underline')} active={toolbarState.underlineActive} onClick={() => editor.chain().focus().toggleUnderline().run()}><Underline /></EditorIconButton>
          <EditorIconButton label={t('contextRoom:tiptapBubbleToolbar.strikethrough')} active={toolbarState.strikeActive} onClick={() => editor.chain().focus().toggleStrike().run()}><Strikethrough /></EditorIconButton>
          <EditorIconButton label={t('contextRoom:tiptapBubbleToolbar.inlineCode')} active={toolbarState.codeActive} onClick={() => editor.chain().focus().toggleCode().run()}><Code2 /></EditorIconButton>
          <span className="context-room-tiptap-bubble-divider" />
          <EditorIconButton label={t('contextRoom:tiptapBubbleToolbar.addLink')} active={toolbarState.linkActive} onClick={openLink}><Link2 /></EditorIconButton>
          {toolbarState.linkActive ? (
            <EditorIconButton label={t('contextRoom:tiptapBubbleToolbar.removeLink')} onClick={() => editor.chain().focus().unsetLink().run()}><Unlink2 /></EditorIconButton>
          ) : null}
          <span className="context-room-tiptap-bubble-divider" />
          <button
            type="button"
            className="context-room-tiptap-ask-ai"
            aria-label="Ask AI"
            title={toolbarState.askAiDisabled ? t('contextRoom:tiptapBubbleToolbar.selectSomeText') : 'Ask AI'}
            disabled={toolbarState.askAiDisabled}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              if (!showSelectionRewritePromptDecoration(editor)) return
              setLinkOpen(false)
              setAskAiOpen(true)
            }}
          >
            <Sparkles aria-hidden="true" />
            <span>Ask AI</span>
          </button>
          <span className="context-room-tiptap-bubble-divider" />
          <EditorIconButton
            label={t('contextRoom:tiptapBubbleToolbar.addComment')}
            onClick={() => {
              const { from, to } = editor.state.selection
              commentSelectionRef.current = { from, to, quotedText: editor.state.doc.textBetween(from, to, ' ').slice(0, 500) }
              setLinkOpen(false)
              setAskAiOpen(false)
              setCommentDraft('')
              setCommentOpen(true)
            }}
          ><MessageSquarePlus aria-hidden="true" /></EditorIconButton>
        </>
      ) : null}
      {commentOpen && !toolbarState.imageActive ? (
        <form
          className="context-room-tiptap-bubble-comment"
          onSubmit={(event) => {
            event.preventDefault()
            const selection = commentSelectionRef.current
            const body = commentDraft.trim()
            if (!selection || !body || commentSubmitting) return
            setCommentSubmitting(true)
            void window.nxcore?.documents.createDocumentComment(documentId, {
              body,
              quotedText: selection.quotedText || null,
            })
              .then(() => {
                setCommentOpen(false)
                setCommentDraft('')
                showToast({ title: t('contextRoom:tiptapBubbleToolbar.commentAdded') })
              })
              .catch((error: unknown) => {
                showToast({
                  title: t('contextRoom:tiptapBubbleToolbar.commentFailed'),
                  message: error instanceof Error ? error.message : undefined,
                })
              })
              .finally(() => setCommentSubmitting(false))
          }}
        >
          <input
            autoFocus
            aria-label={t('contextRoom:tiptapBubbleToolbar.commentInput')}
            placeholder={t('contextRoom:tiptapBubbleToolbar.commentPlaceholder')}
            value={commentDraft}
            maxLength={4000}
            onChange={(event) => setCommentDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                setCommentOpen(false)
              }
            }}
          />
          <button type="submit" disabled={commentSubmitting || !commentDraft.trim()}>
            {t('contextRoom:tiptapBubbleToolbar.commentSubmit')}
          </button>
        </form>
      ) : null}
      </BubbleMenu>
      {imagePreview && typeof document !== 'undefined' ? createPortal(
        <div
          className="context-room-document-image-preview"
          role="dialog"
          aria-modal="true"
          aria-label={t('contextRoom:tiptapBubbleToolbar.imagePreview')}
          data-scale={imagePreviewScale}
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) closeImagePreview()
          }}
        >
          <button
            type="button"
            className="context-room-document-image-preview-close"
            aria-label={t('contextRoom:tiptapBubbleToolbar.closeImagePreview')}
            title={t('contextRoom:tiptapBubbleToolbar.close')}
            autoFocus
            onClick={closeImagePreview}
          >
            <X aria-hidden="true" />
          </button>
          <div
            className="context-room-document-image-preview-viewport"
            onWheel={(event) => {
              if (!event.ctrlKey && !event.metaKey) return
              event.preventDefault()
              changeImagePreviewScale(event.deltaY < 0
                ? IMAGE_PREVIEW_SCALE_STEP
                : -IMAGE_PREVIEW_SCALE_STEP)
            }}
          >
            <div className="context-room-document-image-preview-canvas">
              <img
                src={imagePreview.src}
                alt={imagePreview.alt}
                draggable={false}
                style={imagePreviewSize ? {
                  width: imagePreviewSize.width * imagePreviewScale,
                  height: imagePreviewSize.height * imagePreviewScale,
                  maxWidth: 'none',
                  maxHeight: 'none',
                } : undefined}
                onLoad={(event) => {
                  if (imagePreviewSize) return
                  const { width, height } = event.currentTarget.getBoundingClientRect()
                  if (width > 0 && height > 0) setImagePreviewSize({ width, height })
                }}
              />
            </div>
          </div>
          <div className="context-room-document-image-preview-controls" aria-label={t('contextRoom:tiptapBubbleToolbar.previewZoom')}>
            <button
              type="button"
              aria-label={t('contextRoom:tiptapBubbleToolbar.zoomOutImage')}
              title={t('contextRoom:tiptapBubbleToolbar.zoomOut')}
              disabled={imagePreviewScale <= IMAGE_PREVIEW_MIN_SCALE}
              onClick={() => changeImagePreviewScale(-IMAGE_PREVIEW_SCALE_STEP)}
            ><ZoomOut aria-hidden="true" /></button>
            <output aria-live="polite">{Math.round(imagePreviewScale * 100)}%</output>
            <button
              type="button"
              aria-label={t('contextRoom:tiptapBubbleToolbar.zoomInImage')}
              title={t('contextRoom:tiptapBubbleToolbar.zoomIn')}
              disabled={imagePreviewScale >= IMAGE_PREVIEW_MAX_SCALE}
              onClick={() => changeImagePreviewScale(IMAGE_PREVIEW_SCALE_STEP)}
            ><ZoomIn aria-hidden="true" /></button>
            <button
              type="button"
              aria-label={t('contextRoom:tiptapBubbleToolbar.fitToView')}
              title={t('contextRoom:tiptapBubbleToolbar.fitToView')}
              disabled={imagePreviewScale === 1}
              onClick={() => setImagePreviewScale(1)}
            ><RotateCcw aria-hidden="true" /></button>
          </div>
          {imagePreview.alt ? <span>{imagePreview.alt}</span> : null}
        </div>,
        document.body,
      ) : null}
    </>
  )
}
