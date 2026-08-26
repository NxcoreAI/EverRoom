import { Eye, EyeOff, Link2, Pin, PinOff, Trash2, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import type {
  KnowledgeRoomRelationDto,
  KnowledgeRoomRelationManualType,
} from '../../../../../../shared/knowledge'
import { useLocale } from '../../../../i18n/LocaleContext'
import type { ContextRoomRecord } from '../types'
import { ReferenceDialog } from './shared'

export const ROOM_RELATION_TYPES: KnowledgeRoomRelationManualType[] = [
  'related',
  'depends_on',
  'part_of',
  'supports',
  'blocks',
  'owns',
  'custom',
]

export function relationTypeLabel(
  type: KnowledgeRoomRelationDto['type'],
  t: (key: string, values?: Record<string, string | number>) => string,
): string {
  return t(`contextRoom:relations.type.${type}`)
}

export function RoomRelationInspector({
  relation,
  rooms,
  onClose,
  onChanged,
}: {
  relation: KnowledgeRoomRelationDto
  rooms: ContextRoomRecord[]
  onClose: () => void
  onChanged: () => Promise<void> | void
}) {
  const { t } = useLocale()
  const [type, setType] = useState<KnowledgeRoomRelationManualType>(
    ROOM_RELATION_TYPES.includes(relation.type as KnowledgeRoomRelationManualType)
      ? relation.type as KnowledgeRoomRelationManualType
      : 'related',
  )
  const [directed, setDirected] = useState(relation.directed)
  const [label, setLabel] = useState(relation.label ?? '')
  const [note, setNote] = useState(relation.note ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const source = rooms.find((room) => room.id === relation.sourceRoomId)
  const target = rooms.find((room) => room.id === relation.targetRoomId)

  useEffect(() => {
    setType(ROOM_RELATION_TYPES.includes(relation.type as KnowledgeRoomRelationManualType)
      ? relation.type as KnowledgeRoomRelationManualType
      : 'related')
    setDirected(relation.directed)
    setLabel(relation.label ?? '')
    setNote(relation.note ?? '')
  }, [relation])

  const mutate = async (operation: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await operation()
      await onChanged()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <aside className="context-room-relation-inspector" aria-label={t('contextRoom:relations.inspector')}>
      <header>
        <div>
          <small>{t(`contextRoom:relations.origin.${relation.origin}`)}</small>
          <h3>{source?.title ?? relation.sourceRoomId} {relation.directed ? '→' : '↔'} {target?.title ?? relation.targetRoomId}</h3>
        </div>
        <button type="button" aria-label={t('contextRoom:relations.closeInspector')} onClick={onClose}>
          <X aria-hidden="true" />
        </button>
      </header>

      <div className="context-room-relation-metrics">
        <div><span>{t('contextRoom:relations.score')}</span><b>{relation.score.toFixed(2)}</b></div>
        <div><span>{t('contextRoom:relations.strengthLabel')}</span><b>{t(`contextRoom:relations.strength.${relation.strength}`)}</b></div>
        <div><span>{t('contextRoom:relations.sharedSources')}</span><b>{relation.sharedSourceCount}</b></div>
        <div><span>{t('contextRoom:relations.sharedEntities')}</span><b>{relation.sharedEntityCount + relation.directMentionCount}</b></div>
      </div>

      <section className="context-room-relation-evidence">
        <h4>{t('contextRoom:relations.evidence')}</h4>
        {relation.topReasons.length ? relation.topReasons.map((reason) => (
          <div key={`${reason.kind}:${reason.key}`}>
            <span>{t(`contextRoom:relations.evidenceKind.${reason.kind}`)}</span>
            <b>{reason.label}</b>
            <small>+{reason.contribution.toFixed(2)}</small>
            {reason.evidence ? <p>{reason.evidence}</p> : null}
          </div>
        )) : <p>{t('contextRoom:relations.manualRelationNoAutomaticEvidence')}</p>}
      </section>

      <form
        className="context-room-relation-form"
        onSubmit={(event) => {
          event.preventDefault()
          const api = window.nxcore?.knowledge
          if (!api) return
          void mutate(() => api.updateRoomRelation(relation.id, {
            type,
            directed,
            fromRoomId: relation.sourceRoomId,
            toRoomId: relation.targetRoomId,
            label: label || null,
            note: note || null,
          }))
        }}
      >
        <label>
          <span>{t('contextRoom:relations.relationType')}</span>
          <select value={type} onChange={(event) => setType(event.target.value as KnowledgeRoomRelationManualType)}>
            {ROOM_RELATION_TYPES.map((value) => <option key={value} value={value}>{relationTypeLabel(value, t)}</option>)}
          </select>
        </label>
        <label className="context-room-relation-checkbox">
          <input type="checkbox" checked={directed} onChange={(event) => setDirected(event.target.checked)} />
          <span>{t('contextRoom:relations.directed')}</span>
        </label>
        <label>
          <span>{t('contextRoom:relations.customLabel')}</span>
          <input value={label} maxLength={120} onChange={(event) => setLabel(event.target.value)} />
        </label>
        <label>
          <span>{t('contextRoom:relations.note')}</span>
          <textarea value={note} maxLength={1000} rows={3} onChange={(event) => setNote(event.target.value)} />
        </label>
        {error ? <p className="context-room-relation-error">{error}</p> : null}
        <button type="submit" className="context-room-primary" disabled={busy}>{t('contextRoom:relations.saveRelation')}</button>
      </form>

      <div className="context-room-relation-actions">
        <button
          type="button"
          disabled={busy}
          onClick={() => void mutate(() => window.nxcore!.knowledge.updateRoomRelation(relation.id, { pinned: !relation.pinned }))}
        >
          {relation.pinned ? <PinOff aria-hidden="true" /> : <Pin aria-hidden="true" />}
          {t(relation.pinned ? 'contextRoom:relations.unpin' : 'contextRoom:relations.pin')}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void mutate(() => window.nxcore!.knowledge.updateRoomRelation(relation.id, { hidden: !relation.hidden }))}
        >
          {relation.hidden ? <Eye aria-hidden="true" /> : <EyeOff aria-hidden="true" />}
          {t(relation.hidden ? 'contextRoom:relations.restore' : 'contextRoom:relations.hide')}
        </button>
        {relation.origin !== 'auto' ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => void mutate(() => window.nxcore!.knowledge.removeManualRoomRelation(relation.id))}
          >
            <Trash2 aria-hidden="true" />
            {t('contextRoom:relations.removeManualOverride')}
          </button>
        ) : null}
      </div>
    </aside>
  )
}

export function CreateRoomRelationDialog({
  open,
  fromRoomId,
  rooms,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  fromRoomId: string | null
  rooms: ContextRoomRecord[]
  onOpenChange: (open: boolean) => void
  onCreated: (relation: KnowledgeRoomRelationDto) => Promise<void> | void
}) {
  const { t } = useLocale()
  const candidates = useMemo(() => rooms.filter((room) => room.id !== fromRoomId), [fromRoomId, rooms])
  const [targetRoomId, setTargetRoomId] = useState('')
  const [type, setType] = useState<KnowledgeRoomRelationManualType>('related')
  const [directed, setDirected] = useState(false)
  const [label, setLabel] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setTargetRoomId(candidates[0]?.id ?? '')
    setError(null)
  }, [candidates, open])

  return (
    <ReferenceDialog open={open} onOpenChange={onOpenChange} title={t('contextRoom:relations.newRelation')}>
      <form
        className="context-room-relation-create"
        onSubmit={(event) => {
          event.preventDefault()
          const api = window.nxcore?.knowledge
          if (!api || !fromRoomId || !targetRoomId) return
          setBusy(true)
          setError(null)
          void api.createRoomRelation({
            fromRoomId,
            toRoomId: targetRoomId,
            type,
            directed,
            label: label || null,
            note: note || null,
          }).then(async (relation) => {
            await onCreated(relation)
            onOpenChange(false)
            setLabel('')
            setNote('')
          }).catch((cause: unknown) => {
            setError(cause instanceof Error ? cause.message : String(cause))
          }).finally(() => setBusy(false))
        }}
      >
        <header><Link2 aria-hidden="true" /><div><h2>{t('contextRoom:relations.newRelation')}</h2><p>{t('contextRoom:relations.newRelationDescription')}</p></div></header>
        <label>
          <span>{t('contextRoom:relations.targetRoom')}</span>
          <select required value={targetRoomId} onChange={(event) => setTargetRoomId(event.target.value)}>
            {candidates.map((room) => <option key={room.id} value={room.id}>{room.title}</option>)}
          </select>
        </label>
        <label>
          <span>{t('contextRoom:relations.relationType')}</span>
          <select value={type} onChange={(event) => setType(event.target.value as KnowledgeRoomRelationManualType)}>
            {ROOM_RELATION_TYPES.map((value) => <option key={value} value={value}>{relationTypeLabel(value, t)}</option>)}
          </select>
        </label>
        <label className="context-room-relation-checkbox">
          <input type="checkbox" checked={directed} onChange={(event) => setDirected(event.target.checked)} />
          <span>{t('contextRoom:relations.directed')}</span>
        </label>
        <label><span>{t('contextRoom:relations.customLabel')}</span><input value={label} maxLength={120} onChange={(event) => setLabel(event.target.value)} /></label>
        <label><span>{t('contextRoom:relations.note')}</span><textarea value={note} maxLength={1000} rows={3} onChange={(event) => setNote(event.target.value)} /></label>
        {error ? <p className="context-room-relation-error">{error}</p> : null}
        <footer>
          <button type="button" onClick={() => onOpenChange(false)}>{t('contextRoom:shared.cancel')}</button>
          <button type="submit" className="context-room-primary" disabled={busy || !targetRoomId}>{t('contextRoom:relations.createRelation')}</button>
        </footer>
      </form>
    </ReferenceDialog>
  )
}
