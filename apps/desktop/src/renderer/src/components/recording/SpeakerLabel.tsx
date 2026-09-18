import { useEffect, useRef, useState } from 'react'
import { useLocale, type Translate } from '@/i18n/LocaleContext'
import './SpeakerLabel.css'

interface SpeakerLabelSegment {
  speakerId: number | string | null
  speakerName?: string | null
}

export function speakerLabel(segment: SpeakerLabelSegment, t: Translate, page: 'recording' | 'reality'): string {
  if (segment.speakerName) return segment.speakerName
  if (typeof segment.speakerId === 'number') return t(`diaryReality:${page}.speakerNumber`, { number: segment.speakerId + 1 })
  return t(`diaryReality:${page}.speaker`)
}

/** 说话人标签；传入 onRename 时可点击弹出改名浮层（云端任务专用）。返回 true 表示改名成功，浮层关闭。 */
export function SpeakerLabel({ segment, page, onRename }: {
  segment: SpeakerLabelSegment
  page: 'recording' | 'reality'
  onRename?: (speakerId: string, name: string | null) => Promise<boolean>
}) {
  const { t } = useLocale()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null)
  const rootRef = useRef<HTMLSpanElement>(null)
  const canRename = Boolean(onRename && segment.speakerId !== null)
  const label = speakerLabel(segment, t, page)

  useEffect(() => {
    if (!open) return undefined
    setName(segment.speakerName ?? '')
    const dismiss = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    window.addEventListener('pointerdown', dismiss)
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('pointerdown', dismiss); window.removeEventListener('keydown', onKey) }
  }, [open, segment.speakerName])

  if (!canRename) return <strong>{label}</strong>

  const toggle = (event: React.MouseEvent) => {
    event.stopPropagation()
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
    // fixed 定位跳出滚动容器的 overflow 裁剪。
    setAnchor({ top: Math.min(rect.bottom + 4, window.innerHeight - 150), left: Math.min(rect.left, window.innerWidth - 250) })
    setOpen((value) => !value)
  }

  const submit = async (value: string | null) => {
    if (!onRename || busy) return
    setBusy(true)
    try {
      if (await onRename(String(segment.speakerId), value)) setOpen(false)
    } finally { setBusy(false) }
  }

  return (
    <span className="speaker-label" ref={rootRef}>
      <strong role="button" tabIndex={0} data-renameable="true" title={t(`diaryReality:${page}.renameSpeaker`)} onClick={toggle} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); setOpen((value) => !value) } }}>{label}</strong>
      {open && anchor ? (
        <span className="speaker-rename-popover" style={anchor} role="dialog" aria-label={t(`diaryReality:${page}.renameSpeaker`)}>
          <input
            autoFocus
            value={name}
            maxLength={64}
            placeholder={label}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void submit(name.trim() || null) } }}
          />
          <span className="speaker-rename-actions">
            <button type="button" disabled={busy || !name.trim()} onClick={(event) => { event.stopPropagation(); void submit(name.trim()) }}>{t(`diaryReality:${page}.save`)}</button>
            <button type="button" disabled={busy} onClick={(event) => { event.stopPropagation(); void submit(null) }}>{t(`diaryReality:${page}.clearSpeakerName`)}</button>
          </span>
        </span>
      ) : null}
    </span>
  )
}
