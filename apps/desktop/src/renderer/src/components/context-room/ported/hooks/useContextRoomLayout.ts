import {
  useEffect,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';

import { DETAIL_TABS as TABS, type DetailPane } from '../components/RoomIconSidebar';

const CONTEXT_ROOM_PANE_DRAG_TYPE = 'application/x-nexcore-context-room-pane';

export type PaneDropPosition = 'before' | 'after';

export function useContextRoomLayout({
  activePane,
  initialMobileContent = false,
  onActivePaneChange,
  onEnterDocuments,
}: {
  activePane: DetailPane;
  initialMobileContent?: boolean;
  onActivePaneChange: (pane: DetailPane) => void;
  onEnterDocuments: () => void;
}) {
  const [panels, setPanels] = useState<DetailPane[]>(
    activePane === 'overview' ? ['overview'] : [activePane]
  );
  const [tabOrder, setTabOrder] = useState<DetailPane[]>(() => TABS.map((tab) => tab.id));
  const [activePanelIndex, setActivePanelIndex] = useState(0);
  const [middleHidden, setMiddleHidden] = useState(false);
  const [middleWidth, setMiddleWidth] = useState(320);
  const [panelWeights, setPanelWeights] = useState([1]);
  const [mobileContent, setMobileContent] = useState(initialMobileContent);
  const [draggedPane, setDraggedPane] = useState<DetailPane | null>(null);
  const [paneDragPreview, setPaneDragPreview] = useState<{
    pane: DetailPane;
    x: number;
    y: number;
  } | null>(null);
  const [tabDropTarget, setTabDropTarget] = useState<{
    pane: DetailPane;
    position: PaneDropPosition;
  } | null>(null);
  const [paneDropIndex, setPaneDropIndex] = useState<number | null>(null);
  const layoutRef = useRef<HTMLDivElement | null>(null);
  const draggedPaneRef = useRef<DetailPane | null>(null);
  const panePointerCleanupRef = useRef<(() => void) | null>(null);
  const suppressPaneClickRef = useRef(false);

  useEffect(
    () => () => {
      panePointerCleanupRef.current?.();
    },
    []
  );

  const clearPaneDrag = () => {
    draggedPaneRef.current = null;
    setDraggedPane(null);
    setPaneDragPreview(null);
    setTabDropTarget(null);
    setPaneDropIndex(null);
  };
  const getDraggedPane = (event: ReactDragEvent<HTMLElement>) => {
    const pane =
      draggedPaneRef.current ??
      (event.dataTransfer.getData(CONTEXT_ROOM_PANE_DRAG_TYPE) as DetailPane);
    return TABS.some((tab) => tab.id === pane) ? pane : null;
  };
  const startPaneDrag = (event: ReactDragEvent<HTMLButtonElement>, pane: DetailPane) => {
    draggedPaneRef.current = pane;
    setDraggedPane(pane);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData(CONTEXT_ROOM_PANE_DRAG_TYPE, pane);
    event.dataTransfer.setData('text/plain', pane);
  };
  const reorderTab = (dragged: DetailPane, target: DetailPane, position: PaneDropPosition) => {
    if (dragged === target) return;
    setTabOrder((current) => {
      const next = current.filter((pane) => pane !== dragged);
      const targetIndex = next.indexOf(target);
      next.splice(targetIndex + (position === 'after' ? 1 : 0), 0, dragged);
      return next;
    });
  };
  const getPaneDropIndex = (clientY: number, target: Element | null) => {
    if (panels.length >= 2) {
      const panel = target?.closest<HTMLElement>('[data-panel-index]');
      if (panel) return Number(panel.dataset.panelIndex) === 0 ? 0 : 1;
      const panelElements = Array.from(
        layoutRef.current?.querySelectorAll<HTMLElement>('[data-panel-index]') ?? []
      );
      const matched = panelElements.find((element) => {
        const rect = element.getBoundingClientRect();
        return clientY >= rect.top && clientY <= rect.bottom;
      });
      if (matched) return Number(matched.dataset.panelIndex) === 0 ? 0 : 1;
    }
    const middle = layoutRef.current?.querySelector('.context-room-workspace-middle');
    const rect = middle?.getBoundingClientRect();
    return rect && clientY >= rect.top + rect.height / 2 ? 1 : 0;
  };

  const switchPane = (pane: DetailPane) => {
    onActivePaneChange(pane);
    if (pane === 'documents') onEnterDocuments();
    if (pane === 'overview') {
      setPanels(['overview']);
      setPanelWeights([1]);
      setActivePanelIndex(0);
      setMiddleHidden(false);
      return;
    }
    const overview = panels.length === 1 && panels[0] === 'overview';
    if (overview) {
      setPanels([pane]);
      setPanelWeights([1]);
      setActivePanelIndex(0);
      setMiddleHidden(false);
      return;
    }
    const index = panels.indexOf(pane);
    if (index >= 0) {
      if (panels.length === 1 && !middleHidden) setMiddleHidden(true);
      else {
        setActivePanelIndex(index);
        setMiddleHidden(false);
      }
      return;
    }
    setPanels((current) => {
      const replaceIndex = current.length >= 2 ? (activePanelIndex === 0 ? 1 : 0) : 0;
      return current.map((item, indexValue) => (indexValue === replaceIndex ? pane : item));
    });
    setMiddleHidden(false);
  };

  const dropPaneIntoWorkspace = (pane: DetailPane, dropIndex: number) => {
    if (pane === 'overview') {
      switchPane('overview');
      return;
    }
    onActivePaneChange(pane);
    if (pane === 'documents') onEnterDocuments();
    setMiddleHidden(false);
    setPanels((current) => {
      const existingIndex = current.indexOf(pane);
      if (existingIndex >= 0) {
        setActivePanelIndex(existingIndex);
        return current;
      }
      if (current.length === 1 && current[0] === 'overview') {
        setActivePanelIndex(0);
        setPanelWeights([1]);
        return [pane];
      }
      if (current.length === 1) {
        const insertBelow = dropIndex > 0;
        setActivePanelIndex(insertBelow ? 1 : 0);
        setPanelWeights([1, 1]);
        return insertBelow ? [current[0], pane] : [pane, current[0]];
      }
      const replaceIndex = Math.max(0, Math.min(dropIndex, 1));
      const next = current.slice(0, 2);
      next[replaceIndex] = pane;
      setActivePanelIndex(replaceIndex);
      return next;
    });
  };

  const startPanePointerDrag = (event: ReactPointerEvent<HTMLButtonElement>, pane: DetailPane) => {
    if (!event.isPrimary || event.button !== 0) return;
    panePointerCleanupRef.current?.();
    const startX = event.clientX;
    const startY = event.clientY;
    let moved = false;
    const getDropTarget = (clientX: number, clientY: number) => document.elementFromPoint(clientX, clientY);
    const updateTarget = (clientX: number, clientY: number) => {
      const target = getDropTarget(clientX, clientY);
      const tab = target?.closest<HTMLElement>('[data-pane-id]');
      if (tab) {
        const targetPane = tab.dataset.paneId as DetailPane;
        const rect = tab.getBoundingClientRect();
        const horizontal = getComputedStyle(tab.parentElement ?? tab).flexDirection === 'row';
        setTabDropTarget({
          pane: targetPane,
          position: horizontal
            ? clientX < rect.left + rect.width / 2 ? 'before' : 'after'
            : clientY < rect.top + rect.height / 2 ? 'before' : 'after',
        });
        setPaneDropIndex(null);
        return;
      }
      if (pane !== 'overview' && target?.closest('.context-room-workspace-middle')) {
        setTabDropTarget(null);
        setPaneDropIndex(getPaneDropIndex(clientY, target));
        return;
      }
      setTabDropTarget(null);
      setPaneDropIndex(null);
    };
    const cleanup = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      panePointerCleanupRef.current = null;
    };
    const move = (moveEvent: PointerEvent) => {
      if (!moved && Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) < 6) return;
      moved = true;
      moveEvent.preventDefault();
      draggedPaneRef.current = pane;
      setDraggedPane(pane);
      setPaneDragPreview({ pane, x: moveEvent.clientX, y: moveEvent.clientY });
      updateTarget(moveEvent.clientX, moveEvent.clientY);
    };
    const up = (upEvent: PointerEvent) => {
      if (moved) {
        const target = getDropTarget(upEvent.clientX, upEvent.clientY);
        const tab = target?.closest<HTMLElement>('[data-pane-id]');
        if (tab) {
          const targetPane = tab.dataset.paneId as DetailPane;
          const rect = tab.getBoundingClientRect();
          const horizontal = getComputedStyle(tab.parentElement ?? tab).flexDirection === 'row';
          reorderTab(pane, targetPane, horizontal
            ? upEvent.clientX < rect.left + rect.width / 2 ? 'before' : 'after'
            : upEvent.clientY < rect.top + rect.height / 2 ? 'before' : 'after');
        } else if (pane !== 'overview' && target?.closest('.context-room-workspace-middle')) {
          dropPaneIntoWorkspace(pane, getPaneDropIndex(upEvent.clientY, target));
        }
        suppressPaneClickRef.current = true;
        window.setTimeout(() => { suppressPaneClickRef.current = false; }, 0);
      }
      cleanup();
      clearPaneDrag();
    };
    const cancel = () => { cleanup(); clearPaneDrag(); };
    panePointerCleanupRef.current = cleanup;
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
  };

  const addSplit = (pane: DetailPane, position: 'replace' | 'above' | 'below') => {
    onActivePaneChange(pane);
    if (pane === 'documents') onEnterDocuments();
    const overview = panels.length === 1 && panels[0] === 'overview';
    if (overview) {
      switchPane(pane);
      return;
    }
    const existing = panels.indexOf(pane);
    if (existing >= 0) {
      setActivePanelIndex(existing);
      setMiddleHidden(false);
      return;
    }
    setPanels((current) => {
      const next = [...current];
      if (position === 'replace' || next.length >= 2) next[activePanelIndex] = pane;
      else next.splice(position === 'above' ? activePanelIndex : activePanelIndex + 1, 0, pane);
      setPanelWeights(next.map(() => 1));
      return next;
    });
    if (position === 'below' && panels.length < 2) setActivePanelIndex((index) => index + 1);
    setMiddleHidden(false);
  };

  const startMiddleResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    const rect = layoutRef.current?.getBoundingClientRect();
    if (!rect) return;
    const move = (moveEvent: PointerEvent) => setMiddleWidth(Math.max(240, Math.min(560, moveEvent.clientX - rect.left - 56)));
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const resizeMiddleByKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    setMiddleWidth((value) => Math.max(240, Math.min(560, value + (event.key === 'ArrowRight' ? 16 : -16))));
  };
  const startPanelResize = (event: ReactPointerEvent<HTMLDivElement>, index: number) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    const middle = event.currentTarget.parentElement?.parentElement?.getBoundingClientRect();
    if (!middle) return;
    const move = (moveEvent: PointerEvent) => setPanelWeights((current) => {
      const next = [...current];
      const pair = next[index] + next[index + 1];
      const ratio = Math.max(0.2, Math.min(0.8, (moveEvent.clientY - middle.top) / middle.height));
      next[index] = pair * ratio;
      next[index + 1] = pair * (1 - ratio);
      return next;
    });
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const resizePanelByKey = (event: ReactKeyboardEvent<HTMLDivElement>, index: number) => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    setPanelWeights((current) => {
      const next = [...current];
      const pair = next[index] + next[index + 1];
      const ratio = Math.max(0.2, Math.min(0.8, next[index] / pair + (event.key === 'ArrowDown' ? 0.08 : -0.08)));
      next[index] = pair * ratio;
      next[index + 1] = pair * (1 - ratio);
      return next;
    });
  };

  return {
    panels,
    setPanels,
    tabOrder,
    activePanelIndex,
    setActivePanelIndex,
    middleHidden,
    setMiddleHidden,
    middleWidth,
    panelWeights,
    setPanelWeights,
    mobileContent,
    setMobileContent,
    draggedPane,
    paneDragPreview,
    tabDropTarget,
    setTabDropTarget,
    paneDropIndex,
    setPaneDropIndex,
    layoutRef,
    suppressPaneClickRef,
    clearPaneDrag,
    getDraggedPane,
    startPaneDrag,
    startPanePointerDrag,
    reorderTab,
    getPaneDropIndex,
    dropPaneIntoWorkspace,
    switchPane,
    addSplit,
    startMiddleResize,
    resizeMiddleByKey,
    startPanelResize,
    resizePanelByKey,
  };
}
