import * as ContextMenu from '@radix-ui/react-context-menu';
import type { RoomAppliedEntitySource, RoomDocument, TiptapJsonContent } from '@nxcore/agent-contract';
import { FolderInput, X } from 'lucide-react';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import { useLocale } from '../../../../../i18n/LocaleContext';

import type { ContextRoomRecord, ContextRoomResource, ContextRoomWikiPageResource } from '../../types';
import type { KnowledgeFileDto } from '../../../../../../../shared/knowledge';
import {
  BOARD_TABS as TABS,
  type BoardId,
  type BoardSubtab,
} from '../RoomIconSidebar';
import type { BoardSubtabs } from '../../hooks/useContextRoomLayout';
import { useRoomFocus } from '../../hooks/useRoomFocus';
import { OverviewDashboard, type WorkspaceObjectPreview } from '../detail-panels';
import { BoardTabs } from './BoardTabs';
import { WorkspaceContent } from './WorkspaceContent';
import { WorkspacePaneBody } from './WorkspacePaneBody';

type LayoutRef = RefObject<HTMLDivElement | null>;

export function WorkspaceLayout({
  room,
  rooms,
  panels,
  setPanels,
  subtabs,
  setBoardSubtab,
  activePanelIndex,
  setActivePanelIndex,
  middleHidden,
  setMiddleHidden,
  middleWidth,
  wideMiddle,
  wideWidth,
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
  selectedResourceId,
  selectedObject,
  selectedResource,
  backendDocuments,
  trashedDocuments,
  knowledgeFiles,
  focusedDocumentId,
  focusedBlockId,
  documentFocusRequestId,
  onBackendDocumentChange,
  onCreateDocument,
  onDeleteDocument,
  onRestoreDocument,
  onDeleteDocumentPermanently,
  onEmptyTrash,
  onSelectResource,
  onOpenWikiPage,
  onOpenDocument,
  linkGraphFocusNodeId,
  onOpenObject,
  onOpenSource,
  onCloseObject,
  onOpenRoom,
  onToggleTask,
  onUpdateRoom,
  onImportObsidian,
}: {
  room: ContextRoomRecord;
  rooms: ContextRoomRecord[];
  panels: BoardId[];
  setPanels: Dispatch<SetStateAction<BoardId[]>>;
  subtabs: BoardSubtabs;
  setBoardSubtab: (board: BoardId, subtab: BoardSubtab) => void;
  activePanelIndex: number;
  setActivePanelIndex: Dispatch<SetStateAction<number>>;
  middleHidden: boolean;
  setMiddleHidden: Dispatch<SetStateAction<boolean>>;
  middleWidth: number;
  wideMiddle: boolean;
  wideWidth: number | null;
  panelWeights: number[];
  setPanelWeights: Dispatch<SetStateAction<number[]>>;
  mobileContent: boolean;
  setMobileContent: Dispatch<SetStateAction<boolean>>;
  draggedBoard: BoardId | null;
  paneDragPreview: { board: BoardId; x: number; y: number } | null;
  paneDropIndex: number | null;
  setPaneDropIndex: Dispatch<SetStateAction<number | null>>;
  layoutRef: LayoutRef;
  suppressPaneClickRef: { current: boolean };
  clearPaneDrag: () => void;
  getDraggedPane: (event: React.DragEvent<HTMLElement>) => BoardId | null;
  startPaneDrag: (event: React.DragEvent<HTMLButtonElement>, board: BoardId) => void;
  startPanePointerDrag: (event: React.PointerEvent<HTMLButtonElement>, board: BoardId) => void;
  getPaneDropIndex: (clientY: number, target: Element | null) => number;
  dropBoardIntoWorkspace: (board: BoardId, dropIndex: number) => void;
  switchBoard: (board: BoardId, subtab?: BoardSubtab) => void;
  addSplit: (board: BoardId, position: 'replace' | 'above' | 'below') => void;
  startMiddleResize: (event: React.PointerEvent<HTMLDivElement>) => void;
  resizeMiddleByKey: (event: React.KeyboardEvent<HTMLDivElement>) => void;
  startPanelResize: (event: React.PointerEvent<HTMLDivElement>, index: number) => void;
  resizePanelByKey: (event: React.KeyboardEvent<HTMLDivElement>, index: number) => void;
  selectedResourceId: string | null;
  selectedObject: WorkspaceObjectPreview | null;
  selectedResource: ContextRoomResource | null;
  backendDocuments: RoomDocument[];
  trashedDocuments: RoomDocument[];
  knowledgeFiles: KnowledgeFileDto[];
  focusedDocumentId: string | null;
  focusedBlockId: string | null;
  documentFocusRequestId: number | null;
  onBackendDocumentChange: (document: RoomDocument) => void;
  onCreateDocument: (title: string, contentJson?: TiptapJsonContent) => Promise<void>;
  onDeleteDocument: (document: RoomDocument) => Promise<void>;
  onRestoreDocument: (document: RoomDocument) => Promise<void>;
  onDeleteDocumentPermanently: (document: RoomDocument) => Promise<void>;
  onEmptyTrash: (roomId: string) => Promise<void>;
  onSelectResource: (resource: ContextRoomResource) => void;
  onOpenWikiPage: (resource: ContextRoomWikiPageResource) => void;
  /** 建联图谱等面板按文档 id 在右区打开文档。 */
  onOpenDocument: (documentId: string) => void;
  /** 索引 chip 跳转：建联图谱聚焦节点 id（memory:{id} / doc:{id}）。 */
  linkGraphFocusNodeId?: string | null;
  onOpenObject: (target: WorkspaceObjectPreview) => void;
  /** 记忆图谱来源行跳转（文档右区打开 / 邮件进面板详情）。 */
  onOpenSource: (source: RoomAppliedEntitySource) => void;
  onCloseObject: () => void;
  onOpenRoom: (roomId: string) => void;
  onToggleTask: (taskId: string) => void;
  onUpdateRoom: (updater: (room: ContextRoomRecord) => ContextRoomRecord) => void;
  onImportObsidian: () => void;
}) {
  const { t } = useLocale();
  const overview = panels.length === 1 && panels[0] === 'work' && subtabs.work === 'overview';
  const boardLabel = (board: BoardId) => TABS.find((tab) => tab.id === board)?.label ?? board;
  // 焦点协调器：Room 内唯一权威焦点源（选区>章节>产物>Room），伴随思路页签与
  // 独立思路看板都从这里取焦点；「引用」插回光标处的桥保持原位。
  const focusDocument = selectedResource?.kind === 'cloud-doc' ? selectedResource : null;
  const roomFocus = useRoomFocus({
    roomId: room.id,
    board: panels[0] ?? 'work',
    documentId: focusDocument?.binding.docId ?? null,
    documentTitle: focusDocument?.name ?? null,
  });
  // 工作概览独占整屏时不可被分屏替换。
  const boardSplittable = (board: BoardId) => !(board === 'work' && subtabs.work === 'overview');
  // 宽中栏默认 min(720px, 58vw)，用户拖过分隔条后以拖到的宽度为准（来自布局 hook）。
  const middleWidthCss = wideMiddle
    ? (wideWidth !== null ? `${String(wideWidth)}px` : 'min(720px, 58vw)')
    : `${String(middleWidth)}px`;

  return (
    <>
      {paneDragPreview ? (() => {
        const previewTab = TABS.find((tab) => tab.id === paneDragPreview.board);
        if (!previewTab) return null;
        const PreviewIcon = previewTab.icon;
        return (
          <div
            aria-hidden="true"
            className="context-room-pane-drag-preview"
            data-icon-tone={previewTab.tone}
            data-testid="context-room-pane-drag-preview"
            style={{ transform: `translate3d(${String(paneDragPreview.x + 12)}px, ${String(paneDragPreview.y + 12)}px, 0) scale(0.96)` }}
          >
            <PreviewIcon />
          </div>
        );
      })() : null}
      <div
        ref={layoutRef as React.RefObject<HTMLDivElement>}
        className={`context-room-workspace-layout${overview ? ' is-overview' : ''}${middleHidden ? ' is-middle-hidden' : ''}${mobileContent ? ' is-mobile-content' : ''}${wideMiddle ? ' is-wide-middle' : ''}`}
        style={{ '--context-room-middle-width': middleWidthCss } as React.CSSProperties}
      >
        <nav className="context-room-workspace-tabs" aria-label={t('contextRoom:roomBoard.contextRoomDetail')}>
          {TABS.map(({ id, label, icon: Icon, tone }) => (
            <ContextMenu.Root key={id}>
              <ContextMenu.Trigger asChild>
                <button
                  type="button"
                  aria-label={t(label)}
                  title={t(label)}
                  data-pane-id={id}
                  data-icon-tone={tone}
                  aria-pressed={panels.includes(id) && !middleHidden}
                  draggable={false}
                  className={draggedBoard === id ? 'is-dragging' : ''}
                  onClick={(event) => {
                    if (suppressPaneClickRef.current) { event.preventDefault(); return; }
                    switchBoard(id);
                  }}
                  onPointerDown={(event) => startPanePointerDrag(event, id)}
                  onDragStart={(event) => startPaneDrag(event, id)}
                  onDragEnd={clearPaneDrag}
                  onKeyDown={(event) => {
                    if ((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu') {
                      event.currentTarget.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
                    }
                  }}
                >
                  <Icon aria-hidden="true" />
                </button>
              </ContextMenu.Trigger>
              {boardSplittable(id) ? (
                <ContextMenu.Portal>
                  <ContextMenu.Content className="context-room-tab-menu">
                    <ContextMenu.Label>“{t(label)}”</ContextMenu.Label>
                    {panels.includes(id) ? (
                      <ContextMenu.Item onSelect={() => { setActivePanelIndex(panels.indexOf(id)); setMiddleHidden(false); }}>
                        {t('contextRoom:workspaceLayout.focusThisPanel')}
                      </ContextMenu.Item>
                    ) : (
                      <>
                        <ContextMenu.Item onSelect={() => addSplit(id, 'replace')}>{t('contextRoom:workspaceLayout.replaceCurrentPanel')}</ContextMenu.Item>
                        <ContextMenu.Item disabled={panels.length >= 2} onSelect={() => addSplit(id, 'above')}>{t('contextRoom:workspaceLayout.splitAbove')}</ContextMenu.Item>
                        <ContextMenu.Item disabled={panels.length >= 2} onSelect={() => addSplit(id, 'below')}>{t('contextRoom:workspaceLayout.splitBelow')}</ContextMenu.Item>
                      </>
                    )}
                  </ContextMenu.Content>
                </ContextMenu.Portal>
              ) : null}
            </ContextMenu.Root>
          ))}
          <button type="button" className="context-room-workspace-tabs-footer" aria-label={t('surface:obsidian.importIntoRoom', { room: room.title })} title={t('surface:obsidian.importIntoRoom', { room: room.title })} onClick={onImportObsidian}>
            <FolderInput aria-hidden="true" />
          </button>
        </nav>

        {overview ? (
          // 原型概览态：整中栏独占，顶部仍保留工作页签条（rd-overview）。
          <div className="context-room-overview-board">
            <BoardTabs
              board="work"
              activeSubtab={subtabs.work}
              onSelectSubtab={(nextSubtab) => setBoardSubtab('work', nextSubtab)}
            />
            <OverviewDashboard
              room={room}
              backendDocuments={backendDocuments}
              knowledgeFiles={knowledgeFiles}
              onSelectResource={onSelectResource}
              onOpenObject={onOpenObject}
              onOpenPane={(pane) => setBoardSubtab('work', pane)}
              onOpenWikiBoard={() => switchBoard('wiki')}
              onToggleTask={onToggleTask}
            />
          </div>
        ) : (
          <>
            <section
              className={`context-room-workspace-middle${paneDropIndex === 0 && panels.length === 1 ? ' is-pane-drop-top' : ''}${paneDropIndex === 1 && panels.length === 1 ? ' is-pane-drop-bottom' : ''}`}
              onDragOver={(event) => {
                const board = getDraggedPane(event);
                if (!board || !boardSplittable(board)) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
                setPaneDropIndex(getPaneDropIndex(event.clientY, event.target as Element));
              }}
              onDragLeave={(event) => {
                const nextTarget = event.relatedTarget;
                if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
                setPaneDropIndex(null);
              }}
              onDrop={(event) => {
                const board = getDraggedPane(event);
                if (!board || !boardSplittable(board)) return;
                event.preventDefault();
                dropBoardIntoWorkspace(board, getPaneDropIndex(event.clientY, event.target as Element));
                clearPaneDrag();
              }}
            >
              {panels.map((board, index) => {
                const label = boardLabel(board);
                const subtab = subtabs[board];
                return (
                  <div
                    className={`context-room-workspace-panel${index === activePanelIndex ? ' is-active' : ''}${index < panels.length - 1 ? ' has-divider' : ''}${paneDropIndex === index && panels.length >= 2 ? ' is-drop-target' : ''}`}
                    data-testid={`context-room-workspace-panel-${board}`}
                    data-panel-index={index}
                    style={{ flexGrow: panelWeights[index] ?? 1 }}
                    key={`${board}-${String(index)}`}
                    onClick={() => setActivePanelIndex(index)}
                  >
                    {panels.length > 1 ? (
                      <header>
                        <span>{t(label)}</span>
                        <button
                          type="button"
                          aria-label={t('contextRoom:workspaceLayout.closePanePanel', { pane: t(label) })}
                          onClick={(event) => {
                            event.stopPropagation();
                            setPanels((current) => current.filter((_, currentIndex) => currentIndex !== index));
                            setPanelWeights((current) => current.filter((_, currentIndex) => currentIndex !== index));
                            setActivePanelIndex((value) => Math.max(0, Math.min(value, panels.length - 2)));
                          }}
                        >
                          <X aria-hidden="true" />
                        </button>
                      </header>
                    ) : null}
                    <BoardTabs
                      board={board}
                      activeSubtab={subtab}
                      onSelectSubtab={(nextSubtab) => setBoardSubtab(board, nextSubtab)}
                    />
                    <div className="context-room-workspace-panel-body">
                      <WorkspacePaneBody
                        board={board}
                        subtab={subtab}
                        room={room}
                        selectedResourceId={selectedResourceId}
                        selectedResource={selectedResource}
                        focus={roomFocus.focus}
                        focusLocked={roomFocus.locked}
                        onToggleFocusLock={roomFocus.toggleLocked}
                        backendDocuments={backendDocuments}
                        trashedDocuments={trashedDocuments}
                        knowledgeFiles={knowledgeFiles}
                        rooms={rooms}
                        onOpenRoom={onOpenRoom}
                        onSelectResource={onSelectResource}
                        onOpenWikiPage={onOpenWikiPage}
                        onCreateDocument={onCreateDocument}
                        onDeleteDocument={onDeleteDocument}
                        onRestoreDocument={onRestoreDocument}
                        onDeleteDocumentPermanently={onDeleteDocumentPermanently}
                        onEmptyTrash={onEmptyTrash}
                        onOpenDocument={onOpenDocument}
                        onOpenPane={(nextSubtab) => setBoardSubtab('work', nextSubtab)}
                        linkGraphFocusNodeId={linkGraphFocusNodeId}
                        onToggleTask={onToggleTask}
                        onUpdateRoom={onUpdateRoom}
                        onOpenObject={onOpenObject}
                        onOpenSource={onOpenSource}
                        selectedObject={selectedObject}
                        onCloseObject={onCloseObject}
                      />
                    </div>
                    {index < panels.length - 1 ? (
                      <div
                        role="separator"
                        aria-label={t('contextRoom:workspaceLayout.resizePanelHeight')}
                        aria-orientation="horizontal"
                        aria-valuemin={20}
                        aria-valuemax={80}
                        aria-valuenow={Math.round(((panelWeights[index] ?? 1) / ((panelWeights[index] ?? 1) + (panelWeights[index + 1] ?? 1))) * 100)}
                        tabIndex={0}
                        className="context-room-panel-divider"
                        onPointerDown={(event) => startPanelResize(event, index)}
                        onKeyDown={(event) => resizePanelByKey(event, index)}
                      />
                    ) : null}
                  </div>
                );
              })}
            </section>
            <div
              role="separator"
              tabIndex={0}
              aria-label={t('contextRoom:workspaceLayout.resizeResourcePanel')}
              aria-orientation="vertical"
              className="context-room-middle-divider"
              onPointerDown={startMiddleResize}
              onKeyDown={resizeMiddleByKey}
            />
            <WorkspaceContent
              room={room}
              selectedResource={selectedResource}
              backendDocuments={backendDocuments}
              knowledgeFiles={knowledgeFiles}
              focusedDocumentId={focusedDocumentId}
              focusedBlockId={focusedBlockId}
              documentFocusRequestId={documentFocusRequestId}
              onBackendDocumentChange={onBackendDocumentChange}
              onDeleteDocument={onDeleteDocument}
              onSelectionTextChange={roomFocus.setSelection}
              onChapterChange={roomFocus.setChapter}
              onMobileBack={() => setMobileContent(false)}
              onUpdateRoom={onUpdateRoom}
            />
          </>
        )}
      </div>
    </>
  );
}
