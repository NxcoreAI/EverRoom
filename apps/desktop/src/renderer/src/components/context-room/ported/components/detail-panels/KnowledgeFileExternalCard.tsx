import { ExternalLink, FolderOpen } from 'lucide-react';
import { useState } from 'react';

import { showToast } from '@/state/toast';
import { useLocale } from '../../../../../i18n/LocaleContext';

import type { ContextRoomKnowledgeFileResource } from '../../types';
import { uiText } from '../../adapters';

/**
 * 无应用内预览上传文件（pdf/图片等非 md 非 Office）的编辑栏占位卡：
 * 资源被选中时已用系统默认应用打开原件，这里只留状态/体积与手动打开、
 * 定位原件入口（Office 文件走顶栏内嵌预览标签，不进此卡）。
 */
export function KnowledgeFileExternalCard({ resource }: { resource: ContextRoomKnowledgeFileResource }) {
  const { t } = useLocale();
  const [opening, setOpening] = useState(false);

  const openOriginal = async () => {
    const knowledge = window.nxcore?.knowledge;
    if (!knowledge) return;
    setOpening(true);
    try {
      await knowledge.openFile(resource.fileId);
    } catch (cause) {
      showToast({
        title: t('contextRoom:knowledgeFileExternal.openFailed'),
        message: cause instanceof Error ? cause.message : undefined,
      });
    } finally {
      setOpening(false);
    }
  };

  const reveal = async () => {
    const knowledge = window.nxcore?.knowledge;
    if (!knowledge) return;
    try {
      await knowledge.revealFile(resource.fileId);
    } catch (cause) {
      showToast({
        title: t('contextRoom:knowledgeFileReader.revealFailed'),
        message: cause instanceof Error ? cause.message : undefined,
      });
    }
  };

  return (
    <div className="context-room-wiki-reader-pane" data-testid="context-room-knowledge-external-card">
      <header>
        <strong title={resource.originalName}>{resource.originalName}</strong>
        <span title={resource.updatedAt}>{`${t(uiText(resource.statusLabel))} · ${resource.sizeLabel}`}</span>
      </header>
      <div className="context-room-external-file-body">
        <p>{t('contextRoom:knowledgeFileExternal.openedWithSystemApp')}</p>
        <div className="context-room-external-file-actions">
          <button
            type="button"
            className="context-room-wiki-reveal"
            disabled={opening}
            onClick={() => void openOriginal()}
          >
            <ExternalLink aria-hidden="true" />
            {t(opening
              ? 'contextRoom:knowledgeFileExternal.opening'
              : 'contextRoom:knowledgeFileExternal.openWithSystemApp')}
          </button>
          <button
            type="button"
            className="context-room-wiki-reveal"
            onClick={() => void reveal()}
            title={t('contextRoom:knowledgeFileReader.showOriginalInSystemFileManager')}
          >
            <FolderOpen aria-hidden="true" />
            {t('contextRoom:wiki.showOriginal')}
          </button>
        </div>
      </div>
    </div>
  );
}
