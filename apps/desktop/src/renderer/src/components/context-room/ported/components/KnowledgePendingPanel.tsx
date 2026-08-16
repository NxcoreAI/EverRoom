import { Inbox, RefreshCw, Sparkles, Undo2, Upload } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { showToast } from '@/state/toast';
import type {
  KnowledgeDecisionDto,
  KnowledgePendingItemDto,
} from '../../../../../../shared/knowledge';

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

/**
 * 待归类队列 + 最近归类（room-wiki 方案 §5.4 人在回路）。
 * 低置信资料在此确认归属（选 Room / 按建议新建），误归类可撤销触发重路由。
 */
export function KnowledgePendingPanel() {
  const [pending, setPending] = useState<KnowledgePendingItemDto[]>([]);
  const [recent, setRecent] = useState<KnowledgeDecisionDto[]>([]);
  const [selectedByDecision, setSelectedByDecision] = useState<Record<string, string>>({});
  const [busyDecisions, setBusyDecisions] = useState<Set<string>>(new Set());
  const [uploading, setUploading] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    const knowledge = window.nxcore?.knowledge;
    if (!knowledge) return;
    try {
      const [pendingData, recentData] = await Promise.all([
        knowledge.listPending(),
        knowledge.listRecentDecisions(10),
      ]);
      setPending(pendingData.items);
      setRecent(recentData.items);
      setLoaded(true);
    } catch {
      setLoaded(true); // 知识服务不可用：面板静默为空
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onChanged = () => void refresh();
    window.addEventListener('everroom:knowledge-changed', onChanged);
    return () => window.removeEventListener('everroom:knowledge-changed', onChanged);
  }, [refresh]);

  const confirm = async (item: KnowledgePendingItemDto, input: { roomIds?: string[]; createRoom?: { name: string; summary?: string; kind?: string } }) => {
    const knowledge = window.nxcore?.knowledge;
    if (!knowledge) return;
    setBusyDecisions((current) => new Set(current).add(item.decisionId));
    try {
      await knowledge.confirmDecision(item.decisionId, input);
      showToast({ title: '已归类', message: `「${item.title}」已开始沉淀知识页面` });
      window.dispatchEvent(new CustomEvent('everroom:knowledge-changed'));
      void refresh();
    } catch (cause) {
      showToast({ title: '确认失败', message: cause instanceof Error ? cause.message : undefined });
    } finally {
      setBusyDecisions((current) => {
        const next = new Set(current);
        next.delete(item.decisionId);
        return next;
      });
    }
  };

  const revert = async (item: KnowledgeDecisionDto) => {
    const knowledge = window.nxcore?.knowledge;
    if (!knowledge) return;
    setBusyDecisions((current) => new Set(current).add(item.decisionId));
    try {
      await knowledge.revertDecision(item.decisionId);
      showToast({ title: '已撤销', message: '资料已从该 Room 移除，正在重新归类' });
      window.dispatchEvent(new CustomEvent('everroom:knowledge-changed'));
      void refresh();
    } catch (cause) {
      showToast({ title: '撤销失败', message: cause instanceof Error ? cause.message : undefined });
    } finally {
      setBusyDecisions((current) => {
        const next = new Set(current);
        next.delete(item.decisionId);
        return next;
      });
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
      const succeeded = results.length - failed.length;
      if (succeeded > 0) {
        showToast({ title: `已提交 ${succeeded} 份文件`, message: '自动归类中，稍后在此查看结果' });
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

  if (!loaded) return null;

  return (
    <section className="context-room-home-section context-room-knowledge-panel" data-testid="context-room-knowledge-pending">
      <div className="context-room-my-title">
        <div className="context-room-home-section-title">
          <span>知识</span>
          <h2>资料归类</h2>
        </div>
        <div className="context-room-my-actions" aria-label="资料归类操作">
          <button
            type="button"
            aria-label="上传文件自动归类"
            title="上传 Markdown 文件，自动归类到 Room"
            className="context-room-add-room"
            disabled={uploading}
            onClick={() => void uploadFiles()}
          >
            <Upload aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label="刷新归类状态"
            title="刷新"
            className="context-room-add-room"
            onClick={() => void refresh()}
          >
            <RefreshCw aria-hidden="true" />
          </button>
        </div>
      </div>

      {pending.length === 0 && recent.length === 0 ? (
        <div className="context-room-knowledge-empty">
          <Inbox aria-hidden="true" />
          <p>暂无待归类资料。上传文件或提交 Room 文档后，低置信内容会出现在这里等待确认。</p>
        </div>
      ) : (
        <div className="context-room-knowledge-list">
          {pending.map((item) => {
            const selected = selectedByDecision[item.decisionId] ?? item.candidates[0]?.roomId ?? '';
            return (
              <article key={item.decisionId} className="context-room-knowledge-card" data-state="pending">
                <header>
                  <strong>{item.title}</strong>
                  <span className="context-room-knowledge-tag">{sourceKindLabel(item.sourceKind)}</span>
                </header>
                {item.reason ? <p className="context-room-knowledge-reason">{item.reason}</p> : null}
                {item.summary ? <p className="context-room-knowledge-summary">{item.summary}</p> : null}
                {item.candidates.length > 0 ? (
                  <div className="context-room-knowledge-candidates" role="radiogroup" aria-label="归属 Room">
                    {item.candidates.map((candidate) => (
                      <label key={candidate.roomId} className="context-room-knowledge-candidate">
                        <input
                          type="radio"
                          name={`candidate-${item.decisionId}`}
                          checked={selected === candidate.roomId}
                          onChange={() => setSelectedByDecision((current) => ({
                            ...current,
                            [item.decisionId]: candidate.roomId,
                          }))}
                        />
                        <span>{candidate.title}</span>
                        {candidate.entityScore !== undefined ? <em>实体 {candidate.entityScore.toFixed(1)}</em> : null}
                        {candidate.vectorSimilarity !== undefined ? <em>向量 {candidate.vectorSimilarity.toFixed(2)}</em> : null}
                      </label>
                    ))}
                  </div>
                ) : (
                  <p className="context-room-knowledge-nocandidates">没有匹配的现有 Room</p>
                )}
                <footer>
                  <button
                    type="button"
                    className="context-room-knowledge-confirm"
                    disabled={!selected || busyDecisions.has(item.decisionId)}
                    onClick={() => void confirm(item, { roomIds: [selected] })}
                  >
                    归入所选 Room
                  </button>
                  {item.newRoom ? (
                    <button
                      type="button"
                      className="context-room-knowledge-create"
                      disabled={busyDecisions.has(item.decisionId)}
                      onClick={() => void confirm(item, {
                        createRoom: {
                          name: item.newRoom!.name,
                          summary: item.newRoom!.summary || undefined,
                          ...(item.newRoom!.kind ? { kind: item.newRoom!.kind } : {}),
                        },
                      })}
                    >
                      <Sparkles aria-hidden="true" />
                      新建「{item.newRoom.name}」
                    </button>
                  ) : null}
                </footer>
              </article>
            );
          })}

          {recent.length > 0 ? (
            <div className="context-room-knowledge-recent">
              <h3>最近归类（可撤销）</h3>
              {recent.map((item) => (
                <div key={item.decisionId} className="context-room-knowledge-recent-row">
                  <span className="context-room-knowledge-recent-title">{item.title}</span>
                  <span className="context-room-knowledge-recent-room">→ {item.roomTitle ?? item.roomId ?? '未归类'}</span>
                  <button
                    type="button"
                    className="context-room-knowledge-revert"
                    disabled={busyDecisions.has(item.decisionId)}
                    title={item.reason ?? undefined}
                    onClick={() => void revert(item)}
                  >
                    <Undo2 aria-hidden="true" />
                    撤销
                  </button>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}
