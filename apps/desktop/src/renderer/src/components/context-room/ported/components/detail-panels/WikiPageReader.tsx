import { useEffect, useState } from 'react';
import { useLocale } from '../../../../../i18n/LocaleContext';

import { showToast } from '@/state/toast';

import type { KnowledgeWikiPageDto } from '../../../../../../../shared/knowledge';
import type { ContextRoomWikiPageResource } from '../../types';
import { MarkdownBody, resolveWikiLinkTarget } from './MarkdownBody';

/**
 * 编辑栏的 wiki 页面阅读器（room-wiki 方案 M3c）：readWikiPage 只读渲染，
 * 不复用 TiptapDocumentEditor（那会触发 documents.import 副作用）。
 */
export function WikiPageReader({ resource, onOpenWikiPage }: {
  resource: ContextRoomWikiPageResource;
  /** 双链点击跳转：换选中资源（与目录树点击同链路）。 */
  onOpenWikiPage?: (resource: ContextRoomWikiPageResource) => void;
}) {
  const { t } = useLocale();
  const [markdown, setMarkdown] = useState<string | null>(null);
  // 双链解析需要页面清单（[[标题]] → 页面 path）；拉取失败时双链降级为不可点
  const [pages, setPages] = useState<KnowledgeWikiPageDto[]>([]);

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
        showToast({ title: t('contextRoom:wikiPageReader.failedToLoadPage'), message: cause instanceof Error ? cause.message : undefined });
      });
    return () => { cancelled = true; };
  }, [resource.roomId, resource.wikiPath, t]);

  useEffect(() => {
    let cancelled = false;
    const knowledge = window.nxcore?.knowledge;
    if (!knowledge) return;
    knowledge.listWikiPages(resource.roomId)
      .then((data) => { if (!cancelled) setPages(data.items); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [resource.roomId]);

  const openWikiLink = onOpenWikiPage
    ? (target: string) => {
        const page = resolveWikiLinkTarget(target, pages);
        if (!page) {
          showToast({ title: t('contextRoom:wiki.unresolvedLink') });
          return;
        }
        onOpenWikiPage({
          id: `${resource.roomId}:wiki:${page.path}`,
          roomId: resource.roomId,
          folderId: null,
          name: page.title,
          updatedAt: '',
          kind: 'wiki-page',
          wikiPath: page.path,
        });
      }
    : undefined;

  return (
    <div className="context-room-wiki-reader-pane">
      <header>
        <strong title={resource.name}>{resource.name}</strong>
        <span title={resource.wikiPath}>{resource.wikiPath}</span>
      </header>
      <div className="context-room-wiki-reader-body">
        {markdown === null ? (
          <div className="context-room-workspace-empty">{t('contextRoom:wikiPageReader.loading')}</div>
        ) : (
          <MarkdownBody markdown={markdown} onWikiLink={openWikiLink} />
        )}
      </div>
    </div>
  );
}
