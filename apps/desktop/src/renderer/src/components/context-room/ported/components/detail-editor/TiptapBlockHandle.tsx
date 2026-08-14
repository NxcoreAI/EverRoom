import DragHandle from '@tiptap/extension-drag-handle-react'
import type { Node } from '@tiptap/pm/model'
import type { Editor } from '@tiptap/react'
import {
  Copy,
  GripVertical,
  Heading1,
  Heading2,
  List,
  Pilcrow,
  Plus,
  Quote,
  Trash2,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

export function TiptapBlockHandle({ editor }: { editor: Editor }) {
  const [activeNode, setActiveNode] = useState<Node | null>(null)
  const [activePos, setActivePos] = useState(-1)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menuOpen) return
    const closeMenu = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as globalThis.Node)) setMenuOpen(false)
    }
    document.addEventListener('pointerdown', closeMenu)
    return () => document.removeEventListener('pointerdown', closeMenu)
  }, [menuOpen])

  const insertBlock = () => {
    if (!activeNode || activePos < 0) return
    editor.chain().focus().insertContentAt(activePos + activeNode.nodeSize, {
      type: 'paragraph',
      content: [{ type: 'text', text: '/' }],
    }, { updateSelection: true }).run()
  }

  const transformBlock = (kind: 'paragraph' | 'heading-1' | 'heading-2' | 'bulletList' | 'blockquote') => {
    const chain = editor.chain().focus().setTextSelection(activePos + 1)
    if (kind === 'paragraph') chain.setParagraph().run()
    if (kind === 'heading-1') chain.setHeading({ level: 1 }).run()
    if (kind === 'heading-2') chain.setHeading({ level: 2 }).run()
    if (kind === 'bulletList') chain.toggleBulletList().run()
    if (kind === 'blockquote') chain.toggleBlockquote().run()
    setMenuOpen(false)
  }

  const duplicateBlock = () => {
    if (!activeNode || activePos < 0) return
    editor.chain().focus().insertContentAt(activePos + activeNode.nodeSize, activeNode.toJSON()).run()
    setMenuOpen(false)
  }

  const deleteBlock = () => {
    if (!activeNode || activePos < 0) return
    editor.chain().focus().deleteRange({ from: activePos, to: activePos + activeNode.nodeSize }).run()
    setMenuOpen(false)
  }

  return (
    <DragHandle
      editor={editor}
      className="context-room-tiptap-drag-handle"
      computePositionConfig={{ placement: 'left-start' }}
      onNodeChange={({ node, pos }) => {
        setActiveNode(node)
        setActivePos(pos)
      }}
    >
      <div className="context-room-tiptap-block-controls">
        <button
          type="button"
          className="context-room-tiptap-add-block"
          aria-label="在下方插入内容块"
          title="在下方插入内容块"
          draggable={false}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={insertBlock}
        >
          <Plus strokeWidth={1.8} />
        </button>
        <button
          type="button"
          className="context-room-tiptap-grip"
          aria-label="块选项和拖动排序"
          aria-expanded={menuOpen}
          title="点击打开选项，按住拖动"
          onClick={() => setMenuOpen((open) => !open)}
        >
          <GripVertical strokeWidth={1.8} />
        </button>
        {menuOpen ? (
          <div ref={menuRef} className="context-room-tiptap-block-menu" role="menu" aria-label="内容块选项">
            <span>转换为</span>
            <button type="button" role="menuitem" onClick={() => transformBlock('paragraph')}><Pilcrow />正文</button>
            <button type="button" role="menuitem" onClick={() => transformBlock('heading-1')}><Heading1 />一级标题</button>
            <button type="button" role="menuitem" onClick={() => transformBlock('heading-2')}><Heading2 />二级标题</button>
            <button type="button" role="menuitem" onClick={() => transformBlock('bulletList')}><List />项目列表</button>
            <button type="button" role="menuitem" onClick={() => transformBlock('blockquote')}><Quote />引用</button>
            <i />
            <button type="button" role="menuitem" onClick={duplicateBlock}><Copy />复制块</button>
            <button type="button" role="menuitem" data-danger="true" onClick={deleteBlock}><Trash2 />删除块</button>
          </div>
        ) : null}
      </div>
    </DragHandle>
  )
}
