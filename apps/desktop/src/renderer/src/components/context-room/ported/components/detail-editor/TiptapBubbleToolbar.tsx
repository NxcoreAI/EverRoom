import type { Editor } from '@tiptap/react'
import { BubbleMenu } from '@tiptap/react/menus'
import { Bold, Code2, Italic, Link2, Strikethrough, Underline, Unlink2 } from 'lucide-react'
import { useState } from 'react'

import { EditorIconButton } from './EditorIconButton'

function normalizeLink(value: string): string | null {
  const link = value.trim()
  if (!link || /^(javascript|data):/i.test(link)) return null
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(link)) return `mailto:${link}`
  return /^[a-z][a-z\d+.-]*:/i.test(link) ? link : `https://${link}`
}

export function TiptapBubbleToolbar({ editor }: { editor: Editor }) {
  const [linkOpen, setLinkOpen] = useState(false)
  const [linkValue, setLinkValue] = useState('')

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

  return (
    <BubbleMenu
      editor={editor}
      className="context-room-tiptap-bubble"
      options={{ placement: 'top', offset: 8 }}
      shouldShow={({ editor: currentEditor, from, to }) => (
        from !== to && currentEditor.isEditable && !currentEditor.isActive('codeBlock')
      )}
    >
      {linkOpen ? (
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
        </>
      )}
    </BubbleMenu>
  )
}
