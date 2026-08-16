import { Pencil, RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'

import { MemoryEmptyView } from './MemoryStatusViews'
import { formatDate, useAsyncData } from './useMemoryData'

export function CoreProfilePane() {
  const { data, failure, loading, refresh } = useAsyncData(() => window.nxcore!.memory.readCore())
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (data && !editing) setDraft(data.content ?? '')
  }, [data, editing])

  const save = async () => {
    const content = draft.trim()
    if (!content) return
    setBusy(true)
    setError(null)
    try {
      await window.nxcore!.memory.writeCore(content)
      setEditing(false)
      refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存失败。')
    } finally {
      setBusy(false)
    }
  }

  if (failure) return <div className="mem-pane-error">{failure.message}</div>
  if (loading) return <p className="mem-loading">加载中…</p>

  return (
    <div className="mem-core">
      <div className="mem-toolbar">
        <span className="mem-count">
          画像版本 v{data?.version ?? 0}{data?.updatedAt ? ` · 更新于 ${formatDate(data.updatedAt)}` : ''}
        </span>
        {editing ? (
          <span className="mem-toolbar-actions">
            <button type="button" className="mem-primary" disabled={busy || !draft.trim()} onClick={save}>保存</button>
            <button type="button" disabled={busy} onClick={() => setEditing(false)}>取消</button>
          </span>
        ) : data?.content ? (
          <span className="mem-toolbar-actions">
            <button type="button" onClick={() => setEditing(true)}><Pencil aria-hidden="true" strokeWidth={1.7} />编辑</button>
          </span>
        ) : null}
      </div>
      {editing ? (
        <>
          <textarea
            className="mem-core-editor"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            rows={18}
            maxLength={65536}
          />
          <p className="mem-core-hint">保存为全量覆盖：请基于当前内容修改，避免直接粘贴片段覆盖整篇画像。</p>
        </>
      ) : data?.content ? (
        <pre className="mem-markdown">{data.content}</pre>
      ) : (
        <MemoryEmptyView
          title="画像尚未生成"
          hint="L3 画像是 MemoryCore 跨场景沉淀的长期用户画像，会随着对话积累自动生成并注入 AI 上下文。"
        />
      )}
      {error ? <p className="mem-inline-error">{error}</p> : null}
      {busy ? <p className="mem-loading"><RefreshCw aria-hidden="true" strokeWidth={1.8} className="mem-spin" />保存中…</p> : null}
    </div>
  )
}
