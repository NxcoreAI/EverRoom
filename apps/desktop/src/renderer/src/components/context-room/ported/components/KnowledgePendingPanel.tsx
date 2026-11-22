import {
  AlertCircle,
  ArrowRight,
  Check,
  ChevronDown,
  Clock3,
  Inbox,
  Layers3,
  Link2,
  LoaderCircle,
  MessageCircle,
  Plus,
  RefreshCw,
  Sparkles,
  Undo2,
  EyeOff,
  RotateCcw,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import '../../ContextRoomHomeSkeleton.css';

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
import { UnmatchedDocsSection } from './UnmatchedDocsSection';
import { ReferenceDialog } from './shared';
import { scheduleRoomMarkdownImport } from '../../knowledgeMarkdownImport';

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

/** 创建阶段序（与 promotionPercent 刻度一致）：详情弹框时间线与完成闪光共用。 */
const PROMOTION_STAGES: Array<{ stage: KnowledgePromotionProgressDto['stage']; labelKey: string }> = [
  { stage: 'queued', labelKey: 'contextRoom:knowledgePending.promotionQueued' },
  { stage: 'checking_identity', labelKey: 'contextRoom:knowledgePending.checkingIdentity' },
  { stage: 'registering_entity', labelKey: 'contextRoom:knowledgePending.registeringEntity' },
  { stage: 'creating_room', labelKey: 'contextRoom:knowledgePending.creatingRoom' },
  { stage: 'creating_wiki', labelKey: 'contextRoom:knowledgePending.creatingWiki' },
  { stage: 'importing_documents', labelKey: 'contextRoom:knowledgePending.importingDocuments' },
];

/** 完成闪光的合成进度对象：全部阶段打勾。 */
const PROMOTION_COMPLETED_SNAPSHOT: KnowledgePromotionProgressDto = {
  jobId: '',
  status: 'completed',
  stage: 'completed',
  message: '',
  current: null,
  total: null,
  queuePosition: null,
  roomId: null,
  error: null,
  updatedAt: '',
};

/** 六阶段步骤条：完成打勾 / 当前转圈 / 失败显错；导入步带资料计数。 */
function promotionStepsList(promotion: KnowledgePromotionProgressDto, t: Translate) {
  const failed = promotion.status === 'failed';
  const done = promotion.status === 'completed';
  const activeIndex = done
    ? PROMOTION_STAGES.length
    : Math.max(0, PROMOTION_STAGES.findIndex((item) => item.stage === promotion.stage));
  return (
    <ol className="context-room-creation-steps context-room-promo-steps">
      {PROMOTION_STAGES.map((item, index) => {
        const state = failed && index === activeIndex
          ? 'failed'
          : index < activeIndex || done ? 'done' : index === activeIndex ? 'active' : undefined;
        return (
          <li key={item.stage} data-state={state}>
            <span className="context-room-creation-step-icon">
              {state === 'failed'
                ? <AlertCircle aria-hidden="true" />
                : state === 'done'
                  ? <Check aria-hidden="true" />
                  : state === 'active'
                    ? <LoaderCircle className="spin" aria-hidden="true" />
                    : <span aria-hidden="true" />}
            </span>
            <span className="context-room-creation-step-body">
              <b>{t(item.labelKey)}</b>
              {state === 'active' && item.stage === 'importing_documents' && promotion.total !== null ? (
                <small>{t('contextRoom:knowledgePending.resourceProgress', {
                  current: promotion.current ?? 0,
                  total: promotion.total,
                })}</small>
              ) : null}
              {state === 'failed' && promotion.error ? <small>{promotion.error}</small> : null}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** 仅展示证据分最高的三个待创建候选。 */
const RECOMMEND_LIMIT = 3;

/**
 * 会话级快照缓存：页面切换会整页卸载（PageCanvas 按 page 换 key），
 * 重挂载时先用上一拍数据渲染，挂载刷新静默收敛，推荐区不再闪空。
 */
interface KnowledgeSnapshot {
  recommended: KnowledgeEntityDto[];
  recent: KnowledgeDecisionDto[];
  suppressed: KnowledgeEntityDto[];
}
let knowledgeSnapshotCache: KnowledgeSnapshot | null = null;

/**
 * 证据进度条的真值分母：达到该证据分即视为凑满（clamp 到 1）。与网关
 * recommendationPathOf 的双路径阈值对齐（standard 2.4 / strong 2.0）。
 */
const EVIDENCE_READY_SCORE: Record<'standard' | 'strong', number> = { standard: 2.4, strong: 2.0 };


/**
 * 推荐 Room 面板（entity-room-plan 推荐确认制）：达阈值实体进 ready
 * 推荐池，用户确认后才创建 Room；最近归类保留人工治理入口。
 * 未识别栏已移除——不做人工挂载实体，资料证据自然累积进推荐池。
 */
export function KnowledgePendingPanel({
  variant = 'manage',
  onFocusAgent,
  onOpenCreateRoom,
}: {
  /** manage = 完整管理面板（默认，测试与管理弹框共用）；strip = 首页精简推荐区。 */
  variant?: 'manage' | 'strip';
  onFocusAgent: () => void;
  /** 新建 Room 统一入口（手动创建 / 智能推荐双页签）。 */
  onOpenCreateRoom: () => void;
}) {
  const { t } = useLocale();
  const [recommended, setRecommended] = useState<KnowledgeEntityDto[]>(
    () => knowledgeSnapshotCache?.recommended ?? [],
  );
  const [recent, setRecent] = useState<KnowledgeDecisionDto[]>(
    () => knowledgeSnapshotCache?.recent ?? [],
  );
  const [suppressed, setSuppressed] = useState<KnowledgeEntityDto[]>(
    () => knowledgeSnapshotCache?.suppressed ?? [],
  );
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loaded, setLoaded] = useState(() => knowledgeSnapshotCache !== null);
  /** strip 视图：详情弹框存实体 id（实体对象每拍刷新，进度可实时跟进）。 */
  const [detailId, setDetailId] = useState<string | null>(null);
  /**
   * 创建完成闪光状态：确认创建后实体转 room 态离开 ready 池，detailEntity
   * 随之变 null、弹框会瞬间关闭。捕获这次「promoting → 消失」的迁移，
   * 停留 1.6s 展示全勾完成态再收，长等待有明确的终点画面。
   */
  const [completedFlash, setCompletedFlash] = useState<{ id: string; name: string } | null>(null);
  /** 横幅收起态：关闭≠丢弃——进行中的会话收成小状态点，点开即找回。 */
  const detailSnapshotRef = useRef<{ id: string | null; promoting: boolean; name: string }>({ id: null, promoting: false, name: '' });
  useEffect(() => {
    const snapshot = detailSnapshotRef.current;
    const current = detailId ? recommended.find((entity) => entity.id === detailId) ?? null : null;
    const promoting = current?.promotion?.status === 'queued'
      || current?.promotion?.status === 'running';
    // 换了别的实体：立即撤闪光，别让旧计时器收走新弹框。
    if (completedFlash && detailId !== null && detailId !== completedFlash.id) {
      setCompletedFlash(null);
    }
    if (snapshot.promoting && detailId !== null && detailId === snapshot.id && current === null) {
      const flashId = detailId;
      setCompletedFlash({ id: flashId, name: snapshot.name });
      const timer = window.setTimeout(() => {
        setCompletedFlash(null);
        setDetailId((currentId) => (currentId === flashId ? null : currentId));
      }, 1_600);
      detailSnapshotRef.current = { id: detailId, promoting: false, name: snapshot.name };
      return () => window.clearTimeout(timer);
    }
    detailSnapshotRef.current = { id: detailId, promoting, name: current?.name ?? snapshot.name };
  }, [detailId, recommended, completedFlash]);
  /** strip 视图：完整管理面板弹框（批量选择 / 待挂载 / 历史收纳于此）。 */
  const [manageOpen, setManageOpen] = useState(false);
  /** 知识服务不可用：与「确实没有推荐」区分展示，附重试入口。 */
  const [loadError, setLoadError] = useState(false);
  const activePromotionsRef = useRef(new Map<string, string>());
  const promotionControllers = useRef(new Map<string, AbortController>());
  const selectionInitializedRef = useRef(false);
  const translateRef = useRef(t);
  translateRef.current = t;

  const refresh = useCallback(async () => {
    const knowledge = window.nxcore?.knowledge;
    if (!knowledge) {
      setLoaded(true);
      return;
    }
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
      const rankedReady = [...ready.items].sort((a, b) => {
        const scoreDelta = b.evidenceScore - a.evidenceScore;
        const failureDelta = Number(b.promotion?.status === 'failed') - Number(a.promotion?.status === 'failed');
        const pathDelta = Number(b.readinessPath === 'strong') - Number(a.readinessPath === 'strong');
        const trustedDelta = (b.trustedSourceCount ?? 0) - (a.trustedSourceCount ?? 0);
        const updatedDelta = Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
        return scoreDelta || failureDelta || pathDelta || trustedDelta || updatedDelta;
      });
      const nextRecommended = [
        ...activePromotions,
        ...rankedReady.filter((entity) => !activeIds.has(entity.id)),
      ];
      setRecommended(nextRecommended);
      const selectableIds = new Set(rankedReady
        .filter((entity) => !activeIds.has(entity.id))
        .slice(0, RECOMMEND_LIMIT)
        .filter((entity) => !entity.existingRoomMatch)
        .map((entity) => entity.id));
      setSelected((current) => {
        if (!selectionInitializedRef.current) {
          selectionInitializedRef.current = true;
          return selectableIds;
        }
        const next = new Set([...current].filter((id) => selectableIds.has(id)));
        return next.size === current.size && [...next].every((id) => current.has(id)) ? current : next;
      });
      setRecent(recentData.items);
      setSuppressed(suppressedData.items);
      knowledgeSnapshotCache = {
        recommended: nextRecommended,
        recent: recentData.items,
        suppressed: suppressedData.items,
      };
      setLoaded(true);
      setLoadError(false);
      const previous = activePromotionsRef.current;
      const completed = rooms.items.filter((entity) =>
        previous.has(entity.id) && entity.promotion?.status === 'completed');
      const failed = ready.items.filter((entity) => previous.has(entity.id) && entity.promotion?.status === 'failed');
      activePromotionsRef.current = new Map(activePromotions.map((entity) => [entity.id, entity.name]));
      for (const entity of completed) {
        showToast({ title: translateRef.current('contextRoom:knowledgePending.roomCreated'), message: translateRef.current('contextRoom:knowledgePending.nameIsReadyToUse', { name: entity.name }) });
        // md 上传文件自动转为可编辑云文档（幂等；补跑兜路由决策落库窗口）
        scheduleRoomMarkdownImport(entity.roomId);
        // M2-A：晋升完成即时定向查重，新候选以 toast 引导去首页合并中心处理。
        const promotedRoomId = entity.roomId;
        if (promotedRoomId) {
          void (async () => {
            try {
              const result = await window.nxcore?.contextRooms?.checkRoomDuplicates?.(promotedRoomId);
              if ((result?.newCandidates ?? 0) > 0) {
                showToast({
                  title: translateRef.current('contextRoom:knowledgePending.duplicatesDetectedTitle'),
                  message: translateRef.current('contextRoom:knowledgePending.duplicatesDetectedBody', { name: entity.name, count: result!.newCandidates }),
                });
              }
            } catch {
              // 查重是增强提示：失败静默（合并中心仍会常规发现）。
            }
          })();
        }
      }
      for (const entity of failed) {
        showToast({ title: translateRef.current('contextRoom:knowledgePending.creationFailed'), message: entity.promotion?.error ?? undefined });
      }
      if (completed.length > 0) {
        window.setTimeout(() => window.dispatchEvent(new CustomEvent('everroom:knowledge-changed')), 0);
      }
    } catch {
      // 知识服务不可用：面板显性报错（不再静默为空——用户会把故障误读为"没有资料"）
      setLoaded(true);
      setLoadError(true);
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
        await knowledge.promoteEntity(entity.id, entity.existingRoomMatch?.confidence === 'medium' ? { forceNew: true } : undefined);
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

  const reuseExistingRoom = (entity: KnowledgeEntityDto) =>
    runBusy(`entity:${entity.id}:reuse`, async () => {
      const match = entity.existingRoomMatch;
      if (!match) return;
      await window.nxcore?.knowledge?.mergeEntity(entity.id, match.entityId);
      showToast({
        title: t('contextRoom:knowledgePending.joinedExistingRoom'),
        message: t('contextRoom:knowledgePending.addedToExistingRoom', { name: match.roomTitle }),
      });
    });

  const deferCreate = (entity: KnowledgeEntityDto) =>
    runBusy(`entity:${entity.id}:suppress`, async () => {
      await window.nxcore?.knowledge?.suppressEntity(entity.id);
      showToast({ title: t('contextRoom:knowledgePending.creationDeferred'), message: t('contextRoom:knowledgePending.topicWillNotBeRecommendedAgain', { name: entity.name }) });
    });

  const confirmSelected = () => {
    const entityIds = [...selected];
    if (entityIds.length === 0) return;
    void runBusy('batch:promote', async () => {
      const result = await window.nxcore?.knowledge?.promoteEntities(entityIds);
      const rejected = result?.items.filter((item) => item.status === 'rejected').length ?? 0;
      const queued = (result?.items.length ?? 0) - rejected;
      setSelected((current) => new Set([...current].filter((id) => !entityIds.includes(id))));
      if (queued > 0) showToast({ title: t('contextRoom:knowledgePending.batchCreatingRooms', { count: queued }) });
      if (rejected > 0) showToast({ title: t('contextRoom:knowledgePending.batchRejected', { count: rejected }) });
    });
  };

  const suppressSelected = () => {
    const entityIds = [...selected];
    if (entityIds.length === 0) return;
    void runBusy('batch:suppress', async () => {
      const result = await window.nxcore?.knowledge?.suppressEntities(entityIds);
      const rejected = result?.items.filter((item) => item.status === 'rejected').length ?? 0;
      const suppressedCount = (result?.items.length ?? 0) - rejected;
      setSelected((current) => new Set([...current].filter((id) => !entityIds.includes(id))));
      if (suppressedCount > 0) showToast({ title: t('contextRoom:knowledgePending.batchDeferred', { count: suppressedCount }) });
      if (rejected > 0) showToast({ title: t('contextRoom:knowledgePending.batchRejected', { count: rejected }) });
    });
  };

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

  if (!loaded) {
    if (variant !== 'strip') return null;
    // 首次加载（会话内无快照缓存）：骨架占位保住推荐区高度，
    // 页面级骨架 → 面板骨架 → 内容三段连贯，不再塌掉闪现。
    return (
      <section className="context-room-knowledge-strip" data-loading="true" aria-busy="true">
        <div className="context-room-strip-head">
          <div className="context-room-home-section-title">
            <span>{t('contextRoom:home.recommend')}</span>
            <h2>{t('contextRoom:knowledgePending.recommendedRooms')}</h2>
          </div>
        </div>
        <div className="context-room-knowledge-strip-body">
          <div className="context-room-skeleton-grid" aria-hidden="true">
            {Array.from({ length: RECOMMEND_LIMIT }, (_, index) => (
              <div className="context-room-skeleton-card" key={index}>
                <span className="context-room-skeleton-card-main">
                  <span className="context-room-skeleton-block context-room-skeleton-icon" />
                  <span className="context-room-skeleton-card-copy">
                    <span className="context-room-skeleton-block context-room-skeleton-line" style={{ width: '42%' }} />
                    <span className="context-room-skeleton-block context-room-skeleton-line" style={{ width: '78%' }} />
                  </span>
                </span>
                <span className="context-room-skeleton-block context-room-skeleton-chip" />
              </div>
            ))}
          </div>
        </div>
      </section>
    );
  }

  const promotionActive = (entity: KnowledgeEntityDto) =>
    entity.promotion?.status === 'queued' || entity.promotion?.status === 'running';
  const activeRecommended = recommended.filter(promotionActive);
  const idleRecommended = recommended.filter((entity) => !promotionActive(entity));
  const visibleIdle = idleRecommended.slice(0, RECOMMEND_LIMIT);
  const visibleRecommended = [...activeRecommended, ...visibleIdle];
  const visibleSelectableIds = visibleIdle.filter((entity) => !entity.existingRoomMatch).map((entity) => entity.id);
  const allVisibleSelected = visibleSelectableIds.length > 0
    && visibleSelectableIds.every((id) => selected.has(id));

  const toggleVisible = () => setSelected((current) => {
    const next = new Set(current);
    if (allVisibleSelected) visibleSelectableIds.forEach((id) => next.delete(id));
    else visibleSelectableIds.forEach((id) => next.add(id));
    return next;
  });

  /** 推荐理由一句话（加入已有 Room 提示 / 强证据 / 标准证据）：strip 卡与详情弹框共用。 */
  const entityReason = (entity: KnowledgeEntityDto) => entity.existingRoomMatch
    ? t(entity.existingRoomMatch.confidence === 'high'
      ? 'contextRoom:knowledgePending.existingRoomHighMatch'
      : 'contextRoom:knowledgePending.existingRoomMediumMatch', {
        name: entity.existingRoomMatch.roomTitle,
      })
    : entity.readinessPath === 'strong'
      ? t('contextRoom:knowledgePending.strongEvidenceReason', { count: entity.strongSourceCount ?? 0 })
      : t('contextRoom:knowledgePending.standardEvidenceReason', {
        count: entity.eligibleSourceCount ?? entity.sourceCount,
        trusted: entity.trustedSourceCount ?? 0,
      });

  /** 操作按钮组（加入已有 / 确认创建 / 仍要创建 / 暂不创建）：管理卡 footer 与详情弹框共用。 */
  const entityActions = (entity: KnowledgeEntityDto) => {
    const promotion = entity.promotion;
    const isPromotionActive = promotionActive(entity);
    return (
      <>
        {entity.existingRoomMatch && !isPromotionActive ? (
          <button
            type="button"
            className="context-room-knowledge-confirm"
            aria-label={t('contextRoom:knowledgePending.joinExistingRoom')}
            disabled={busy.has(`entity:${entity.id}:reuse`)}
            onClick={() => void reuseExistingRoom(entity)}
          >
            {busy.has(`entity:${entity.id}:reuse`) ? <LoaderCircle className="spin" aria-hidden="true" /> : <Link2 aria-hidden="true" />}
            {t('contextRoom:knowledgePending.joinExistingRoom')}
          </button>
        ) : (
          <button
            type="button"
            className="context-room-knowledge-confirm"
            disabled={busy.has(`entity:${entity.id}:promote`) || isPromotionActive}
            onClick={() => void confirmCreate(entity)}
          >
            {isPromotionActive ? <LoaderCircle className="spin" aria-hidden="true" /> : <Sparkles aria-hidden="true" />}
            {t(isPromotionActive
              ? promotion?.status === 'queued' ? 'contextRoom:knowledgePending.queued' : 'contextRoom:knowledgePending.creating'
              : promotion?.status === 'failed' ? 'contextRoom:knowledgePending.retryCreation' : 'contextRoom:knowledgePending.create')}
          </button>
        )}
        {entity.existingRoomMatch?.confidence === 'medium' && !isPromotionActive ? (
          <button
            type="button"
            className="context-room-knowledge-defer"
            disabled={busy.has(`entity:${entity.id}:promote`)}
            onClick={() => void confirmCreate(entity)}
          >
            <Sparkles aria-hidden="true" />
            {t('contextRoom:knowledgePending.createAnyway')}
          </button>
        ) : null}
        {!isPromotionActive ? (
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
      </>
    );
  };

  /** 创建进度块（排队/建 Room/建 Wiki/导资料）：管理卡与详情弹框共用。 */
  const promotionProgressBlock = (entity: KnowledgeEntityDto) => {
    const promotion = entity.promotion;
    if (!promotion) return null;
    const creationPercent = promotionPercent(promotion);
    return (
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
    );
  };

  /** 创建过程时间线（详情弹框用）：六阶段步骤条，当前步带资料计数，比紧凑进度条更能安放长等待。 */
  const promotionDetailBlock = (entity: KnowledgeEntityDto) => {
    const promotion = entity.promotion;
    if (!promotion) return null;
    return (
      <div
        className="context-room-promo-run"
        data-status={promotion.status}
        role="status"
      >
        {promotionStepsList(promotion, t)}
      </div>
    );
  };

  const manageView = (
    <section className="context-room-knowledge-panel" data-testid="context-room-knowledge-pending">
      <div className="context-room-my-title">
        <div className="context-room-home-section-title">
          <span>{t('contextRoom:knowledgePending.knowledge')}</span>
          <h2>{t('contextRoom:knowledgePending.recommendedRooms')}</h2>
        </div>
        <div className="context-room-my-actions" aria-label={t('contextRoom:knowledgePending.recommendedRoomActions')}>
          <button
            type="button"
            aria-label={t('contextRoom:home.newRoom')}
            title={t('contextRoom:home.newRoom')}
            className="context-room-add-room"
            onClick={onOpenCreateRoom}
          >
            <Plus aria-hidden="true" />
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

      {loadError && recommended.length === 0 ? (
        <div className="context-room-knowledge-empty" data-error="true">
          <AlertCircle aria-hidden="true" />
          <h3>{t('contextRoom:knowledgePending.loadFailedTitle')}</h3>
          <p>{t('contextRoom:knowledgePending.loadFailedBody')}</p>
          <button type="button" className="context-room-knowledge-empty-cta" onClick={() => void refresh()}>
            <span className="context-room-knowledge-empty-cta-icon">
              <RefreshCw aria-hidden="true" />
            </span>
            <span>{t('contextRoom:knowledgePending.loadFailedRetry')}</span>
          </button>
        </div>
      ) : recommended.length === 0 ? (
        <div className="context-room-knowledge-empty">
          <Inbox aria-hidden="true" />
          <h3>{t('contextRoom:knowledgePending.understandingResources')}</h3>
          <p>{t('contextRoom:knowledgePending.tellAgentWhatRoomToCreate')}</p>
          <button type="button" className="context-room-knowledge-empty-cta" onClick={() => {
            // 管理弹窗是模态覆盖层：不先关掉，Agent 面板在背后打开用户感知不到（表现为点了没反应）。
            setManageOpen(false)
            onFocusAgent()
          }}>
            <span className="context-room-knowledge-empty-cta-icon">
              <MessageCircle aria-hidden="true" />
            </span>
            <span>{t('contextRoom:knowledgePending.talkToAgent')}</span>
          </button>
        </div>
      ) : (
        <div className="context-room-knowledge-list">
          <div className="context-room-knowledge-batchbar">
            <label>
              <input type="checkbox" checked={allVisibleSelected} onChange={toggleVisible} />
              <span>{t('contextRoom:knowledgePending.selectVisible')}</span>
            </label>
            <span>{t('contextRoom:knowledgePending.selectedCount', { count: selected.size })}</span>
            <button type="button" className="context-room-knowledge-confirm" disabled={selected.size === 0 || busy.has('batch:promote')} onClick={confirmSelected}>
              {busy.has('batch:promote') ? <LoaderCircle className="spin" aria-hidden="true" /> : <Sparkles aria-hidden="true" />}
              {t('contextRoom:knowledgePending.createSelected', { count: selected.size })}
            </button>
            <button type="button" className="context-room-knowledge-defer" disabled={selected.size === 0 || busy.has('batch:suppress')} onClick={suppressSelected}>
              <EyeOff aria-hidden="true" />
              {t('contextRoom:knowledgePending.deferSelected')}
            </button>
          </div>
          <h3 className="context-room-knowledge-group">{t('contextRoom:knowledgePending.highConfidenceRecommendations')}</h3>
          {visibleRecommended.map((entity) => {
            const scoreRatio = Math.min(1, entity.evidenceScore
              / EVIDENCE_READY_SCORE[entity.readinessPath === 'strong' ? 'strong' : 'standard']);
            const promotion = entity.promotion;
            const isPromotionActive = promotion?.status === 'queued' || promotion?.status === 'running';
            return (
              <article key={entity.id} className="context-room-knowledge-card" data-state="recommended">
                <header>
                  {!isPromotionActive && !entity.existingRoomMatch ? (
                    <input
                      type="checkbox"
                      aria-label={t('contextRoom:knowledgePending.selectRecommendation', { name: entity.name })}
                      checked={selected.has(entity.id)}
                      onChange={() => setSelected((current) => {
                        const next = new Set(current);
                        if (next.has(entity.id)) next.delete(entity.id); else next.add(entity.id);
                        return next;
                      })}
                    />
                  ) : null}
                  <strong>{entity.name}</strong>
                  <span className="context-room-knowledge-tag">{localizedUiText(entity.kind, t)}</span>
                </header>
                <p className="context-room-knowledge-reason">
                  {entityReason(entity)}
                  {entity.sourceKinds?.length
                    ? ` · ${entity.sourceKinds.map((kind) => t(`contextRoom:knowledgePending.sourceKind.${kind}`)).join(' / ')}`
                    : ''}
                </p>
                <div className="context-room-knowledge-progress" role="progressbar" aria-label={t('contextRoom:knowledgePending.evidenceProgress')}>
                  <div className="context-room-knowledge-progress-bar">
                    <div className="context-room-knowledge-progress-fill" style={{ width: `${Math.round(scoreRatio * 100)}%` }} />
                  </div>
                  <span>
                    {t('contextRoom:knowledgePending.evidenceScoreSecondary', { score: entity.evidenceScore.toFixed(2), count: entity.sourceCount })}
                  </span>
                </div>
                {entity.firstEvidence ? (
                  <p className="context-room-knowledge-summary">{entity.firstEvidence}</p>
                ) : null}
                {promotionProgressBlock(entity)}
                <footer>
                  {entityActions(entity)}
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

      <UnmatchedDocsSection />

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

  if (variant !== 'strip') return manageView;

  const detailEntity = detailId ? recommended.find((entity) => entity.id === detailId) ?? null : null;

  // 原型首页推荐区：一行简单推荐卡，工作流收纳进「全部推荐」与卡片详情弹框。
  return (
    <section className="context-room-knowledge-strip">
      <div className="context-room-strip-head">
        <div className="context-room-home-section-title">
          <span>{t('contextRoom:home.recommend')}</span>
          <h2>{t('contextRoom:knowledgePending.recommendedRooms')}</h2>
        </div>
        <button type="button" className="context-room-strip-manage" onClick={() => setManageOpen(true)}>
          {t('contextRoom:knowledgePending.manageAll')}
          <ArrowRight aria-hidden="true" />
        </button>
      </div>
      <div className="context-room-knowledge-strip-body">
        {loadError && recommended.length === 0 ? (
          <div className="context-room-rec-empty" data-error="true">
            <AlertCircle aria-hidden="true" />
            <h3>{t('contextRoom:knowledgePending.loadFailedTitle')}</h3>
            <button type="button" className="context-room-rec-retry" onClick={() => void refresh()}>
              <RefreshCw aria-hidden="true" />
              {t('contextRoom:knowledgePending.loadFailedRetry')}
            </button>
          </div>
        ) : visibleRecommended.length === 0 ? (
          <div className="context-room-rec-empty">
            <Sparkles aria-hidden="true" />
            <h3>{t('contextRoom:knowledgePending.understandingResources')}</h3>
            <p>{t('contextRoom:knowledgePending.tellAgentWhatRoomToCreate')}</p>
            <button type="button" className="context-room-rec-retry" onClick={onFocusAgent}>
              <MessageCircle aria-hidden="true" />
              {t('contextRoom:knowledgePending.talkToAgent')}
            </button>
          </div>
        ) : (
          <div className="context-room-rec-grid">
            {visibleRecommended.slice(0, RECOMMEND_LIMIT).map((entity) => {
              const promotion = entity.promotion;
              return (
                <button
                  key={entity.id}
                  type="button"
                  className="context-room-rec-card"
                  onClick={() => setDetailId(entity.id)}
                >
                  <span className="context-room-rec-card-icon"><Sparkles aria-hidden="true" /></span>
                  <span className="context-room-rec-card-body">
                    <strong>{entity.name}</strong>
                    <small>{entityReason(entity)}</small>
                  </span>
                  {promotionActive(entity) && promotion ? (
                    <span className="context-room-rec-score" data-state="creating" title={promotionLabel(promotion, t)}>
                      <LoaderCircle className="spin" aria-hidden="true" />
                      {promotionPercent(promotion)}%
                    </span>
                  ) : (
                    <span
                      className="context-room-rec-score"
                      title={t('contextRoom:knowledgePending.evidenceScoreSecondary', { score: entity.evidenceScore.toFixed(2), count: entity.sourceCount })}
                    >
                      <Layers3 aria-hidden="true" />
                      <b>{entity.sourceCount}</b>
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <ReferenceDialog
        open={manageOpen}
        onOpenChange={setManageOpen}
        title={t('contextRoom:knowledgePending.recommendedRooms')}
        contentClassName="context-room-manage-dialog"
      >
        {manageView}
      </ReferenceDialog>

      <ReferenceDialog
        open={detailEntity !== null || completedFlash !== null}
        onOpenChange={(open) => {
          if (!open) {
            setCompletedFlash(null);
            setDetailId(null);
          }
        }}
        title={detailEntity?.name ?? completedFlash?.name ?? ''}
        contentClassName="context-room-rec-detail-dialog"
      >
        {detailEntity ? (
          <div className="context-room-rec-detail">
            <header>
              <h3>{detailEntity.name}</h3>
              <span className="context-room-knowledge-tag">{localizedUiText(detailEntity.kind, t)}</span>
            </header>
            {detailEntity.firstEvidence ? (
              <p className="context-room-rec-detail-desc">{detailEntity.firstEvidence}</p>
            ) : null}
            <div className="context-room-rec-detail-stats">
              <div className="context-room-rec-detail-stat">
                <span className="context-room-rec-detail-stat-num">{detailEntity.sourceCount}</span>
                <span className="context-room-rec-detail-stat-label">{t('contextRoom:knowledgePending.statSources')}</span>
              </div>
              <div className="context-room-rec-detail-stat">
                <span className="context-room-rec-detail-stat-num">{detailEntity.evidenceScore.toFixed(2)}</span>
                <span className="context-room-rec-detail-stat-label">{t('contextRoom:knowledgePending.statScore')}</span>
              </div>
            </div>
            {promotionDetailBlock(detailEntity)}
            <footer className="context-room-rec-detail-actions">
              {entityActions(detailEntity)}
            </footer>
          </div>
        ) : completedFlash ? (
          <div className="context-room-rec-detail context-room-rec-detail-flash" data-status="completed">
            <header>
              <h3>{completedFlash.name}</h3>
              <span className="context-room-knowledge-tag" data-tone="success">
                <Check aria-hidden="true" />
                {t('contextRoom:knowledgePending.roomCreated')}
              </span>
            </header>
            {promotionStepsList(PROMOTION_COMPLETED_SNAPSHOT, t)}
          </div>
        ) : null}
      </ReferenceDialog>
    </section>
  );
}
