import { RotateCcw, X } from 'lucide-react'

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
      <h2>{title}</h2>
      <label>
        <span>名称</span>
        <input name="name" defaultValue={initial?.name} required maxLength={40} autoFocus />
      </label>
      {renameOnly ? (
        <input type="hidden" name="kind" value={initial?.kind ?? '项目'} />
      ) : (
        <label>
          <span>类型</span>
          <select name="kind" defaultValue={initial?.kind ?? '项目'}>
            {(['项目', '主题', '人物', '长期目标', '议题', '事件'] as ContextRoomKind[]).map((kind) => (
              <option key={kind}>{kind}</option>
            ))}
          </select>
        </label>
      )}
      {renameOnly ? (
        <input type="hidden" name="summary" value={initial?.summary ?? ''} />
      ) : (
        <label>
          <span>初始说明</span>
          <textarea
            name="summary"
            rows={4}
            defaultValue={initial?.summary}
            placeholder="描述目标、范围或需要聚合的资料"
          />
        </label>
      )}
      <footer>
        {onCancel ? <button type="button" className="context-room-ghost" onClick={onCancel}>取消</button> : null}
        <button type="submit" className="context-room-primary">{submitLabel}</button>
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
  return (
    <>
      <ReferenceDialog
        open={Boolean(renameRoom)}
        onOpenChange={(open) => !open && onRenameRoomChange(null)}
        title="重命名 Room"
      >
        {renameRoom ? (
          <RoomForm
            title={`为「${renameRoom.title}」设置新名称`}
            submitLabel="保存"
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
        title="删除 Context Room"
        summary={deleteRoom ? `“${deleteRoom.title}”将移至已删除 Room。` : ''}
        rows={deleteRoom ? [
          { label: 'Room 类型', value: deleteRoom.kind },
          { label: '资料范围', value: `文档 ${String(deleteRoom.stats.docs)} · 邮件 ${String(deleteRoom.stats.mails)} · 会议 ${String(deleteRoom.stats.meetings)}` },
        ] : []}
        risk="资料本体不会被删除，但 Agent 不再以此 Room 作为上下文边界，可在已删除 Room 中恢复。"
        confirmLabel="删除"
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
          <span>已删除“{recentlyDeleted.title}”</span>
          <button type="button" onClick={() => { onRestoreRoom(recentlyDeleted.id); onRecentlyDeletedChange(null) }}>
            <RotateCcw aria-hidden="true" />撤销
          </button>
          <button type="button" aria-label="关闭撤销提示" onClick={() => onRecentlyDeletedChange(null)}>
            <X aria-hidden="true" />
          </button>
        </div>
      ) : null}
    </>
  )
}
