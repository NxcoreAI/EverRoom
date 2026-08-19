import { useEffect, useState } from 'react';

import { showToast } from '@/state/toast';

import type { ContextRoomWikiPageResource } from '../../types';
import { MarkdownBody } from './MarkdownBody';

/**
 * 编辑栏的 wiki 页面阅读器（room-wiki 方案 M3c）：readWikiPage 只读渲染，
 * 不复用 TiptapDocumentEditor（那会触发 documents.import 副作用）。
 */
export function WikiPageReader({ resource }: { resource: ContextRoomWikiPageResource }) {
  const [markdown, setMarkdown] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setMarkdown(null);
    const knowledge = window.nxcore?.knowledge;
    if (!knowledge) return;
    knowledge.readWikiPage(resource.roomId, resource.wikiPath)
      .then((data) => {
        if (!cancelled) setMarkdown(data.markdown);
      })
      .catch((cause) => {
        if (cancelled) return;
        showToast({ title: '读取页面失败', message: cause instanceof Error ? cause.message : undefined });
      });
    return () => { cancelled = true; };
  }, [resource.roomId, resource.wikiPath]);

  return (
    <div className="context-room-wiki-reader-pane">
      <header>
        <strong>{resource.name}</strong>
        <span>{resource.wikiPath}</span>
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
