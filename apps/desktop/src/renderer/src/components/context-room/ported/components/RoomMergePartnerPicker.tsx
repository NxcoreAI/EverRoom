import { Search } from 'lucide-react'
import { useMemo, useState, type KeyboardEvent } from 'react'

import { useLocale } from '@/i18n/LocaleContext'

export interface MergePartnerOption {
  id: string
  title: string
  kind?: string
}

/**
 * 手动合并的伙伴选择器：搜索过滤 + 列表单选。Room 数量多时原生 select
 * 无法定位，这里用输入框按标题实时过滤（不区分大小写），回车快捷选中
 * 过滤结果的第一项。
 */
export function RoomMergePartnerPicker({
  rooms,
  excludeRoomId,
  value,
  onChange,
}: {
  rooms: MergePartnerOption[]
  excludeRoomId?: string
  value: string
  onChange: (roomId: string) => void
}) {
  const { t } = useLocale()
  const [query, setQuery] = useState('')
  const keyword = query.trim().toLowerCase()
  const candidates = useMemo(
    () => rooms.filter((room) => room.id !== excludeRoomId),
    [rooms, excludeRoomId],
  )
  const matches = useMemo(
    () => keyword ? candidates.filter((room) => room.title.toLowerCase().includes(keyword)) : candidates,
    [candidates, keyword],
  )

  const searchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter') return
    if (value && matches.some((room) => room.id === value)) return
    const first = matches[0]
    if (first) onChange(first.id)
  }

  return (
    <div className="context-room-merge-picker">
      <label>
        <span>{t('contextRoom:home.manualMergePartner')}</span>
        <div className="context-room-merge-picker-search">
          <Search aria-hidden="true" />
          <input
            type="text"
            value={query}
            placeholder={t('contextRoom:home.manualMergeSearch')}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={searchKeyDown}
          />
        </div>
      </label>
      <div className="context-room-merge-picker-list" role="listbox" aria-label={t('contextRoom:home.manualMergePartner')}>
        {matches.map((room) => (
          <button
            key={room.id}
            type="button"
            role="option"
            aria-selected={value === room.id}
            data-selected={value === room.id}
            onClick={() => onChange(room.id)}
          >
            <b>{room.title}</b>
            {room.kind ? <small>{room.kind}</small> : null}
          </button>
        ))}
        {matches.length === 0 ? (
          <p className="context-room-merge-picker-empty">{t('contextRoom:home.manualMergeNoMatch')}</p>
        ) : null}
      </div>
    </div>
  )
}
