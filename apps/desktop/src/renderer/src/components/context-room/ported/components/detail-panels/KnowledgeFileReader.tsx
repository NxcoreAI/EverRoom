import { useEffect, useRef, useState } from 'react';
import { FolderOpen, ListTree } from 'lucide-react';

import { showToast } from '@/state/toast';
import { useLocale } from '../../../../../i18n/LocaleContext';

import type { ContextRoomKnowledgeFileResource } from '../../types';
import { uiText } from '../../adapters';
import { MarkdownBody } from './MarkdownBody';

interface ReaderTocEntry {
  id: string;
  level: number;
  text: string;
}

/**
 * 编辑栏的 knowledge 上传文件阅读器：readFileMarkdown 只读渲染原件，
 * 不进 Tiptap 编辑器（上传文件是只读资料，云文档列表合并展示的一部分）。
 * 长文档/Markdown 提供目录边栏（PRD 6.6）：按标题层级生成锚点，点击定位。
 */
export function KnowledgeFileReader({ resource }: { resource: ContextRoomKnowledgeFileResource }) {
  const { t } = useLocale();
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [toc, setToc] = useState<ReaderTocEntry[]>([]);
  const bodyRef = useRef<HTMLDivElement>(null);

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
        showToast({ title: t('contextRoom:knowledgeFileReader.readFailed'), message: cause instanceof Error ? cause.message : undefined });
      });
    return () => { cancelled = true; };
  }, [resource.fileId, t]);

  // 渲染完成后扫描标题（MarkdownBody 把 # 映射为 h3…h6），生成锚点目录。
  useEffect(() => {
    if (markdown === null) return;
    const container = bodyRef.current;
    if (!container) return;
    const used = new Set<string>();
    const entries = Array.from(container.querySelectorAll('h3, h4, h5, h6')).flatMap((heading, index) => {
      const text = heading.textContent?.trim() ?? '';
      if (!text) return [];
      let slug = text.toLowerCase().replace(/\s+/g, '-');
      while (used.has(slug)) slug = `${slug}-${String(index)}`;
      used.add(slug);
      heading.id = slug;
      return [{ id: slug, level: Number(heading.tagName.slice(1)), text }];
    });
    setToc(entries);
    return () => {
      for (const entry of entries) {
        const element = container.querySelector(`#${CSS.escape(entry.id)}`);
        element?.removeAttribute('id');
      }
    };
  }, [markdown]);

  const reveal = async () => {
    const knowledge = window.nxcore?.knowledge;
    if (!knowledge) return;
    try {
      await knowledge.revealFile(resource.fileId);
    } catch (cause) {
      showToast({ title: t('contextRoom:knowledgeFileReader.revealFailed'), message: cause instanceof Error ? cause.message : undefined });
    }
  };

  return (
    <div className={`context-room-wiki-reader-pane${toc.length ? ' has-toc' : ''}`}>
      <header>
        <strong title={resource.originalName}>{resource.originalName}</strong>
        <span title={resource.updatedAt}>{`${t(uiText(resource.statusLabel))} · ${resource.sizeLabel}`}</span>
        <button
          type="button"
          className="context-room-wiki-reveal"
          onClick={() => void reveal()}
          title={t('contextRoom:knowledgeFileReader.showOriginalInSystemFileManager')}
        >
          <FolderOpen aria-hidden="true" />
          {t('contextRoom:wiki.showOriginal')}
        </button>
      </header>
      {toc.length ? (
        <nav className="context-room-reader-toc" aria-label={t('contextRoom:knowledgeFileReader.tocTitle')}>
          <strong><ListTree aria-hidden="true" />{t('contextRoom:knowledgeFileReader.tocTitle')}</strong>
          {toc.map((entry) => (
            <button
              type="button"
              key={entry.id}
              data-level={String(entry.level)}
              title={entry.text}
              onClick={() => bodyRef.current?.querySelector(`#${CSS.escape(entry.id)}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
            >
              {entry.text}
            </button>
          ))}
        </nav>
      ) : null}
      <div className="context-room-wiki-reader-body" ref={bodyRef}>
        {markdown === null ? (
          <div className="context-room-workspace-empty">{t('contextRoom:wiki.loading')}</div>
        ) : (
          <MarkdownBody markdown={markdown} />
        )}
      </div>
    </div>
  );
}
