import { LoaderCircle, Plus } from 'lucide-react'
import { useEffect, useState } from 'react'

import { showToast } from '@/state/toast'
import { useLocale } from '../../../../i18n/LocaleContext'
import { useContextRoomState } from '../../ContextRoomStateProvider'

/**
 * 新建 Room 极简弹窗：只有名称输入框。提交即调网关直建（fallback 内容先行，
 * room-enrich 子 Agent 异步整理），成功后刷新列表并打开新 Room。
 * 无描述也允许创建——网关侧缺省用标题兜底（#241 后续简化）。
 */
export function RoomCreationStudio({
  open,
  onOpenChange,
  onRoomCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 创建成功回调：宿主负责刷新本地态/打开新 Room。 */
  onRoomCreated: (room: { id: string; title: string }) => void
}) {
  const { t } = useLocale()
  const { refreshFromBackend } = useContextRoomState()
  const [name, setName] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 每次打开重置表单：极简弹窗不留脏状态，输入即所见。
  useEffect(() => {
    if (open) {
      setName('')
      setError(null)
    }
  }, [open])

  const submit = async () => {
    const title = name.trim()
    if (!title || submitting) return
    setSubmitting(true)
    setError(null)
    try {
      const api = window.nxcore?.contextRooms
      if (!api?.create) throw new Error(t('contextRoom:roomDialogs.serviceUnavailable'))
      const result = await api.create({ title: title.slice(0, 40) })
      await refreshFromBackend().catch(() => undefined)
      showToast({
        title: t('contextRoom:creation.created', { title: result.room.title || title }),
        message: t('contextRoom:creation.createdHint'),
      })
      onOpenChange(false)
      onRoomCreated({ id: result.room.id, title: result.room.title || title })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('contextRoom:roomDialogs.createFailed'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form
      className="context-room-creation-quick"
      data-testid="context-room-creation-quick"
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <header>
        <h2>{t('contextRoom:home.newContextRoom')}</h2>
      </header>
      <label>
        <span>{t('contextRoom:roomDialogs.name')}</span>
        <input
          name="name"
          value={name}
          maxLength={40}
          autoFocus
          autoComplete="off"
          placeholder={t('contextRoom:creation.namePlaceholder')}
          disabled={submitting}
          onChange={(event) => {
            setName(event.target.value)
            setError(null)
          }}
        />
      </label>
      {error ? <p className="context-room-form-error" role="alert">{error}</p> : null}
      <footer>
        <button
          type="button"
          className="context-room-ghost"
          disabled={submitting}
          onClick={() => onOpenChange(false)}
        >
          {t('contextRoom:roomDialogs.cancel')}
        </button>
        <button
          type="submit"
          className="context-room-primary context-room-creation-quick-submit"
          data-testid="context-room-creation-start"
          disabled={submitting || !name.trim()}
        >
          {submitting ? <LoaderCircle className="spin" aria-hidden="true" /> : <Plus aria-hidden="true" />}
          {submitting ? t('contextRoom:roomDialogs.creatingQuick') : t('contextRoom:home.newRoom')}
        </button>
      </footer>
    </form>
  )
}
