import { Compass, Lock, LockOpen, Maximize2, Target, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

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
import { resolveCenter } from '../emergence-graph/focusTreeModel';
import { EmergenceCard } from './EmergenceCard';

const DIALOG_MOTION_MS = 240;

/**
 * 伴随思路（工作区产物页签）：中栏卡片流，焦点跟右区打开的产物，引用插回编辑器。
 * 面板内不画标题行：锁定/展开/聚焦漫游翻面（与思路板块同款同 UI）portal
 * 到「伴随思路」页签行右端。展开=与窗口同比例的大弹窗看整棵聚焦思维导图
 * （纯图浏览：无详情条、无说明小字，路径除外）。
 */
export function ThoughtsPane({
  room,
  focus,
  focusLocked,
  onToggleFocusLock,
  onQuote,
}: {
  room: ContextRoomRecord;
  /** 焦点协调器输出的权威焦点档案。 */
  focus: EmergenceFocusInput;
  focusLocked: boolean;
  onToggleFocusLock: () => void;
  /** 卡片「引用」：插回右区正在编辑的产物。 */
  onQuote?: (card: EmergenceCardDto) => void;
}) {
  const { t } = useLocale();
  const [mode, setMode] = useState<EmergenceMode>('focus');
  const [pinned, setPinned] = useState<EmergenceCardDto[]>([]);
  const [hiddenFocus, setHiddenFocus] = useState<Set<string>>(() => new Set());
  const [hiddenWander, setHiddenWander] = useState<Set<string>>(() => new Set());
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [selectedNodeRef, setSelectedNodeRef] = useState<string | null>(null);
  const [dialog, setDialog] = useState<'closed' | 'open' | 'closing'>('closed');
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  // 弹窗挂在 shell 根（--cr-* 变量作用域内）；挂 body 会丢主题变量。
  const [portalTarget, setPortalTarget] = useState<Element | null>(null);
  // 动作行浮到「伴随思路」页签行右端：面板体 overflow 会裁掉上浮元素，故 portal 进页签行。
  const [tabBarTarget, setTabBarTarget] = useState<HTMLElement | null>(null);

  useEffect(() => {
    const panel = rootRef.current?.closest('.context-room-workspace-panel');
    setTabBarTarget(panel?.querySelector<HTMLElement>('.context-room-board-tabs') ?? null);
  }, []);

  const {
    wanderResult, wanderLoading, error, wanderFrom,
  } = useEmergence({ roomId: room.id, focus });
  // 聚焦世界=agent 生成的思维导图（NotebookLM 式）；scope 只跟打开的文档走。
  const mindmap = useFocusMindmap({ roomId: room.id, documentId: focus.documentId ?? null });
  const focusResult = mindmap.projection;

  const mindmapErrorText = mindmap.error === 'mindmap_no_content'
    ? t('contextRoom:emergence.mindmapNoContent')
    : t('contextRoom:emergence.mindmapFailed');

  const visibleFocusCards = (focusResult?.cards ?? []).filter((card) => !hiddenFocus.has(card.id));
  const visibleWanderCards = (wanderResult?.cards ?? []).filter((card) => !hiddenWander.has(card.id));

  const nodeLabels = useMemo(() => new Map(
    (mode === 'focus' ? focusResult?.nodes : wanderResult?.nodes)?.map((node) => [node.id, node.label]) ?? [],
  ), [mode, focusResult, wanderResult]);

  // 树根听服务端的：导图根=mindmap:root，resolveCenter 兜底到 room/首节点
  const focusRootRef = resolveCenter(focusResult, focusResult?.focusRootRef ?? `room:${room.id}`);

  // 新导图=清图内选中：渲染期重置（无空帧）。上一份必须存 state
  // （存 ref 会在严格模式双渲染下丢重置）；focusRootRef 两级 scope 同名，须按结果身份判。
  const [prevFocusResult, setPrevFocusResult] = useState<EmergenceProjectionResultDto | null>(null);
  if (focusResult !== prevFocusResult) {
    setPrevFocusResult(focusResult);
    setSelectedNodeRef(null);
  }

  // 路径链（只进大弹窗头）：当前选中（无选中=根）只带直接父级与第一个子级，更远的层级收成 …
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

  const openDialog = () => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    setPortalTarget(rootRef.current?.closest('.context-room-app, .context-room-operation-shell') ?? document.body);
    setDialog('open');
  };

  const closeDialog = () => {
    if (dialog !== 'open') return;
    setDialog('closing');
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = null;
      setDialog('closed');
    }, DIALOG_MOTION_MS);
  };

  useEffect(() => () => {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
  }, []);

  useEffect(() => {
    if (dialog === 'closed') return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeDialog();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dialog]);

  const pinCard = (card: EmergenceCardDto) => {
    setPinned((current) => current.some((item) => item.id === card.id) ? current : [...current, card]);
  };

  const quoteCard = (card: EmergenceCardDto) => {
    if (onQuote) onQuote(card);
    else pinCard(card);
  };

  // 翻面按钮切换（与思路板块同款）：进漫游=从 Room 起点新走一遭
  const switchMode = (next: EmergenceMode) => {
    if (next === mode) return;
    setMode(next);
    setExpandedId(null);
    setSelectedNodeRef(null);
    if (next === 'wander') wanderFrom(null);
  };

  // 漫游卡片主动作「沿此漫步」：换起点重走
  const enterWander = (startNodeRef: string | null) => {
    setMode('wander');
    setExpandedId(null);
    wanderFrom(startNodeRef);
  };

  const expandedCard = expandedId === null
    ? null
    : (mode === 'focus' ? focusResult?.cards : wanderResult?.cards)?.find((card) => card.id === expandedId) ?? null;

  // 弹窗内纯浏览：不带详情条（小字摘要），失败只留重试动作，生成中只留骨架
  const dialogGraph = mindmap.failed ? (
    <div className="eg-viewport eg-empty">
      <button type="button" className="context-room-panel-empty-action" onClick={mindmap.retry}>
        {t('contextRoom:emergence.mindmapRetry')}
      </button>
    </div>
  ) : focusResult && focusResult.nodes.length > 0 ? (
    <FocusTreeCanvas
      result={focusResult}
      rootRef={focusRootRef}
      selectedNodeRef={selectedNodeRef}
      cards={visibleFocusCards}
      showDetail={false}
      onSelectNode={setSelectedNodeRef}
    />
  ) : mindmap.generating ? (
    <SkeletonTreeCanvas />
  ) : (
    <div className="eg-viewport eg-empty" />
  );

  const focusBody = (
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
  );

  const wanderBody = (
    <div className="context-room-emergence-cards">
      {visibleWanderCards.map((card) => (
        <EmergenceCard
          key={card.id}
          card={card}
          mode="wander"
          nodeLabels={nodeLabels}
          expanded={expandedId === card.id}
          onToggle={() => setExpandedId((current) => current === card.id ? null : card.id)}
          onPrimaryAction={() => enterWander(card.nodeRef)}
          onPin={() => pinCard(card)}
          onHide={() => setHiddenWander((current) => new Set(current).add(card.id))}
        />
      ))}
      {!wanderLoading && visibleWanderCards.length === 0 ? (
        <div className="context-room-workspace-empty">{error ?? t('contextRoom:emergence.wanderEmpty')}</div>
      ) : null}
      {wanderLoading ? (
        <div className="context-room-workspace-empty">{t('contextRoom:emergence.wandering')}</div>
      ) : null}
    </div>
  );

  // 页签行右端动作行：data-mode 驱动翻面旋转（行被 portal 出面板，不吃面板根选择器）
  const tabBarActions = (
    <div className="context-room-thoughts-head-actions context-room-thoughts-companion-actions" data-mode={mode}>
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
        className="context-room-thoughts-expand"
        aria-label={t('contextRoom:emergence.mindmapExpand')}
        title={t('contextRoom:emergence.mindmapExpand')}
        onClick={openDialog}
      >
        <Maximize2 aria-hidden="true" />
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
  );

  const pathNav = chain ? (
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
  ) : <div className="context-room-thoughts-path" />;

  return (
    <div ref={rootRef} className="context-room-thoughts-pane" data-variant="companion" data-mode={mode}>
      {mode === 'focus' ? focusBody : wanderBody}
      {pinned.length > 0 ? (
        <section className="context-room-thoughts-pinned">
          {pinned.map((card) => (
            <span key={card.id} className="context-room-thoughts-pinned-item" title={card.title}>
              {card.title}
            </span>
          ))}
        </section>
      ) : null}
      {tabBarTarget ? createPortal(tabBarActions, tabBarTarget) : null}
      {dialog !== 'closed' && portalTarget ? createPortal(
        <div
          className={`context-room-mindmap-overlay${dialog === 'closing' ? ' is-closing' : ''}`}
          role="presentation"
          onClick={(event) => {
            if (event.target === event.currentTarget) closeDialog();
          }}
        >
          <section
            className="context-room-mindmap-modal"
            role="dialog"
            aria-modal="true"
            aria-label={t('contextRoom:emergence.mindmapDialog')}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="context-room-mindmap-head">
              {pathNav}
              <button
                type="button"
                className="context-room-mindmap-close"
                aria-label={t('contextRoom:emergence.mindmapClose')}
                title={t('contextRoom:emergence.mindmapClose')}
                onClick={closeDialog}
              >
                <X aria-hidden="true" />
              </button>
            </div>
            <div className="context-room-mindmap-body">
              {dialogGraph}
            </div>
          </section>
        </div>,
        portalTarget,
      ) : null}
    </div>
  );
}
