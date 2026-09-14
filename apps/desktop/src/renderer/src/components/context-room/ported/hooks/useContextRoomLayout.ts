import {
  useEffect,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';

import {
  BOARD_TABS,
  DEFAULT_SUBTABS,
  type BoardId,
  type BoardSubtab,
} from '../components/RoomIconSidebar';

const CONTEXT_ROOM_PANE_DRAG_TYPE = 'application/x-nexcore-context-room-pane';

export type BoardSubtabs = Record<BoardId, BoardSubtab | null>;

export function useContextRoomLayout({
  activeBoard,
  initialSubtabs,
  onActiveBoardChange,
}: {
  activeBoard: BoardId;
  initialSubtabs?: Partial<BoardSubtabs>;
  onActiveBoardChange: (board: BoardId) => void;
}) {
  const [panels, setPanels] = useState<BoardId[]>(
    activeBoard === 'work' ? ['work'] : [activeBoard]
  );
  const [subtabs, setSubtabs] = useState<BoardSubtabs>({
    ...DEFAULT_SUBTABS,
    ...initialSubtabs,
  });
  const [activePanelIndex, setActivePanelIndex] = useState(0);
  const [middleHidden, setMiddleHidden] = useState(false);
  const [middleWidth, setMiddleWidth] = useState(320);
  const [panelWeights, setPanelWeights] = useState([1]);
  const [mobileContent, setMobileContent] = useState(false);
  const [draggedBoard, setDraggedBoard] = useState<BoardId | null>(null);
  const [paneDragPreview, setPaneDragPreview] = useState<{
    board: BoardId;
    x: number;
    y: number;
  } | null>(null);
  const [paneDropIndex, setPaneDropIndex] = useState<number | null>(null);
  const layoutRef = useRef<HTMLDivElement | null>(null);
  const draggedBoardRef = useRef<BoardId | null>(null);
  const panePointerCleanupRef = useRef<(() => void) | null>(null);
  const suppressPaneClickRef = useRef(false);

  useEffect(
    () => () => {
      panePointerCleanupRef.current?.();
    },
    []
  );

  const clearPaneDrag = () => {
    draggedBoardRef.current = null;
    setDraggedBoard(null);
    setPaneDragPreview(null);
    setPaneDropIndex(null);
  };
  const getDraggedPane = (event: ReactDragEvent<HTMLElement>) => {
    const board =
      draggedBoardRef.current ??
      (event.dataTransfer.getData(CONTEXT_ROOM_PANE_DRAG_TYPE) as BoardId);
    return BOARD_TABS.some((tab) => tab.id === board) ? board : null;
  };
  const startPaneDrag = (event: ReactDragEvent<HTMLButtonElement>, board: BoardId) => {
    draggedBoardRef.current = board;
    setDraggedBoard(board);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData(CONTEXT_ROOM_PANE_DRAG_TYPE, board);
    event.dataTransfer.setData('text/plain', board);
  };
  const isOverviewWorkspace = (current: BoardId[], currentSubtabs: BoardSubtabs) =>
    current.length === 1 && current[0] === 'work' && currentSubtabs.work === 'overview';

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

  const switchBoard = (board: BoardId, nextSubtab?: BoardSubtab) => {
    onActiveBoardChange(board);
    if (nextSubtab) {
      setSubtabs((current) => (current[board] === nextSubtab ? current : { ...current, [board]: nextSubtab }));
    }
    // 工作概览独占整屏：无论从哪个板块进入，都收敛为单面板（沿用旧概览布局）。
    if (board === 'work' && (nextSubtab ?? subtabs.work) === 'overview') {
      setPanels(['work']);
      setPanelWeights([1]);
      setActivePanelIndex(0);
      setMiddleHidden(false);
      return;
    }
    if (isOverviewWorkspace(panels, subtabs)) {
      setPanels([board]);
      setPanelWeights([1]);
      setActivePanelIndex(0);
      setMiddleHidden(false);
      return;
    }
    const index = panels.indexOf(board);
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
      return current.map((item, indexValue) => (indexValue === replaceIndex ? board : item));
    });
    setMiddleHidden(false);
  };

  const setBoardSubtab = (board: BoardId, nextSubtab: BoardSubtab) => {
    setSubtabs((current) => (current[board] === nextSubtab ? current : { ...current, [board]: nextSubtab }));
    // 概览页签只在单面板整屏布局下成立；从分屏切回概览时收敛布局。
    if (board === 'work' && nextSubtab === 'overview') {
      setPanels((current) => (current.length === 1 && current[0] === 'work' ? current : ['work']));
      setPanelWeights([1]);
      setActivePanelIndex(0);
      setMiddleHidden(false);
    }
  };

  const dropBoardIntoWorkspace = (board: BoardId, dropIndex: number) => {
    if (board === 'work' && subtabs.work === 'overview') {
      switchBoard('work', 'overview');
      return;
    }
    onActiveBoardChange(board);
    setMiddleHidden(false);
    setPanels((current) => {
      const existingIndex = current.indexOf(board);
      if (existingIndex >= 0) {
        setActivePanelIndex(existingIndex);
        return current;
      }
      if (isOverviewWorkspace(current, subtabs)) {
        setActivePanelIndex(0);
        setPanelWeights([1]);
        return [board];
      }
      if (current.length === 1) {
        const insertBelow = dropIndex > 0;
        setActivePanelIndex(insertBelow ? 1 : 0);
        setPanelWeights([1, 1]);
        return insertBelow ? [current[0], board] : [board, current[0]];
      }
      const replaceIndex = Math.max(0, Math.min(dropIndex, 1));
      const next = current.slice(0, 2);
      next[replaceIndex] = board;
      setActivePanelIndex(replaceIndex);
      return next;
    });
  };

  const startPanePointerDrag = (event: ReactPointerEvent<HTMLButtonElement>, board: BoardId) => {
    if (!event.isPrimary || event.button !== 0) return;
    panePointerCleanupRef.current?.();
    const startX = event.clientX;
    const startY = event.clientY;
    let moved = false;
    const getDropTarget = (clientX: number, clientY: number) => document.elementFromPoint(clientX, clientY);
    const updateTarget = (clientX: number, clientY: number) => {
      const target = getDropTarget(clientX, clientY);
      // 工作概览独占整屏，不能作为分屏对象拖入中栏。
      if (board !== 'work' || subtabs.work !== 'overview') {
        if (target?.closest('.context-room-workspace-middle')) {
          setPaneDropIndex(getPaneDropIndex(clientY, target));
          return;
        }
      }
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
      draggedBoardRef.current = board;
      setDraggedBoard(board);
      setPaneDragPreview({ board, x: moveEvent.clientX, y: moveEvent.clientY });
      updateTarget(moveEvent.clientX, moveEvent.clientY);
    };
    const up = (upEvent: PointerEvent) => {
      if (moved) {
        const target = getDropTarget(upEvent.clientX, upEvent.clientY);
        if ((board !== 'work' || subtabs.work !== 'overview')
          && target?.closest('.context-room-workspace-middle')) {
          dropBoardIntoWorkspace(board, getPaneDropIndex(upEvent.clientY, target));
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

  const addSplit = (board: BoardId, position: 'replace' | 'above' | 'below') => {
    onActiveBoardChange(board);
    if (isOverviewWorkspace(panels, subtabs)) {
      switchBoard(board);
      return;
    }
    const existing = panels.indexOf(board);
    if (existing >= 0) {
      setActivePanelIndex(existing);
      setMiddleHidden(false);
      return;
    }
    setPanels((current) => {
      const next = [...current];
      if (position === 'replace' || next.length >= 2) next[activePanelIndex] = board;
      else next.splice(position === 'above' ? activePanelIndex : activePanelIndex + 1, 0, board);
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
    subtabs,
    setBoardSubtab,
    activePanelIndex,
    setActivePanelIndex,
    middleHidden,
    setMiddleHidden,
    middleWidth,
    panelWeights,
    setPanelWeights,
    mobileContent,
    setMobileContent,
    draggedBoard,
    paneDragPreview,
    paneDropIndex,
    setPaneDropIndex,
    layoutRef,
    suppressPaneClickRef,
    clearPaneDrag,
    getDraggedPane,
    startPaneDrag,
    startPanePointerDrag,
    getPaneDropIndex,
    dropBoardIntoWorkspace,
    switchBoard,
    addSplit,
    startMiddleResize,
    resizeMiddleByKey,
    startPanelResize,
    resizePanelByKey,
  };
}
