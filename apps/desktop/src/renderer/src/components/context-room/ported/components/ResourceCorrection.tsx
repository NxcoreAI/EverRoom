import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { FolderInput, FolderMinus, MoreVertical } from 'lucide-react'
import { useState } from 'react'

import { showToast } from '@/state/toast'
import { useLocale } from '../../../../i18n/LocaleContext'
import type { ContextRoomRecord } from '../types'
import { ReferenceDialog } from './shared'
import { RoomMergePartnerPicker } from './RoomMergePartnerPicker'

/** 可纠正的路由资料：file=知识上传文件，mail=连接器邮件。 */
export interface CorrectionTarget {
  sourceKind: 'file' | 'mail'
  sourceId: string
  title: string
}

export function notifyKnowledgeChanged(): void {
  window.dispatchEvent(new CustomEvent('everroom:knowledge-changed'))
}

/**
 * 资料条目的归入纠正菜单（P0-1）：
 * - 移出本 Room = revertDecision（撤销该资料的最新确认决策，自动重新归类）
 * - 改归其他 Room = attachDoc 到目标 Room 的户口实体（manual 链接，权重 1.5）
 * 两个动作都只消费既有网关端点，决策反查走 listRecentDecisions(100)。
 */
export function ResourceCorrectionMenu({
  room,
  rooms,
  target,
  onCorrected,
}: {
  room: ContextRoomRecord
  rooms: ContextRoomRecord[]
  target: CorrectionTarget
  onCorrected?: () => void
}) {
  const { t } = useLocale()
  const [reassignOpen, setReassignOpen] = useState(false)
  const [targetRoomId, setTargetRoomId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const removeFromRoom = async () => {
    const knowledge = window.nxcore?.knowledge
    if (!knowledge) return
    setBusy(true)
    try {
      const { items } = await knowledge.listRecentDecisions(100)
      const decision = items.find((item) => item.sourceKind === target.sourceKind
        && item.sourceId === target.sourceId && item.roomId === room.id)
      if (!decision) throw new Error(t('contextRoom:correction.decisionNotFound'))
      await knowledge.revertDecision(decision.decisionId)
      showToast({
        title: t('contextRoom:correction.removedTitle'),
        message: t('contextRoom:correction.removedBody', { title: target.title }),
      })
      notifyKnowledgeChanged()
      onCorrected?.()
    } catch (cause) {
      showToast({
        title: t('contextRoom:correction.removeFailed'),
        message: cause instanceof Error ? cause.message : undefined,
      })
    } finally {
      setBusy(false)
    }
  }

  const reassignToRoom = async () => {
    const knowledge = window.nxcore?.knowledge
    if (!knowledge || !targetRoomId) return
    setBusy(true)
    setError(null)
    try {
      const { items } = await knowledge.listEntities('room')
      const entity = items.find((item) => item.roomId === targetRoomId)
      if (!entity) throw new Error(t('contextRoom:correction.noEntityAnchor'))
      await knowledge.attachDoc(target.sourceKind, target.sourceId, { entityId: entity.id })
      const roomTitle = rooms.find((item) => item.id === targetRoomId)?.title ?? targetRoomId
      showToast({
        title: t('contextRoom:correction.reassignedTitle'),
        message: t('contextRoom:correction.reassignedBody', { title: target.title, room: roomTitle }),
      })
      notifyKnowledgeChanged()
      onCorrected?.()
      setReassignOpen(false)
      setTargetRoomId('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('contextRoom:correction.reassignFailed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            className="context-room-resource-correct-button"
            aria-label={t('contextRoom:correction.menuLabel', { title: target.title })}
            title={t('contextRoom:correction.menuLabel', { title: target.title })}
            disabled={busy}
          >
            <MoreVertical aria-hidden="true" />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content className="context-room-card-menu" sideOffset={6} align="end">
            <DropdownMenu.Item onSelect={() => { setTargetRoomId(''); setError(null); setReassignOpen(true) }}>
              <FolderInput aria-hidden="true" />
              {t('contextRoom:correction.reassign')}
            </DropdownMenu.Item>
            <DropdownMenu.Item onSelect={() => void removeFromRoom()}>
              <FolderMinus aria-hidden="true" />
              {t('contextRoom:correction.remove')}
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

      <ReferenceDialog
        open={reassignOpen}
        onOpenChange={(open) => { if (!open && !busy) setReassignOpen(false) }}
        title={t('contextRoom:correction.reassignTitle')}
      >
        <div className="context-room-manual-merge">
          <header>
            <div>
              <span>{t('contextRoom:correction.eyebrow')}</span>
              <h2>{t('contextRoom:correction.reassignTitle')}</h2>
            </div>
          </header>
          <p>{t('contextRoom:correction.reassignHint', { title: target.title })}</p>
          <RoomMergePartnerPicker
            rooms={(rooms ?? []).map((item) => ({
              id: item.id,
              title: item.title,
              ...(item.kind ? { kind: item.kind } : {}),
            }))}
            excludeRoomId={room.id}
            value={targetRoomId}
            onChange={setTargetRoomId}
          />
          {error ? <p className="context-room-form-error" role="alert">{error}</p> : null}
          <footer>
            <button type="button" onClick={() => setReassignOpen(false)} disabled={busy}>
              {t('contextRoom:duplicateCenter.cancel')}
            </button>
            <button
              type="button"
              className="context-room-primary-button"
              disabled={!targetRoomId || busy}
              onClick={() => void reassignToRoom()}
            >
              {t('contextRoom:correction.reassignConfirm')}
            </button>
          </footer>
        </div>
      </ReferenceDialog>
    </>
  )
}
