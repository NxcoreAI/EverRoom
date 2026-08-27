import {
  Brain,
  CalendarClock,
  CalendarDays,
  CheckSquare2,
  ChevronRight,
  Clock3,
  FileText,
  Mail,
  Users,
  X,
  type LucideIcon,
} from 'lucide-react'
import type { ReactNode } from 'react'

import { useLocale } from '../../../../i18n/LocaleContext'
import { localizedUiText, uiText } from '../adapters'
import type { ContextRoomRecord } from '../types'
import { roomKindIcon, roomKindTone } from './utils'

export function RoomGraphInspectorShell({
  ariaLabel,
  children,
  eyebrow,
  footer,
  icon: Icon,
  onClose,
  relationType,
  title,
  tone,
}: {
  ariaLabel: string
  children: ReactNode
  eyebrow: string
  footer?: ReactNode
  icon: LucideIcon
  onClose: () => void
  relationType?: string
  title: string
  tone?: string
}) {
  const { t } = useLocale()

  return (
    <aside
      className="context-room-room-graph-inspector"
      aria-label={ariaLabel}
      data-icon-tone={tone}
      data-relation-type={relationType}
    >
      <header className="context-room-graph-inspector-header">
        <span className="context-room-graph-inspector-icon"><Icon aria-hidden="true" /></span>
        <div>
          <small>{eyebrow}</small>
          <h3>{title}</h3>
        </div>
        <button type="button" aria-label={t('contextRoom:relations.closeInspector')} onClick={onClose}>
          <X aria-hidden="true" />
        </button>
      </header>
      <div className="context-room-graph-inspector-scroll">{children}</div>
      {footer ? <footer className="context-room-graph-inspector-footer">{footer}</footer> : null}
    </aside>
  )
}

function Stat({ icon: Icon, label, value }: { icon: LucideIcon; label: string; value: number }) {
  return (
    <div className="context-room-node-stat">
      <Icon aria-hidden="true" />
      <span>{label}</span>
      <b>{value}</b>
    </div>
  )
}

export function RoomNodeInspector({
  contextLabel,
  onClose,
  onOpenRoom,
  relationshipSummary,
  room,
}: {
  contextLabel?: string
  onClose: () => void
  onOpenRoom: (roomId: string) => void
  relationshipSummary?: string | null
  room: ContextRoomRecord
}) {
  const { t } = useLocale()
  const Icon = roomKindIcon(room.kind)
  const resourceCount = room.materials.length + room.fileItems.length
  const recentResources = [
    ...room.materials.map((item) => ({ id: item.id, name: item.title, time: item.time, type: t(uiText(item.type)) })),
    ...room.fileItems.map((item) => ({ id: item.id, name: item.name, time: item.time, type: item.extension.toUpperCase() })),
  ].slice(0, 5)
  const background = localizedUiText(room.brief.background, t)
  const goal = localizedUiText(room.brief.goal, t)
  const status = localizedUiText(room.brief.status, t)

  return (
    <RoomGraphInspectorShell
      ariaLabel={t('contextRoom:relations.roomInspector')}
      eyebrow={contextLabel ?? t(uiText(room.kind))}
      icon={Icon}
      onClose={onClose}
      title={room.title}
      tone={roomKindTone(room.kind)}
      footer={(
        <button type="button" className="context-room-primary" onClick={() => onOpenRoom(room.id)}>
          {t('contextRoom:relations.openRoom')}<ChevronRight aria-hidden="true" />
        </button>
      )}
    >
      <section className="context-room-node-overview">
        <div className="context-room-node-meta">
          <span>{t(uiText(room.status)) || t('contextRoom:relations.statusUnknown')}</span>
          <span><Clock3 aria-hidden="true" />{room.lastViewed || t('contextRoom:relations.timeUnknown')}</span>
        </div>
        <p>{background || t('contextRoom:overviewDashboard.noBackgroundProvided')}</p>
      </section>

      {relationshipSummary ? (
        <section className="context-room-inspector-highlight">
          <span>{t('contextRoom:relations.relationshipBasis')}</span>
          <b>{relationshipSummary}</b>
        </section>
      ) : null}

      <section className="context-room-inspector-section">
        <h4>{t('contextRoom:relations.roomContext')}</h4>
        <dl className="context-room-node-context-list">
          <div><dt>{t('contextRoom:relations.currentGoal')}</dt><dd>{goal || t('contextRoom:overviewDashboard.notSet')}</dd></div>
          <div><dt>{t('contextRoom:relations.currentStatus')}</dt><dd>{status || t('contextRoom:overviewDashboard.noStatusSummaryYet')}</dd></div>
        </dl>
      </section>

      <section className="context-room-inspector-section">
        <h4>{t('contextRoom:relations.resourceOverview')}<span>{resourceCount}</span></h4>
        <div className="context-room-node-stats">
          <Stat icon={FileText} label={t('contextRoom:relations.documents')} value={room.stats.docs} />
          <Stat icon={Mail} label={t('contextRoom:relations.emails')} value={room.stats.mails} />
          <Stat icon={CalendarDays} label={t('contextRoom:relations.meetings')} value={room.stats.meetings} />
          <Stat icon={CheckSquare2} label={t('contextRoom:relations.tasks')} value={room.stats.tasks} />
          <Stat icon={Brain} label={t('contextRoom:relations.memories')} value={room.stats.memories} />
          <Stat icon={CalendarClock} label={t('contextRoom:relations.events')} value={room.stats.events} />
        </div>
      </section>

      {(room.brief.decisions.length || room.brief.risks.length) ? (
        <section className="context-room-inspector-section context-room-node-signals">
          <h4>{t('contextRoom:relations.keySignals')}</h4>
          {room.brief.decisions.length ? <div><span>{t('contextRoom:relations.decisions')}</span><ul>{room.brief.decisions.slice(0, 3).map((item) => <li key={item}>{localizedUiText(item, t)}</li>)}</ul></div> : null}
          {room.brief.risks.length ? <div data-kind="risk"><span>{t('contextRoom:relations.risks')}</span><ul>{room.brief.risks.slice(0, 3).map((item) => <li key={item}>{localizedUiText(item, t)}</li>)}</ul></div> : null}
        </section>
      ) : null}

      {room.people.length ? (
        <section className="context-room-inspector-section">
          <h4><span>{t('contextRoom:relations.participants')}</span><span>{room.people.length}</span></h4>
          <div className="context-room-node-people">
            {room.people.slice(0, 6).map((person) => (
              <span key={`${person.name}:${person.role}`} title={localizedUiText(person.role, t)}>
                <Users aria-hidden="true" /><b>{person.name}</b><small>{localizedUiText(person.role, t)}</small>
              </span>
            ))}
          </div>
        </section>
      ) : null}

      <section className="context-room-inspector-section">
        <h4><span>{t('contextRoom:relations.recentResources')}</span><span>{resourceCount}</span></h4>
        {recentResources.length ? (
          <div className="context-room-node-resources">
            {recentResources.map((resource) => (
              <div key={`${resource.type}:${resource.id}`}>
                <FileText aria-hidden="true" />
                <span><b>{resource.name}</b><small>{resource.type} · {resource.time}</small></span>
              </div>
            ))}
          </div>
        ) : <p className="context-room-inspector-empty">{t('contextRoom:overviewDashboard.noResourcesYet')}</p>}
      </section>
    </RoomGraphInspectorShell>
  )
}
