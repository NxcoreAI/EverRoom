import { CheckSquare2, ChevronRight, CircleDot, Link2, Mail, MessageSquareText, Mic } from 'lucide-react';
import { useLocale } from '../../../../../i18n/LocaleContext';

import { formatRoomUpdatedTime } from '../../roomUpdatedTime';
import type { ContextRoomRecord } from '../../types';
import { localizedUiText, uiText } from '../../adapters';
import type { EntityFactGraphNode } from '../entityFactGraphModel';
import { ROOT_ID } from '../entityFactGraphModel';
import { roomKindIcon, roomKindTone } from '../utils';

function EmptyState({ children }: { children: string }) {
  return <div className="context-room-workspace-empty">{children}</div>;
}

export type WorkspaceObjectPreview =
  | { kind: 'task'; id: string }
  | { kind: 'mail'; id: string }
  | { kind: 'meeting'; id: string }
  | { kind: 'related-room'; id: string }
  /** 实体与事实图谱节点：点击图谱节点后在右侧内容区展示详情。 */
  | { kind: 'graph-node'; node: EntityFactGraphNode };

export function ObjectPreview({
  room,
  rooms,
  selection,
  onOpenRoom,
}: {
  room: ContextRoomRecord;
  rooms: ContextRoomRecord[];
  selection: WorkspaceObjectPreview;
  onOpenRoom: (roomId: string) => void;
}) {
  const { locale, t } = useLocale();
  if (selection.kind === 'graph-node') {
    const { node } = selection;
    if (node.kind === 'fact' && node.fact) {
      // 应用事实（room_entity_facts 持续抽取）：内容 + 关联实体 + 来源资料
      const fact = node.fact;
      return (
        <article className="context-room-object-preview" data-testid="context-room-object-preview">
          <header>
            <MessageSquareText aria-hidden="true" />
            <div>
              <span>{t('contextRoom:objectPreview.factDetails')}</span>
              <h1>{t(`contextRoom:memory.factType.${fact.type === '关系' ? 'relation' : 'attribute'}`)}</h1>
            </div>
          </header>
          <dl>
            <div>
              <dt>{t('contextRoom:objectPreview.factContent')}</dt>
              <dd>{localizedUiText(fact.content, t)}</dd>
            </div>
            {fact.entityNames.length ? (
              <div>
                <dt>{t('contextRoom:objectPreview.relatedEntities')}</dt>
                <dd>{fact.entityNames.join(locale === 'zh-CN' ? '、' : ', ')}</dd>
              </div>
            ) : null}
            <div>
              <dt>{t('contextRoom:objectPreview.mentionSources')}</dt>
              <dd>{t('contextRoom:objectPreview.countSources', { count: fact.sourceCount })}</dd>
            </div>
            {fact.lastMentionAt ? (
              <div>
                <dt>{t('contextRoom:objectPreview.lastMention')}</dt>
                <dd>{formatRoomUpdatedTime(fact.lastMentionAt, fact.lastMentionAt, locale, t)}</dd>
              </div>
            ) : null}
          </dl>
          {fact.sources.length ? (
            <section>
              <div className="context-room-memory-detail-section-head">
                <span>{t('contextRoom:memory.sourceMaterials')}</span>
                <small>{fact.sources.length}</small>
              </div>
              <div className="context-room-memory-detail-list">
                {fact.sources.map((source) => {
                  const kindLabel = t(`contextRoom:memory.sourceKind.${source.sourceKind}`);
                  return (
                    <div className="context-room-memory-source-row" key={`${source.sourceKind}-${source.sourceId}`}>
                      <span className="context-room-memory-detail-row-icon"><Link2 aria-hidden="true" /></span>
                      <span>
                        <b>{source.sourceTitle ?? kindLabel}</b>
                        <small>
                          {kindLabel}
                          {' · '}
                          {formatRoomUpdatedTime(source.mentionedAt, source.mentionedAt, locale, t)}
                        </small>
                      </span>
                    </div>
                  );
                })}
              </div>
            </section>
          ) : null}
        </article>
      );
    }
    if (node.kind === 'fact') {
      const memory = node.memory!;
      return (
        <article className="context-room-object-preview" data-testid="context-room-object-preview">
          <header>
            <MessageSquareText aria-hidden="true" />
            <div>
              <span>{t('contextRoom:objectPreview.factDetails')}</span>
              <h1>{t(uiText(memory.type))}</h1>
            </div>
          </header>
          <dl>
            <div>
              <dt>{t('contextRoom:objectPreview.factContent')}</dt>
              <dd>{localizedUiText(memory.content, t)}</dd>
            </div>
            <div>
              <dt>{t('contextRoom:objectPreview.currentStatus')}</dt>
              <dd>{t(uiText(memory.status))}</dd>
            </div>
          </dl>
          {memory.sources?.length ? (
            <section>
              <div className="context-room-memory-detail-section-head">
                <span>{t('contextRoom:memory.sourceMaterials')}</span>
                <small>{memory.sources.length}</small>
              </div>
              <div className="context-room-memory-detail-list">
                {memory.sources.map((source) => (
                  <div className="context-room-memory-source-row" key={`${source.type}-${source.name}`}>
                    <span className="context-room-memory-detail-row-icon"><Link2 aria-hidden="true" /></span>
                    <span>
                      <b>{source.name}</b>
                      <small>{t(uiText(source.type))}</small>
                    </span>
                  </div>
                ))}
              </div>
            </section>
          ) : null}
        </article>
      );
    }
    const isRoomRoot = node.id === ROOT_ID;
    return (
      <article className="context-room-object-preview" data-testid="context-room-object-preview">
        <header>
          <CircleDot aria-hidden="true" />
          <div>
            <span>{t(isRoomRoot ? 'contextRoom:objectPreview.roomOverview' : 'contextRoom:objectPreview.entityDetails')}</span>
            <h1>
              {node.label}
              {node.status ? (
                <span className="context-room-memory-entity-status" data-status={node.status}>
                  {t(`contextRoom:memory.entityStatus.${node.status}`)}
                </span>
              ) : null}
            </h1>
          </div>
        </header>
        <dl>
          <div>
            <dt>{t('contextRoom:objectPreview.entityType')}</dt>
            <dd>{t(uiText(node.entityType))}</dd>
          </div>
          {node.status ? (
            <div>
              <dt>{t('contextRoom:objectPreview.entityStatus')}</dt>
              <dd>{t(`contextRoom:memory.entityStatus.${node.status}`)}</dd>
            </div>
          ) : null}
          {node.mentionCount !== undefined ? (
            <div>
              <dt>{t('contextRoom:objectPreview.mentionSources')}</dt>
              <dd>{t('contextRoom:objectPreview.countSources', { count: node.mentionCount })}</dd>
            </div>
          ) : null}
          {node.lastMentionAt ? (
            <div>
              <dt>{t('contextRoom:objectPreview.lastMention')}</dt>
              <dd>{formatRoomUpdatedTime(node.lastMentionAt, node.lastMentionAt, locale, t)}</dd>
            </div>
          ) : null}
          {isRoomRoot ? (
            <div>
              <dt>{t('contextRoom:objectPreview.resourceScope')}</dt>
              <dd>{t('contextRoom:objectPreview.countItems', { count: room.materials.length + room.fileItems.length })}</dd>
            </div>
          ) : null}
        </dl>
        <p className="context-room-object-preview-desc">{localizedUiText(node.description, t)}</p>
        {node.sources?.length ? (
          <section>
            <div className="context-room-memory-detail-section-head">
              <span>{t('contextRoom:memory.sourceMaterials')}</span>
              <small>{node.sources.length}</small>
            </div>
            <div className="context-room-memory-detail-list">
              {node.sources.map((source) => {
                const kindLabel = t(`contextRoom:memory.sourceKind.${source.sourceKind}`);
                return (
                  <div className="context-room-memory-source-row" key={`${source.sourceKind}-${source.sourceId}`}>
                    <span className="context-room-memory-detail-row-icon"><Link2 aria-hidden="true" /></span>
                    <span>
                      <b>{source.evidence ?? source.sourceTitle ?? kindLabel}</b>
                      <small>
                        {source.sourceTitle ? `${source.sourceTitle} · ${kindLabel}` : kindLabel}
                        {' · '}
                        {formatRoomUpdatedTime(source.mentionedAt, source.mentionedAt, locale, t)}
                      </small>
                    </span>
                  </div>
                );
              })}
            </div>
          </section>
        ) : null}
        {node.relatedFacts?.length ? (
          <section>
            <div className="context-room-memory-detail-section-head">
              <span>{t('contextRoom:memory.relatedFacts')}</span>
              <small>{node.relatedFacts.length}</small>
            </div>
            <div className="context-room-memory-detail-list">
              {node.relatedFacts.map((fact) => (
                <div className="context-room-memory-source-row" key={fact.factId}>
                  <span className="context-room-memory-detail-row-icon"><MessageSquareText aria-hidden="true" /></span>
                  <span>
                    <b>{localizedUiText(fact.content, t)}</b>
                    <small>{t(`contextRoom:memory.factType.${fact.type === '关系' ? 'relation' : 'attribute'}`)}</small>
                  </span>
                </div>
              ))}
            </div>
          </section>
        ) : null}
        {node.linkedRoomId ? (
          <button
            type="button"
            className="context-room-primary context-room-object-preview-action"
            onClick={() => onOpenRoom(node.linkedRoomId!)}
          >
            {t('contextRoom:objectPreview.openLinkedRoom')}
            <ChevronRight aria-hidden="true" />
          </button>
        ) : null}
      </article>
    );
  }
  if (selection.kind === 'related-room') {
    const relatedRoom = rooms.find((item) => item.id === selection.id);
    if (!relatedRoom) return <EmptyState>{t('contextRoom:objectPreview.relatedRoomNotFound')}</EmptyState>;
    const people = new Set(room.people.map((person) => person.name));
    const sharedPeople = relatedRoom.people.filter((person) => people.has(person.name));
    const Icon = roomKindIcon(relatedRoom.kind);
    return (
      <article className="context-room-object-preview" data-testid="context-room-object-preview">
        <header data-icon-tone={roomKindTone(relatedRoom.kind)}>
          <Icon aria-hidden="true" />
          <div>
            <span>{t('contextRoom:objectPreview.relatedRoom')}</span>
            <h1>{relatedRoom.title}</h1>
          </div>
        </header>
        <dl>
          <div>
            <dt>{t('contextRoom:objectPreview.relationshipBasis')}</dt>
            <dd>
              {sharedPeople.length
                ? t('contextRoom:objectPreview.sharedPeoplePeople', { people: sharedPeople.map((person) => person.name).join(locale === 'zh-CN' ? '、' : ', ') })
                : t('contextRoom:objectPreview.bothAreKindRooms', { kind: t(uiText(room.kind)) })}
            </dd>
          </div>
          <div>
            <dt>{t('contextRoom:objectPreview.currentStatus')}</dt>
            <dd>{t(uiText(relatedRoom.status))}</dd>
          </div>
          <div>
            <dt>{t('contextRoom:objectPreview.resourceScope')}</dt>
            <dd>{t('contextRoom:objectPreview.countItems', { count: relatedRoom.materials.length + relatedRoom.fileItems.length })}</dd>
          </div>
        </dl>
        <button
          type="button"
          className="context-room-primary context-room-object-preview-action"
          onClick={() => onOpenRoom(relatedRoom.id)}
        >
          {t('contextRoom:objectPreview.openRoom')}
          <ChevronRight aria-hidden="true" />
        </button>
      </article>
    );
  }

  if (selection.kind === 'task') {
    const task = room.actionItems.find((item) => item.id === selection.id);
    if (!task) return <EmptyState>{t('contextRoom:objectPreview.taskNotFoundOrDoesNotBelongTo')}</EmptyState>;
    return (
      <article className="context-room-object-preview" data-testid="context-room-object-preview">
        <header>
          <CheckSquare2 aria-hidden="true" />
          <div>
            <span>{t('contextRoom:objectPreview.taskDetails')}</span>
            <h1>{task.title}</h1>
          </div>
        </header>
        <dl>
          <div>
            <dt>{t('contextRoom:objectPreview.status')}</dt>
            <dd>{t(uiText(task.status))}</dd>
          </div>
          <div>
            <dt>{t('contextRoom:objectPreview.owner')}</dt>
            <dd>{t(uiText(task.owner))}</dd>
          </div>
          <div>
            <dt>{t('contextRoom:objectPreview.dueDate')}</dt>
            <dd>{t(uiText(task.deadline))}</dd>
          </div>
        </dl>
      </article>
    );
  }

  if (selection.kind === 'meeting') {
    const meeting = room.materials.find((item) => item.id === selection.id && item.type === '会议');
    if (!meeting) return <EmptyState>{t('contextRoom:objectPreview.meetingNotFoundOrDoesNotBelongTo')}</EmptyState>;
    return (
      <article className="context-room-object-preview" data-testid="context-room-object-preview">
        <header data-icon-tone="calendar">
          <Mic aria-hidden="true" />
          <div>
            <span>{t('contextRoom:objectPreview.meetingDetails')}</span>
            <h1>{meeting.title}</h1>
          </div>
        </header>
        <dl>
          <div>
            <dt>{t('contextRoom:objectPreview.time')}</dt>
            <dd>{meeting.time}</dd>
          </div>
          <div>
            <dt>{t('contextRoom:objectPreview.attendees')}</dt>
            <dd>{meeting.attendees?.join(locale === 'zh-CN' ? '、' : ', ') || t('contextRoom:objectPreview.notRecorded')}</dd>
          </div>
          <div>
            <dt>{t('contextRoom:objectPreview.meetingNotes')}</dt>
            <dd>{localizedUiText(meeting.summary, t)}</dd>
          </div>
        </dl>
      </article>
    );
  }

  const mail = room.materials.find((item) => item.id === selection.id && item.type === '邮件');
  if (!mail) return <EmptyState>{t('contextRoom:objectPreview.emailNotFoundOrDoesNotBelongTo')}</EmptyState>;
  return (
    <article className="context-room-object-preview" data-testid="context-room-object-preview">
      <header>
        <Mail aria-hidden="true" />
        <div>
          <span>{t('contextRoom:objectPreview.emailPreview')}</span>
          <h1>{mail.title}</h1>
        </div>
      </header>
      <dl>
        <div>
          <dt>{t('contextRoom:objectPreview.updated')}</dt>
          <dd>{mail.time}</dd>
        </div>
        <div>
          <dt>{t('contextRoom:objectPreview.emailBody')}</dt>
          <dd>{localizedUiText(mail.summary, t)}</dd>
        </div>
      </dl>
    </article>
  );
}
