import { CheckSquare2, FileText, GitBranch, History, Mail, Mic } from 'lucide-react';
import { useCallback, useState } from 'react';
import { useLocale } from '../../../../../i18n/LocaleContext';
import type { RoomOverviewEvidence } from '@nxcore/agent-contract';

import {
  timelineMaterials,
  timelineResource,
  type ActivityCategory,
  type ActivityEntry,
} from '../../hooks/useRoomActivityEntries';
import { localizedUiText } from '../../adapters';
import type { ContextRoomResource } from '../../types';
import { requestDocumentHistory } from '../detail-editor/documentHistoryOpenSignal';
import type { WorkspaceObjectPreview } from './index';

export const CATEGORY_ICONS: Record<ActivityCategory, typeof Mic> = {
  meeting: Mic,
  mail: Mail,
  task: CheckSquare2,
  material: FileText,
  other: GitBranch,
};

type ChangeSummaryState = { loading: boolean; text: string | null; error: boolean };

/** 动态条目的打开动作与文档版本摘要加载：概览时间轴卡与动态信息流共用。 */
export function useActivityEntryInteractions({
  libraryResources,
  onSelectResource,
  onOpenObject,
}: {
  libraryResources: ContextRoomResource[];
  onSelectResource: (resource: ContextRoomResource) => void;
  onOpenObject: (target: WorkspaceObjectPreview) => void;
}) {
  const [changeSummaries, setChangeSummaries] = useState<Record<string, ChangeSummaryState>>({});

  const openDocResource = useCallback((documentId: string) => {
    const resource = libraryResources.find((item) => item.kind === 'cloud-doc' && item.binding.docId === documentId);
    if (resource) onSelectResource(resource);
  }, [libraryResources, onSelectResource]);

  const openFileResource = useCallback((entryId: string) => {
    const fileId = entryId.slice('file:'.length);
    const resource = libraryResources.find((item) => item.kind === 'knowledge-file' && item.fileId === fileId);
    if (resource) onSelectResource(resource);
  }, [libraryResources, onSelectResource]);

  const loadChangeSummary = useCallback((documentId: string, version: number) => {
    const key = `${documentId}:${String(version)}`;
    setChangeSummaries((current) => ({
      ...current,
      [key]: current[key] ?? { loading: true, text: null, error: false },
    }));
    const documents = window.nxcore?.documents;
    if (!documents?.versionChangeSummary) {
      setChangeSummaries((current) => ({ ...current, [key]: { loading: false, text: null, error: true } }));
      return;
    }
    documents.versionChangeSummary(documentId, version)
      .then((result) => {
        setChangeSummaries((current) => ({ ...current, [key]: { loading: false, text: result.summary, error: false } }));
      })
      .catch(() => {
        setChangeSummaries((current) => ({ ...current, [key]: { loading: false, text: null, error: true } }));
      });
  }, []);

  const entryClick = useCallback((entry: ActivityEntry) => {
    if (entry.document) {
      openDocResource(entry.document.documentId);
      return;
    }
    if (entry.id.startsWith('file:')) {
      openFileResource(entry.id);
      return;
    }
    if (entry.id.startsWith('mail:')) {
      onOpenObject({ kind: 'connector-mail', sourceId: entry.id.slice('mail:'.length) });
      return;
    }
    if (entry.id.startsWith('lmail:')) {
      onOpenObject({ kind: 'mail', id: entry.id.slice('lmail:'.length) });
      return;
    }
    if (entry.id.startsWith('meeting:')) {
      onOpenObject({ kind: 'meeting', id: entry.id.slice('meeting:'.length) });
    }
  }, [onOpenObject, openDocResource, openFileResource]);

  return { changeSummaries, loadChangeSummary, entryClick, openDocResource, libraryResources, onSelectResource };
}

/** 相关资料 chip：可跳转资源渲染为按钮，连接器来源仅作标签。 */
function MaterialChip({
  source,
  interactions,
}: {
  source: RoomOverviewEvidence;
  interactions: ReturnType<typeof useActivityEntryInteractions>;
}) {
  const { t } = useLocale();
  const resource = timelineResource(source, interactions.libraryResources);
  const label = resource ? resource.name : source.sourceTitle || t(`contextRoom:memory.sourceKind.${source.sourceKind}`);
  return resource ? (
    <button type="button" className="context-room-timeline-material" onClick={() => interactions.onSelectResource(resource)}>
      <FileText aria-hidden="true" />
      {label}
    </button>
  ) : (
    <span className="context-room-timeline-material is-plain">
      <FileText aria-hidden="true" />
      {label}
    </span>
  );
}

/** 单条动态的正文（描述 + 文档版本动作 + 相关资料）：时间轴卡（折叠）与信息流（chips 平铺）共用。 */
export function ActivityEntryBody({
  entry,
  interactions,
  materialsVariant,
  expanded = false,
  onToggle,
}: {
  entry: ActivityEntry;
  interactions: ReturnType<typeof useActivityEntryInteractions>;
  /** collapse = 时间轴卡的「相关资料」折叠开关；chips = 信息流平铺资料 chips。 */
  materialsVariant: 'collapse' | 'chips';
  expanded?: boolean;
  onToggle?: (key: string) => void;
}) {
  const { t } = useLocale();
  const materials = timelineMaterials(entry.evidence);
  const summaryKey = entry.document ? `${entry.document.documentId}:${String(entry.document.version)}` : null;
  const summary = summaryKey ? interactions.changeSummaries[summaryKey] : undefined;
  return <>
    {entry.description ? <p>{localizedUiText(entry.description, t)}</p> : null}
    {entry.document ? (
      <div className="context-room-activity-doc-actions">
        <button
          type="button"
          aria-expanded={Boolean(summary)}
          onClick={() => summaryKey && interactions.loadChangeSummary(entry.document!.documentId, entry.document!.version)}
        >
          {t(summary?.loading
            ? 'contextRoom:activityPane.loadingChangeSummary'
            : summary?.error
              ? 'contextRoom:activityPane.changeSummaryRetry'
              : 'contextRoom:activityPane.viewChangeSummary')}
        </button>
        {summary && !summary.loading && !summary.error && summary.text
          ? <p className="context-room-activity-summary">{summary.text}</p>
          : null}
        {summary?.error ? <p className="context-room-activity-summary is-error">{t('contextRoom:activityPane.changeSummaryUnavailable')}</p> : null}
        <button
          type="button"
          onClick={() => {
            interactions.openDocResource(entry.document!.documentId);
            requestDocumentHistory(entry.document!.documentId);
          }}
        >
          <History aria-hidden="true" />
          {t('contextRoom:activityPane.viewVersions')}
        </button>
      </div>
    ) : null}
    {materials.length ? (
      materialsVariant === 'chips' ? (
        <div className="context-room-timeline-materials is-chips">
          {materials.map((source) => (
            <MaterialChip key={`${source.sourceKind}:${source.sourceId}`} source={source} interactions={interactions} />
          ))}
        </div>
      ) : (
        <>
          <button type="button" className="context-room-activity-materials-toggle" aria-expanded={expanded} onClick={() => onToggle?.(entry.id)}>
            {t('contextRoom:overviewDashboard.relatedResources')} <span>{materials.length}</span>
          </button>
          {expanded ? (
            <div className="context-room-timeline-materials">
              {materials.map((source) => (
                <MaterialChip key={`${source.sourceKind}:${source.sourceId}`} source={source} interactions={interactions} />
              ))}
            </div>
          ) : null}
        </>
      )
    ) : null}
  </>;
}
