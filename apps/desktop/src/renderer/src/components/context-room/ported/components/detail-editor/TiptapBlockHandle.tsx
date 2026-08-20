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
  Link2,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useLocale } from '../../../../../i18n/LocaleContext'
import { useTiptapBlockHandleVisibility } from './useTiptapBlockHandleVisibility'

const BLOCK_HANDLE_POSITION = { placement: 'left-start' } as const

export function TiptapBlockHandle({
  editor,
  onDraggingChange,
  onCopyBlockReference,
}: {
  editor: Editor
  onDraggingChange: (dragging: boolean) => void
  onCopyBlockReference?: (blockId: string, textPreview: string) => void | Promise<void>
}) {
  const { t } = useLocale()
  const [activeNode, setActiveNode] = useState<Node | null>(null)
  const [activePos, setActivePos] = useState(-1)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const controlsRef = useRef<HTMLDivElement>(null)

  useTiptapBlockHandleVisibility(editor, controlsRef)

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

  const copyBlockReference = () => {
    const blockId = typeof activeNode?.attrs.id === 'string' ? activeNode.attrs.id.trim() : ''
    if (!activeNode || !blockId) return
    void onCopyBlockReference?.(blockId, activeNode.textContent.slice(0, 240))
    setMenuOpen(false)
  }

  return (
    <DragHandle
      editor={editor}
      className="context-room-tiptap-drag-handle"
      computePositionConfig={BLOCK_HANDLE_POSITION}
      onElementDragStart={() => {
        setMenuOpen(false)
        onDraggingChange(true)
      }}
      onElementDragEnd={() => onDraggingChange(false)}
      onNodeChange={({ node, pos }) => {
        setActiveNode(node)
        setActivePos(pos)
      }}
    >
      <div ref={controlsRef} className="context-room-tiptap-block-controls">
        <button
          type="button"
          className="context-room-tiptap-add-block"
          aria-label={t('contextRoom:tiptapBlockHandle.insertBlockBelow')}
          title={t('contextRoom:tiptapBlockHandle.insertBlockBelow')}
          draggable={false}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={insertBlock}
        >
          <Plus strokeWidth={1.8} />
        </button>
        <button
          type="button"
          className="context-room-tiptap-grip"
          aria-label={t('contextRoom:tiptapBlockHandle.blockOptionsAndDragToReorder')}
          aria-expanded={menuOpen}
          title={t('contextRoom:tiptapBlockHandle.clickForOptionsOrDragToReorder')}
          onClick={() => setMenuOpen((open) => !open)}
        >
          <GripVertical strokeWidth={1.8} />
        </button>
        {menuOpen ? (
          <div ref={menuRef} className="context-room-tiptap-block-menu" role="menu" aria-label={t('contextRoom:tiptapBlockHandle.blockOptions')}>
            <span>{t('contextRoom:tiptapBlockHandle.turnInto')}</span>
            <button type="button" role="menuitem" onClick={() => transformBlock('paragraph')}><Pilcrow />{t('contextRoom:tiptapBlockHandle.text')}</button>
            <button type="button" role="menuitem" onClick={() => transformBlock('heading-1')}><Heading1 />{t('contextRoom:tiptapBlockHandle.heading1')}</button>
            <button type="button" role="menuitem" onClick={() => transformBlock('heading-2')}><Heading2 />{t('contextRoom:tiptapBlockHandle.heading2')}</button>
            <button type="button" role="menuitem" onClick={() => transformBlock('bulletList')}><List />{t('contextRoom:tiptapBlockHandle.bulletList')}</button>
            <button type="button" role="menuitem" onClick={() => transformBlock('blockquote')}><Quote />{t('contextRoom:tiptapBlockHandle.quote')}</button>
            <i />
            {onCopyBlockReference ? (
              <button type="button" role="menuitem" onClick={copyBlockReference}><Link2 />{t('contextRoom:tiptapBlockHandle.copyBlockReference')}</button>
            ) : null}
            <button type="button" role="menuitem" onClick={duplicateBlock}><Copy />{t('contextRoom:tiptapBlockHandle.duplicateBlock')}</button>
            <button type="button" role="menuitem" data-danger="true" onClick={deleteBlock}><Trash2 />{t('contextRoom:tiptapBlockHandle.deleteBlock')}</button>
          </div>
        ) : null}
      </div>
    </DragHandle>
  )
}
