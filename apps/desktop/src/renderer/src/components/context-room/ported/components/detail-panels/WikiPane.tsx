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

import { showToast } from '@/state/toast';
import type {
  KnowledgeFileDto,
  KnowledgeWikiGraphDto,
  KnowledgeWikiPageDto,
} from '../../../../../../../shared/knowledge';
import type { ContextRoomRecord, ContextRoomWikiPageResource } from '../../types';
import { formatBytes, knowledgeFileStatusLabel } from '../../resources';
import { WikiGraphCanvas } from '../WikiGraphCanvas';
import { MarkdownBody } from './MarkdownBody';
import { WikiTree } from './WikiTree';

const SOURCE_KIND_LABELS: Record<string, string> = {
  'everroom-doc': 'Room 文档',
  'reality-event': '会议实录',
  mail: '邮件',
  file: '文件',
  'cloud-doc': '云文档',
};

function sourceKindLabel(kind: string): string {
  return SOURCE_KIND_LABELS[kind] ?? kind;
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
        showToast({ title: '图谱加载失败', message: cause instanceof Error ? cause.message : undefined });
        setGraph({ nodes: [], edges: [] });
      })
      .finally(() => setGraphLoading(false));
  }, [view, graph, graphLoading, pages.length, room.id]);

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
      showToast({ title: '读取文件失败', message: cause instanceof Error ? cause.message : undefined });
    }
  };

  const revealFile = async (fileId: string) => {
    const knowledge = window.nxcore?.knowledge;
    if (!knowledge) return;
    try {
      await knowledge.revealFile(fileId);
    } catch (cause) {
      showToast({ title: '定位文件失败', message: cause instanceof Error ? cause.message : undefined });
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
          title: `${deduped} 份文件已存在`,
          message: '同名且内容未变，跳过重复入库',
        });
      }
      if (succeeded > 0) {
        showToast({
          title: `已提交 ${succeeded} 份文件`,
          message: '已归入本 Room，正在沉淀知识页面',
        });
      }
      for (const failure of failed) {
        showToast({ title: `${failure.filename} 上传失败`, message: failure.error ?? undefined });
      }
      window.dispatchEvent(new CustomEvent('everroom:knowledge-changed'));
    } catch (cause) {
      showToast({ title: '上传失败', message: cause instanceof Error ? cause.message : undefined });
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
              返回列表
            </button>
            <strong title={selectedFile.title}>{selectedFile.title}</strong>
          </div>
          <button
            type="button"
            className="context-room-wiki-reveal"
            title="在文件夹中显示原件"
            onClick={() => void revealFile(selectedFile.fileId)}
          >
            <FolderOpen aria-hidden="true" />
            显示原件
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
          <h2>知识库</h2>
          {pages.length > 0 ? <span>{pages.length} 页</span> : null}
        </div>
        <div className="context-room-wiki-actions">
          <div className="context-room-wiki-toggle" role="tablist" aria-label="知识库视图">
            <button
              type="button"
              role="tab"
              aria-label="目录树"
              aria-selected={view === 'tree'}
              className={view === 'tree' ? 'is-active' : ''}
              title="目录树"
              onClick={() => setView('tree')}
            >
              <ListTree aria-hidden="true" />
              <span>目录</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-label="页面内链图谱"
              aria-selected={view === 'graph'}
              className={view === 'graph' ? 'is-active' : ''}
              title="页面内链图谱"
              onClick={() => setView('graph')}
            >
              <Network aria-hidden="true" />
              <span>图谱</span>
            </button>
          </div>
          <button
            type="button"
            className="context-room-wiki-upload"
            aria-label={uploading ? '正在上传文件' : '上传文件'}
            disabled={uploading}
            onClick={() => void uploadFiles()}
          >
            <Upload aria-hidden="true" />
            <span>{uploading ? '上传中…' : '上传文件'}</span>
          </button>
          <button
            type="button"
            className="context-room-wiki-refresh"
            aria-label="刷新"
            title="刷新"
            onClick={() => void refresh()}
          >
            <RefreshCw aria-hidden="true" />
          </button>
        </div>
      </header>
      {status === 'error' ? (
        <div className="context-room-workspace-empty">知识服务不可用：{error}</div>
      ) : status === 'loading' ? (
        <div className="context-room-workspace-empty">加载中…</div>
      ) : status === 'none' ? (
        <div className="context-room-workspace-empty">
          这个 Room 还没有知识沉淀：Room 内文档提交后会自动整理成知识页面。
        </div>
      ) : status === 'processing' || status === 'pending' ? (
        <div className="context-room-workspace-empty">
          知识库正在构建中{pageCount ? `（已生成 ${pageCount} 页）` : ''}，停止编辑片刻后刷新即可查看。
        </div>
      ) : pages.length === 0 ? (
        <div className="context-room-workspace-empty">
          还没有生成知识页面：上传文件或在 Room 里写文档后自动生成。
        </div>
      ) : view === 'graph' ? (
        graphLoading ? (
          <div className="context-room-workspace-empty">图谱构建中…</div>
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
              <span>{graph.nodes.length} 个页面</span>
              <span>{graph.edges.length} 条内链</span>
            </p>
          </div>
        ) : (
          <div className="context-room-workspace-empty">页面之间还没有内链，图谱为空。</div>
        )
      ) : (
        <div className="context-room-wiki-tree-wrap">
          <WikiTree pages={pages} selectedPath={selectedPath} onSelect={openPage} />
        </div>
      )}
      {files.length > 0 && view === 'tree' ? (
        <section className="context-room-wiki-files">
          <h3>来源文件</h3>
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
                      {knowledgeFileStatusLabel(file)} · {formatBytes(file.bytes)}
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  className="context-room-file-reveal"
                  aria-label="在文件夹中显示原件"
                  title="在文件夹中显示原件"
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
