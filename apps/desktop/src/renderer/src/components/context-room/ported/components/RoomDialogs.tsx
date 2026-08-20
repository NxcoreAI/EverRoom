import { RotateCcw, X } from 'lucide-react'
import { useLocale } from '../../../../i18n/LocaleContext'

import type { ContextRoomKind, ContextRoomRecord } from '../types'
import { ActionConfirmDialog, ReferenceDialog } from './shared'

export interface DraftRoom {
  kind: ContextRoomKind
  name: string
  summary: string
}

export function RoomForm({
  title,
  initial,
  submitLabel,
  renameOnly = false,
  onCancel,
  onSubmit,
}: {
  title: string
  initial?: DraftRoom
  submitLabel: string
  renameOnly?: boolean
  onCancel?: () => void
  onSubmit: (draft: DraftRoom) => void
}) {
  const { t } = useLocale()
  return (
    <form
      className="context-room-room-form"
      onSubmit={(event) => {
        event.preventDefault()
        const values = new FormData(event.currentTarget)
        const name = values.get('name')
        const kind = values.get('kind')
        const summary = values.get('summary')
        onSubmit({
          name: typeof name === 'string' ? name.trim() : '',
          kind: (typeof kind === 'string' ? kind : '项目') as ContextRoomKind,
          summary: typeof summary === 'string' ? summary.trim() : '',
        })
      }}
    >
      <h2>{t(title)}</h2>
      <label>
        <span>{t('名称')}</span>
        <input name="name" defaultValue={initial?.name} required maxLength={40} autoFocus />
      </label>
      {renameOnly ? (
        <input type="hidden" name="kind" value={initial?.kind ?? '项目'} />
      ) : (
        <label>
          <span>{t('类型')}</span>
          <select name="kind" defaultValue={initial?.kind ?? '项目'}>
            {(['项目', '主题', '人物', '长期目标', '议题', '事件'] as ContextRoomKind[]).map((kind) => (
              <option key={kind}>{t(kind)}</option>
            ))}
          </select>
        </label>
      )}
      {renameOnly ? (
        <input type="hidden" name="summary" value={initial?.summary ?? ''} />
      ) : (
        <label>
          <span>{t('初始说明')}</span>
          <textarea
            name="summary"
            rows={4}
            defaultValue={initial?.summary}
            placeholder={t('描述目标、范围或需要聚合的资料')}
          />
        </label>
      )}
      <footer>
        {onCancel ? <button type="button" className="context-room-ghost" onClick={onCancel}>{t('取消')}</button> : null}
        <button type="submit" className="context-room-primary">{t(submitLabel)}</button>
      </footer>
    </form>
  )
}

export function RoomLifecycleDialogs({
  renameRoom,
  deleteRoom,
  recentlyDeleted,
  onRenameRoomChange,
  onDeleteRoomChange,
  onRecentlyDeletedChange,
  onRenameRoom,
  onDeleteRoom,
  onRestoreRoom,
}: {
  renameRoom: ContextRoomRecord | null
  deleteRoom: ContextRoomRecord | null
  recentlyDeleted: ContextRoomRecord | null
  onRenameRoomChange: (room: ContextRoomRecord | null) => void
  onDeleteRoomChange: (room: ContextRoomRecord | null) => void
  onRecentlyDeletedChange: (room: ContextRoomRecord | null) => void
  onRenameRoom: (roomId: string, name: string) => void
  onDeleteRoom: (roomId: string) => void
  onRestoreRoom: (roomId: string) => void
}) {
  const { t } = useLocale()
  return (
    <>
      <ReferenceDialog
        open={Boolean(renameRoom)}
        onOpenChange={(open) => !open && onRenameRoomChange(null)}
        title={t('重命名 Room')}
      >
        {renameRoom ? (
          <RoomForm
            title={t('为「{title}」设置新名称', { title: renameRoom.title })}
            submitLabel={t('保存')}
            renameOnly
            onCancel={() => onRenameRoomChange(null)}
            initial={{ name: renameRoom.title, kind: renameRoom.kind, summary: renameRoom.brief.background }}
            onSubmit={(draft) => {
              onRenameRoom(renameRoom.id, draft.name)
              onRenameRoomChange(null)
            }}
          />
        ) : null}
      </ReferenceDialog>
      <ActionConfirmDialog
        open={Boolean(deleteRoom)}
        onOpenChange={(open) => !open && onDeleteRoomChange(null)}
        title={t('删除 Context Room')}
        summary={deleteRoom ? t('“{title}”将移至已删除 Room。', { title: deleteRoom.title }) : ''}
        rows={deleteRoom ? [
          { label: t('Room 类型'), value: t(deleteRoom.kind) },
          { label: t('资料范围'), value: t('文档 {docs} · 邮件 {mails} · 会议 {meetings}', {
            docs: deleteRoom.stats.docs,
            mails: deleteRoom.stats.mails,
            meetings: deleteRoom.stats.meetings,
          }) },
        ] : []}
        risk={t('资料本体不会被删除，但 Agent 不再以此 Room 作为上下文边界，可在已删除 Room 中恢复。')}
        confirmLabel={t('删除')}
        danger
        onConfirm={() => {
          if (!deleteRoom) return
          onDeleteRoom(deleteRoom.id)
          onRecentlyDeletedChange(deleteRoom)
          onDeleteRoomChange(null)
        }}
      />
      {recentlyDeleted ? (
        <div className="context-room-undo" role="status">
          <span>{t('已删除“{title}”', { title: recentlyDeleted.title })}</span>
          <button type="button" onClick={() => { onRestoreRoom(recentlyDeleted.id); onRecentlyDeletedChange(null) }}>
            <RotateCcw aria-hidden="true" />{t('撤销')}
          </button>
          <button type="button" aria-label={t('关闭撤销提示')} onClick={() => onRecentlyDeletedChange(null)}>
            <X aria-hidden="true" />
          </button>
        </div>
      ) : null}
    </>
  )
}
