import { Redo2, Search, Undo2 } from 'lucide-react'
import { useEffect, useState } from 'react'

import { useLocale } from '../../../../../i18n/LocaleContext'
import type { Editor } from '@tiptap/react'

/** 文档顶部状态行的快捷操作：撤销 / 重做 / 文档内查找。
 * undo/redo 可用态经 editor transaction 事件在本组件内局部刷新。 */
export function TiptapDocumentQuickActions({
  editor,
  disabled,
  onOpenFind,
}: {
  editor: Editor
  disabled?: boolean
  onOpenFind: () => void
}) {
  const { t } = useLocale()
  const [historyState, setHistoryState] = useState({ canUndo: false, canRedo: false })

  useEffect(() => {
    const update = () => {
      const next = { canUndo: editor.can().undo(), canRedo: editor.can().redo() }
      setHistoryState((current) => current.canUndo === next.canUndo && current.canRedo === next.canRedo
        ? current
        : next)
    }
    update()
    editor.on('transaction', update)
    return () => { editor.off('transaction', update) }
  }, [editor])

  const locked = disabled || !editor.isEditable

  return (
    <div className="context-room-doc-quick-actions" role="group" aria-label={t('contextRoom:tiptapDocumentEditor.quickActions')}>
      <button
        type="button"
        aria-label={t('contextRoom:tiptapDocumentEditor.undo')}
        title={t('contextRoom:tiptapDocumentEditor.undo')}
        disabled={locked || !historyState.canUndo}
        onMouseDown={(mouseEvent) => mouseEvent.preventDefault()}
        onClick={() => editor.chain().focus().undo().run()}
      >
        <Undo2 aria-hidden="true" />
      </button>
      <button
        type="button"
        aria-label={t('contextRoom:tiptapDocumentEditor.redo')}
        title={t('contextRoom:tiptapDocumentEditor.redo')}
        disabled={locked || !historyState.canRedo}
        onMouseDown={(mouseEvent) => mouseEvent.preventDefault()}
        onClick={() => editor.chain().focus().redo().run()}
      >
        <Redo2 aria-hidden="true" />
      </button>
      <button
        type="button"
        aria-label={t('contextRoom:tiptapDocumentEditor.searchInDocument')}
        title={t('contextRoom:tiptapDocumentEditor.searchInDocument')}
        onMouseDown={(mouseEvent) => mouseEvent.preventDefault()}
        onClick={onOpenFind}
      >
        <Search aria-hidden="true" />
      </button>
    </div>
  )
}
