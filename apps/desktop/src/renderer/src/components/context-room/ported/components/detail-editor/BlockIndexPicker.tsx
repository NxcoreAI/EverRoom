import { Brain, Link2, Search, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useLocale } from '../../../../../i18n/LocaleContext'

import type { ContextRoomMemoryItem } from '../../types'
import type { BlockIndexTarget } from './blockIndexLink'
import './DocumentBlockReference.css'
import './BlockIndexMark.css'

/**
 * 记忆项索引选择器。文档块索引的手动路径是"复制块引用 → 粘贴"
 * (见 BlockIndexMark 的 handleBlockIndexPaste),不经此选择器;
 * 记忆项没有可复制的链接来源,只能在这里选。
 */
export interface BlockIndexPickerProps {
  roomId: string
  memoryItems: ContextRoomMemoryItem[]
  onSelect: (target: BlockIndexTarget) => void
  onClose: () => void
}

export function BlockIndexPicker({
  roomId,
  memoryItems,
  onSelect,
  onClose,
}: BlockIndexPickerProps) {
  const { t } = useLocale()
  const [query, setQuery] = useState('')
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const filteredMemories = useMemo(() => {
    if (!normalizedQuery) return memoryItems
    return memoryItems.filter((memory) => `${memory.type} ${memory.content}`.toLocaleLowerCase().includes(normalizedQuery))
  }, [memoryItems, normalizedQuery])

  const select = (memory: ContextRoomMemoryItem) => onSelect({
    kind: 'memory',
    roomId,
    memoryId: memory.id,
    fallbackTitle: memory.type,
    fallbackPreview: memory.content.slice(0, 160),
  })

  return (
    <div className="context-room-reference-picker-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="context-room-reference-picker"
        role="dialog"
        aria-modal="true"
        aria-label={t('contextRoom:blockIndexPicker.addMemoryIndex')}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <span><Link2 aria-hidden="true" />{t('contextRoom:blockIndexPicker.addMemoryIndex')}</span>
          <button type="button" aria-label={t('contextRoom:blockIndexPicker.close')} title={t('contextRoom:blockIndexPicker.close')} onClick={onClose}><X /></button>
        </header>
        <div className="context-room-reference-picker-body context-room-block-index-memory-body">
          <main>
            <label>
              <Search aria-hidden="true" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t('contextRoom:blockIndexPicker.searchMemories')}
                aria-label={t('contextRoom:blockIndexPicker.searchMemories')}
              />
            </label>
            <div className="context-room-reference-picker-blocks">
              {filteredMemories.map((memory) => (
                <button type="button" key={memory.id} onClick={() => select(memory)}>
                  <Brain aria-hidden="true" />
                  <span>{memory.content || t('contextRoom:blockIndexPicker.emptyMemory')}</span>
                  <small>{memory.type}</small>
                </button>
              ))}
              {filteredMemories.length === 0 ? (
                <p>{t(query ? 'contextRoom:blockIndexPicker.noMatchingMemories' : 'contextRoom:blockIndexPicker.noMemories')}</p>
              ) : null}
            </div>
          </main>
        </div>
      </section>
    </div>
  )
}
