import { useEditorState, type Editor } from '@tiptap/react'
import { BubbleMenu } from '@tiptap/react/menus'
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

import { showToast } from '../../../../../state/toast'
import { EditorIconButton } from './EditorIconButton'
import { DOCUMENT_IMAGE_ACCEPT, storeDocumentImageFile } from './documentImageAssets'
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
  onAskAi,
}: {
  editor: Editor
  documentId: string
  onAskAi: (instruction: string) => void
}) {
  const [linkOpen, setLinkOpen] = useState(false)
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
    if (!documents) throw new Error('本地图片服务不可用。')
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
              title: '无法替换图片',
              message: error instanceof Error ? error.message : '请稍后重试。',
            })
          })
        }}
      />
      {toolbarState.imageActive ? imageAltOpen ? (
        <form className="context-room-tiptap-bubble-link" onSubmit={(event) => { event.preventDefault(); applyImageAlt() }}>
          <input
            autoFocus
            aria-label="图片替代文本"
            placeholder="替代文本"
            value={imageAltValue}
            onChange={(event) => setImageAltValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                setImageAltOpen(false)
              }
            }}
          />
          <button type="submit">应用</button>
        </form>
      ) : (
        <>
          <EditorIconButton
            label="替换图片"
            onClick={() => {
              imagePositionRef.current = editor.state.selection.from
              imageInputRef.current?.click()
            }}
          ><Replace /></EditorIconButton>
          <EditorIconButton
            label="替代文本"
            onClick={() => {
              imagePositionRef.current = editor.state.selection.from
              setImageAltValue(String(editor.getAttributes('image').alt ?? ''))
              setImageAltOpen(true)
            }}
          ><TextCursorInput /></EditorIconButton>
          <EditorIconButton
            label="放大预览"
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
            label="恢复原始尺寸"
            disabled={toolbarState.imageWidth == null && toolbarState.imageHeight == null}
            onClick={() => {
              imagePositionRef.current = editor.state.selection.from
              updateSelectedImage({ width: null, height: null })
            }}
          ><RotateCcw /></EditorIconButton>
          <span className="context-room-tiptap-bubble-divider" />
          <EditorIconButton
            label="删除图片"
            onClick={() => editor.chain().focus().deleteSelection().run()}
          ><Trash2 /></EditorIconButton>
        </>
      ) : askAiOpen ? (
        <form ref={askAiFormRef} className="context-room-tiptap-bubble-ai" onSubmit={(event) => { event.preventDefault(); submitAskAi() }}>
          <Sparkles aria-hidden="true" />
          <input
            autoFocus
            aria-label="重写要求"
            placeholder="如何重写？"
            value={askAiInstruction}
            onChange={(event) => setAskAiInstruction(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                closeAskAi()
              }
            }}
          />
          <button type="submit" aria-label="开始重写" title="开始重写"><ArrowUp /></button>
          <button type="button" aria-label="关闭" title="关闭" onClick={closeAskAi}><X /></button>
        </form>
      ) : linkOpen ? (
        <form className="context-room-tiptap-bubble-link" onSubmit={(event) => { event.preventDefault(); applyLink() }}>
          <input
            autoFocus
            aria-label="链接地址"
            placeholder="https://"
            value={linkValue}
            onChange={(event) => setLinkValue(event.target.value)}
          />
          <button type="submit">应用</button>
          </form>
      ) : (
        <>
          <EditorIconButton label="粗体" active={toolbarState.boldActive} onClick={() => editor.chain().focus().toggleBold().run()}><Bold /></EditorIconButton>
          <EditorIconButton label="斜体" active={toolbarState.italicActive} onClick={() => editor.chain().focus().toggleItalic().run()}><Italic /></EditorIconButton>
          <EditorIconButton label="下划线" active={toolbarState.underlineActive} onClick={() => editor.chain().focus().toggleUnderline().run()}><Underline /></EditorIconButton>
          <EditorIconButton label="删除线" active={toolbarState.strikeActive} onClick={() => editor.chain().focus().toggleStrike().run()}><Strikethrough /></EditorIconButton>
          <EditorIconButton label="行内代码" active={toolbarState.codeActive} onClick={() => editor.chain().focus().toggleCode().run()}><Code2 /></EditorIconButton>
          <span className="context-room-tiptap-bubble-divider" />
          <EditorIconButton label="添加链接" active={toolbarState.linkActive} onClick={openLink}><Link2 /></EditorIconButton>
          {toolbarState.linkActive ? (
            <EditorIconButton label="移除链接" onClick={() => editor.chain().focus().unsetLink().run()}><Unlink2 /></EditorIconButton>
          ) : null}
          <span className="context-room-tiptap-bubble-divider" />
          <button
            type="button"
            className="context-room-tiptap-ask-ai"
            aria-label="Ask AI"
            title={toolbarState.askAiDisabled ? '请选择文本' : 'Ask AI'}
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
        </>
      )}
      </BubbleMenu>
      {imagePreview && typeof document !== 'undefined' ? createPortal(
        <div
          className="context-room-document-image-preview"
          role="dialog"
          aria-modal="true"
          aria-label="图片预览"
          data-scale={imagePreviewScale}
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) closeImagePreview()
          }}
        >
          <button
            type="button"
            className="context-room-document-image-preview-close"
            aria-label="关闭图片预览"
            title="关闭"
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
          <div className="context-room-document-image-preview-controls" aria-label="预览缩放">
            <button
              type="button"
              aria-label="缩小图片"
              title="缩小"
              disabled={imagePreviewScale <= IMAGE_PREVIEW_MIN_SCALE}
              onClick={() => changeImagePreviewScale(-IMAGE_PREVIEW_SCALE_STEP)}
            ><ZoomOut aria-hidden="true" /></button>
            <output aria-live="polite">{Math.round(imagePreviewScale * 100)}%</output>
            <button
              type="button"
              aria-label="放大图片"
              title="放大"
              disabled={imagePreviewScale >= IMAGE_PREVIEW_MAX_SCALE}
              onClick={() => changeImagePreviewScale(IMAGE_PREVIEW_SCALE_STEP)}
            ><ZoomIn aria-hidden="true" /></button>
            <button
              type="button"
              aria-label="恢复适配大小"
              title="恢复适配大小"
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
