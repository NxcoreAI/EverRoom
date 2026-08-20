import { RotateCcw, X } from 'lucide-react'
import { useState } from 'react'
import { useLocale } from '../../../../i18n/LocaleContext'

import type { ContextRoomRecord } from '../types'
import { localizedUiText, uiText } from '../adapters'
import { ActionConfirmDialog, ReferenceDialog } from './shared'

export interface DraftRoom {
  name: string
  description: string
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
  onSubmit: (draft: DraftRoom) => void | Promise<void>
}) {
  const { t } = useLocale()
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <form
      className="context-room-room-form"
      onSubmit={(event) => {
        event.preventDefault()
        const values = new FormData(event.currentTarget)
        const name = values.get('name')
        const description = values.get('description')
        setSubmitting(true)
        setError(null)
        void Promise.resolve(onSubmit({
          name: typeof name === 'string' ? name.trim() : '',
          description: typeof description === 'string' ? description.trim() : '',
        })).catch((cause: unknown) => {
          setError(cause instanceof Error ? cause.message : t('contextRoom:roomDialogs.createFailed'))
        }).finally(() => setSubmitting(false))
      }}
    >
      <h2>{t(title)}</h2>
      <label>
        <span>{t('contextRoom:roomDialogs.name')}</span>
        <input name="name" defaultValue={initial?.name} required maxLength={40} autoFocus />
      </label>
      {renameOnly ? (
        <input type="hidden" name="description" value={initial?.description ?? ''} />
      ) : (
        <label>
          <span>{t('contextRoom:roomDialogs.initialDescription')}</span>
          <textarea
            name="description"
            rows={4}
            defaultValue={initial?.description}
            placeholder={t('contextRoom:roomDialogs.describeTheGoalScopeOrResourcesToCollect')}
            required
            maxLength={2_000}
          />
        </label>
      )}
      {error ? <p className="context-room-form-error" role="alert">{error}</p> : null}
      <footer>
        {onCancel ? <button type="button" className="context-room-ghost" disabled={submitting} onClick={onCancel}>{t('contextRoom:roomDialogs.cancel')}</button> : null}
        <button type="submit" className="context-room-primary" disabled={submitting}>
          {submitting ? t('contextRoom:roomDialogs.creating') : t(submitLabel)}
        </button>
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
        title={t('contextRoom:roomDialogs.renameRoom')}
      >
        {renameRoom ? (
          <RoomForm
            title={t('contextRoom:roomDialogs.setANewNameForTitle', { title: renameRoom.title })}
            submitLabel={t('contextRoom:roomDialogs.save')}
            renameOnly
            onCancel={() => onRenameRoomChange(null)}
            initial={{ name: renameRoom.title, description: localizedUiText(renameRoom.brief.background, t) }}
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
        title={t('contextRoom:roomDialogs.deleteContextRoom')}
        summary={deleteRoom ? t('contextRoom:roomDialogs.titleWillBeMovedToDeletedRooms', { title: deleteRoom.title }) : ''}
        rows={deleteRoom ? [
          { label: t('contextRoom:roomDialogs.roomType'), value: t(uiText(deleteRoom.kind)) },
          { label: t('contextRoom:roomDialogs.resourceScope'), value: t('contextRoom:roomDialogs.documentsDocsEmailsMailsMeetingsMeetings', {
            docs: deleteRoom.stats.docs,
            mails: deleteRoom.stats.mails,
            meetings: deleteRoom.stats.meetings,
          }) },
        ] : []}
        risk={t('contextRoom:roomDialogs.theResourcesWillRemainButAgentWillNo')}
        confirmLabel={t('contextRoom:roomDialogs.delete')}
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
          <span>{t('contextRoom:roomDialogs.deletedTitle', { title: recentlyDeleted.title })}</span>
          <button type="button" onClick={() => { onRestoreRoom(recentlyDeleted.id); onRecentlyDeletedChange(null) }}>
            <RotateCcw aria-hidden="true" />{t('contextRoom:roomDialogs.undo')}
          </button>
          <button type="button" aria-label={t('contextRoom:roomDialogs.dismissUndoNotice')} onClick={() => onRecentlyDeletedChange(null)}>
            <X aria-hidden="true" />
          </button>
        </div>
      ) : null}
    </>
  )
}
