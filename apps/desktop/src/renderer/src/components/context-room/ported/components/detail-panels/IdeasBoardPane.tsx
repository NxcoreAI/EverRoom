import { Compass, Lock, LockOpen, Target } from 'lucide-react';
import { Fragment, useEffect, useMemo, useState } from 'react';

import { useLocale } from '../../../../../i18n/LocaleContext';
import type { EmergenceFocusInput, EmergenceMode } from '../../../../../../../shared/knowledge';
import type { ContextRoomRecord } from '../../types';
import { useEmergence } from '../../hooks/useEmergence';
import { useRouteMindmap } from '../../hooks/useRouteMindmap';
import { FocusTreeCanvas } from '../emergence-graph/FocusTreeCanvas';
import { SkeletonTreeCanvas } from '../emergence-graph/SkeletonTreeCanvas';
import { WalkJourneyCanvas } from '../emergence-graph/WalkJourneyCanvas';
import { resolveCenter } from '../emergence-graph/focusTreeModel';
import { backWalk, initialWalkLog, nextHops, stepWalk, type WalkStation } from '../emergence-graph/walkModel';
import { ROUTE_MAX_DEPTH, routeNodeDepth, routePathProjection, routePathTo, routeProjectionCards, routeProjectionToGraph, routeTailNode } from './routeProjection';

/**
 * 思路板块：聚焦=当前文档的写作路线导图（路径链+当前分岔，点选项续生一层、
 * 点路径上级回退；「就按这条路写」拍板后只读浏览——点节点本地换层不触发生成）；
 * 漫游=步进链不动。
 */
export function IdeasBoardPane({
  room,
  focus,
  focusLocked,
  onToggleFocusLock,
}: {
  room: ContextRoomRecord;
  /** 焦点协调器输出：跨板块共享的当前焦点（编辑场景=章节/选区/产物，否则 Room）。 */
  focus: EmergenceFocusInput;
  focusLocked: boolean;
  onToggleFocusLock: () => void;
}) {
  const { t } = useLocale();
  const [mode, setMode] = useState<EmergenceMode>('focus');
  const [selectedNodeRef, setSelectedNodeRef] = useState<string | null>(null);
  const [walkLog, setWalkLog] = useState<WalkStation[]>([]);
  const [wanderStart, setWanderStart] = useState<{ nodeRef: string | null; label: string } | null>(null);

  const {
    wanderResult, wanderLoading, extending, journeyKey, error, wanderFrom, extendWalk,
  } = useEmergence({ roomId: room.id, focus });
  // 聚焦=写作路线导图，跟着打开的文档走。
  const route = useRouteMindmap({ roomId: room.id, documentId: focus.documentId ?? null });
  const routeView = route.view;
  // 已拍板后的只读浏览路径（本地视图，不改服务端已选路线）；换文档即清。
  const [finalPath, setFinalPath] = useState<string[] | null>(null);
  const [prevDocId, setPrevDocId] = useState<string | null>(null);
  if (routeView && routeView.documentId !== prevDocId) {
    setPrevDocId(routeView.documentId);
    setFinalPath(null);
  }
  const viewPath = routeView?.status === 'finalized' && finalPath ? finalPath : routeView?.selectionPath ?? null;
  const projection = useMemo(
    () => routePathProjection(routeView?.graph ?? null, viewPath),
    [routeView, viewPath],
  );
  const routeCards = useMemo(() => routeProjectionCards(projection), [projection]);
  // 续层生成中：目标节点下挂骨架占位子级（生成动画）。
  const pendingChildren = routeView?.status === 'expanding' && routeView.graph && routeView.expandingNodeRef
    ? { parentRef: routeView.expandingNodeRef }
    : null;
  const routeCanvasResult = useMemo(() => {
    const graph = routeProjectionToGraph(projection);
    if (!graph || !routeView?.graph) return null;
    return {
      cards: [] as never[],
      nodes: graph.nodes,
      edges: graph.edges,
      paths: [],
      focusRootRef: routeView.graph.root.ref,
      scoreComponents: null,
      requestVersion: routeView.requestVersion,
      degraded: false,
      degradedReason: null,
      generatedAt: routeView.generatedAt ?? '',
    };
  }, [projection, routeView]);

  // 路线内容变化（文档/状态/尾节点）= 选中回落当前尾节点：渲染期重置（无空帧）。
  // 轮询带来的同内容新对象不触发回落，用户手动选中的节点保持。
  const tailRef = projection ? routeTailNode(projection)?.ref ?? null : null;
  const routeResetKey = routeView ? `${routeView.documentId}|${routeView.status}|${tailRef ?? ''}` : '';
  const [prevResetKey, setPrevResetKey] = useState<string | null>(null);
  if (routeResetKey !== prevResetKey) {
    setPrevResetKey(routeResetKey);
    setSelectedNodeRef(tailRef);
  }

  // 骨架→真图交叉过渡：初始生成完成时骨架淡出（真图同帧淡入），280ms 后卸载。
  const skeletonShown = mode === 'focus' && !!focus.documentId && routeView !== null
    && routeView.status === 'expanding' && !routeView.graph;
  const [prevSkeleton, setPrevSkeleton] = useState<boolean | null>(null);
  const [skeletonLeaving, setSkeletonLeaving] = useState(false);
  if (skeletonShown !== prevSkeleton) {
    setPrevSkeleton(skeletonShown);
    if (prevSkeleton === true && skeletonShown === false) setSkeletonLeaving(true);
  }
  useEffect(() => {
    if (!skeletonLeaving) return;
    const timer = window.setTimeout(() => setSkeletonLeaving(false), 280);
    return () => window.clearTimeout(timer);
  }, [skeletonLeaving]);

  // 路线点击：路径上级=回退到该层（下层已生成选项重新露出）；尾节点子级=选它并
  // 续生一层（已有子级时服务端只挪 selectionPath）。回退是纯本地操作，生成中
  // （expanding）也放行——否则生成中点上级只剩镜头挪过去、分岔露不出来；
  // 续生只在 active 态且未到末梢层（全图最多四层，末梢点选只选中）；
  // 已拍板=只读浏览（同普通导图）：点父级露出全部分岔、点选项沿链下钻，
  // 点末端叶子则收缩成路径链；只改本地视图路径，不触发续生、不改服务端已选路线。
  const onRouteSelect = (nodeRef: string | null) => {
    if (nodeRef) setSelectedNodeRef(nodeRef);
    if (!nodeRef || !routeView || !projection) return;
    const depth = projection.path.findIndex((node) => node.ref === nodeRef);
    if (routeView.status === 'finalized') {
      if (depth >= 0) {
        if (depth < projection.path.length - 1) setFinalPath(projection.path.slice(0, depth + 1).map((node) => node.ref));
        return;
      }
      const chain = routeView.graph ? routePathTo(routeView.graph.root, nodeRef) : null;
      // 点选项（含末端叶子）都换层：点有子级的露出其全部分岔，点叶子则视图收缩成
      // 路径链——前面父级的分岔全部收起，画面聚焦到这条链。
      if (chain) setFinalPath(chain.map((node) => node.ref));
      return;
    }
    if (depth >= 0) {
      if (depth < projection.path.length - 1
        && (routeView.status === 'active' || routeView.status === 'expanding')) route.back(depth);
      return;
    }
    if (routeView.status === 'active'
      && (routeNodeDepth(projection, nodeRef) ?? 0) < ROUTE_MAX_DEPTH - 1) route.expand(nodeRef);
  };

  const routeErrorText = routeView?.error === 'route_no_material'
    ? t('contextRoom:routeMindmap.noMaterial')
    : t('contextRoom:routeMindmap.failed');

  // 新的旅程（入口/再走一次）=新的路：渲染期重置（无空帧）。以 journeyKey 而非
  // 结果对象身份判断——续走（extendWalk）合并出的新对象不再重置路径，脚下扩充而已。
  // 上一次 key 必须存 state（存 ref 会在严格模式双渲染下丢重置：首跑改了 ref，次跑看不到变化）。
  const [prevJourneyKey, setPrevJourneyKey] = useState<number>(-1);
  if (journeyKey !== prevJourneyKey && wanderResult) {
    setPrevJourneyKey(journeyKey);
    const start = wanderResult.nodes.length > 0
      ? resolveCenter(wanderResult, wanderStart?.nodeRef ?? '')
      : '';
    const reset: WalkStation[] = start ? initialWalkLog(start) : [];
    if (walkLog.length !== reset.length || (reset.length > 0 && walkLog[0].nodeRef !== reset[0].nodeRef)) {
      setWalkLog(reset);
    }
  }

  // 自动续走（步进永不停）：下一跳候选不足两条且未在续走时，以当前驻足为起点
  // 再投影一次并合并——尽头变成「还在展开」，桥接点过去仍有下文。
  const candidateHops = useMemo(
    () => (wanderResult && walkLog.length > 0 ? nextHops(wanderResult, room.id, walkLog) : []),
    [wanderResult, walkLog, room.id],
  );
  useEffect(() => {
    if (mode !== 'wander' || !wanderResult || walkLog.length === 0 || extending) return;
    if (candidateHops.length >= 2) return;
    void extendWalk(walkLog[walkLog.length - 1].nodeRef);
  }, [mode, wanderResult, walkLog, candidateHops, extending, extendWalk]);

  const switchMode = (next: EmergenceMode) => {
    if (next === mode) return;
    setMode(next);
    setSelectedNodeRef(null);
    if (next === 'wander') {
      setWanderStart({ nodeRef: null, label: room.title });
      wanderFrom(null);
    }
  };

  const walkStep = (nodeRef: string) => {
    if (!wanderResult) return;
    setWalkLog((log) => stepWalk(wanderResult, room.id, log, nodeRef) ?? log);
  };

  const walkBackTo = (index: number) => setWalkLog((log) => backWalk(log, index));

  const routeStatusText = route.actionError
    ?? (routeView?.status === 'expanding' && routeView.graph ? t('contextRoom:routeMindmap.generatingMore')
      : routeView?.writing ? t('contextRoom:routeMindmap.writing')
        : routeView?.status === 'finalized' ? t('contextRoom:routeMindmap.finalized') : null);
  const canSkip = routeView?.status === 'expanding' && !routeView.graph;
  const canFinalize = routeView?.status === 'active' && (routeView.selectionPath?.length ?? 0) > 1;

  // 路径链过长时只留尾部四段（头部 … 收起），点按钮=回退到该层。
  const chain = useMemo(() => {
    if (!projection) return null;
    const nodes = projection.path;
    return nodes.length <= 5
      ? { leadGap: false, nodes }
      : { leadGap: true, nodes: nodes.slice(nodes.length - 4) };
  }, [projection]);

  const graphContent = mode === 'focus'
    ? (
        !focus.documentId ? (
          <div className="eg-viewport eg-empty">{t('contextRoom:routeMindmap.noDocument')}</div>
        ) : routeView === null ? (
          <div className="eg-viewport eg-empty" />
        ) : routeView.status === 'failed' ? (
          <div className="eg-viewport eg-empty">
            <span>{routeErrorText}</span>
            <button type="button" className="context-room-panel-empty-action" onClick={route.retry}>
              {t('contextRoom:routeMindmap.retry')}
            </button>
          </div>
        ) : routeCanvasResult && routeView.graph ? (
          <FocusTreeCanvas
            result={routeCanvasResult}
            rootRef={routeView.graph.root.ref}
            selectedNodeRef={selectedNodeRef}
            cards={routeCards}
            pending={pendingChildren}
            onSelectNode={onRouteSelect}
          />
        ) : routeView.status === 'expanding' ? (
          <SkeletonTreeCanvas hint={t('contextRoom:routeMindmap.generating')} />
        ) : (
          <div className="eg-viewport eg-empty">
            <span>{t('contextRoom:routeMindmap.empty')}</span>
            <button type="button" className="context-room-panel-empty-action" onClick={() => route.start()}>
              {t('contextRoom:routeMindmap.start')}
            </button>
          </div>
        )
      )
    : (
        wanderResult && wanderResult.nodes.length > 0 ? (
          <WalkJourneyCanvas
            result={wanderResult}
            roomId={room.id}
            log={walkLog}
            cards={wanderResult.cards ?? []}
            pending={extending}
            onStep={walkStep}
            onBackTo={walkBackTo}
            onWalkAgain={() => wanderFrom(wanderStart?.nodeRef ?? null)}
          />
        ) : wanderLoading ? (
          <SkeletonTreeCanvas hint={t('contextRoom:emergence.wandering')} />
        ) : (
          <div className="eg-viewport eg-empty">{error ?? t('contextRoom:emergence.wanderEmpty')}</div>
        )
      );

  return (
    <div className="context-room-thoughts-pane" data-variant="board" data-mode={mode}>
      <div className="context-room-thoughts-head">
        {mode === 'focus' && chain ? (
          <nav className="context-room-thoughts-path" aria-label={t('contextRoom:emergence.pathLabel')}>
            {chain.leadGap ? <span className="is-gap">…</span> : null}
            {chain.nodes.map((node, position) => {
              const sep = position === 0 && !chain.leadGap
                ? null
                : <span className="is-sep" aria-hidden="true">›</span>;
              return position === chain.nodes.length - 1 ? (
                <Fragment key={node.ref}>
                  {sep}
                  <strong className="is-current" title={node.label}>{node.label}</strong>
                </Fragment>
              ) : (
                <Fragment key={node.ref}>
                  {sep}
                  <button type="button" title={node.label} onClick={() => onRouteSelect(node.ref)}>
                    {node.label}
                  </button>
                </Fragment>
              );
            })}
          </nav>
        ) : <div className="context-room-thoughts-path" />}
        <div className="context-room-thoughts-head-actions">
          {mode === 'focus' && routeStatusText ? (
            <span className="context-room-thoughts-route-status">{routeStatusText}</span>
          ) : null}
          {mode === 'focus' && canSkip ? (
            <button type="button" className="context-room-thoughts-route-action" onClick={route.skip}>
              {t('contextRoom:routeMindmap.skip')}
            </button>
          ) : null}
          {mode === 'focus' && canFinalize ? (
            <button type="button" className="context-room-thoughts-route-action is-primary" onClick={route.finalize}>
              {t('contextRoom:routeMindmap.finalize')}
            </button>
          ) : null}
          <button
            type="button"
            className={focusLocked ? 'context-room-thoughts-lock is-locked' : 'context-room-thoughts-lock'}
            aria-pressed={focusLocked}
            aria-label={t('contextRoom:emergence.lockFocus')}
            title={t(focusLocked ? 'contextRoom:emergence.unlockFocus' : 'contextRoom:emergence.lockFocus')}
            onClick={onToggleFocusLock}
          >
            {focusLocked ? <Lock aria-hidden="true" /> : <LockOpen aria-hidden="true" />}
          </button>
          <button
            type="button"
            className="context-room-thoughts-flip"
            aria-label={t(mode === 'focus' ? 'contextRoom:emergence.switchToWander' : 'contextRoom:emergence.switchToFocus')}
            title={t(mode === 'focus' ? 'contextRoom:emergence.switchToWander' : 'contextRoom:emergence.switchToFocus')}
            onClick={() => switchMode(mode === 'focus' ? 'wander' : 'focus')}
          >
            <span className="context-room-thoughts-flip-inner" aria-hidden="true">
              <span className="context-room-thoughts-flip-face is-front">
                <Target aria-hidden="true" />
                {t('contextRoom:emergence.modeFocus')}
              </span>
              <span className="context-room-thoughts-flip-face is-back">
                <Compass aria-hidden="true" />
                {t('contextRoom:emergence.modeWander')}
              </span>
            </span>
          </button>
        </div>
      </div>
      <div className="context-room-thoughts-board-body">
        {graphContent}
        {skeletonLeaving ? (
          <div className="eg-skeleton-leave">
            <SkeletonTreeCanvas />
          </div>
        ) : null}
      </div>
    </div>
  );
}
