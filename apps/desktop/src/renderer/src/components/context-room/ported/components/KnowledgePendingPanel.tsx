import {
  AlertCircle,
  ChevronDown,
  Clock3,
  Inbox,
  LoaderCircle,
  MessageCircle,
  RefreshCw,
  Sparkles,
  Undo2,
  Upload,
  EyeOff,
  RotateCcw,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { showToast } from '@/state/toast';
import { useLocale } from '../../../../i18n/LocaleContext';
import type { Translate } from '../../../../i18n/LocaleContext';
import {
  type KnowledgeDecisionDto,
  type KnowledgeEntityDto,
  type KnowledgePromotionProgressDto,
} from '../../../../../../shared/knowledge';
import { localizedUiText } from '../adapters';
import { waitForKnowledgeEntityPromotion } from '../knowledgePromotion';

function promotionPercent(progress: KnowledgePromotionProgressDto): number {
  if (progress.status === 'completed') return 100;
  if (progress.status === 'failed') return 100;
  if (progress.stage === 'queued') return 5;
  if (progress.stage === 'checking_identity') return 15;
  if (progress.stage === 'registering_entity') return 30;
  if (progress.stage === 'creating_room') return 45;
  if (progress.stage === 'creating_wiki') return 60;
  if (progress.stage === 'importing_documents') {
    const materialRatio = progress.total && progress.current !== null
      ? progress.current / progress.total
      : 0;
    return Math.min(95, Math.round(60 + materialRatio * 35));
  }
  return 5;
}

function promotionLabel(progress: KnowledgePromotionProgressDto, t: Translate): string {
  if (progress.status === 'failed') return t('contextRoom:knowledgePending.creationFailed');
  if (progress.status === 'completed') return t('contextRoom:knowledgePending.roomCreated');
  const stageKeys: Record<string, string> = {
    queued: 'contextRoom:knowledgePending.promotionQueued',
    checking_identity: 'contextRoom:knowledgePending.checkingIdentity',
    registering_entity: 'contextRoom:knowledgePending.registeringEntity',
    creating_room: 'contextRoom:knowledgePending.creatingRoom',
    creating_wiki: 'contextRoom:knowledgePending.creatingWiki',
    importing_documents: 'contextRoom:knowledgePending.importingDocuments',
  };
  return t(stageKeys[progress.stage] ?? 'contextRoom:knowledgePending.creatingRoom');
}

/** 推荐池展示上限：页面只放前三个，按证据分排（推荐确认制）。 */
const RECOMMEND_LIMIT = 3;

/**
 * 推荐 Room 面板（entity-room-plan 推荐确认制）：达阈值实体进 ready
 * 推荐池，用户确认后才创建 Room；最近归类保留人工治理入口。
 * 未识别栏已移除——不做人工挂载实体，资料证据自然累积进推荐池。
 */
export function KnowledgePendingPanel({ onFocusAgent }: { onFocusAgent: () => void }) {
  const { t } = useLocale();
  const [recommended, setRecommended] = useState<KnowledgeEntityDto[]>([]);
  const [recent, setRecent] = useState<KnowledgeDecisionDto[]>([]);
  const [suppressed, setSuppressed] = useState<KnowledgeEntityDto[]>([]);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [uploading, setUploading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const activePromotionsRef = useRef(new Map<string, string>());
  const promotionControllers = useRef(new Map<string, AbortController>());

  const refresh = useCallback(async () => {
    const knowledge = window.nxcore?.knowledge;
    if (!knowledge) return;
    try {
      const [ready, promoting, rooms, suppressedData, recentData] = await Promise.all([
        knowledge.listEntities('ready'),
        knowledge.listEntities('promoting'),
        knowledge.listEntities('room'),
        knowledge.listEntities('suppressed'),
        knowledge.listRecentDecisions(10),
      ]);
      const promotionActive = (entity: KnowledgeEntityDto) =>
        entity.promotion?.status === 'queued' || entity.promotion?.status === 'running';
      // Room 行会先于 Wiki/资料导入创建。任务真正 completed 前仍要留在进度区，
      // 否则卡片会在“创建 Room”阶段提前消失并误报完成。
      const activePromotions = [...promoting.items, ...ready.items, ...rooms.items]
        .filter(promotionActive);
      const activeIds = new Set(activePromotions.map((entity) => entity.id));
      const failedFirst = [...ready.items].sort((a, b) => {
        const failureDelta = Number(b.promotion?.status === 'failed') - Number(a.promotion?.status === 'failed');
        return failureDelta || b.evidenceScore - a.evidenceScore;
      });
      setRecommended([
        ...activePromotions,
        ...failedFirst.filter((entity) => !activeIds.has(entity.id)).slice(0, RECOMMEND_LIMIT),
      ]);
      setRecent(recentData.items);
      setSuppressed(suppressedData.items);
      setLoaded(true);
      const previous = activePromotionsRef.current;
      const completed = rooms.items.filter((entity) =>
        previous.has(entity.id) && entity.promotion?.status === 'completed');
      const failed = ready.items.filter((entity) => previous.has(entity.id) && entity.promotion?.status === 'failed');
      activePromotionsRef.current = new Map(activePromotions.map((entity) => [entity.id, entity.name]));
      for (const entity of completed) {
        showToast({ title: t('contextRoom:knowledgePending.roomCreated'), message: t('contextRoom:knowledgePending.nameIsReadyToUse', { name: entity.name }) });
      }
      for (const entity of failed) {
        showToast({ title: t('contextRoom:knowledgePending.creationFailed'), message: entity.promotion?.error ?? undefined });
      }
      if (completed.length > 0) {
        window.setTimeout(() => window.dispatchEvent(new CustomEvent('everroom:knowledge-changed')), 0);
      }
    } catch {
      setLoaded(true); // 知识服务不可用：面板静默为空
    }
  }, [t]);

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

  const hasActivePromotion = recommended.some((entity) =>
    entity.promotion?.status === 'queued' || entity.promotion?.status === 'running');
  useEffect(() => {
    if (!hasActivePromotion) return;
    const timer = window.setInterval(() => void refresh(), 1_000);
    return () => window.clearInterval(timer);
  }, [hasActivePromotion, refresh]);

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

  const deferCreate = (entity: KnowledgeEntityDto) =>
    runBusy(`entity:${entity.id}:suppress`, async () => {
      await window.nxcore?.knowledge?.suppressEntity(entity.id);
      showToast({ title: t('contextRoom:knowledgePending.creationDeferred'), message: t('contextRoom:knowledgePending.topicWillNotBeRecommendedAgain', { name: entity.name }) });
    });

  const restoreCreate = (entity: KnowledgeEntityDto) =>
    runBusy(`entity:${entity.id}:restore`, async () => {
      await window.nxcore?.knowledge?.restoreSuppressedEntity(entity.id);
      showToast({ title: t('contextRoom:knowledgePending.recommendationRestored'), message: entity.name });
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
            const promotion = entity.promotion;
            const promotionActive = promotion?.status === 'queued' || promotion?.status === 'running';
            const creationPercent = promotion ? promotionPercent(promotion) : 0;
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
                {promotion ? (
                  <div className="context-room-creation-progress" data-status={promotion.status} role="status">
                    <div className="context-room-creation-progress-heading">
                      {promotion.status === 'failed'
                        ? <AlertCircle aria-hidden="true" />
                        : promotion.status === 'queued'
                          ? <Clock3 aria-hidden="true" />
                          : <LoaderCircle className="spin" aria-hidden="true" />}
                      <strong>{promotionLabel(promotion, t)}</strong>
                      <span>{creationPercent}%</span>
                    </div>
                    <div className="context-room-creation-progress-bar" aria-hidden="true">
                      <div style={{ width: `${creationPercent}%` }} />
                    </div>
                    {promotion.status === 'queued' && promotion.queuePosition ? (
                      <small>{t('contextRoom:knowledgePending.queuePosition', { position: promotion.queuePosition })}</small>
                    ) : promotion.stage === 'importing_documents' && promotion.total !== null ? (
                      <small>{t('contextRoom:knowledgePending.resourceProgress', { current: promotion.current ?? 0, total: promotion.total })}</small>
                    ) : promotion.error ? <small>{promotion.error}</small> : null}
                  </div>
                ) : null}
                <footer>
                  <button
                    type="button"
                    className="context-room-knowledge-confirm"
                    disabled={busy.has(`entity:${entity.id}:promote`) || promotionActive}
                    onClick={() => void confirmCreate(entity)}
                  >
                    {promotionActive ? <LoaderCircle className="spin" aria-hidden="true" /> : <Sparkles aria-hidden="true" />}
                    {t(promotionActive
                      ? promotion?.status === 'queued' ? 'contextRoom:knowledgePending.queued' : 'contextRoom:knowledgePending.creating'
                      : promotion?.status === 'failed' ? 'contextRoom:knowledgePending.retryCreation' : 'contextRoom:knowledgePending.create')}
                  </button>
                  {!promotionActive ? (
                    <button
                      type="button"
                      className="context-room-knowledge-defer"
                      disabled={busy.has(`entity:${entity.id}:suppress`)}
                      onClick={() => void deferCreate(entity)}
                    >
                      <EyeOff aria-hidden="true" />
                      {t('contextRoom:knowledgePending.deferCreation')}
                    </button>
                  ) : null}
                </footer>
              </article>
            );
          })}
        </div>
      )}

      {suppressed.length > 0 ? (
        <details className="context-room-knowledge-history context-room-knowledge-suppressed">
          <summary><span>{t('contextRoom:knowledgePending.deferredTopics')}</span><small>{suppressed.length}</small><ChevronDown aria-hidden="true" /></summary>
          <div className="context-room-knowledge-history-content">
            {suppressed.map((entity) => (
              <div key={entity.id} className="context-room-knowledge-recent-row">
                <span className="context-room-knowledge-recent-title">{entity.name}</span>
                <button type="button" className="context-room-knowledge-defer" disabled={busy.has(`entity:${entity.id}:restore`)} onClick={() => void restoreCreate(entity)}><RotateCcw aria-hidden="true" />{t('contextRoom:knowledgePending.restoreRecommendation')}</button>
              </div>
            ))}
          </div>
        </details>
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
