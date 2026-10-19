import { useCallback, useEffect, useMemo, useState } from 'react'

import { useLocale } from '@/i18n/LocaleContext'
import type { ScreenMemoryIntervalDto, ScreenMemoryStatusDto } from '../../../../shared/sources'

function assetUrlOf(imagePath: string): string {
  const marker = 'images/'
  const index = imagePath.lastIndexOf(marker)
  const relative = index === -1 ? imagePath : imagePath.slice(index + marker.length)
  return `screen-memory-asset://local/${relative.split('/').map(encodeURIComponent).join('/')}`
}

function formatRange(locale: string, startedAt: string, endedAt: string): string {
  const start = new Date(startedAt)
  const end = new Date(endedAt)
  const sameDay = start.toDateString() === end.toDateString()
  const time = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' })
  const day = new Intl.DateTimeFormat(locale, { month: 'numeric', day: 'numeric' })
  return sameDay
    ? `${day.format(start)} ${time.format(start)}–${time.format(end)}`
    : `${day.format(start)} ${time.format(start)} – ${day.format(end)} ${time.format(end)}`
}

export function ScreenMemoryPanel({ refreshTick = 0 }: { refreshTick?: number }) {
  const { t, locale } = useLocale()
  const [items, setItems] = useState<ScreenMemoryIntervalDto[]>([])
  const [status, setStatus] = useState<ScreenMemoryStatusDto | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<ScreenMemoryIntervalDto | null>(null)
  const [editing, setEditing] = useState(false)
  const [editTitle, setEditTitle] = useState('')
  const [editLines, setEditLines] = useState('')
  const [busy, setBusy] = useState(false)
  const [materialRef, setMaterialRef] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const loadRecent = useCallback(async () => {
    if (!window.nxcore) return
    const [statusResult, listResult] = await Promise.all([
      window.nxcore.screenMemory.status().catch(() => null),
      window.nxcore.screenMemory.listIntervals({ limit: 30 }).catch(() => null),
    ])
    if (statusResult) setStatus(statusResult)
    if (listResult) setItems(listResult.items)
  }, [])

  useEffect(() => {
    void loadRecent()
  }, [loadRecent, refreshTick])

  const openDetail = useCallback(async (id: string) => {
    if (!window.nxcore) return
    if (expandedId === id) {
      setExpandedId(null)
      setDetail(null)
      setEditing(false)
      return
    }
    setExpandedId(id)
    setEditing(false)
    const result = await window.nxcore.screenMemory.getInterval(id).catch(() => null)
    setDetail(result)
  }, [expandedId])

  const startEditing = useCallback(() => {
    if (!detail) return
    setEditTitle(detail.title)
    setEditLines(detail.textLines.join('\n'))
    setEditing(true)
  }, [detail])

  const saveCorrection = useCallback(async () => {
    if (!window.nxcore || !detail) return
    setBusy(true)
    try {
      const updated = await window.nxcore.screenMemory.correctInterval({
        id: detail.id,
        title: editTitle.trim() || detail.title,
        textLines: editLines.split('\n').map((line) => line.trim()).filter((line) => line.length > 0),
      })
      setDetail(updated)
      setEditing(false)
      setItems((previous) => previous.map((item) => (item.id === updated.id ? updated : item)))
    } finally {
      setBusy(false)
    }
  }, [detail, editTitle, editLines])

  const addToRoom = useCallback(async () => {
    if (!window.nxcore || !detail) return
    setBusy(true)
    setMaterialRef(null)
    try {
      const result = await window.nxcore.screenMemory.registerMaterial(detail.id)
      setMaterialRef(result.ref)
    } finally {
      setBusy(false)
    }
  }, [detail])

  const handToAgent = useCallback(async () => {
    if (!detail) return
    const citation = [
      `屏幕记忆引用（${detail.appName}，${detail.startedAt} 至 ${detail.endedAt}）：`,
      `标题：${detail.title}`,
      detail.summary ? `摘要：${detail.summary}` : '',
      `原文片段：${detail.textLines.slice(0, 10).join('\n')}`,
    ].filter(Boolean).join('\n')
    await navigator.clipboard.writeText(citation).catch(() => undefined)
    setCopied(true)
    setTimeout(() => setCopied(false), 2_000)
  }, [detail])

  const summaryLabel = useMemo(() => {
    return (interval: ScreenMemoryIntervalDto): string => {
      if (interval.summary) return interval.summary
      if (interval.summaryStatus === 'ready') return t('diaryReality:screenMemory.summaryEmpty')
      return t('diaryReality:screenMemory.summaryWaiting')
    }
  }, [t])

  return (
    <section className="screen-memory-panel" aria-labelledby="screen-memory-title">
      <div className="screen-memory-toolbar">
        <strong id="screen-memory-title">{t('diaryReality:screenMemory.title')}</strong>
        {status && !status.enabled ? <span className="screen-memory-hint">{t('diaryReality:screenMemory.disabledHint')}</span> : null}
      </div>

      <ul className="screen-memory-cards">
        {items.map((interval) => (
          <li
            key={interval.id}
            className={expandedId === interval.id ? 'screen-memory-card expanded' : 'screen-memory-card'}
            onClick={() => void openDetail(interval.id)}
          >
            <div className="screen-memory-card-head">
              <span className="screen-memory-time">{formatRange(locale, interval.startedAt, interval.endedAt)}</span>
              <span className="screen-memory-app">{interval.appName}</span>
              <span className="screen-memory-frames">{t('diaryReality:screenMemory.keyframeCount', { count: interval.keyframeCount })}</span>
            </div>
            <div className="screen-memory-title">{interval.title}</div>
            {interval.textLines.length > 0 ? (
              <div className="screen-memory-excerpt">{interval.textLines.slice(0, 2).join(' · ')}</div>
            ) : null}
            <div className={interval.summary ? 'screen-memory-summary' : 'screen-memory-summary waiting'}>
              {summaryLabel(interval)}
            </div>

            {expandedId === interval.id ? (
              <div className="screen-memory-detail" onClick={(event) => event.stopPropagation()}>
                {editing ? (
                  <div className="screen-memory-edit">
                    <input value={editTitle} onChange={(event) => setEditTitle(event.target.value)} />
                    <textarea
                      rows={6}
                      value={editLines}
                      onChange={(event) => setEditLines(event.target.value)}
                    />
                    <div className="screen-memory-edit-actions">
                      <button type="button" disabled={busy} onClick={() => void saveCorrection()}>
                        {t('diaryReality:screenMemory.saveCorrection')}
                      </button>
                      <button type="button" onClick={() => setEditing(false)}>
                        {t('diaryReality:screenMemory.cancel')}
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    {detail?.keyframes?.length ? (
                      <div className="screen-memory-keyframes">
                        {detail.keyframes.map((frame) => (
                          <img
                            key={frame.id}
                            src={assetUrlOf(frame.imagePath)}
                            alt={new Date(frame.capturedAt).toLocaleString(locale)}
                            loading="lazy"
                          />
                        ))}
                      </div>
                    ) : null}
                    {detail && detail.summaryKeyPoints.length > 0 ? (
                      <ul className="screen-memory-points">
                        {detail.summaryKeyPoints.map((point) => <li key={point}>{point}</li>)}
                      </ul>
                    ) : null}
                    <div className="screen-memory-actions">
                      <button type="button" onClick={startEditing} disabled={!detail}>
                        {t('diaryReality:screenMemory.correct')}
                      </button>
                      <button type="button" onClick={() => void addToRoom()} disabled={busy || !detail}>
                        {t('diaryReality:screenMemory.addToRoom')}
                      </button>
                      <button type="button" onClick={() => void handToAgent()} disabled={!detail}>
                        {copied ? t('diaryReality:screenMemory.copied') : t('diaryReality:screenMemory.handToAgent')}
                      </button>
                    </div>
                    {materialRef ? <span className="screen-memory-material-ref">{materialRef}</span> : null}
                  </>
                )}
              </div>
            ) : null}
          </li>
        ))}
        {items.length === 0 ? <li className="screen-memory-empty">{t('diaryReality:screenMemory.empty')}</li> : null}
      </ul>
    </section>
  )
}
