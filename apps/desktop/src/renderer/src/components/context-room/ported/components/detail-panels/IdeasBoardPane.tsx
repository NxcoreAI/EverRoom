import { Compass, RotateCw, Target } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { useLocale } from '../../../../../i18n/LocaleContext';
import type { EmergenceCardDto, EmergenceMode, EmergenceProjectionResultDto } from '../../../../../../../shared/knowledge';
import type { ContextRoomRecord } from '../../types';
import { useEmergence } from '../../hooks/useEmergence';
import { FocusTreeCanvas } from '../emergence-graph/FocusTreeCanvas';
import { WalkJourneyCanvas } from '../emergence-graph/WalkJourneyCanvas';
import { resolveCenter } from '../emergence-graph/focusTreeModel';
import { backWalk, initialWalkLog, stepWalk, type WalkStation } from '../emergence-graph/walkModel';

/** 投影中的图占位：胶囊骨架 + 提示语（数据未到时不空白）。圆点按中心定位（translate -50%），坐标与连线端点一一对应。 */
function GraphSkeleton({ hint }: { hint: string }) {
  const pills: Array<[string, string, string]> = [
    ['14%', '50%', 'is-center'],
    ['38%', '22%', ''],
    ['38%', '78%', ''],
    ['62%', '10%', ''],
    ['62%', '34%', ''],
    ['62%', '66%', ''],
    ['62%', '90%', ''],
  ];
  return (
    <div className="eg-viewport eg-skeleton" aria-busy="true">
      <svg className="eg-skeleton-edges" aria-hidden="true" viewBox="0 0 100 100" preserveAspectRatio="none">
        <path vectorEffect="non-scaling-stroke" d="M 14 50 C 24 50, 28 22, 38 22" />
        <path vectorEffect="non-scaling-stroke" d="M 14 50 C 24 50, 28 78, 38 78" />
        <path vectorEffect="non-scaling-stroke" d="M 38 22 C 48 22, 52 10, 62 10" />
        <path vectorEffect="non-scaling-stroke" d="M 38 22 C 48 22, 52 34, 62 34" />
        <path vectorEffect="non-scaling-stroke" d="M 38 78 C 48 78, 52 66, 62 66" />
        <path vectorEffect="non-scaling-stroke" d="M 38 78 C 48 78, 52 90, 62 90" />
      </svg>
      {pills.map(([left, top, cls]) => (
        <span key={`${left}-${top}`} className={`eg-sk ${cls}`} style={{ left, top }} />
      ))}
      <p className="eg-skeleton-hint">{hint}</p>
    </div>
  );
}

/**
 * 思路板块（上图下卡）：聚焦=思维导图常驻 + 悬浮节点详情卡；漫游=步进链。
 * 工具条=聚焦/漫游分段 + 层级回退箭头 + 刷新；卡片流只存在于伴随区。
 */
export function IdeasBoardPane({ room }: { room: ContextRoomRecord }) {
  const { t } = useLocale();
  const [mode, setMode] = useState<EmergenceMode>('focus');
  const [pinned, setPinned] = useState<EmergenceCardDto[]>([]);
  const focusCenterRef = `room:${room.id}`;
  const [focusPath, setFocusPath] = useState<{ stack: string[]; index: number }>(() => ({ stack: [focusCenterRef], index: 0 }));
  const [selectedNodeRef, setSelectedNodeRef] = useState<string | null>(null);
  const [walkLog, setWalkLog] = useState<WalkStation[]>([]);
  const [wanderStart, setWanderStart] = useState<{ nodeRef: string | null; label: string } | null>(null);

  const focusInput = useMemo(() => ({ documentId: null, selectionText: null, blockId: null }), []);
  const {
    focusResult, wanderResult, focusLoading, wanderLoading, error, request, wanderFrom,
  } = useEmergence({ roomId: room.id, focus: focusInput });

  // 焦点源变化（换房间）=重置钻取历史与图内选中
  useEffect(() => {
    setFocusPath((p) => (p.stack[p.index] === focusCenterRef ? p : { stack: [focusCenterRef], index: 0 }));
    setSelectedNodeRef(null);
  }, [focusCenterRef]);

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
          <GraphSkeleton hint={t('contextRoom:emergence.projecting')} />
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
          <GraphSkeleton hint={t('contextRoom:emergence.wandering')} />
        ) : (
          <div className="eg-viewport eg-empty">{error ?? t('contextRoom:emergence.wanderEmpty')}</div>
        )
      );

  return (
    <div className="context-room-thoughts-pane" data-variant="board" data-mode={mode}>
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
