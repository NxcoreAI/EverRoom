import { useEffect, useState } from 'react';
import { FolderOpen } from 'lucide-react';

import { showToast } from '@/state/toast';
import { useLocale } from '../../../../../i18n/LocaleContext';

import type { ContextRoomKnowledgeFileResource } from '../../types';
import { uiText } from '../../adapters';
import { MarkdownBody } from './MarkdownBody';

/**
 * 编辑栏的 knowledge 上传文件阅读器：readFileMarkdown 只读渲染原件，
 * 不进 Tiptap 编辑器（上传文件是只读资料，云文档列表合并展示的一部分）。
 */
export function KnowledgeFileReader({ resource }: { resource: ContextRoomKnowledgeFileResource }) {
  const { t } = useLocale();
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
        showToast({ title: t('contextRoom:knowledgeFileReader.readFailed'), message: cause instanceof Error ? cause.message : undefined });
      });
    return () => { cancelled = true; };
  }, [resource.fileId, t]);

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
    <div className="context-room-wiki-reader-pane">
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
      <div className="context-room-wiki-reader-body">
        {markdown === null ? (
          <div className="context-room-workspace-empty">{t('contextRoom:wiki.loading')}</div>
        ) : (
          <MarkdownBody markdown={markdown} />
        )}
      </div>
    </div>
  );
}
