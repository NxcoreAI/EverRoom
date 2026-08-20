import { Inbox, RefreshCw, Sparkles, Upload } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { showToast } from '@/state/toast';
import { useLocale } from '../../../../i18n/LocaleContext';
import type { KnowledgeEntityDto } from '../../../../../../shared/knowledge';
import { waitForKnowledgeEntityPromotion } from '../knowledgePromotion';

/** 推荐池展示上限：页面只放前三个，按证据分排（推荐确认制）。 */
const RECOMMEND_LIMIT = 3;

/**
 * 推荐 Room 面板（entity-room-plan 推荐确认制）：只有达阈值且尚未创建
 * Room 的 ready 实体才会出现在这里，用户确认后才创建 Room。
 */
export function KnowledgePendingPanel() {
  const { t } = useLocale();
  const [recommended, setRecommended] = useState<KnowledgeEntityDto[]>([]);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [uploading, setUploading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const promotionControllers = useRef(new Map<string, AbortController>());

  const refresh = useCallback(async () => {
    const knowledge = window.nxcore?.knowledge;
    if (!knowledge) {
      setRecommended([]);
      setLoaded(true);
      return;
    }
    try {
      const ready = await knowledge.listEntities('ready');
      setRecommended(
        [...ready.items].sort((a, b) => b.evidenceScore - a.evidenceScore).slice(0, RECOMMEND_LIMIT),
      );
      setLoaded(true);
    } catch {
      setRecommended([]);
      setLoaded(true); // 知识服务不可用：面板静默为空
    }
  }, []);

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => void refresh(), 5_000);
    const onChanged = () => void refresh();
    window.addEventListener('everroom:knowledge-changed', onChanged);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('everroom:knowledge-changed', onChanged);
    };
  }, [refresh]);

  useEffect(() => () => {
    for (const controller of promotionControllers.current.values()) controller.abort();
    promotionControllers.current.clear();
  }, []);

  const runBusy = async (key: string, action: () => Promise<void>) => {
    setBusy((current) => new Set(current).add(key));
    try {
      await action();
      window.dispatchEvent(new CustomEvent('everroom:knowledge-changed'));
      void refresh();
    } catch {
      // Each action reports its own user-facing error; do not leak a rejected click promise.
    } finally {
      setBusy((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }
  };

  const confirmCreate = (entity: KnowledgeEntityDto) =>
    runBusy(`entity:${entity.id}:promote`, async () => {
      try {
        const knowledge = window.nxcore?.knowledge;
        if (!knowledge) return;
        await knowledge.promoteEntity(entity.id);
        showToast({ title: t('正在创建 Room'), message: t('「{name}」的 Room 与 wiki 开始构建', { name: entity.name }) });
        const controller = new AbortController();
        promotionControllers.current.get(entity.id)?.abort();
        promotionControllers.current.set(entity.id, controller);
        let promoted: Awaited<ReturnType<typeof waitForKnowledgeEntityPromotion>>;
        try {
          promoted = await waitForKnowledgeEntityPromotion(knowledge, entity.id, {
            signal: controller.signal,
          });
        } finally {
          if (promotionControllers.current.get(entity.id) === controller) {
            promotionControllers.current.delete(entity.id);
          }
        }
        if (promoted) {
          showToast({ title: t('Room 已创建'), message: t('「{name}」已加入 Context Room', { name: promoted.room?.title ?? entity.name }) });
        } else if (!controller.signal.aborted) {
          showToast({ title: t('仍在后台创建'), message: t('完成后会自动同步到 Context Room') });
        }
      } catch (cause) {
        showToast({ title: t('创建失败'), message: cause instanceof Error ? cause.message : undefined });
        throw cause;
      }
    });

  const uploadFiles = async () => {
    const knowledge = window.nxcore?.knowledge;
    if (!knowledge) return;
    setUploading(true);
    try {
      const results = await knowledge.pickAndUploadFiles();
      if (results.length === 0) return;
      const failed = results.filter((result) => result.error);
      const succeeded = results.length - failed.length;
      if (succeeded > 0) {
        showToast({ title: t('已提交 {count} 份文件', { count: succeeded }), message: t('正在抽取实体并累积证据，达到阈值即进入推荐') });
      }
      for (const failure of failed) {
        showToast({ title: t('{filename} 上传失败', { filename: failure.filename }), message: failure.error });
      }
      window.dispatchEvent(new CustomEvent('everroom:knowledge-changed'));
    } catch (cause) {
      showToast({ title: t('上传失败'), message: cause instanceof Error ? cause.message : undefined });
    } finally {
      setUploading(false);
    }
  };

  if (!loaded) return null;

  const empty = recommended.length === 0;

  return (
    <section className="context-room-knowledge-panel" data-testid="context-room-knowledge-pending">
      <div className="context-room-my-title">
        <div className="context-room-home-section-title">
          <span>{t('知识')}</span>
          <h2>{t('推荐 Room')}</h2>
        </div>
        <div className="context-room-my-actions" aria-label={t('推荐 Room 操作')}>
          <button
            type="button"
            aria-label={t('上传文件自动归类')}
            title={t('上传 Markdown 文件，抽取实体并累积证据')}
            className="context-room-add-room"
            disabled={uploading}
            onClick={() => void uploadFiles()}
          >
            <Upload aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label={t('刷新推荐状态')}
            title={t('刷新')}
            className="context-room-add-room"
            onClick={() => void refresh()}
          >
            <RefreshCw aria-hidden="true" />
          </button>
        </div>
      </div>

      {empty ? (
        <div className="context-room-knowledge-empty">
          <Inbox aria-hidden="true" />
          <p>{t('暂无推荐 Room。上传资料后系统会自动抽取实体并累积证据，达到阈值即在此推荐。')}</p>
        </div>
      ) : (
        <div className="context-room-knowledge-list">
          {recommended.length > 0 ? <h3 className="context-room-knowledge-group">{t('推荐（按证据分排序，前 3）')}</h3> : null}
          {recommended.map((entity) => {
            const scoreRatio = Math.min(1, entity.evidenceScore / entity.promoteScore);
            return (
              <article key={entity.id} className="context-room-knowledge-card" data-state="recommended">
                <header>
                  <strong>{entity.name}</strong>
                  <span className="context-room-knowledge-tag">{entity.kind}</span>
                </header>
                <div className="context-room-knowledge-progress" role="progressbar" aria-label={t('证据进度')}>
                  <div className="context-room-knowledge-progress-bar">
                    <div className="context-room-knowledge-progress-fill" style={{ width: `${Math.round(scoreRatio * 100)}%` }} />
                  </div>
                  <span>
                    {t('证据 {score} · 资料 {count} 份 · 达到推荐阈值', { score: entity.evidenceScore.toFixed(1), count: entity.sourceCount })}
                  </span>
                </div>
                {entity.firstEvidence ? (
                  <p className="context-room-knowledge-summary">{entity.firstEvidence}</p>
                ) : null}
                <footer>
                  <button
                    type="button"
                    className="context-room-knowledge-confirm"
                    disabled={busy.has(`entity:${entity.id}:promote`)}
                    onClick={() => void confirmCreate(entity)}
                  >
                    <Sparkles aria-hidden="true" />
                    {t('确认创建')}
                  </button>
                </footer>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
