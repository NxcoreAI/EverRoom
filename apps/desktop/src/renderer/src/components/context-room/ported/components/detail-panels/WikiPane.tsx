import {
  ChevronLeft,
  FileText,
  FolderOpen,
  ListTree,
  Network,
  RefreshCw,
  Upload,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useLocale } from '../../../../../i18n/LocaleContext';

import { showToast } from '@/state/toast';
import type {
  KnowledgeFileDto,
  KnowledgeWikiGraphDto,
  KnowledgeWikiPageDto,
} from '../../../../../../../shared/knowledge';
import type { ContextRoomRecord, ContextRoomWikiPageResource } from '../../types';
import { WikiGraphCanvas } from '../WikiGraphCanvas';
import { MarkdownBody } from './MarkdownBody';
import { WikiTree } from './WikiTree';

const SOURCE_KIND_LABELS: Record<string, string> = {
  'everroom-doc': 'contextRoom:wiki.roomDocument',
  'reality-event': 'contextRoom:wiki.meetingTranscript',
  mail: 'contextRoom:display.email',
  file: 'contextRoom:display.file',
  'cloud-doc': 'contextRoom:wiki.cloudDocument',
};

function sourceKindLabel(kind: string): string {
  return SOURCE_KIND_LABELS[kind] ?? kind;
}

/** 上传文件的沉淀状态徽标文案（route_decisions.status → 展示）。 */
function fileStatusLabel(file: KnowledgeFileDto): string {
  if (file.status === 'confirmed') return 'contextRoom:wiki.captured';
  if (file.status === 'auto') return file.decidedBy === 'user' ? 'contextRoom:wiki.userConfirmedImporting' : 'contextRoom:wiki.classifying';
  if (file.status === 'reverted') return 'contextRoom:wiki.reverted';
  return 'contextRoom:wiki.processing';
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

type WikiView = 'tree' | 'graph';

/**
 * Room 知识库面板（room-wiki 方案 M3c）：wiki 页面按 path 组织成目录树，
 * 点击交给编辑栏（onOpenPage）；图谱视图渲染 md 内链派生的链接图。
 * 来源文件与上传区保留（上传走自动归类路由）。
 */
export function WikiPane({ room, selectedResourceId, onOpenPage }: {
  room: ContextRoomRecord;
  /** 编辑栏当前选中资源 id（wiki 页高亮联动）。 */
  selectedResourceId?: string | null;
  onOpenPage: (resource: ContextRoomWikiPageResource) => void;
}) {
  const { t } = useLocale();
  const [status, setStatus] = useState<string>('loading');
  const [pages, setPages] = useState<KnowledgeWikiPageDto[]>([]);
  const [pageCount, setPageCount] = useState<number | null>(null);
  const [files, setFiles] = useState<KnowledgeFileDto[]>([]);
  const [selectedFile, setSelectedFile] = useState<
    { title: string; markdown: string; fileId: string } | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [view, setView] = useState<WikiView>('tree');
  const [graph, setGraph] = useState<KnowledgeWikiGraphDto | null>(null);
  const [graphLoading, setGraphLoading] = useState(false);

  const selectedPath = selectedResourceId?.startsWith(`${room.id}:wiki:`)
    ? selectedResourceId.slice(`${room.id}:wiki:`.length)
    : null;

  const refresh = useCallback(async () => {
    const knowledge = window.nxcore?.knowledge;
    if (!knowledge) return;
    try {
      const [data, fileList] = await Promise.all([
        knowledge.listWikiPages(room.id),
        knowledge.listRoomFiles(room.id).catch(() => ({ items: [] as KnowledgeFileDto[] })),
      ]);
      setStatus(data.status);
      setPages(data.items);
      setPageCount(data.pageCount);
      setFiles(fileList.items);
      setError(null);
    } catch (cause) {
      setStatus('error');
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [room.id]);

  useEffect(() => {
    setSelectedFile(null);
    setView('tree');
    void refresh();
    // 上传/确认后广播的事件：wiki 内容可能变化（图谱缓存一并作废）
    const onChanged = () => {
      setGraph(null);
      void refresh();
    };
    window.addEventListener('everroom:knowledge-changed', onChanged);
    return () => window.removeEventListener('everroom:knowledge-changed', onChanged);
  }, [refresh]);

  // 图谱懒加载：首次切到图谱视图才拉取（服务端要读全部页面，别在目录态白跑）
  useEffect(() => {
    if (view !== 'graph' || graph || graphLoading || pages.length === 0) return;
    const knowledge = window.nxcore?.knowledge;
    if (!knowledge) return;
    setGraphLoading(true);
    knowledge.getWikiGraph(room.id)
      .then((data) => setGraph(data))
      .catch((cause) => {
        showToast({ title: t('contextRoom:wiki.failedToLoadGraph'), message: cause instanceof Error ? cause.message : undefined });
        setGraph({ nodes: [], edges: [] });
      })
      .finally(() => setGraphLoading(false));
  }, [view, graph, graphLoading, pages.length, room.id, t]);

  const openPage = (page: KnowledgeWikiPageDto) => {
    onOpenPage({
      id: `${room.id}:wiki:${page.path}`,
      roomId: room.id,
      folderId: null,
      name: page.title,
      updatedAt: '',
      kind: 'wiki-page',
      wikiPath: page.path,
    });
  };

  const openFile = async (file: KnowledgeFileDto) => {
    const knowledge = window.nxcore?.knowledge;
    if (!knowledge) return;
    try {
      const data = await knowledge.readFileMarkdown(file.id);
      setSelectedFile({ title: file.originalName, markdown: data.markdown, fileId: file.id });
    } catch (cause) {
      showToast({ title: t('contextRoom:wiki.failedToReadFile'), message: cause instanceof Error ? cause.message : undefined });
    }
  };

  const revealFile = async (fileId: string) => {
    const knowledge = window.nxcore?.knowledge;
    if (!knowledge) return;
    try {
      await knowledge.revealFile(fileId);
    } catch (cause) {
      showToast({ title: t('contextRoom:wiki.failedToLocateFile'), message: cause instanceof Error ? cause.message : undefined });
    }
  };

  const uploadFiles = async () => {
    const filesApi = window.nxcore?.files;
    if (!filesApi) return;
    setUploading(true);
    try {
      // Room 内上传：带 roomId 显式归属（入口直达本 Room，不走全局自动归类）
      const results = await filesApi.pickAndImport({ roomId: room.id });
      if (results.length === 0) return;
      const failed = results.filter((result) => result.error);
      const deduped = results.filter((result) => result.deduped).length;
      const succeeded = results.length - failed.length - deduped;
      if (deduped > 0) {
        showToast({
          title: t('contextRoom:wiki.countFilesAlreadyExist', { count: deduped }),
          message: t('contextRoom:wiki.skippedDuplicateFilesWithTheSameNameAnd'),
        });
      }
      if (succeeded > 0) {
        showToast({
          title: t('contextRoom:wiki.countFilesSubmitted', { count: succeeded }),
          message: t('contextRoom:wiki.classifyingAutomaticallyHighConfidenceFilesGoDirectlyTo'),
        });
      }
      for (const failure of failed) {
        showToast({ title: t('contextRoom:wiki.failedToUploadFilename', { filename: failure.filename }), message: failure.error ?? undefined });
      }
      window.dispatchEvent(new CustomEvent('everroom:knowledge-changed'));
    } catch (cause) {
      showToast({ title: t('contextRoom:wiki.uploadFailed'), message: cause instanceof Error ? cause.message : undefined });
    } finally {
      setUploading(false);
    }
  };

  if (selectedFile) {
    return (
      <div className="context-room-wiki-pane is-reading-file">
        <header className="context-room-wiki-reader-toolbar">
          <div className="context-room-wiki-reader-heading">
            <button type="button" className="context-room-wiki-back" onClick={() => setSelectedFile(null)}>
              <ChevronLeft aria-hidden="true" />
              {t('contextRoom:wiki.backToList')}
            </button>
            <strong title={selectedFile.title}>{selectedFile.title}</strong>
          </div>
          <button
            type="button"
            className="context-room-wiki-reveal"
            title={t('contextRoom:wiki.showOriginalInFolder')}
            onClick={() => void revealFile(selectedFile.fileId)}
          >
            <FolderOpen aria-hidden="true" />
            {t('contextRoom:wiki.showOriginal')}
          </button>
        </header>
        <div className="context-room-wiki-reader">
          <MarkdownBody markdown={selectedFile.markdown} />
        </div>
      </div>
    );
  }

  return (
    <div className="context-room-wiki-pane">
      <header className="context-room-wiki-header">
        <div className="context-room-wiki-title">
          <h2>{t('contextRoom:wiki.knowledgeBase')}</h2>
          {pages.length > 0 ? <span>{t('contextRoom:wiki.countPages', { count: pages.length })}</span> : null}
        </div>
        <div className="context-room-wiki-actions">
          <div className="context-room-wiki-toggle" role="tablist" aria-label={t('contextRoom:wiki.knowledgeBaseView')}>
            <button
              type="button"
              role="tab"
              aria-label={t('contextRoom:wiki.pageTree')}
              aria-selected={view === 'tree'}
              className={view === 'tree' ? 'is-active' : ''}
              title={t('contextRoom:wiki.pageTree')}
              onClick={() => setView('tree')}
            >
              <ListTree aria-hidden="true" />
              <span>{t('contextRoom:wiki.pages')}</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-label={t('contextRoom:wiki.pageLinkGraph')}
              aria-selected={view === 'graph'}
              className={view === 'graph' ? 'is-active' : ''}
              title={t('contextRoom:wiki.pageLinkGraph')}
              onClick={() => setView('graph')}
            >
              <Network aria-hidden="true" />
              <span>{t('contextRoom:wiki.graph')}</span>
            </button>
          </div>
          <button
            type="button"
            className="context-room-wiki-upload"
            aria-label={t(uploading ? 'contextRoom:wiki.uploadingFiles' : 'contextRoom:wiki.uploadFiles')}
            disabled={uploading}
            onClick={() => void uploadFiles()}
          >
            <Upload aria-hidden="true" />
            <span>{t(uploading ? 'contextRoom:wiki.uploading' : 'contextRoom:wiki.uploadFiles')}</span>
          </button>
          <button
            type="button"
            className="context-room-wiki-refresh"
            aria-label={t('contextRoom:wiki.refresh')}
            title={t('contextRoom:wiki.refresh')}
            onClick={() => void refresh()}
          >
            <RefreshCw aria-hidden="true" />
          </button>
        </div>
      </header>
      {status === 'error' ? (
        <div className="context-room-workspace-empty">{t('contextRoom:wiki.knowledgeServiceUnavailableError', { error: error ?? '' })}</div>
      ) : status === 'loading' ? (
        <div className="context-room-workspace-empty">{t('contextRoom:wiki.loading')}</div>
      ) : status === 'none' ? (
        <div className="context-room-workspace-empty">
          {t('contextRoom:wiki.thisRoomHasNoCapturedKnowledgeYetSubmitted')}
        </div>
      ) : status === 'processing' || status === 'pending' ? (
        <div className="context-room-workspace-empty">
          {t('contextRoom:wiki.buildingTheKnowledgeBaseProgressPauseEditingBriefly', { progress: pageCount ? t('contextRoom:wiki.countPagesGenerated', { count: pageCount }) : '' })}
        </div>
      ) : pages.length === 0 ? (
        <div className="context-room-workspace-empty">
          {t('contextRoom:wiki.noKnowledgePagesYetUploadFilesOrWrite')}
        </div>
      ) : view === 'graph' ? (
        graphLoading ? (
          <div className="context-room-workspace-empty">{t('contextRoom:wiki.buildingGraph')}</div>
        ) : graph && graph.nodes.length > 0 ? (
          <div className="context-room-wiki-graph-wrap">
            <WikiGraphCanvas
              graph={graph}
              selectedPath={selectedPath}
              onSelectPage={(path) => {
                const page = pages.find((candidate) => candidate.path === path);
                if (page) openPage(page);
              }}
            />
            <p className="context-room-wiki-graph-hint">
              <span>{t('contextRoom:wiki.pageCountLabel', { count: graph.nodes.length })}</span>
              <span>{t('contextRoom:wiki.countInternalLinks', { count: graph.edges.length })}</span>
            </p>
          </div>
        ) : (
          <div className="context-room-workspace-empty">{t('contextRoom:wiki.thereAreNoLinksBetweenPagesYet')}</div>
        )
      ) : (
        <div className="context-room-wiki-tree-wrap">
          <WikiTree pages={pages} selectedPath={selectedPath} onSelect={openPage} />
        </div>
      )}
      {files.length > 0 && view === 'tree' ? (
        <section className="context-room-wiki-files">
          <h3>{t('contextRoom:wiki.sourceFiles')}</h3>
          <ul>
            {files.map((file) => (
              <li key={file.id}>
                <button type="button" className="context-room-file-item" onClick={() => void openFile(file)}>
                  <span className="context-room-wiki-item-icon">
                    <FileText aria-hidden="true" />
                  </span>
                  <span className="context-room-wiki-item-body">
                    <strong>{file.originalName}</strong>
                    <span>
                      {t(fileStatusLabel(file))} · {formatBytes(file.bytes)}
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  className="context-room-file-reveal"
                  aria-label={t('contextRoom:wiki.showOriginalInFolder')}
                  title={t('contextRoom:wiki.showOriginalInFolder')}
                  onClick={() => void revealFile(file.id)}
                >
                  <FolderOpen aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
