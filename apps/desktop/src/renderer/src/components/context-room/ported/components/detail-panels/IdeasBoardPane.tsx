import { Compass, Lock, LockOpen, Target } from 'lucide-react';
import { useMemo, useState } from 'react';

import { useLocale } from '../../../../../i18n/LocaleContext';
import type {
  EmergenceCardDto,
  EmergenceFocusInput,
  EmergenceMode,
  EmergenceProjectionResultDto,
} from '../../../../../../../shared/knowledge';
import type { ContextRoomRecord } from '../../types';
import { useEmergence } from '../../hooks/useEmergence';
import { useFocusMindmap } from '../../hooks/useFocusMindmap';
import { FocusTreeCanvas } from '../emergence-graph/FocusTreeCanvas';
import { SkeletonTreeCanvas } from '../emergence-graph/SkeletonTreeCanvas';
import { WalkJourneyCanvas } from '../emergence-graph/WalkJourneyCanvas';
import { resolveCenter } from '../emergence-graph/focusTreeModel';
import { backWalk, initialWalkLog, stepWalk, type WalkStation } from '../emergence-graph/walkModel';

/**
 * 思路板块（上图下卡）：聚焦=思维导图常驻（NotebookLM 式点击展开/收起）；
 * 漫游=步进链。头部一行=路径链（父级 › 当前 › 可能的子级，其余 …）+
 * 右上角锁定与聚焦/漫游正反面切换；卡片流只存在于伴随区。
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
  const [pinned, setPinned] = useState<EmergenceCardDto[]>([]);
  const [selectedNodeRef, setSelectedNodeRef] = useState<string | null>(null);
  const [walkLog, setWalkLog] = useState<WalkStation[]>([]);
  const [wanderStart, setWanderStart] = useState<{ nodeRef: string | null; label: string } | null>(null);

  const {
    wanderResult, wanderLoading, error, wanderFrom,
  } = useEmergence({ roomId: room.id, focus });
  // 聚焦世界=agent 生成的思维导图（NotebookLM 式）；scope 只跟打开的文档走。
  const mindmap = useFocusMindmap({ roomId: room.id, documentId: focus.documentId ?? null });
  const focusResult = mindmap.projection;

  // 树根听服务端的：导图根=mindmap:root，resolveCenter 兜底到 room/首节点
  const focusRootRef = resolveCenter(focusResult, focusResult?.focusRootRef ?? `room:${room.id}`);

  const mindmapErrorText = mindmap.error === 'mindmap_no_content'
    ? t('contextRoom:emergence.mindmapNoContent')
    : t('contextRoom:emergence.mindmapFailed');

  // 头部路径链：当前选中（无选中=根）只带直接父级与第一个子级，更远的层级收成 …
  const chain = useMemo(() => {
    if (!focusResult || focusResult.nodes.length === 0) return null;
    const byId = new Map(focusResult.nodes.map((node) => [node.id, node]));
    const parentOf = new Map<string, string>();
    const firstChildOf = new Map<string, string>();
    const childCount = new Map<string, number>();
    for (const edge of focusResult.edges) {
      if (!parentOf.has(edge.to)) parentOf.set(edge.to, edge.from);
      if (!firstChildOf.has(edge.from)) firstChildOf.set(edge.from, edge.to);
      childCount.set(edge.from, (childCount.get(edge.from) ?? 0) + 1);
    }
    const currentId = selectedNodeRef && byId.has(selectedNodeRef) ? selectedNodeRef : focusRootRef;
    const current = byId.get(currentId);
    if (!current) return null;
    const parentId = parentOf.get(currentId);
    const parent = parentId ? byId.get(parentId) ?? null : null;
    const childId = firstChildOf.get(currentId);
    const child = childId ? byId.get(childId) ?? null : null;
    return {
      leftGap: parent !== null && parentOf.has(parent.id),
      parent,
      current,
      child,
      rightGap: child !== null && (childCount.get(child.id) ?? 0) > 0,
    };
  }, [focusResult, selectedNodeRef, focusRootRef]);

  // 新导图=清图内选中：渲染期重置（无空帧）。上一份必须存 state
  // （存 ref 会在严格模式双渲染下丢重置）。
  const [prevFocusResult, setPrevFocusResult] = useState<EmergenceProjectionResultDto | null>(null);
  if (focusResult !== prevFocusResult) {
    setPrevFocusResult(focusResult);
    setSelectedNodeRef(null);
  }

  // 新的漫步结果=新的路：渲染期重置（无空帧），刷新/再走一次都不丢当前视图。
  // 上一次结果必须存 state（存 ref 会在严格模式双渲染下丢重置：首跑改了 ref，次跑看不到变化）。
  const [prevWanderResult, setPrevWanderResult] = useState<EmergenceProjectionResultDto | null>(null);
  if (wanderResult !== prevWanderResult) {
    setPrevWanderResult(wanderResult);
    const start = wanderResult && wanderResult.nodes.length > 0
      ? resolveCenter(wanderResult, wanderStart?.nodeRef ?? '')
      : '';
    const reset: WalkStation[] = start ? initialWalkLog(start) : [];
    if (walkLog.length !== reset.length || (reset.length > 0 && walkLog[0].nodeRef !== reset[0].nodeRef)) {
      setWalkLog(reset);
    }
  }

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

  const pinCard = (card: EmergenceCardDto) => {
    setPinned((current) => current.some((item) => item.id === card.id) ? current : [...current, card]);
  };

  const graphContent = mode === 'focus'
    ? (
        mindmap.failed ? (
          <div className="eg-viewport eg-empty">
            <span>{mindmapErrorText}</span>
            <button type="button" className="context-room-panel-empty-action" onClick={mindmap.retry}>
              {t('contextRoom:emergence.mindmapRetry')}
            </button>
          </div>
        ) : focusResult && focusResult.nodes.length > 0 ? (
          <FocusTreeCanvas
            result={focusResult}
            rootRef={focusRootRef}
            selectedNodeRef={selectedNodeRef}
            cards={focusResult.cards ?? []}
            onSelectNode={setSelectedNodeRef}
            onCardAction={pinCard}
          />
        ) : mindmap.generating ? (
          <SkeletonTreeCanvas hint={t('contextRoom:emergence.mindmapGenerating')} />
        ) : (
          <div className="eg-viewport eg-empty">{t('contextRoom:emergence.veinEmpty')}</div>
        )
      )
    : (
        wanderResult && wanderResult.nodes.length > 0 ? (
          <WalkJourneyCanvas
            result={wanderResult}
            roomId={room.id}
            log={walkLog}
            cards={wanderResult.cards ?? []}
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
        {chain ? (
          <nav className="context-room-thoughts-path" aria-label={t('contextRoom:emergence.pathLabel')}>
            {chain.leftGap ? <span className="is-gap">…</span> : null}
            {chain.parent ? (
              <>
                <button type="button" title={chain.parent.label} onClick={() => setSelectedNodeRef(chain.parent!.id)}>
                  {chain.parent.label}
                </button>
                <span className="is-sep" aria-hidden="true">›</span>
              </>
            ) : null}
            <strong className="is-current" title={chain.current.label}>{chain.current.label}</strong>
            {chain.child ? (
              <>
                <span className="is-sep" aria-hidden="true">›</span>
                <button type="button" title={chain.child.label} onClick={() => setSelectedNodeRef(chain.child!.id)}>
                  {chain.child.label}
                </button>
                {chain.rightGap ? <span className="is-gap">…</span> : null}
              </>
            ) : null}
          </nav>
        ) : <div className="context-room-thoughts-path" />}
        <div className="context-room-thoughts-head-actions">
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
      </div>
      {pinned.length > 0 ? (
        <section className="context-room-thoughts-pinned">
          {pinned.map((card) => (
            <span key={card.id} className="context-room-thoughts-pinned-item" title={card.title}>
              {card.title}
            </span>
          ))}
        </section>
      ) : null}
    </div>
  );
}
