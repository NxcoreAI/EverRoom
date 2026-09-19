import { Footprints, ListTree, Lock, LockOpen, Network, RotateCcw, Sparkles, Undo2 } from 'lucide-react';
import { useMemo, useState } from 'react';

import { useLocale } from '../../../../../i18n/LocaleContext';
import type { EmergenceCardDto, EmergenceFocusInput, EmergenceMode, EmergenceProjectionResultDto } from '../../../../../../../shared/knowledge';
import type { ContextRoomRecord } from '../../types';
import { useEmergence } from '../../hooks/useEmergence';
import { useFocusMindmap } from '../../hooks/useFocusMindmap';
import { FocusTreeCanvas } from '../emergence-graph/FocusTreeCanvas';
import { SkeletonTreeCanvas } from '../emergence-graph/SkeletonTreeCanvas';
import { WalkJourneyCanvas } from '../emergence-graph/WalkJourneyCanvas';
import { resolveCenter } from '../emergence-graph/focusTreeModel';
import { backWalk, initialWalkLog, stepWalk, type WalkStation } from '../emergence-graph/walkModel';
import { EmergenceCard } from './EmergenceCard';

/**
 * 思路面板 · 知识涌现：聚焦=默认态（agent 生成的思维导图，NotebookLM 式
 * 点击展开/收起）；漫步=底部入口进入的独立态（两个世界，整屏交叉过渡），
 * 再走一次=新 seed、沿此漫步=换起点。
 * 模式是临时态：不进 localStorage，重进面板落在聚焦。
 * 图视图：聚焦=树状导图（展开状态在画布内部）；漫步=步进链（walkLog 随结果身份重置）。
 */
export function ThoughtsPane({
  room,
  variant = 'board',
  focus,
  focusLabel,
  focusLocked,
  onToggleFocusLock,
  onQuote,
  onViewChange,
}: {
  room: ContextRoomRecord;
  /** board=独立板块；companion=伴随区（引用=光标处插块引用）。 */
  variant?: 'board' | 'companion';
  /** 焦点协调器输出的权威焦点档案。 */
  focus: EmergenceFocusInput;
  /** 非选区级别的焦点显示文案；选区级别显示 i18n 的「选区焦点」。 */
  focusLabel: string | null;
  focusLocked: boolean;
  onToggleFocusLock: () => void;
  onQuote?: (card: EmergenceCardDto) => void;
  /** 视图切换回调（伴随区据此扩展/收缩列宽）。 */
  onViewChange?: (view: 'cards' | 'graph') => void;
}) {
  const { t } = useLocale();
  const [mode, setMode] = useState<EmergenceMode>('focus');
  const [view, setView] = useState<'cards' | 'graph'>('cards');
  const locked = focusLocked;
  const [pinned, setPinned] = useState<EmergenceCardDto[]>([]);
  const [hiddenFocus, setHiddenFocus] = useState<Set<string>>(() => new Set());
  const [hiddenWander, setHiddenWander] = useState<Set<string>>(() => new Set());
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [wanderStart, setWanderStart] = useState<{ nodeRef: string | null; label: string } | null>(null);
  const [selectedNodeRef, setSelectedNodeRef] = useState<string | null>(null);
  const [walkLog, setWalkLog] = useState<WalkStation[]>([]);

  const {
    wanderResult, wanderLoading, error, wanderFrom,
  } = useEmergence({ roomId: room.id, focus });
  // 聚焦世界=agent 生成的思维导图（NotebookLM 式）；scope 只跟打开的文档走。
  const mindmap = useFocusMindmap({ roomId: room.id, documentId: focus.documentId ?? null });
  const focusResult = mindmap.projection;

  const focusLabelText = focus.level === 'selection'
    ? t('contextRoom:emergence.selectionFocus')
    : (focusLabel || room.title);
  const mindmapErrorText = mindmap.error === 'mindmap_no_content'
    ? t('contextRoom:emergence.mindmapNoContent')
    : t('contextRoom:emergence.mindmapFailed');
  const nodeLabels = useMemo(() => new Map(
    (mode === 'focus' ? focusResult?.nodes : wanderResult?.nodes)?.map((node) => [node.id, node.label]) ?? [],
  ), [mode, focusResult, wanderResult]);

  const visibleFocusCards = (focusResult?.cards ?? []).filter((card) => !hiddenFocus.has(card.id));
  const visibleWanderCards = (wanderResult?.cards ?? []).filter((card) => !hiddenWander.has(card.id));

  const enterWander = (startNodeRef: string | null, label: string) => {
    setMode('wander');
    setExpandedId(null);
    setWanderStart({ nodeRef: startNodeRef, label });
    wanderFrom(startNodeRef);
  };

  const backToFocus = () => {
    setMode('focus');
    setExpandedId(null);
    setWanderStart(null);
  };

  const pinCard = (card: EmergenceCardDto) => {
    setPinned((current) => current.some((item) => item.id === card.id) ? current : [...current, card]);
  };

  const quoteCard = (card: EmergenceCardDto) => {
    if (onQuote) onQuote(card);
    else pinCard(card);
  };

  const wanderLabel = wanderStart?.label ?? focusLabelText;
  const expandedCard = expandedId === null
    ? null
    : (mode === 'focus' ? focusResult?.cards : wanderResult?.cards)?.find((card) => card.id === expandedId) ?? null;

  // 树根听服务端的：导图根=mindmap:root，resolveCenter 兜底到 room/首节点
  const focusRootRef = resolveCenter(focusResult, focusResult?.focusRootRef ?? `room:${room.id}`);

  // 新导图=清图内选中：渲染期重置（无空帧）。上一份必须存 state
  // （存 ref 会在严格模式双渲染下丢重置）；focusRootRef 两级 scope 同名，须按结果身份判。
  const [prevFocusResult, setPrevFocusResult] = useState<EmergenceProjectionResultDto | null>(null);
  if (focusResult !== prevFocusResult) {
    setPrevFocusResult(focusResult);
    setSelectedNodeRef(null);
  }

  // 新的漫步结果=新的路：渲染期重置（无空帧），视图切换不丢。
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

  // 点图节点=切回卡片流并展开同一候选卡；卡片展开的 nodeRef 反向高亮图节点
  const openCardAtNode = (nodeRef: string) => {
    const card = (mode === 'focus' ? focusResult?.cards : wanderResult?.cards)
      ?.find((candidate) => candidate.nodeRef === nodeRef);
    if (!card) return;
    switchView('cards');
    setExpandedId(card.id);
  };

  const switchView = (next: 'cards' | 'graph') => {
    setView(next);
    onViewChange?.(next);
  };

  const selectGraphNode = (nodeRef: string | null) => {
    setSelectedNodeRef(nodeRef);
    if (nodeRef !== null) setExpandedId(null);
  };

  const walkStep = (nodeRef: string) => {
    if (!wanderResult) return;
    setWalkLog((log) => stepWalk(wanderResult, room.id, log, nodeRef) ?? log);
  };

  const walkBackTo = (index: number) => setWalkLog((log) => backWalk(log, index));

  const graphSelectedNode = expandedCard?.nodeRef ?? selectedNodeRef;

  const viewToggle = (
    <div className="context-room-thoughts-view-toggle" role="tablist" aria-label={t('contextRoom:emergence.viewToggle')}>
      <button
        type="button"
        role="tab"
        aria-selected={view === 'cards'}
        className={view === 'cards' ? 'is-active' : ''}
        title={t('contextRoom:emergence.viewCards')}
        onClick={() => switchView('cards')}
      >
        <ListTree aria-hidden="true" />
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={view === 'graph'}
        className={view === 'graph' ? 'is-active' : ''}
        title={t('contextRoom:emergence.viewVein')}
        onClick={() => switchView('graph')}
      >
        <Network aria-hidden="true" />
      </button>
    </div>
  );

  return (
    <div className="context-room-thoughts-pane" data-variant={variant} data-mode={mode}>
      <div className="context-room-thoughts-world" data-world="focus" aria-hidden={mode !== 'focus'}>
        <header className="context-room-thoughts-header">
          <div className="context-room-thoughts-focus" title={focusLabelText}>
            <Sparkles aria-hidden="true" />
            <span>{t('contextRoom:emergence.focusPrefix')}</span>
            <strong>{focusLabelText}</strong>
          </div>
          <div className="context-room-thoughts-header-actions">
            {viewToggle}
            <button
              type="button"
              className={locked ? 'context-room-thoughts-lock is-locked' : 'context-room-thoughts-lock'}
              aria-pressed={locked}
              aria-label={t('contextRoom:emergence.lockFocus')}
              title={t(locked ? 'contextRoom:emergence.unlockFocus' : 'contextRoom:emergence.lockFocus')}
              onClick={onToggleFocusLock}
            >
              {locked ? <Lock aria-hidden="true" /> : <LockOpen aria-hidden="true" />}
            </button>
          </div>
        </header>
        {view === 'cards' ? (
          <div className="context-room-emergence-cards">
            {mindmap.failed ? (
              <div className="context-room-workspace-empty">
                <span>{mindmapErrorText}</span>
                <button type="button" className="context-room-panel-empty-action" onClick={mindmap.retry}>
                  {t('contextRoom:emergence.mindmapRetry')}
                </button>
              </div>
            ) : (
              <>
                {visibleFocusCards.map((card) => (
                  <EmergenceCard
                    key={card.id}
                    card={card}
                    mode="focus"
                    nodeLabels={nodeLabels}
                    expanded={expandedId === card.id}
                    onToggle={() => setExpandedId((current) => current === card.id ? null : card.id)}
                    onPrimaryAction={() => quoteCard(card)}
                    onPin={() => pinCard(card)}
                    onHide={() => setHiddenFocus((current) => new Set(current).add(card.id))}
                  />
                ))}
                {mindmap.generating && visibleFocusCards.length === 0 ? (
                  <div className="context-room-workspace-empty">{t('contextRoom:emergence.mindmapGenerating')}</div>
                ) : !mindmap.generating && visibleFocusCards.length === 0 ? (
                  <div className="context-room-workspace-empty">{t('contextRoom:emergence.noCardsYet')}</div>
                ) : null}
              </>
            )}
          </div>
        ) : mindmap.failed ? (
          <div className="context-room-workspace-empty">
            <span>{mindmapErrorText}</span>
            <button type="button" className="context-room-panel-empty-action" onClick={mindmap.retry}>
              {t('contextRoom:emergence.mindmapRetry')}
            </button>
          </div>
        ) : focusResult && focusResult.nodes.length > 0 ? (
          <div className="context-room-thoughts-graph">
            <FocusTreeCanvas
              result={focusResult}
              rootRef={focusRootRef}
              selectedNodeRef={graphSelectedNode}
              cards={visibleFocusCards}
              onSelectNode={selectGraphNode}
              onOpenCard={openCardAtNode}
              onCardAction={quoteCard}
            />
          </div>
        ) : mindmap.generating ? (
          <div className="context-room-thoughts-graph">
            <SkeletonTreeCanvas hint={t('contextRoom:emergence.mindmapGenerating')} />
          </div>
        ) : (
          <div className="context-room-workspace-empty">{t('contextRoom:emergence.veinEmpty')}</div>
        )}
        {pinned.length > 0 ? (
          <section className="context-room-thoughts-pinned">
            {pinned.map((card) => (
              <span key={card.id} className="context-room-thoughts-pinned-item" title={card.title}>
                {card.title}
              </span>
            ))}
          </section>
        ) : null}
        <footer className="context-room-thoughts-entry">
          <button type="button" onClick={() => enterWander(null, focusLabelText)}>
            <Footprints aria-hidden="true" />
            {t('contextRoom:emergence.wanderEntry')}
          </button>
        </footer>
      </div>

      <div className="context-room-thoughts-world" data-world="wander" aria-hidden={mode === 'focus'}>
        <header className="context-room-thoughts-header">
          <div className="context-room-thoughts-focus" title={wanderLabel}>
            <Footprints aria-hidden="true" />
            <span>{t('contextRoom:emergence.wanderFrom')}</span>
            <strong>{wanderLabel}</strong>
          </div>
          <div className="context-room-thoughts-header-actions">
            {viewToggle}
            <div className="context-room-thoughts-wander-actions">
              <button type="button" onClick={() => wanderFrom(wanderStart?.nodeRef ?? null)}>
                <RotateCcw aria-hidden="true" />
                {t('contextRoom:emergence.wanderAgain')}
              </button>
              <button type="button" onClick={backToFocus}>
                <Undo2 aria-hidden="true" />
                {t('contextRoom:emergence.backToFocus')}
              </button>
            </div>
          </div>
        </header>
        {view === 'cards' ? (
          <div className="context-room-emergence-cards">
            {visibleWanderCards.map((card) => (
              <EmergenceCard
                key={card.id}
                card={card}
                mode="wander"
                nodeLabels={nodeLabels}
                expanded={expandedId === card.id}
                onToggle={() => setExpandedId((current) => current === card.id ? null : card.id)}
                onPrimaryAction={() => enterWander(card.nodeRef, card.title)}
                onPin={() => pinCard(card)}
                onHide={() => setHiddenWander((current) => new Set(current).add(card.id))}
              />
            ))}
            {!wanderLoading && visibleWanderCards.length === 0 ? (
              <div className="context-room-workspace-empty">
                {error ?? t('contextRoom:emergence.wanderEmpty')}
              </div>
            ) : null}
            {wanderLoading ? (
              <div className="context-room-workspace-empty">{t('contextRoom:emergence.wandering')}</div>
            ) : null}
          </div>
        ) : wanderResult && wanderResult.nodes.length > 0 ? (
          <div className="context-room-thoughts-graph">
            <WalkJourneyCanvas
              result={wanderResult}
              roomId={room.id}
              log={walkLog}
              cards={visibleWanderCards}
              onStep={walkStep}
              onBackTo={walkBackTo}
              onWalkAgain={() => wanderFrom(wanderStart?.nodeRef ?? null)}
            />
          </div>
        ) : (
          <div className="context-room-workspace-empty">{t('contextRoom:emergence.veinEmpty')}</div>
        )}
      </div>
    </div>
  );
}
