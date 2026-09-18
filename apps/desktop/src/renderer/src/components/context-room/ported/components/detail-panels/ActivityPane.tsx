import type { RoomDocument } from '@nxcore/agent-contract';
import { GitBranch } from 'lucide-react';
import { useLocale } from '../../../../../i18n/LocaleContext';

import type { KnowledgeFileDto } from '../../../../../../../shared/knowledge';
import { useRoomActivityEntries } from '../../hooks/useRoomActivityEntries';
import { localizedUiText } from '../../adapters';
import { formatTimelineTime, parseTimelineDate } from '../../roomTimeline';
import type { ContextRoomRecord, ContextRoomResource } from '../../types';
import { ActivityEntryBody, CATEGORY_ICONS, useActivityEntryInteractions } from './ActivityEntryParts';
import { PanelEmptyState } from './PanelEmptyState';
import type { WorkspaceObjectPreview } from './index';

/**
 * 工作 / 动态（原型 renderWorkFeed）：Room 统一信息流——
 * 投影事件、文档版本、资料收录、邮件与会议按时间倒序平铺；
 * 时间范围浏览与筛选在概览底部的「Room 时间轴」卡。
 */
export function ActivityPane({
  room,
  backendDocuments,
  knowledgeFiles,
  onSelectResource,
  onOpenObject,
}: {
  room: ContextRoomRecord;
  backendDocuments: RoomDocument[];
  knowledgeFiles: KnowledgeFileDto[];
  onSelectResource: (resource: ContextRoomResource) => void;
  onOpenObject: (target: WorkspaceObjectPreview) => void;
}) {
  const { locale, t } = useLocale();
  const { rawEntries, projectedEntries, library, today } = useRoomActivityEntries({
    room,
    backendDocuments,
    knowledgeFiles,
    locale,
    t,
  });
  const interactions = useActivityEntryInteractions({
    libraryResources: library.resources,
    onSelectResource,
    onOpenObject,
  });

  const entries = [...projectedEntries, ...rawEntries]
    .sort((left, right) => {
      const leftDate = parseTimelineDate(left.time ?? '', today);
      const rightDate = parseTimelineDate(right.time ?? '', today);
      if (leftDate && rightDate) return rightDate.getTime() - leftDate.getTime();
      if (leftDate) return -1;
      if (rightDate) return 1;
      return 0;
    });

  return (
    <section className="context-room-activity-feed" data-testid="context-room-pane-activity">
      {entries.length ? <div className="context-room-activity-feed-list">{entries.map((entry) => {
        const Icon = CATEGORY_ICONS[entry.category];
        return (
          <article className="context-room-activity-feed-item" data-kind={entry.kind} data-category={entry.category} key={entry.id}>
            <span className="context-room-activity-feed-ico"><Icon aria-hidden="true" /></span>
            <div className="context-room-activity-feed-main">
              <div className="context-room-activity-entry-row">
                <button
                  type="button"
                  className="context-room-activity-entry-title"
                  title={entry.title}
                  onClick={() => interactions.entryClick(entry)}
                >
                  <b>{localizedUiText(entry.title, t)}</b>
                </button>
                <time>{entry.time ? formatTimelineTime(entry.time, locale) : entry.timeRaw ?? ''}</time>
                {entry.document && entry.document.version > 0
                  ? <span className="context-room-activity-version">V{String(entry.document.version)}</span>
                  : null}
              </div>
              <ActivityEntryBody entry={entry} interactions={interactions} materialsVariant="chips" />
            </div>
          </article>
        );
      })}</div> : (
        <PanelEmptyState
          icon={GitBranch}
          title={t('contextRoom:activityPane.noEventsYet')}
          description={t('contextRoom:activityPane.meetingsMailsTasksAndResourceChanges')}
        />
      )}
    </section>
  );
}
