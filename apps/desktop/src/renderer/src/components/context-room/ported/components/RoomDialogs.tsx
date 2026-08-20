import { CalendarDays, FileText, Mail, RotateCcw, Trash2, X } from 'lucide-react'
import { useState } from 'react'
import { useLocale } from '../../../../i18n/LocaleContext'

import type { ContextRoomRecord } from '../types'
import { localizedUiText, uiText } from '../adapters'
import { ReferenceDialog } from './shared'
import { roomKindIcon, roomKindTone } from './utils'

export interface DraftRoom {
  name: string
  description: string
}

function DeleteRoomDialog({
  room,
  onOpenChange,
  onConfirm,
}: {
  room: ContextRoomRecord | null
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}) {
  const { t } = useLocale()
  const RoomIcon = room ? roomKindIcon(room.kind) : null

  return (
    <ReferenceDialog
      open={Boolean(room)}
      onOpenChange={onOpenChange}
      title={t('contextRoom:roomDialogs.deleteContextRoom')}
      contentClassName="context-room-delete-room-dialog-shell"
    >
      <div className="context-room-delete-room-dialog">
        <header>
          <span className="context-room-delete-room-symbol">
            <Trash2 aria-hidden="true" strokeWidth={1.8} />
          </span>
          <div>
            <h2>{t('contextRoom:roomDialogs.deleteContextRoom')}</h2>
            <p>{room ? t('contextRoom:roomDialogs.titleWillBeMovedToDeletedRooms', { title: room.title }) : ''}</p>
          </div>
        </header>

        {room && RoomIcon ? (
          <div className="context-room-delete-room-body">
            <section className="context-room-delete-room-target" aria-label={t('contextRoom:roomDialogs.resourceScope')}>
              <div className="context-room-delete-room-identity">
                <span data-icon-tone={roomKindTone(room.kind)}>
                  <RoomIcon aria-hidden="true" strokeWidth={1.8} />
                </span>
                <div>
                  <strong>{room.title}</strong>
                  <small>{t(uiText(room.kind))}</small>
                </div>
              </div>
              <div className="context-room-delete-room-stats">
                <span>
                  <FileText aria-hidden="true" strokeWidth={1.8} />
                  <b>{room.stats.docs}</b>
                  <small>{t('contextRoom:roomDialogs.documents')}</small>
                </span>
                <span>
                  <Mail aria-hidden="true" strokeWidth={1.8} />
                  <b>{room.stats.mails}</b>
                  <small>{t('contextRoom:roomDialogs.emails')}</small>
                </span>
                <span>
                  <CalendarDays aria-hidden="true" strokeWidth={1.8} />
                  <b>{room.stats.meetings}</b>
                  <small>{t('contextRoom:roomDialogs.meetings')}</small>
                </span>
              </div>
            </section>

            <div className="context-room-delete-room-recovery">
              <RotateCcw aria-hidden="true" strokeWidth={1.8} />
              <p>{t('contextRoom:roomDialogs.theResourcesWillRemainButAgentWillNo')}</p>
            </div>
          </div>
        ) : null}

        <footer>
          <button type="button" className="context-room-ghost" onClick={() => onOpenChange(false)}>
            {t('contextRoom:roomDialogs.cancel')}
          </button>
          <button
            type="button"
            className="context-room-danger-button"
            onClick={() => {
              onOpenChange(false)
              onConfirm()
            }}
          >
            <Trash2 aria-hidden="true" strokeWidth={1.8} />
            {t('contextRoom:roomDialogs.delete')}
          </button>
        </footer>
      </div>
    </ReferenceDialog>
  )
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
      <DeleteRoomDialog
        room={deleteRoom}
        onOpenChange={(open) => !open && onDeleteRoomChange(null)}
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
