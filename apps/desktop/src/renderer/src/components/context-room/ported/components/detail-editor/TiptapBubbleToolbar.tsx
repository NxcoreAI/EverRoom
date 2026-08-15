import type { Editor } from '@tiptap/react'
import { BubbleMenu } from '@tiptap/react/menus'
import { TextSelection } from '@tiptap/pm/state'
import { ArrowUp, Bold, Code2, Italic, Link2, Sparkles, Strikethrough, Underline, Unlink2, X } from 'lucide-react'
import { useState } from 'react'

import { EditorIconButton } from './EditorIconButton'

function normalizeLink(value: string): string | null {
  const link = value.trim()
  if (!link || /^(javascript|data):/i.test(link)) return null
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(link)) return `mailto:${link}`
  return /^[a-z][a-z\d+.-]*:/i.test(link) ? link : `https://${link}`
}

export function TiptapBubbleToolbar({
  editor,
  dragging,
  selecting,
  onAskAi,
}: {
  editor: Editor
  dragging: boolean
  selecting: boolean
  onAskAi: (instruction: string) => void
}) {
  const [linkOpen, setLinkOpen] = useState(false)
  const [linkValue, setLinkValue] = useState('')
  const [askAiOpen, setAskAiOpen] = useState(false)
  const [askAiInstruction, setAskAiInstruction] = useState('')

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

  const submitAskAi = () => {
    onAskAi(askAiInstruction)
    setAskAiInstruction('')
    setAskAiOpen(false)
  }

  const selection = editor.state.selection
  const askAiDisabled = !(selection instanceof TextSelection) ||
    selection.empty ||
    !selection.$from.sameParent(selection.$to)

  return (
    <BubbleMenu
      editor={editor}
      className="context-room-tiptap-bubble"
      updateDelay={0}
      options={{ placement: 'top', offset: 8 }}
      shouldShow={({ editor: currentEditor, state }) => (
        !dragging &&
        !selecting &&
        state.selection instanceof TextSelection &&
        !state.selection.empty &&
        currentEditor.isEditable &&
        !currentEditor.isActive('codeBlock')
      )}
    >
      {askAiOpen ? (
        <form className="context-room-tiptap-bubble-ai" onSubmit={(event) => { event.preventDefault(); submitAskAi() }}>
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
                setAskAiOpen(false)
              }
            }}
          />
          <button type="submit" aria-label="开始重写" title="开始重写"><ArrowUp /></button>
          <button type="button" aria-label="关闭" title="关闭" onClick={() => setAskAiOpen(false)}><X /></button>
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
          <EditorIconButton label="粗体" active={editor.isActive('bold')} onClick={() => editor.chain().focus().toggleBold().run()}><Bold /></EditorIconButton>
          <EditorIconButton label="斜体" active={editor.isActive('italic')} onClick={() => editor.chain().focus().toggleItalic().run()}><Italic /></EditorIconButton>
          <EditorIconButton label="下划线" active={editor.isActive('underline')} onClick={() => editor.chain().focus().toggleUnderline().run()}><Underline /></EditorIconButton>
          <EditorIconButton label="删除线" active={editor.isActive('strike')} onClick={() => editor.chain().focus().toggleStrike().run()}><Strikethrough /></EditorIconButton>
          <EditorIconButton label="行内代码" active={editor.isActive('code')} onClick={() => editor.chain().focus().toggleCode().run()}><Code2 /></EditorIconButton>
          <span className="context-room-tiptap-bubble-divider" />
          <EditorIconButton label="添加链接" active={editor.isActive('link')} onClick={openLink}><Link2 /></EditorIconButton>
          {editor.isActive('link') ? (
            <EditorIconButton label="移除链接" onClick={() => editor.chain().focus().unsetLink().run()}><Unlink2 /></EditorIconButton>
          ) : null}
          <span className="context-room-tiptap-bubble-divider" />
          <button
            type="button"
            className="context-room-tiptap-ask-ai"
            aria-label="Ask AI"
            title={askAiDisabled ? '请选择单个段落中的文字' : 'Ask AI'}
            disabled={askAiDisabled}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
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
