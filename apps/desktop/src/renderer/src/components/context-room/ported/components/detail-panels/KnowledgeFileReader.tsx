import { useEffect, useState } from 'react';
import { FolderOpen } from 'lucide-react';

import { showToast } from '@/state/toast';

import type { ContextRoomKnowledgeFileResource } from '../../types';
import { MarkdownBody } from './MarkdownBody';

/**
 * 编辑栏的 knowledge 上传文件阅读器：readFileMarkdown 只读渲染原件，
 * 不进 Tiptap 编辑器（上传文件是只读资料，云文档列表合并展示的一部分）。
 */
export function KnowledgeFileReader({ resource }: { resource: ContextRoomKnowledgeFileResource }) {
  const [markdown, setMarkdown] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setMarkdown(null);
    const knowledge = window.nxcore?.knowledge;
    if (!knowledge) return;
    knowledge.readFileMarkdown(resource.fileId)
      .then((data) => {
        if (!cancelled) setMarkdown(data.markdown);
      })
      .catch((cause) => {
        if (cancelled) return;
        showToast({ title: '读取文件失败', message: cause instanceof Error ? cause.message : undefined });
      });
    return () => { cancelled = true; };
  }, [resource.fileId]);

  const reveal = async () => {
    const knowledge = window.nxcore?.knowledge;
    if (!knowledge) return;
    try {
      await knowledge.revealFile(resource.fileId);
    } catch (cause) {
      showToast({ title: '定位文件失败', message: cause instanceof Error ? cause.message : undefined });
    }
  };

  return (
    <div className="context-room-wiki-reader-pane">
      <header>
        <strong title={resource.originalName}>{resource.originalName}</strong>
        <span title={resource.updatedAt}>{`${resource.statusLabel} · ${resource.sizeLabel}`}</span>
        <button
          type="button"
          className="context-room-wiki-reveal"
          onClick={() => void reveal()}
          title="在系统文件管理器中显示原件"
        >
          <FolderOpen aria-hidden="true" />
          显示原件
        </button>
      </header>
      <div className="context-room-wiki-reader-body">
        {markdown === null ? (
          <div className="context-room-workspace-empty">加载中…</div>
        ) : (
          <MarkdownBody markdown={markdown} />
        )}
      </div>
    </div>
  );
}
