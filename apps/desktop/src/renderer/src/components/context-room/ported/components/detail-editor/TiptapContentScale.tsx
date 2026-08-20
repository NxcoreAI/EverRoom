import type { TableOfContentData } from '@tiptap/extension-table-of-contents'
import { useLocale } from '../../../../../i18n/LocaleContext'

export function TiptapContentScale({ items }: { items: TableOfContentData }) {
  const { t } = useLocale()
  if (items.length === 0) return null

  return (
    <nav className="context-room-tiptap-content-scale" aria-label={t('contextRoom:tiptapContentScale.documentOutlineScale')}>
      <div className="context-room-tiptap-scale-markers">
        <span className="context-room-tiptap-scale-track" />
        {items.map((item) => (
          <button
            type="button"
            key={item.id}
            aria-label={t('contextRoom:tiptapContentScale.goToTitle', { title: item.textContent })}
            data-level={item.level}
            data-active={String(item.isActive)}
            data-scrolled={String(item.isScrolledOver)}
            onClick={() => item.editor.chain().focus().setTextSelection(item.pos + 1).scrollIntoView().run()}
          >
            <span className="context-room-tiptap-scale-preview" role="tooltip">
              {item.textContent}
            </span>
          </button>
        ))}
      </div>
    </nav>
  )
}
