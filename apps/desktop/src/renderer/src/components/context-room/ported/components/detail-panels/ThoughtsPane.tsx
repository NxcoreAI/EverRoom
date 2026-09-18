import { Footprints, ListTree, Lock, LockOpen, Network, RotateCcw, Sparkles, Undo2 } from 'lucide-react';
import { useMemo, useState } from 'react';

import { useLocale } from '../../../../../i18n/LocaleContext';
import type { EmergenceCardDto, EmergenceMode } from '../../../../../../../shared/knowledge';
import type { ContextRoomRecord } from '../../types';
import { useEmergence } from '../../hooks/useEmergence';
import { VeinGraphCanvas } from '../VeinGraphCanvas';
import { EmergenceCard } from './EmergenceCard';

/**
 * 思路面板 · 知识涌现：聚焦=默认态（随焦点增量更新）；漫步=底部入口进入的
 * 独立态（两个世界，整屏交叉过渡），再走一次=新 seed、沿此漫步=换起点。
 * 模式是临时态：不进 localStorage，重进面板落在聚焦。
 */
export function ThoughtsPane({
  room,
  variant = 'board',
  focusDocumentId,
  focusDocumentTitle,
  focusSelectionText,
  onQuote,
  onViewChange,
}: {
  room: ContextRoomRecord;
  /** board=独立板块；companion=伴随区（引用=光标处插块引用）。 */
  variant?: 'board' | 'companion';
  focusDocumentId?: string | null;
  focusDocumentTitle?: string | null;
  /** 选区文本（伴随区编辑态）；渲染层截断到 300 字。 */
  focusSelectionText?: string | null;
  onQuote?: (card: EmergenceCardDto) => void;
  /** 视图切换回调（伴随区据此扩展/收缩列宽）。 */
  onViewChange?: (view: 'cards' | 'vein') => void;
}) {
  const { t } = useLocale();
  const [mode, setMode] = useState<EmergenceMode>('focus');
  const [view, setView] = useState<'cards' | 'vein'>('cards');
  const [locked, setLocked] = useState(false);
  const [pinned, setPinned] = useState<EmergenceCardDto[]>([]);
  const [hiddenFocus, setHiddenFocus] = useState<Set<string>>(() => new Set());
  const [hiddenWander, setHiddenWander] = useState<Set<string>>(() => new Set());
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [wanderStart, setWanderStart] = useState<{ nodeRef: string | null; label: string } | null>(null);

  const selectionText = focusSelectionText ? focusSelectionText.slice(0, 300) : null;
  const focusInput = useMemo(() => ({
    documentId: focusDocumentId ?? null,
    selectionText,
    blockId: null,
  }), [focusDocumentId, selectionText]);

  const {
    focusResult, wanderResult, focusLoading, wanderLoading, error, wanderFrom,
  } = useEmergence({ roomId: room.id, focus: focusInput, locked });

  const focusLabel = selectionText
    ? t('contextRoom:emergence.selectionFocus')
    : (focusDocumentTitle || room.title);
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

  const wanderLabel = wanderStart?.label ?? focusLabel;
  const focusCenterRef = focusDocumentId ? `doc:${focusDocumentId}` : `room:${room.id}`;
  const expandedCard = expandedId === null
    ? null
    : (mode === 'focus' ? focusResult?.cards : wanderResult?.cards)?.find((card) => card.id === expandedId) ?? null;

  // 点脉络节点=切回卡片流并展开同一候选卡；卡片展开的 nodeRef 反向高亮脉络节点
  const openCardAtNode = (nodeRef: string) => {
    const card = (mode === 'focus' ? focusResult?.cards : wanderResult?.cards)
      ?.find((candidate) => candidate.nodeRef === nodeRef);
    if (!card) return;
    switchView('cards');
    setExpandedId(card.id);
  };

  const switchView = (next: 'cards' | 'vein') => {
    setView(next);
    onViewChange?.(next);
  };

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
        aria-selected={view === 'vein'}
        className={view === 'vein' ? 'is-active' : ''}
        title={t('contextRoom:emergence.viewVein')}
        onClick={() => switchView('vein')}
      >
        <Network aria-hidden="true" />
      </button>
    </div>
  );

  const veinOf = (result: typeof focusResult, centerRef: string) => (
    result && result.nodes.length > 0 ? (
      <div className="context-room-thoughts-vein">
        <VeinGraphCanvas
          result={result}
          centerNodeRef={centerRef}
          selectedNodeRef={view === 'vein' ? (expandedCard?.nodeRef ?? null) : null}
          onSelectNode={openCardAtNode}
        />
      </div>
    ) : (
      <div className="context-room-workspace-empty">{t('contextRoom:emergence.veinEmpty')}</div>
    )
  );

  return (
    <div className="context-room-thoughts-pane" data-variant={variant} data-mode={mode}>
      <div className="context-room-thoughts-world" data-world="focus" aria-hidden={mode !== 'focus'}>
        <header className="context-room-thoughts-header">
          <div className="context-room-thoughts-focus" title={focusLabel}>
            <Sparkles aria-hidden="true" />
            <span>{t('contextRoom:emergence.focusPrefix')}</span>
            <strong>{focusLabel}</strong>
          </div>
          <div className="context-room-thoughts-header-actions">
            {viewToggle}
            <button
              type="button"
              className={locked ? 'context-room-thoughts-lock is-locked' : 'context-room-thoughts-lock'}
              aria-pressed={locked}
              aria-label={t('contextRoom:emergence.lockFocus')}
              title={t(locked ? 'contextRoom:emergence.unlockFocus' : 'contextRoom:emergence.lockFocus')}
              onClick={() => setLocked((value) => !value)}
            >
              {locked ? <Lock aria-hidden="true" /> : <LockOpen aria-hidden="true" />}
            </button>
          </div>
        </header>
        {view === 'cards' ? (
          <div className="context-room-emergence-cards">
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
            {!focusLoading && visibleFocusCards.length === 0 ? (
              <div className="context-room-workspace-empty">
                {error ?? t('contextRoom:emergence.noCardsYet')}
              </div>
            ) : null}
            {focusLoading && visibleFocusCards.length === 0 ? (
              <div className="context-room-workspace-empty">{t('contextRoom:emergence.projecting')}</div>
            ) : null}
          </div>
        ) : veinOf(focusResult, focusCenterRef)}
        {focusResult?.degraded ? (
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
        <footer className="context-room-thoughts-entry">
          <button type="button" onClick={() => enterWander(null, focusLabel)}>
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
        ) : veinOf(wanderResult, wanderStart?.nodeRef ?? focusCenterRef)}
      </div>
    </div>
  );
}
