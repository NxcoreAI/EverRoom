import type { RoomDocument, RoomOverviewEvidence } from '@nxcore/agent-contract';
import { useMemo } from 'react';
import type { Translate } from '../../../../i18n/LocaleContext';

import type { KnowledgeFileDto } from '../../../../../../shared/knowledge';
import { createContextRoomResourceLibrary } from '../resources';
import { localizedUiText } from '../adapters';
import { useRoomMails } from './useRoomMails';
import { useRoomOverviewProjection } from './useRoomOverviewProjection';
import type { ContextRoomRecord, ContextRoomResource } from '../types';
import { parseTimelineDate } from '../roomTimeline';

/** 动态条目的对象类别（筛选 chips 与图标用）。 */
export type ActivityCategory = 'meeting' | 'mail' | 'task' | 'material' | 'other';

/** 动态时间轴的统一条目形状：投影 claim 与本地/连接器真实对象共用同一渲染路径。 */
export type ActivityEntry = {
  id: string;
  /** null = 无日期事件（解析不到发生时间），排序沉底、不参与日期范围过滤。 */
  time: string | null;
  /** 无日期条目的原始展示时间（本地快照的「昨天 16:40」等），动态流直接展示。 */
  timeRaw?: string;
  title: string;
  description: string;
  category: ActivityCategory;
  kind: 'done' | 'warn' | 'info';
  evidence: RoomOverviewEvidence[];
  /** 人物筛选项：与会人 / 发件人等。 */
  people: string[];
  /** 文档版本条目：提供变更摘要与版本 diff 入口。 */
  document?: { documentId: string; version: number };
};

export function activityCategoryFromEventType(eventType: string | null | undefined): ActivityCategory {
  if (eventType === 'meeting') return 'meeting';
  if (eventType === 'task') return 'task';
  if (eventType === 'source') return 'material';
  return 'other';
}

export function localDateKey(value: Date): string {
  return `${String(value.getFullYear())}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
}

export function parseDateOrNull(value: string | null): Date | null {
  if (!value || !/^\d{4}-\d{1,2}-\d{1,2}/.test(value.trim())) return null;
  // 本地快照的宽松解析（"昨天"/"07-21"）会回退到今天：只信完整 ISO/日期串。
  const parsed = parseTimelineDate(value, new Date());
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed : null;
}

/** 证据去重（同来源多版本只展示一次）并按展示预算截断。 */
export function timelineMaterials(evidence: RoomOverviewEvidence[]): RoomOverviewEvidence[] {
  const unique: RoomOverviewEvidence[] = [];
  for (const source of evidence) {
    if (unique.some((candidate) =>
      candidate.sourceKind === source.sourceKind && candidate.sourceId === source.sourceId)) continue;
    unique.push(source);
  }
  return unique.slice(0, 4);
}

/** 证据 → 可跳转资源：云文档/上传文件有对应资源；连接器来源仅作标签展示。 */
export function timelineResource(source: RoomOverviewEvidence, resources: ContextRoomResource[]): ContextRoomResource | null {
  if (source.sourceKind === 'everroom-doc') {
    return resources.find((item) => item.kind === 'cloud-doc' && item.binding.docId === source.sourceId) ?? null;
  }
  if (source.sourceKind === 'file') {
    return resources.find((item) => item.kind === 'knowledge-file' && item.fileId === source.sourceId) ?? null;
  }
  return null;
}

/**
 * Room 动态条目池：概览底部的时间轴卡与「动态」信息流共用。
 * 汇聚概览投影事件、文档版本、上传文件、连接器/本地邮件与会议，
 * 同对象同日的收录类 claim 与真实条目去重（保留带动作的真实条目）。
 */
export function useRoomActivityEntries({
  room,
  backendDocuments,
  knowledgeFiles,
  locale,
  t,
}: {
  room: ContextRoomRecord;
  backendDocuments: RoomDocument[];
  knowledgeFiles: KnowledgeFileDto[];
  locale: string;
  t: Translate;
}) {
  const today = new Date();
  const overviewProjection = useRoomOverviewProjection(room.id);
  const { mails: connectorMails } = useRoomMails(room.id);
  const library = useMemo(
    () => createContextRoomResourceLibrary(room, backendDocuments, [], knowledgeFiles, locale),
    [backendDocuments, knowledgeFiles, locale, room],
  );

  // 本地会议快照与投影日历事件同名同日视为同一事件，保留投影版本（时间与证据更准）。
  const connectorMeetingKeys = useMemo(() => new Set((overviewProjection?.timeline ?? []).flatMap((claim) => {
    if (activityCategoryFromEventType(claim.data?.kind === 'timeline' ? claim.data.eventType : null) !== 'meeting') return [];
    const when = parseDateOrNull(claim.occurredAt ?? null);
    const title = (claim.data?.kind === 'timeline' ? claim.data.title : '') || claim.text;
    return when ? [`${title.trim().toLocaleLowerCase()}\x00${localDateKey(when)}`] : [];
  })), [overviewProjection]);

  // 本地快照邮件按「主题 + 同日」与连接器邮件去重，保留连接器版本（真实发件人/时间）。
  const connectorMailKeys = useMemo(() => new Set(connectorMails.flatMap((mail) => {
    const when = parseDateOrNull(mail.sentAt);
    return when ? [`${mail.subject.trim().toLocaleLowerCase()}\x00${localDateKey(when)}`] : [];
  })), [connectorMails]);

  // 真实对象条目（文档版本/资料收录/邮件/会议）：携带可执行动作。
  const rawEntries = useMemo<ActivityEntry[]>(() => {
    const docEntries: ActivityEntry[] = backendDocuments
      .filter((document) => !document.deletedAt)
      .map((document) => ({
        id: `doc:${document.id}`,
        time: document.updatedAt,
        title: document.title,
        description: '',
        category: 'material' as const,
        kind: 'done' as const,
        evidence: [],
        people: [],
        document: { documentId: document.id, version: document.version },
      }));
    const fileEntries: ActivityEntry[] = knowledgeFiles.map((file) => ({
      id: `file:${file.id}`,
      time: file.uploadedAt,
      title: file.originalName,
      description: t('contextRoom:activityPane.fileIngested'),
      category: 'material' as const,
      kind: 'done' as const,
      evidence: [],
      people: [],
    }));
    const connectorMailEntries: ActivityEntry[] = connectorMails.map((mail) => ({
      id: `mail:${mail.sourceId}`,
      time: mail.sentAt,
      title: mail.subject,
      description: mail.snippet ?? '',
      category: 'mail' as const,
      kind: 'done' as const,
      evidence: [],
      people: mail.senderName ? [mail.senderName] : [],
    }));
    const localMailEntries: ActivityEntry[] = room.materials
      .filter((material) => material.type === '邮件')
      .filter((mail) => !connectorMailKeys.has(`${mail.title.trim().toLocaleLowerCase()}\x00${localDateKey(parseTimelineDate(mail.time, today) ?? today)}`))
      .map((mail) => ({
        id: `lmail:${mail.id}`,
        time: null,
        timeRaw: mail.time,
        title: mail.title,
        description: localizedUiText(mail.summary, t),
        category: 'mail' as const,
        kind: 'done' as const,
        evidence: [],
        people: mail.sender ? [mail.sender] : [],
      }));
    const meetingEntries: ActivityEntry[] = room.materials
      .filter((material) => material.type === '会议')
      .filter((meeting) => !connectorMeetingKeys.has(`${meeting.title.trim().toLocaleLowerCase()}\x00${localDateKey(parseTimelineDate(meeting.time, today) ?? today)}`))
      .map((meeting) => ({
        id: `meeting:${meeting.id}`,
        time: null,
        timeRaw: meeting.time,
        title: meeting.title,
        description: localizedUiText(meeting.summary, t),
        category: 'meeting' as const,
        kind: 'done' as const,
        evidence: [],
        people: meeting.attendees ?? [],
      }));
    return [...docEntries, ...fileEntries, ...connectorMailEntries, ...localMailEntries, ...meetingEntries];
  }, [backendDocuments, connectorMailKeys, connectorMeetingKeys, connectorMails, knowledgeFiles, room.materials, t, today]);

  // 投影条目与真实对象条目按证据/标题去重：同对象同日的收录类 claim 让位给带动作的真实条目。
  const rawEvidenceKeys = useMemo(() => {
    const docDays = new Map<string, Set<string>>();
    for (const entry of rawEntries) {
      if (!entry.document && !entry.id.startsWith('file:')) continue;
      const when = parseDateOrNull(entry.time);
      if (!when) continue;
      const objectKey = entry.document ? `everroom-doc\x00${entry.document.documentId}` : `file\x00${entry.id.slice('file:'.length)}`;
      const day = localDateKey(when);
      docDays.set(objectKey, (docDays.get(objectKey) ?? new Set()).add(day));
    }
    return docDays;
  }, [rawEntries]);

  const projectedEntries = useMemo<ActivityEntry[]>(() => {
    const claims = overviewProjection?.timeline ?? [];
    return claims.flatMap((claim) => {
      const data = claim.data?.kind === 'timeline' ? claim.data : null;
      const category = activityCategoryFromEventType(data?.eventType);
      // 同对象同日的收录/更新 claim 已由真实条目承载，跳过避免重复。
      if (data?.eventType === 'source' || data?.eventType === 'update') {
        const duplicated = claim.evidence.some((source) => {
          const objectKey = source.sourceKind === 'everroom-doc' || source.sourceKind === 'file'
            ? `${source.sourceKind}\x00${source.sourceId}`
            : null;
          const when = parseDateOrNull(claim.occurredAt ?? null);
          return Boolean(objectKey && when && rawEvidenceKeys.get(objectKey)?.has(localDateKey(when)));
        });
        if (duplicated) return [];
      }
      return [{
        id: claim.id,
        time: claim.occurredAt ?? null,
        title: data?.title || claim.text,
        description: data?.description
          || (data?.certainty === 'inference' ? t('contextRoom:overviewDashboard.inferredTimelineEntry') : ''),
        category,
        kind: claim.origin === 'inference' ? 'info' as const : 'done' as const,
        evidence: claim.evidence,
        people: [],
      }];
    });
  }, [overviewProjection, rawEvidenceKeys, t]);

  const peoplePool = useMemo(() => {
    const people = new Set<string>();
    for (const entry of [...rawEntries, ...projectedEntries]) {
      for (const person of entry.people) {
        const name = person.trim();
        if (name) people.add(name);
      }
    }
    return [...people].sort((left, right) => left.localeCompare(right, locale));
  }, [locale, projectedEntries, rawEntries]);

  return { rawEntries, projectedEntries, peoplePool, library, today };
}
