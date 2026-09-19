import { Compass, Lock, LockOpen, RotateCw, Sparkles, Target } from 'lucide-react';
import { useEffect, useState } from 'react';

import { useLocale } from '../../../../../i18n/LocaleContext';
import type {
  EmergenceCardDto,
  EmergenceFocusInput,
  EmergenceFocusLevel,
  EmergenceMode,
  EmergenceProjectionResultDto,
} from '../../../../../../../shared/knowledge';
import type { ContextRoomRecord } from '../../types';
import { useEmergence } from '../../hooks/useEmergence';
import { FocusTreeCanvas } from '../emergence-graph/FocusTreeCanvas';
import { SkeletonTreeCanvas } from '../emergence-graph/SkeletonTreeCanvas';
import { WalkJourneyCanvas } from '../emergence-graph/WalkJourneyCanvas';
import { resolveCenter } from '../emergence-graph/focusTreeModel';
import { backWalk, initialWalkLog, stepWalk, type WalkStation } from '../emergence-graph/walkModel';

/**
 * 思路板块（上图下卡）：聚焦=思维导图常驻 + 悬浮节点详情卡；漫游=步进链。
 * 工具条=聚焦/漫游分段 + 层级回退箭头 + 刷新；卡片流只存在于伴随区。
 */
export function IdeasBoardPane({
  room,
  focus,
  focusLabel,
  focusLevel,
  focusLocked,
  onToggleFocusLock,
}: {
  room: ContextRoomRecord;
  /** 焦点协调器输出：跨板块共享的当前焦点（编辑场景=章节/选区/产物，否则 Room）。 */
  focus: EmergenceFocusInput;
  focusLabel: string | null;
  focusLevel: EmergenceFocusLevel;
  focusLocked: boolean;
  onToggleFocusLock: () => void;
}) {
  const { t } = useLocale();
  const [mode, setMode] = useState<EmergenceMode>('focus');
  const [pinned, setPinned] = useState<EmergenceCardDto[]>([]);
  const focusCenterRef = focus.documentId ? `doc:${focus.documentId}` : `room:${room.id}`;
  const [focusPath, setFocusPath] = useState<{ stack: string[]; index: number }>(() => ({ stack: [focusCenterRef], index: 0 }));
  const [selectedNodeRef, setSelectedNodeRef] = useState<string | null>(null);
  const [walkLog, setWalkLog] = useState<WalkStation[]>([]);
  const [wanderStart, setWanderStart] = useState<{ nodeRef: string | null; label: string } | null>(null);

  const {
    focusResult, wanderResult, focusLoading, wanderLoading, error, request, wanderFrom,
  } = useEmergence({ roomId: room.id, focus, locked: focusLocked });

  // 树根听服务端的：章节级焦点时网关注入临时章节节点，钻取栈必须从章节长起
  const focusRootRef = focusResult?.focusRootRef ?? focusCenterRef;

  const focusLabelText = focusLevel === 'selection'
    ? t('contextRoom:emergence.selectionFocus')
    : (focusLabel || room.title);

  // 焦点源变化（换房间/换章节）=重置钻取历史与图内选中
  useEffect(() => {
    setFocusPath((p) => (p.stack[p.index] === focusRootRef ? p : { stack: [focusRootRef], index: 0 }));
    setSelectedNodeRef(null);
  }, [focusRootRef]);

  // 新的漫步结果=新的路：渲染期重置（无空帧），刷新/再走一次都不丢当前视图。
  // 上一次结果必须存 state（存 ref 会在严格模式双渲染下丢重置：首跑改了 ref，次跑看不到变化）。
  const [prevWanderResult, setPrevWanderResult] = useState<EmergenceProjectionResultDto | null>(null);
  if (wanderResult !== prevWanderResult) {
    setPrevWanderResult(wanderResult);
    const start = wanderResult && wanderResult.nodes.length > 0
      ? resolveCenter(wanderResult, wanderStart?.nodeRef ?? focusCenterRef)
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

  const refresh = () => {
    if (mode === 'focus') void request('focus');
    else wanderFrom(wanderStart?.nodeRef ?? null);
  };

  const drillTo = (nodeRef: string) => {
    setFocusPath((p) => {
      if (p.stack[p.index] === nodeRef) return p;
      const stack = p.stack.slice(0, p.index + 1);
      stack.push(nodeRef);
      return { stack, index: stack.length - 1 };
    });
    setSelectedNodeRef(null);
  };

  const goBackLevel = () => setFocusPath((p) => ({ ...p, index: Math.max(0, p.index - 1) }));
  const goForwardLevel = () => setFocusPath((p) => ({ ...p, index: Math.min(p.stack.length - 1, p.index + 1) }));

  const walkStep = (nodeRef: string) => {
    if (!wanderResult) return;
    setWalkLog((log) => stepWalk(wanderResult, room.id, log, nodeRef) ?? log);
  };

  const walkBackTo = (index: number) => setWalkLog((log) => backWalk(log, index));

  const pinCard = (card: EmergenceCardDto) => {
    setPinned((current) => current.some((item) => item.id === card.id) ? current : [...current, card]);
  };

  const focusCenter = resolveCenter(focusResult, focusPath.stack[focusPath.index] ?? focusCenterRef);
  const focusReturnRef = focusPath.index > 0 ? focusPath.stack[focusPath.index - 1] : null;

  const graphContent = mode === 'focus'
    ? (
        focusResult && focusResult.nodes.length > 0 ? (
          <FocusTreeCanvas
            result={focusResult}
            centerRef={focusCenter}
            returnRef={focusReturnRef}
            selectedNodeRef={selectedNodeRef}
            cards={focusResult.cards ?? []}
            onDrill={drillTo}
            onGoBack={goBackLevel}
            onSelectNode={setSelectedNodeRef}
            onCardAction={pinCard}
          />
        ) : focusLoading ? (
          <SkeletonTreeCanvas hint={t('contextRoom:emergence.projecting')} />
        ) : (
          <div className="eg-viewport eg-empty">{error ?? t('contextRoom:emergence.veinEmpty')}</div>
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
      <div className="context-room-thoughts-focus" title={focusLabelText}>
        <Sparkles aria-hidden="true" />
        <span>{t('contextRoom:emergence.focusPrefix')}</span>
        <strong>{focusLabelText}</strong>
      </div>
      <div className="context-room-thoughts-toolbar">
        <div className="context-room-thoughts-seg" role="tablist" aria-label={t('contextRoom:emergence.modeLabel')}>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'focus'}
            className={mode === 'focus' ? 'is-active' : ''}
            onClick={() => switchMode('focus')}
          >
            <Target aria-hidden="true" />
            {t('contextRoom:emergence.modeFocus')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'wander'}
            className={mode === 'wander' ? 'is-active' : ''}
            onClick={() => switchMode('wander')}
          >
            <Compass aria-hidden="true" />
            {t('contextRoom:emergence.modeWander')}
          </button>
        </div>
        {mode === 'focus' ? (
          <div className="context-room-thoughts-level-nav">
            <button
              type="button"
              disabled={focusPath.index === 0}
              title={t('contextRoom:emergence.treeBack')}
              aria-label={t('contextRoom:emergence.treeBack')}
              onClick={goBackLevel}
            >
              ‹
            </button>
            <button
              type="button"
              disabled={focusPath.index >= focusPath.stack.length - 1}
              title={t('contextRoom:emergence.treeForward')}
              aria-label={t('contextRoom:emergence.treeForward')}
              onClick={goForwardLevel}
            >
              ›
            </button>
          </div>
        ) : null}
        <div className="context-room-thoughts-toolbar-tools">
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
          <button type="button" onClick={refresh} title={t('contextRoom:emergence.refresh')}>
            <RotateCw aria-hidden="true" />
            {t('contextRoom:emergence.refresh')}
          </button>
        </div>
      </div>
      <div className="context-room-thoughts-board-body">
        {graphContent}
      </div>
      {mode === 'focus' && focusResult?.degraded ? (
        <p className="context-room-thoughts-degraded">{t('contextRoom:emergence.degraded')}</p>
      ) : null}
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
