import {
  AlertCircle,
  Check,
  ChevronDown,
  Clock3,
  Inbox,
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
import {
  ROOM_RECOMMENDATION_RUN_EVENT,
  type RoomRecommendationRunPayload,
  type StagedPath,
  type UploadedFile,
} from '../roomRecommendationRun';
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

/** 仅展示证据分最高的三个待创建候选。 */
const RECOMMEND_LIMIT = 3;

/** 推荐生成会话轮询节奏：2s 一拍，路由或候选实体任一增长即视为有进度。 */
const RUN_POLL_INTERVAL_MS = 2_000;
/**
 * 无进度超时：连续 60 拍（约 2 分钟）路由与候选都无增长才转超时。网关路由
 * 是串行 LLM（实测约 15-20s/个），绝对超时会在积压时误杀仍在推进的会话。
 */
const RUN_IDLE_TIMEOUT_TICKS = 60;
/** 快照到轮询的时钟漂移余量：实体 updatedAt 在此窗口内即计入本次会话。 */
const RUN_TOUCHED_SLACK_MS = 5_000;
/** 导入断点续传：内容寻址去重让重跑幂等；网络波动自动重试。 */
const IMPORT_RETRY_ATTEMPTS = 3;
const IMPORT_RETRY_DELAY_MS = 2_000;
/** 会话清单的本地持久化键：应用重启后据此恢复进度（真实状态在网关）。 */
const RUN_STORAGE_KEY = 'everroom:room-recommendation-run';

/** 创建弹窗提交后的推荐生成会话：导入 → 路由 → 证据累积，整卡蒙层展示进度。 */
interface RecommendationRun {
  id: number;
  intent: string | null;
  paths: StagedPath[];
  startedAt: number;
  /** 会话开始前已在推荐池的实体：之后新出现的 ready 实体即本次产出。 */
  readySnapshot: ReadonlySet<string>;
  phase: 'importing' | 'routing' | 'accumulating' | 'timeout' | 'failed';
  imported: { completed: number; total: number };
  files: UploadedFile[];
  /** 导入阶段无法解析的文件数（如扫描版 PDF）：蒙层显性展示，不再静默丢弃。 */
  failedImports: number;
  routed: number;
  candidates: number;
  error: string | null;
}

/** 蒙层进度条刻度：导入 5-30%，解析 30-70%，累积 85%。 */
function runPercentOf(run: RecommendationRun): number {
  if (run.phase === 'importing') {
    return run.imported.total > 0
      ? 5 + 25 * Math.min(1, run.imported.completed / run.imported.total)
      : 5;
  }
  if (run.phase === 'routing') {
    const total = Math.max(run.files.length, 1);
    return 30 + 40 * Math.min(1, run.routed / total);
  }
  if (run.phase === 'failed') {
    return run.imported.total > 0
      ? 5 + 25 * Math.min(1, run.imported.completed / run.imported.total)
      : 5;
  }
  return 85;
}

/** 从 localStorage 恢复未完会话；已完结（timeout/failed）或损坏的清单丢弃。 */
function readPersistedRun(): RecommendationRun | null {
  try {
    const raw = window.localStorage?.getItem(RUN_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Omit<RecommendationRun, 'readySnapshot'> & { readySnapshot?: unknown };
    if (typeof parsed?.id !== 'number' || !Array.isArray(parsed.paths) || typeof parsed.startedAt !== 'number') {
      return null;
    }
    if (parsed.phase !== 'importing' && parsed.phase !== 'routing' && parsed.phase !== 'accumulating') {
      return null;
    }
    return {
      ...parsed,
      failedImports: typeof parsed.failedImports === 'number' ? parsed.failedImports : 0,
      readySnapshot: new Set(Array.isArray(parsed.readySnapshot) ? parsed.readySnapshot : []),
    };
  } catch {
    return null;
  }
}

function persistRun(run: RecommendationRun | null): void {
  try {
    const storage = window.localStorage;
    if (!storage) return;
    if (run && (run.phase === 'importing' || run.phase === 'routing' || run.phase === 'accumulating')) {
      const { readySnapshot, ...rest } = run;
      storage.setItem(RUN_STORAGE_KEY, JSON.stringify({ ...rest, readySnapshot: [...readySnapshot] }));
    } else {
      storage.removeItem(RUN_STORAGE_KEY);
    }
  } catch {
    // 存储不可用（隐私模式等）：仅失去重启恢复，会话本体不受影响。
  }
}

/**
 * 推荐 Room 面板（entity-room-plan 推荐确认制）：达阈值实体进 ready
 * 推荐池，用户确认后才创建 Room；最近归类保留人工治理入口。
 * 未识别栏已移除——不做人工挂载实体，资料证据自然累积进推荐池。
 */
export function KnowledgePendingPanel({
  onFocusAgent,
  onOpenCreateRoom,
}: {
  onFocusAgent: () => void;
  /** 新建 Room 统一入口（手动创建 / 智能推荐双页签）。 */
  onOpenCreateRoom: () => void;
}) {
  const { t } = useLocale();
  const [recommended, setRecommended] = useState<KnowledgeEntityDto[]>([]);
  const [recent, setRecent] = useState<KnowledgeDecisionDto[]>([]);
  const [suppressed, setSuppressed] = useState<KnowledgeEntityDto[]>([]);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loaded, setLoaded] = useState(false);
  const activePromotionsRef = useRef(new Map<string, string>());
  const promotionControllers = useRef(new Map<string, AbortController>());
  const selectionInitializedRef = useRef(false);
  const translateRef = useRef(t);
  translateRef.current = t;

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
      setLoaded(true);
      const previous = activePromotionsRef.current;
      const completed = rooms.items.filter((entity) =>
        previous.has(entity.id) && entity.promotion?.status === 'completed');
      const failed = ready.items.filter((entity) => previous.has(entity.id) && entity.promotion?.status === 'failed');
      activePromotionsRef.current = new Map(activePromotions.map((entity) => [entity.id, entity.name]));
      for (const entity of completed) {
        showToast({ title: translateRef.current('contextRoom:knowledgePending.roomCreated'), message: translateRef.current('contextRoom:knowledgePending.nameIsReadyToUse', { name: entity.name }) });
        // md 上传文件自动转为可编辑云文档（幂等；补跑兜路由决策落库窗口）
        scheduleRoomMarkdownImport(entity.roomId);
      }
      for (const entity of failed) {
        showToast({ title: translateRef.current('contextRoom:knowledgePending.creationFailed'), message: entity.promotion?.error ?? undefined });
      }
      if (completed.length > 0) {
        window.setTimeout(() => window.dispatchEvent(new CustomEvent('everroom:knowledge-changed')), 0);
      }
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

  const hasActivePromotion = recommended.some((entity) =>
    entity.promotion?.status === 'queued' || entity.promotion?.status === 'running');
  useEffect(() => {
    if (!hasActivePromotion) return;
    const timer = window.setInterval(() => void refresh(), 1_000);
    return () => window.clearInterval(timer);
  }, [hasActivePromotion, refresh]);

  const [run, setRun] = useState<RecommendationRun | null>(null);
  const runIdRef = useRef(0);
  // 蒙层展示中的会话（含导入阶段）；轮询只在路由/累积阶段进行。
  const runActive = run !== null
    && (run.phase === 'importing' || run.phase === 'routing' || run.phase === 'accumulating');
  const runPolling = run !== null && (run.phase === 'routing' || run.phase === 'accumulating');

  /**
   * 执行/重试会话导入：内容寻址去重使重跑幂等（已传文件直接复用），
   * 网络波动自动重试；成功文件进入路由轮询。断点续传与失败重试共用。
   */
  const continueImport = useCallback(async (session: RecommendationRun) => {
    const filesApi = window.nxcore?.files;
    const patchRun = (patch: Partial<RecommendationRun>) =>
      setRun((current) => (current && current.id === session.id ? { ...current, ...patch } : current));
    if (!filesApi?.importPaths) {
      patchRun({ phase: 'failed', error: 'files api unavailable' });
      return;
    }
    patchRun({ phase: 'importing', imported: { completed: 0, total: 0 }, error: null });
    const unsubscribeProgress = filesApi.onImportProgress((event) => {
      setRun((current) => current && current.id === session.id
        ? { ...current, imported: { completed: event.completed, total: event.total } }
        : current);
    });
    let outcomes: Awaited<ReturnType<typeof filesApi.importPaths>> | null = null;
    for (let attempt = 1; attempt <= IMPORT_RETRY_ATTEMPTS; attempt += 1) {
      try {
        outcomes = await filesApi.importPaths(session.paths);
        break;
      } catch (cause) {
        if (attempt >= IMPORT_RETRY_ATTEMPTS) {
          unsubscribeProgress();
          patchRun({ phase: 'failed', error: cause instanceof Error ? cause.message : String(cause) });
          return;
        }
        await new Promise((resolve) => window.setTimeout(resolve, IMPORT_RETRY_DELAY_MS));
      }
    }
    unsubscribeProgress();
    if (outcomes === null) return;
    const failures = outcomes.filter((item) => item.error);
    if (failures.length > 0) {
      // 逐文件 toast 在批量导入（如整仓扫描件）时会刷屏：聚合成一条。
      showToast({
        title: translateRef.current('contextRoom:creation.runImportPartial', {
          ok: outcomes.length - failures.length,
          failed: failures.length,
        }),
        message: translateRef.current('contextRoom:creation.runImportPartialHint'),
      });
    }
    const files = outcomes
      .filter((item) => item.fileId && !item.error)
      .map((item) => ({ fileId: item.fileId as string, filename: item.filename }));
    patchRun({
      files,
      failedImports: failures.length,
      phase: files.length > 0 ? 'routing' : 'failed',
      error: files.length > 0 ? null : 'no files imported',
    });
    window.dispatchEvent(new CustomEvent('everroom:knowledge-changed'));
  }, []);

  /**
   * 弹窗提交后接手：先统一导入暂存路径（蒙层显示 x/y），成功文件进入
   * 路由轮询，再由实体证据累积推进到推荐。全程只用原有机制。
   */
  const startRecommendationRun = useCallback(async (payload: RoomRecommendationRunPayload) => {
    if (payload.paths.length === 0) return;
    const startedAt = Date.now();
    const knowledge = window.nxcore?.knowledge;
    let readySnapshot: ReadonlySet<string> = new Set();
    try {
      if (knowledge) {
        readySnapshot = new Set((await knowledge.listEntities('ready')).items.map((entity) => entity.id));
      }
    } catch {
      // 快照失败按空集兜底：之后出现的 ready 实体即视为本次新推荐。
    }
    runIdRef.current += 1;
    const session: RecommendationRun = {
      id: runIdRef.current,
      intent: payload.intent,
      paths: payload.paths,
      startedAt,
      readySnapshot,
      phase: 'importing',
      imported: { completed: 0, total: 0 },
      files: [],
      failedImports: 0,
      routed: 0,
      candidates: 0,
      error: null,
    };
    setRun(session);
    void refresh();
    void continueImport(session);
  }, [continueImport, refresh]);

  // 应用重启恢复：真实进度都在网关（决策 + 实体池），清单只负责重挂蒙层；
  // 导入中被打断则重跑导入（内容去重幂等，不重复存储）。
  // 注意：必须先于 persistRun 效果执行，否则挂载时的空状态会先清掉清单。
  const resumedRef = useRef(false);
  useEffect(() => {
    if (resumedRef.current) return;
    resumedRef.current = true;
    const persisted = readPersistedRun();
    if (!persisted) return;
    runIdRef.current = Math.max(runIdRef.current, persisted.id);
    setRun(persisted);
    void refresh();
    if (persisted.phase === 'importing') {
      void continueImport(persisted);
    }
  }, [continueImport, refresh]);

  // 会话清单持久化：进行中写入，结束（完成/超时/失败/关闭）清除。
  useEffect(() => {
    persistRun(run);
  }, [run]);

  useEffect(() => {
    const onStart = (event: Event) => {
      const detail = (event as CustomEvent<RoomRecommendationRunPayload>).detail;
      if (!detail || !Array.isArray(detail.paths)) return;
      void startRecommendationRun(detail);
    };
    window.addEventListener(ROOM_RECOMMENDATION_RUN_EVENT, onStart);
    return () => window.removeEventListener(ROOM_RECOMMENDATION_RUN_EVENT, onStart);
  }, [startRecommendationRun]);

  // 会话推进完全由真实机制驱动：路由决策落库 → routed；实体池出现新 ready → 完成撤蒙层。
  // 超时只看「无进度」：路由/候选连续 RUN_IDLE_TIMEOUT_TICKS 拍无增长才转超时，
  // 绝对时长上限会在路由积压（串行 LLM）时误杀仍在推进的会话。
  useEffect(() => {
    if (!run || !runPolling) return;
    const session = run;
    let lastRouted = -1;
    let lastCandidates = -1;
    let idleTicks = 0;
    let cancelled = false;
    let timer: number | null = null;
    const finish = () => {
      showToast({
        title: translateRef.current('contextRoom:creation.runDone'),
        message: translateRef.current('contextRoom:creation.runDoneBody'),
      });
      window.dispatchEvent(new CustomEvent('everroom:knowledge-changed'));
      setRun((current) => current && current.id === session.id ? null : current);
    };
    const stall = () => {
      setRun((current) => current && current.id === session.id
        ? { ...current, phase: 'timeout' }
        : current);
      cancelled = true;
      if (timer !== null) window.clearInterval(timer);
    };
    const poll = async () => {
      const knowledge = window.nxcore?.knowledge;
      if (!knowledge || cancelled) return;
      try {
        const [routedIds, weak, ready] = await Promise.all([
          // 按 fileId 直查最新决策（任意状态）。新落库的 awaiting_review 就是
          // 「已解析」；listRecentDecisions 只回 confirmed，用它计数会永远 0。
          knowledge.routeStatus
            ? knowledge.routeStatus(session.files.map((file) => file.fileId))
              .then((status) => new Set(status.items.map((item) => item.sourceId)))
            : knowledge.listRecentDecisions(100).then((decisions) => new Set(decisions.items
              .filter((decision) => decision.sourceKind === 'file')
              .map((decision) => decision.sourceId))),
          knowledge.listEntities('weak'),
          knowledge.listEntities('ready'),
        ]);
        if (cancelled) return;
        const routed = session.files.filter((file) => routedIds.has(file.fileId)).length;
        const touchedSince = session.startedAt - RUN_TOUCHED_SLACK_MS;
        const candidates = [...weak.items, ...ready.items]
          .filter((entity) => Date.parse(entity.updatedAt) >= touchedSince).length;
        const hasNewReady = ready.items.some((entity) => !session.readySnapshot.has(entity.id));
        const nextPhase = hasNewReady ? 'done' as const
          : routed >= session.files.length ? 'accumulating' as const
          : 'routing' as const;
        setRun((current) => current && current.id === session.id
          ? { ...current, routed, candidates, phase: nextPhase === 'done' ? 'accumulating' : nextPhase }
          : current);
        if (nextPhase === 'done') {
          // 新推荐落池：撤蒙层放行确认操作，toast 指路。
          finish();
          return;
        }
        if (routed > lastRouted || candidates > lastCandidates) {
          idleTicks = 0;
        } else {
          idleTicks += 1;
        }
        lastRouted = routed;
        lastCandidates = candidates;
        if (idleTicks >= RUN_IDLE_TIMEOUT_TICKS) stall();
      } catch {
        // 网关短暂不可用：下一轮重试；连续不可用同样计入无进度，超时兜底。
        idleTicks += 1;
        if (idleTicks >= RUN_IDLE_TIMEOUT_TICKS) stall();
      }
    };
    void poll();
    timer = window.setInterval(() => {
      if (!cancelled) void poll();
    }, RUN_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      if (timer !== null) window.clearInterval(timer);
    };
  }, [run?.id, runPolling]);

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

  if (!loaded) return null;

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
            aria-label={t('contextRoom:home.newRoom')}
            title={t('contextRoom:knowledgePending.newRoomFromUpload')}
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

      {run ? (
        <div
          className="context-room-knowledge-overlay"
          data-testid="context-room-recommendation-run"
          data-phase={run.phase}
        >
          <div className="context-room-knowledge-overlay-card">
            <header>
              {run.phase === 'failed'
                ? <AlertCircle aria-hidden="true" />
                : run.phase === 'timeout'
                  ? <Clock3 aria-hidden="true" />
                  : <LoaderCircle className="spin" aria-hidden="true" />}
              <strong>{run.intent
                ? t('contextRoom:creation.runIntentTitle', { intent: run.intent })
                : t('contextRoom:creation.runTitle')}</strong>
            </header>
            <div
              className="context-room-knowledge-overlay-bar"
              role="progressbar"
              aria-label={t('contextRoom:creation.runTitle')}
            >
              <div style={{ width: `${Math.round(runPercentOf(run))}%` }} />
            </div>
            <ol className="context-room-creation-steps" data-testid="context-room-creation-steps">
              <li data-state={run.phase === 'importing' ? 'active' : 'done'}>
                <span className="context-room-creation-step-icon">
                  {run.phase === 'importing'
                    ? <LoaderCircle className="spin" aria-hidden="true" />
                    : <Check aria-hidden="true" />}
                </span>
                <span className="context-room-creation-step-body">
                  <b>{t('contextRoom:creation.stepImport')}</b>
                  <small>{run.phase === 'importing'
                    ? t('contextRoom:creation.importProgress', {
                        current: run.imported.completed,
                        total: run.imported.total,
                      })
                    : run.failedImports > 0
                      ? t('contextRoom:creation.runImportPartial', {
                          ok: run.files.length,
                          failed: run.failedImports,
                        })
                      : t('contextRoom:creation.filesSelected', { count: run.files.length })}</small>
                </span>
              </li>
              <li data-state={run.phase === 'routing' ? 'active' : run.phase === 'importing' ? undefined : 'done'}>
                <span className="context-room-creation-step-icon">
                  {run.phase === 'routing'
                    ? <LoaderCircle className="spin" aria-hidden="true" />
                    : run.phase === 'importing' ? <span aria-hidden="true" /> : <Check aria-hidden="true" />}
                </span>
                <span className="context-room-creation-step-body">
                  <b>{t('contextRoom:creation.stepRoute')}</b>
                  <small>{run.phase === 'importing'
                    ? t('contextRoom:creation.stepWaiting')
                    : t('contextRoom:creation.routeProgress', { current: run.routed, total: run.files.length })}</small>
                </span>
              </li>
              <li data-state={run.phase === 'accumulating' || run.phase === 'timeout' ? 'active' : undefined}>
                <span className="context-room-creation-step-icon">
                  {run.phase === 'timeout'
                    ? <Clock3 aria-hidden="true" />
                    : run.phase === 'accumulating'
                      ? <LoaderCircle className="spin" aria-hidden="true" />
                      : <span aria-hidden="true" />}
                </span>
                <span className="context-room-creation-step-body">
                  <b>{t('contextRoom:creation.stepAccumulate')}</b>
                  <small>{run.phase === 'timeout'
                    ? t('contextRoom:creation.runTimeoutHint')
                    : run.phase === 'accumulating'
                      ? t('contextRoom:creation.runCandidates', { count: run.candidates })
                      : t('contextRoom:creation.stepWaiting')}</small>
                </span>
              </li>
            </ol>
            {run.phase === 'failed' ? (
              <p className="context-room-knowledge-overlay-note">{t('contextRoom:creation.runImportFailed')}</p>
            ) : null}
            {run.phase === 'timeout' || run.phase === 'failed' ? (
              <div className="context-room-knowledge-overlay-actions">
                {run.phase === 'failed' ? (
                  <button
                    type="button"
                    className="context-room-knowledge-overlay-retry"
                    onClick={() => void continueImport(run)}
                  >
                    {t('contextRoom:creation.runImportRetry')}
                  </button>
                ) : null}
                <button
                  type="button"
                  className="context-room-knowledge-overlay-dismiss"
                  onClick={() => setRun(null)}
                >
                  {t('contextRoom:creation.runDismiss')}
                </button>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {recommended.length === 0 && !runActive ? (
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
            const scoreRatio = 1;
            const promotion = entity.promotion;
            const isPromotionActive = promotion?.status === 'queued' || promotion?.status === 'running';
            const creationPercent = promotion ? promotionPercent(promotion) : 0;
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
                  {entity.existingRoomMatch
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
                      })}
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
