import { BookOpen, ChevronLeft, FileText, FolderOpen, RefreshCw, Upload } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { showToast } from '@/state/toast';
import type { KnowledgeFileDto, KnowledgeWikiPageDto } from '../../../../../../../shared/knowledge';
import type { ContextRoomRecord } from '../../types';

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

/** 上传文件的沉淀状态徽标文案（route_decisions.status → 展示）。 */
function fileStatusLabel(file: KnowledgeFileDto): string {
  if (file.status === 'confirmed') return '已沉淀';
  if (file.status === 'auto') return file.decidedBy === 'user' ? '用户确认·入库中' : '归类中';
  if (file.status === 'reverted') return '已撤销';
  return '处理中';
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 剥 KS 页面 frontmatter（--- 包围的元数据块）。 */
function stripFrontmatter(markdown: string): string {
  if (!markdown.startsWith('---')) return markdown;
  const end = markdown.indexOf('\n---', 3);
  return end >= 0 ? markdown.slice(end + 4).replace(/^\s*\n/, '') : markdown;
}

interface MarkdownBlock {
  key: number;
  kind: 'h1' | 'h2' | 'h3' | 'li' | 'p';
  text: string;
}

/** 轻量 markdown 分块：标题/列表/段落（wiki 页面以这三种为主，够用且零依赖）。 */
function parseMarkdown(markdown: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  const lines = stripFrontmatter(markdown).split('\n');
  let paragraph: string[] = [];
  let key = 0;
  const flush = () => {
    const text = paragraph.join(' ').trim();
    paragraph = [];
    if (text) blocks.push({ key: key++, kind: 'p', text });
  };
  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!line.trim()) {
      flush();
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      const level = heading[1]!.length;
      blocks.push({ key: key++, kind: level === 1 ? 'h1' : level === 2 ? 'h2' : 'h3', text: heading[2]! });
      continue;
    }
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      flush();
      blocks.push({ key: key++, kind: 'li', text: bullet[1]! });
      continue;
    }
    paragraph.push(line.trim());
  }
  flush();
  return blocks;
}

function MarkdownBody({ markdown }: { markdown: string }) {
  const blocks = parseMarkdown(markdown);
  return (
    <div className="context-room-wiki-markdown">
      {blocks.map((block) => {
        if (block.kind === 'h1') return <h3 key={block.key}>{block.text}</h3>;
        if (block.kind === 'h2') return <h4 key={block.key}>{block.text}</h4>;
        if (block.kind === 'h3') return <h5 key={block.key}>{block.text}</h5>;
        if (block.kind === 'li') return <li key={block.key}>{block.text}</li>;
        return <p key={block.key}>{block.text}</p>;
      })}
    </div>
  );
}

/**
 * Room 知识库面板（room-wiki 方案 M3）：本 Room wiki 的页面列表与阅读。
 * 页面由文档/资料 ingest 后自动生成；"上传文件"走自动归类路由。
 */
export function WikiPane({ room }: { room: ContextRoomRecord }) {
  const [status, setStatus] = useState<string>('loading');
  const [pages, setPages] = useState<KnowledgeWikiPageDto[]>([]);
  const [pageCount, setPageCount] = useState<number | null>(null);
  const [files, setFiles] = useState<KnowledgeFileDto[]>([]);
  const [selected, setSelected] = useState<
    { kind: 'page' | 'file'; title: string; markdown: string; fileId?: string } | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

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
    setSelected(null);
    void refresh();
    // 上传/确认后广播的事件：wiki 内容可能变化
    const onChanged = () => void refresh();
    window.addEventListener('everroom:knowledge-changed', onChanged);
    return () => window.removeEventListener('everroom:knowledge-changed', onChanged);
  }, [refresh]);

  const openPage = async (page: KnowledgeWikiPageDto) => {
    const knowledge = window.nxcore?.knowledge;
    if (!knowledge) return;
    try {
      const data = await knowledge.readWikiPage(room.id, page.path);
      setSelected({ kind: 'page', title: page.title, markdown: data.markdown });
    } catch (cause) {
      showToast({ title: '读取页面失败', message: cause instanceof Error ? cause.message : undefined });
    }
  };

  const openFile = async (file: KnowledgeFileDto) => {
    const knowledge = window.nxcore?.knowledge;
    if (!knowledge) return;
    try {
      const data = await knowledge.readFileMarkdown(file.id);
      setSelected({ kind: 'file', title: file.originalName, markdown: data.markdown, fileId: file.id });
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
    const knowledge = window.nxcore?.knowledge;
    if (!knowledge) return;
    setUploading(true);
    try {
      const results = await knowledge.pickAndUploadFiles();
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
          message: '自动归类中：高置信直接入 Room，其余进入待归类队列',
        });
      }
      for (const failure of failed) {
        showToast({ title: `${failure.filename} 上传失败`, message: failure.error });
      }
      window.dispatchEvent(new CustomEvent('everroom:knowledge-changed'));
    } catch (cause) {
      showToast({ title: '上传失败', message: cause instanceof Error ? cause.message : undefined });
    } finally {
      setUploading(false);
    }
  };

  if (selected) {
    return (
      <div className="context-room-wiki-pane">
        <header>
          <button type="button" className="context-room-wiki-back" onClick={() => setSelected(null)}>
            <ChevronLeft aria-hidden="true" />
            返回列表
          </button>
          {selected.kind === 'file' && selected.fileId ? (
            <button
              type="button"
              className="context-room-wiki-reveal"
              title="在文件夹中显示原件"
              onClick={() => void revealFile(selected.fileId!)}
            >
              <FolderOpen aria-hidden="true" />
              显示原件
            </button>
          ) : null}
        </header>
        <div className="context-room-wiki-reader">
          <MarkdownBody markdown={selected.markdown} />
        </div>
      </div>
    );
  }

  return (
    <div className="context-room-wiki-pane">
      <header>
        <h2>知识库</h2>
        <div className="context-room-wiki-actions">
          <button
            type="button"
            className="context-room-wiki-upload"
            disabled={uploading}
            onClick={() => void uploadFiles()}
          >
            <Upload aria-hidden="true" />
            {uploading ? '上传中…' : '上传文件'}
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
      ) : (
        <ul className="context-room-wiki-list">
          {pages.map((page) => (
            <li key={page.id}>
              <button type="button" className="context-room-wiki-item" onClick={() => void openPage(page)}>
                <span className="context-room-wiki-item-icon">
                  <BookOpen aria-hidden="true" />
                </span>
                <span className="context-room-wiki-item-body">
                  <strong>{page.title}</strong>
                  <span>{page.description || sourceKindLabel(page.type)}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {files.length > 0 ? (
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
                      {fileStatusLabel(file)} · {formatBytes(file.bytes)}
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
