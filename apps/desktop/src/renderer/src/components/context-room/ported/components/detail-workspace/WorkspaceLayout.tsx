import * as ContextMenu from '@radix-ui/react-context-menu';
import type { RoomDocument, TiptapJsonContent } from '@nxcore/agent-contract';
import { FolderInput, X } from 'lucide-react';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import { useLocale } from '../../../../../i18n/LocaleContext';

import type { ContextRoomRecord, ContextRoomResource, ContextRoomWikiPageResource } from '../../types';
import type { KnowledgeFileDto } from '../../../../../../../shared/knowledge';
import { DETAIL_TABS as TABS, type DetailPane } from '../RoomIconSidebar';
import { OverviewDashboard, type WorkspaceObjectPreview } from '../detail-panels';
import type { LocalOfficeFile } from '../detail-panels/ResourcePanel';
import { WorkspaceContent } from './WorkspaceContent';
import { WorkspacePaneBody } from './WorkspacePaneBody';

type LayoutRef = RefObject<HTMLDivElement | null>;

export function WorkspaceLayout({
  room,
  rooms,
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
  onAddFile,
  onOpenMemory,
  onOpenObject,
  onCloseObject,
  onOpenRoom,
  onToggleTask,
  onUpdateRoom,
  onImportObsidian,
}: {
  room: ContextRoomRecord;
  rooms: ContextRoomRecord[];
  panels: DetailPane[];
  setPanels: Dispatch<SetStateAction<DetailPane[]>>;
  tabOrder: DetailPane[];
  activePanelIndex: number;
  setActivePanelIndex: Dispatch<SetStateAction<number>>;
  middleHidden: boolean;
  setMiddleHidden: Dispatch<SetStateAction<boolean>>;
  middleWidth: number;
  panelWeights: number[];
  setPanelWeights: Dispatch<SetStateAction<number[]>>;
  mobileContent: boolean;
  setMobileContent: Dispatch<SetStateAction<boolean>>;
  draggedPane: DetailPane | null;
  paneDragPreview: { pane: DetailPane; x: number; y: number } | null;
  tabDropTarget: { pane: DetailPane; position: 'before' | 'after' } | null;
  setTabDropTarget: Dispatch<SetStateAction<{ pane: DetailPane; position: 'before' | 'after' } | null>>;
  paneDropIndex: number | null;
  setPaneDropIndex: Dispatch<SetStateAction<number | null>>;
  layoutRef: LayoutRef;
  suppressPaneClickRef: { current: boolean };
  clearPaneDrag: () => void;
  getDraggedPane: (event: React.DragEvent<HTMLElement>) => DetailPane | null;
  startPaneDrag: (event: React.DragEvent<HTMLButtonElement>, pane: DetailPane) => void;
  startPanePointerDrag: (event: React.PointerEvent<HTMLButtonElement>, pane: DetailPane) => void;
  reorderTab: (dragged: DetailPane, target: DetailPane, position: 'before' | 'after') => void;
  getPaneDropIndex: (clientY: number, target: Element | null) => number;
  dropPaneIntoWorkspace: (pane: DetailPane, dropIndex: number) => void;
  switchPane: (pane: DetailPane) => void;
  addSplit: (pane: DetailPane, position: 'replace' | 'above' | 'below') => void;
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
  onAddFile: (file: LocalOfficeFile) => void;
  onOpenMemory: (memoryId: string) => void;
  onOpenObject: (target: WorkspaceObjectPreview) => void;
  onCloseObject: () => void;
  onOpenRoom: (roomId: string) => void;
  onToggleTask: (taskId: string) => void;
  onUpdateRoom: (updater: (room: ContextRoomRecord) => ContextRoomRecord) => void;
  onImportObsidian: () => void;
}) {
  const { t } = useLocale();
  const overview = panels.length === 1 && panels[0] === 'overview';
  const orderedTabs = tabOrder
    .map((pane) => TABS.find((tab) => tab.id === pane))
    .filter((tab): tab is (typeof TABS)[number] => Boolean(tab));

  return (
    <>
      {paneDragPreview ? (() => {
        const previewTab = TABS.find((tab) => tab.id === paneDragPreview.pane);
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
        className={`context-room-workspace-layout${overview ? ' is-overview' : ''}${middleHidden ? ' is-middle-hidden' : ''}${mobileContent ? ' is-mobile-content' : ''}${panels.includes('tasks') ? ' has-task-pane' : ''}`}
        style={{ '--context-room-middle-width': `${String(middleWidth)}px` } as React.CSSProperties}
      >
        <nav className="context-room-workspace-tabs" aria-label={t('contextRoom:roomSidebar.contextRoomDetail')}>
          {orderedTabs.map(({ id, label, icon: Icon, tone }) => (
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
                  className={`${draggedPane === id ? 'is-dragging' : ''}${tabDropTarget?.pane === id ? ` is-drop-${tabDropTarget.position}` : ''}`}
                  onClick={(event) => {
                    if (suppressPaneClickRef.current) { event.preventDefault(); return; }
                    switchPane(id);
                  }}
                  onPointerDown={(event) => startPanePointerDrag(event, id)}
                  onDragStart={(event) => startPaneDrag(event, id)}
                  onDragEnd={clearPaneDrag}
                  onDragOver={(event) => {
                    const pane = getDraggedPane(event);
                    if (!pane) return;
                    event.preventDefault();
                    event.stopPropagation();
                    event.dataTransfer.dropEffect = 'move';
                    const rect = event.currentTarget.getBoundingClientRect();
                    const horizontal = getComputedStyle(event.currentTarget.parentElement ?? event.currentTarget).flexDirection === 'row';
                    setTabDropTarget({ pane: id, position: horizontal
                      ? event.clientX < rect.left + rect.width / 2 ? 'before' : 'after'
                      : event.clientY < rect.top + rect.height / 2 ? 'before' : 'after' });
                    setPaneDropIndex(null);
                  }}
                  onDrop={(event) => {
                    const pane = getDraggedPane(event);
                    if (!pane) return;
                    event.preventDefault();
                    event.stopPropagation();
                    reorderTab(pane, id, tabDropTarget?.position ?? 'before');
                    clearPaneDrag();
                  }}
                  onKeyDown={(event) => {
                    if ((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu') {
                      event.currentTarget.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
                    }
                  }}
                >
                  <Icon aria-hidden="true" />
                </button>
              </ContextMenu.Trigger>
              {id !== 'overview' ? (
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
          <OverviewDashboard
            room={room}
            backendDocuments={backendDocuments}
            onSelectResource={onSelectResource}
            onOpenObject={onOpenObject}
            onToggleTask={onToggleTask}
          />
        ) : (
          <>
            <section
              className={`context-room-workspace-middle${paneDropIndex === 0 && panels.length === 1 ? ' is-pane-drop-top' : ''}${paneDropIndex === 1 && panels.length === 1 ? ' is-pane-drop-bottom' : ''}`}
              onDragOver={(event) => {
                const pane = getDraggedPane(event);
                if (!pane || pane === 'overview') return;
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
                setPaneDropIndex(getPaneDropIndex(event.clientY, event.target as Element));
                setTabDropTarget(null);
              }}
              onDragLeave={(event) => {
                const nextTarget = event.relatedTarget;
                if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
                setPaneDropIndex(null);
              }}
              onDrop={(event) => {
                const pane = getDraggedPane(event);
                if (!pane || pane === 'overview') return;
                event.preventDefault();
                dropPaneIntoWorkspace(pane, getPaneDropIndex(event.clientY, event.target as Element));
                clearPaneDrag();
              }}
            >
              {panels.map((pane, index) => {
                const paneLabel = TABS.find((tab) => tab.id === pane)?.label ?? pane;
                return (
                  <div
                    className={`context-room-workspace-panel${index === activePanelIndex ? ' is-active' : ''}${index < panels.length - 1 ? ' has-divider' : ''}${paneDropIndex === index && panels.length >= 2 ? ' is-drop-target' : ''}`}
                    data-testid={`context-room-workspace-panel-${pane}`}
                    data-panel-index={index}
                    style={{ flexGrow: panelWeights[index] ?? 1 }}
                    key={`${pane}-${String(index)}`}
                    onClick={() => setActivePanelIndex(index)}
                  >
                    {panels.length > 1 ? (
                      <header>
                        <span>{t(paneLabel)}</span>
                        <button
                          type="button"
                          aria-label={t('contextRoom:workspaceLayout.closePanePanel', { pane: t(paneLabel) })}
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
                    <div className="context-room-workspace-panel-body">
                      <WorkspacePaneBody
                        pane={pane}
                        room={room}
                        selectedResourceId={selectedResourceId}
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
                        onAddFile={onAddFile}
                        onOpenMemory={onOpenMemory}
                        onToggleTask={onToggleTask}
                        onUpdateRoom={onUpdateRoom}
                        onOpenObject={onOpenObject}
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
              rooms={rooms}
              panels={panels}
              selectedObject={selectedObject}
              selectedResource={selectedResource}
              backendDocuments={backendDocuments}
              knowledgeFiles={knowledgeFiles}
              focusedDocumentId={focusedDocumentId}
              focusedBlockId={focusedBlockId}
              documentFocusRequestId={documentFocusRequestId}
              onBackendDocumentChange={onBackendDocumentChange}
              onDeleteDocument={onDeleteDocument}
              onOpenRoom={onOpenRoom}
              onMobileBack={() => setMobileContent(false)}
              onCloseObject={onCloseObject}
              onUpdateRoom={onUpdateRoom}
            />
          </>
        )}
      </div>
    </>
  );
}
