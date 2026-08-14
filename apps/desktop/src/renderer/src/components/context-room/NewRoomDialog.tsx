import { Plus, X } from 'lucide-react'

import { ROOM_KINDS } from './roomConfig'
import type { RoomKind, RoomRecommendation } from './types'

export function NewRoomDialog({
  recommendation,
  onClose,
  onCreate,
}: {
  recommendation: RoomRecommendation | null
  onClose: () => void
  onCreate: (input: { title: string; kind: RoomKind; description: string }) => void
}) {
  return (
    <div
      className="cr-modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) onClose()
      }}
    >
      <form
        className="cr-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cr-new-room-title"
        onSubmit={(event) => {
          event.preventDefault()
          const values = new FormData(event.currentTarget)
          onCreate({
            title: String(values.get('title') ?? '').trim(),
            kind: String(values.get('kind') ?? '项目') as RoomKind,
            description: String(values.get('description') ?? '').trim(),
          })
        }}
      >
        <header>
          <div>
            <span>工作边界</span>
            <h2 id="cr-new-room-title">新建 Context Room</h2>
          </div>
          <button type="button" aria-label="关闭" onClick={onClose}>
            <X aria-hidden="true" />
          </button>
        </header>
        <label>
          <span>名称</span>
          <input name="title" required maxLength={40} autoFocus defaultValue={recommendation?.title} />
        </label>
        <label>
          <span>类型</span>
          <select name="kind" defaultValue={recommendation?.kind ?? '项目'}>
            {ROOM_KINDS.map((kind) => <option key={kind}>{kind}</option>)}
          </select>
        </label>
        <label>
          <span>初始说明</span>
          <textarea
            name="description"
            rows={4}
            defaultValue={recommendation?.reason}
            placeholder="描述目标、范围或需要聚合的资料"
          />
        </label>
        <footer>
          <button type="button" className="secondary-button" onClick={onClose}>取消</button>
          <button type="submit" className="primary-button">
            <Plus aria-hidden="true" />创建 Room
          </button>
        </footer>
      </form>
    </div>
  )
}
