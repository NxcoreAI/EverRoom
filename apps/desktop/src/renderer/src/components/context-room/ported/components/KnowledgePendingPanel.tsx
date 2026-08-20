import { ChevronDown, Inbox, Link2, MessageCircle, RefreshCw, Sparkles, Undo2, Upload } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { showToast } from '@/state/toast';
import { useLocale } from '../../../../i18n/LocaleContext';
import {
  KNOWLEDGE_ENTITY_KINDS,
  type KnowledgeDecisionDto,
  type KnowledgeEntityDto,
  type KnowledgeUnmatchedItemDto,
} from '../../../../../../shared/knowledge';
import { localizedUiText } from '../adapters';
import { waitForKnowledgeEntityPromotion } from '../knowledgePromotion';

const SOURCE_KIND_LABELS: Record<string, string> = {
  'everroom-doc': 'contextRoom:wiki.roomDocument',
  'reality-event': 'contextRoom:wiki.meetingTranscript',
  mail: 'contextRoom:display.email',
  file: 'contextRoom:display.file',
  'cloud-doc': 'contextRoom:wiki.cloudDocument',
};

const NEW_ENTITY = '__new__';

function sourceKindLabel(kind: string): string {
  return SOURCE_KIND_LABELS[kind] ?? kind;
}

/** 推荐池展示上限：页面只放前三个，按证据分排（推荐确认制）。 */
const RECOMMEND_LIMIT = 3;

/**
 * 推荐 Room 面板（entity-room-plan 推荐确认制）：达阈值实体进 ready
 * 推荐池，用户确认后才创建 Room；未识别栏/最近归类保持人工治理入口。
 */
export function KnowledgePendingPanel({ onFocusAgent }: { onFocusAgent: () => void }) {
  const { t } = useLocale();
  const [recommended, setRecommended] = useState<KnowledgeEntityDto[]>([]);
  const [attachPool, setAttachPool] = useState<KnowledgeEntityDto[]>([]);
  const [unmatched, setUnmatched] = useState<KnowledgeUnmatchedItemDto[]>([]);
  const [recent, setRecent] = useState<KnowledgeDecisionDto[]>([]);
  const [attachSelection, setAttachSelection] = useState<Record<string, string>>({});
  const [attachDrafts, setAttachDrafts] = useState<Record<string, { name: string; kind: string }>>({});
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [uploading, setUploading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const promotionControllers = useRef(new Map<string, AbortController>());

  const refresh = useCallback(async () => {
    const knowledge = window.nxcore?.knowledge;
    if (!knowledge) return;
    try {
      // ready = 推荐池；weak+room 仅供未识别栏挂载下拉（该区块不动）
      const [ready, weak, rooms, unmatchedData, recentData] = await Promise.all([
        knowledge.listEntities('ready'),
        knowledge.listEntities('weak'),
        knowledge.listEntities('room'),
        knowledge.listUnmatched(),
        knowledge.listRecentDecisions(10),
      ]);
      setRecommended(
        [...ready.items].sort((a, b) => b.evidenceScore - a.evidenceScore).slice(0, RECOMMEND_LIMIT),
      );
      setAttachPool([...weak.items, ...rooms.items]);
      setUnmatched(unmatchedData.items);
      setRecent(recentData.items);
      setLoaded(true);
    } catch {
      setLoaded(true); // 知识服务不可用：面板静默为空
    }
  }, []);

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => void refresh(), 5_000);
    const onChanged = () => void refresh();
    window.addEventListener('everroom:knowledge-changed', onChanged);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('everroom:knowledge-changed', onChanged);
    };
  }, [refresh]);

  useEffect(() => () => {
    for (const controller of promotionControllers.current.values()) controller.abort();
    promotionControllers.current.clear();
  }, []);

  const runBusy = async (key: string, action: () => Promise<void>) => {
    setBusy((current) => new Set(current).add(key));
    try {
      await action();
      window.dispatchEvent(new CustomEvent('everroom:knowledge-changed'));
      void refresh();
    } catch {
      // Each action reports its own user-facing error; do not leak a rejected click promise.
    } finally {
      setBusy((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }
  };

  const confirmCreate = (entity: KnowledgeEntityDto) =>
    runBusy(`entity:${entity.id}:promote`, async () => {
      try {
        const knowledge = window.nxcore?.knowledge;
        if (!knowledge) return;
        await knowledge.promoteEntity(entity.id);
        showToast({ title: t('contextRoom:knowledgePending.creatingRoom'), message: t('contextRoom:knowledgePending.buildingTheRoomAndWikiForName', { name: entity.name }) });
        const controller = new AbortController();
        promotionControllers.current.get(entity.id)?.abort();
        promotionControllers.current.set(entity.id, controller);
        let promoted: Awaited<ReturnType<typeof waitForKnowledgeEntityPromotion>>;
        try {
          promoted = await waitForKnowledgeEntityPromotion(knowledge, entity.id, {
            signal: controller.signal,
          });
        } finally {
          if (promotionControllers.current.get(entity.id) === controller) {
            promotionControllers.current.delete(entity.id);
          }
        }
        if (promoted) {
          showToast({ title: t('contextRoom:knowledgePending.roomCreated'), message: t('contextRoom:knowledgePending.nameWasAddedToContextRoom', { name: promoted.room?.title ?? entity.name }) });
        } else if (!controller.signal.aborted) {
          showToast({ title: t('contextRoom:knowledgePending.stillCreatingInTheBackground'), message: t('contextRoom:knowledgePending.itWillSyncToContextRoomAutomaticallyWhen') });
        }
      } catch (cause) {
        showToast({ title: t('contextRoom:knowledgePending.creationFailed'), message: cause instanceof Error ? cause.message : undefined });
        throw cause;
      }
    });

  const attach = (item: KnowledgeUnmatchedItemDto) =>
    runBusy(`attach:${item.decisionId}`, async () => {
      const knowledge = window.nxcore?.knowledge;
      if (!knowledge) return;
      const selection = attachSelection[item.decisionId] ?? '';
      const draft = attachDrafts[item.decisionId];
      try {
        if (selection === NEW_ENTITY) {
          if (!draft?.name?.trim()) {
            showToast({ title: t('contextRoom:knowledgePending.enterEntityName') });
            return;
          }
          await knowledge.attachDoc(item.sourceKind, item.sourceId, {
            createEntity: { name: draft.name.trim(), kind: draft.kind },
          });
          showToast({ title: t('contextRoom:knowledgePending.attached'), message: t('contextRoom:knowledgePending.manualEvidenceAddedForName', { name: draft.name.trim() }) });
        } else if (selection) {
          await knowledge.attachDoc(item.sourceKind, item.sourceId, { entityId: selection });
          showToast({ title: t('contextRoom:knowledgePending.attached'), message: t('contextRoom:knowledgePending.resourceAddedAsManualEvidence') });
        }
      } catch (cause) {
        showToast({ title: t('contextRoom:knowledgePending.attachmentFailed'), message: cause instanceof Error ? cause.message : undefined });
        throw cause;
      }
    });

  const revert = (item: KnowledgeDecisionDto) =>
    runBusy(`decision:${item.decisionId}:revert`, async () => {
      try {
        await window.nxcore?.knowledge?.revertDecision(item.decisionId);
        showToast({ title: t('contextRoom:knowledgePending.undone'), message: t('contextRoom:knowledgePending.resourceRemovedAndBeingReclassified') });
      } catch (cause) {
        showToast({ title: t('contextRoom:knowledgePending.undoFailed'), message: cause instanceof Error ? cause.message : undefined });
        throw cause;
      }
    });

  const uploadFiles = async () => {
    const filesApi = window.nxcore?.files;
    if (!filesApi) return;
    setUploading(true);
    try {
      const results = await filesApi.pickAndImport();
      if (results.length === 0) return;
      const failed = results.filter((result) => result.error);
      const deduped = results.filter((result) => result.deduped).length;
      const succeeded = results.length - failed.length - deduped;
      if (succeeded > 0) {
        showToast({ title: t('contextRoom:knowledgePending.countFilesSubmitted', { count: succeeded }), message: t('contextRoom:knowledgePending.extractingEntitiesAndCollectingEvidenceARecommendationWill') });
      }
      for (const failure of failed) {
        showToast({ title: t('contextRoom:knowledgePending.failedToUploadFilename', { filename: failure.filename }), message: failure.error ?? undefined });
      }
      window.dispatchEvent(new CustomEvent('everroom:knowledge-changed'));
    } catch (cause) {
      showToast({ title: t('contextRoom:knowledgePending.uploadFailed'), message: cause instanceof Error ? cause.message : undefined });
    } finally {
      setUploading(false);
    }
  };

  if (!loaded) return null;

  return (
    <section className="context-room-knowledge-panel" data-testid="context-room-knowledge-pending">
      <div className="context-room-my-title">
        <div className="context-room-home-section-title">
          <span>{t('contextRoom:knowledgePending.knowledge')}</span>
          <h2>{t('contextRoom:knowledgePending.recommendedRooms')}</h2>
        </div>
        <div className="context-room-my-actions" aria-label={t('contextRoom:knowledgePending.recommendedRoomActions')}>
          <button
            type="button"
            aria-label={t('contextRoom:knowledgePending.uploadFilesForAutomaticClassification')}
            title={t('contextRoom:knowledgePending.uploadMarkdownFilesToExtractEntitiesAndCollect')}
            className="context-room-add-room"
            disabled={uploading}
            onClick={() => void uploadFiles()}
          >
            <Upload aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label={t('contextRoom:knowledgePending.refreshRecommendationStatus')}
            title={t('contextRoom:knowledgePending.refresh')}
            className="context-room-add-room"
            onClick={() => void refresh()}
          >
            <RefreshCw aria-hidden="true" />
          </button>
        </div>
      </div>

      {recommended.length === 0 ? (
        <div className="context-room-knowledge-empty">
          <Inbox aria-hidden="true" />
          <h3>{t('contextRoom:knowledgePending.understandingResources')}</h3>
          <p>{t('contextRoom:knowledgePending.tellAgentWhatRoomToCreate')}</p>
          <button type="button" className="context-room-knowledge-empty-cta" onClick={onFocusAgent}>
            <span className="context-room-knowledge-empty-cta-icon">
              <MessageCircle aria-hidden="true" />
            </span>
            <span>{t('contextRoom:knowledgePending.talkToAgent')}</span>
          </button>
        </div>
      ) : (
        <div className="context-room-knowledge-list">
          <h3 className="context-room-knowledge-group">{t('contextRoom:knowledgePending.recommendedTop3ByEvidenceScore')}</h3>
          {recommended.map((entity) => {
            const scoreRatio = Math.min(1, entity.evidenceScore / entity.promoteScore);
            return (
              <article key={entity.id} className="context-room-knowledge-card" data-state="recommended">
                <header>
                  <strong>{entity.name}</strong>
                  <span className="context-room-knowledge-tag">{localizedUiText(entity.kind, t)}</span>
                </header>
                <div className="context-room-knowledge-progress" role="progressbar" aria-label={t('contextRoom:knowledgePending.evidenceProgress')}>
                  <div className="context-room-knowledge-progress-bar">
                    <div className="context-room-knowledge-progress-fill" style={{ width: `${Math.round(scoreRatio * 100)}%` }} />
                  </div>
                  <span>
                    {t('contextRoom:knowledgePending.evidenceScoreCountResourcesRecommendationThresholdReached', { score: entity.evidenceScore.toFixed(1), count: entity.sourceCount })}
                  </span>
                </div>
                {entity.firstEvidence ? (
                  <p className="context-room-knowledge-summary">{entity.firstEvidence}</p>
                ) : null}
                <footer>
                  <button
                    type="button"
                    className="context-room-knowledge-confirm"
                    disabled={busy.has(`entity:${entity.id}:promote`)}
                    onClick={() => void confirmCreate(entity)}
                  >
                    <Sparkles aria-hidden="true" />
                    {t('contextRoom:knowledgePending.create')}
                  </button>
                </footer>
              </article>
            );
          })}
        </div>
      )}

      {unmatched.length > 0 ? (
        <div className="context-room-knowledge-list">
          <h3 className="context-room-knowledge-group">{t('contextRoom:knowledgePending.unrecognizedResourcesWaitingForAttachment')}</h3>
          {unmatched.map((item) => {
            const selection = attachSelection[item.decisionId] ?? '';
            const draft = attachDrafts[item.decisionId];
            return (
              <article key={item.decisionId} className="context-room-knowledge-card" data-state="unmatched">
                <header>
                  <strong>{item.title}</strong>
                  <span className="context-room-knowledge-tag">{t(sourceKindLabel(item.sourceKind))}</span>
                </header>
                {item.reason ? <p className="context-room-knowledge-reason">{item.reason}</p> : null}
                {item.summary ? <p className="context-room-knowledge-summary">{item.summary}</p> : null}
                <div className="context-room-knowledge-attach">
                  <Link2 aria-hidden="true" />
                  <select
                    className="context-room-knowledge-select"
                    value={selection}
                    onChange={(event) => setAttachSelection((current) => ({
                      ...current,
                      [item.decisionId]: event.target.value,
                    }))}
                  >
                    <option value="">{t('contextRoom:knowledgePending.attachToEntity')}</option>
                    {attachPool.map((entity) => (
                      <option key={entity.id} value={entity.id}>
                        {t('contextRoom:knowledgePending.entityWithStatus', { name: entity.name, status: t(entity.status === 'room' ? 'contextRoom:knowledgePending.promoted' : 'contextRoom:knowledgePending.incubating') })}
                      </option>
                    ))}
                    <option value={NEW_ENTITY}>{t('contextRoom:knowledgePending.newEntity')}</option>
                  </select>
                  <button
                    type="button"
                    className="context-room-knowledge-confirm"
                    disabled={!selection || busy.has(`attach:${item.decisionId}`)}
                    onClick={() => void attach(item)}
                  >
                    {t('contextRoom:knowledgePending.attach')}
                  </button>
                </div>
                {selection === NEW_ENTITY ? (
                  <div className="context-room-knowledge-newentity">
                    <input
                      type="text"
                      placeholder={t('contextRoom:knowledgePending.entityName')}
                      value={draft?.name ?? ''}
                      onChange={(event) => setAttachDrafts((current) => ({
                        ...current,
                        [item.decisionId]: {
                          name: event.target.value,
                          kind: current[item.decisionId]?.kind ?? KNOWLEDGE_ENTITY_KINDS[4],
                        },
                      }))}
                    />
                    <select
                      className="context-room-knowledge-select"
                      value={draft?.kind ?? KNOWLEDGE_ENTITY_KINDS[4]}
                      onChange={(event) => setAttachDrafts((current) => ({
                        ...current,
                        [item.decisionId]: { name: current[item.decisionId]?.name ?? '', kind: event.target.value },
                      }))}
                    >
                      {KNOWLEDGE_ENTITY_KINDS.map((kind) => (
                        <option key={kind} value={kind}>{kind}</option>
                      ))}
                    </select>
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      ) : null}

      {recent.length > 0 ? (
        <details className="context-room-knowledge-history">
          <summary>
            <span>{t('contextRoom:knowledgePending.history')}</span>
            <small>{recent.length}</small>
            <ChevronDown aria-hidden="true" />
          </summary>
          <div className="context-room-knowledge-history-content">
            <div className="context-room-knowledge-recent">
              {recent.map((item) => (
                <div key={item.decisionId} className="context-room-knowledge-recent-row">
                  <span className="context-room-knowledge-recent-title">{item.title}</span>
                  <span className="context-room-knowledge-recent-room">→ {item.roomTitle ?? item.roomId ?? t('contextRoom:knowledgePending.unclassified')}</span>
                  <button
                    type="button"
                    className="context-room-knowledge-revert"
                    disabled={busy.has(`decision:${item.decisionId}:revert`)}
                    title={item.reason ?? undefined}
                    onClick={() => void revert(item)}
                  >
                    <Undo2 aria-hidden="true" />
                    {t('contextRoom:knowledgePending.undo')}
                  </button>
                </div>
              ))}
            </div>
          </div>
        </details>
      ) : null}
    </section>
  );
}
