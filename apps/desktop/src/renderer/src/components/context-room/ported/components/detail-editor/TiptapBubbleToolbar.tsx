import { useEditorState, type Editor } from '@tiptap/react'
import { BubbleMenu } from '@tiptap/react/menus'
import { TextSelection } from '@tiptap/pm/state'
import { ArrowUp, Bold, Code2, Italic, Link2, Sparkles, Strikethrough, Underline, Unlink2, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { EditorIconButton } from './EditorIconButton'
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

export function TiptapBubbleToolbar({
  editor,
  onAskAi,
}: {
  editor: Editor
  onAskAi: (instruction: string) => void
}) {
  const [linkOpen, setLinkOpen] = useState(false)
  const [linkValue, setLinkValue] = useState('')
  const [askAiOpen, setAskAiOpen] = useState(false)
  const [askAiInstruction, setAskAiInstruction] = useState('')
  const askAiFormRef = useRef<HTMLFormElement>(null)
  const toolbarState = useEditorState({
    editor,
    selector: ({ editor: currentEditor }) => {
      const selection = currentEditor.state.selection

      return {
        askAiDisabled: !(selection instanceof TextSelection) ||
          selection.empty ||
          !selection.$from.sameParent(selection.$to),
        boldActive: currentEditor.isActive('bold'),
        codeActive: currentEditor.isActive('code'),
        italicActive: currentEditor.isActive('italic'),
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

  const submitAskAi = () => {
    onAskAi(askAiInstruction)
    setAskAiInstruction('')
    setAskAiOpen(false)
  }

  useEffect(() => () => {
    clearSelectionRewritePromptDecoration(editor)
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

  return (
    <BubbleMenu
      editor={editor}
      className="context-room-tiptap-bubble"
    >
      {askAiOpen ? (
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
            title={toolbarState.askAiDisabled ? '请选择单个段落中的文字' : 'Ask AI'}
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
  )
}
