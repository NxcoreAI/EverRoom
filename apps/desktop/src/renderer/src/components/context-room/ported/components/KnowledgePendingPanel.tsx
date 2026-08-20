import { ChevronDown, Inbox, Link2, MessageCircle, RefreshCw, Sparkles, Undo2, Upload } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { showToast } from '@/state/toast';
import {
  KNOWLEDGE_ENTITY_KINDS,
  type KnowledgeDecisionDto,
  type KnowledgeEntityDto,
  type KnowledgeUnmatchedItemDto,
} from '../../../../../../shared/knowledge';
import { waitForKnowledgeEntityPromotion } from '../knowledgePromotion';

const SOURCE_KIND_LABELS: Record<string, string> = {
  'everroom-doc': 'Room 文档',
  'reality-event': '会议实录',
  mail: '邮件',
  file: '文件',
  'cloud-doc': '云文档',
};

const NEW_ENTITY = '__new__';

function sourceKindLabel(kind: string): string {
  return SOURCE_KIND_LABELS[kind] ?? kind;
}

/** 推荐池展示上限：页面只放前三个，按证据分排（推荐确认制）。 */
const RECOMMEND_LIMIT = 3;

/**
 * 推荐 Room 面板（entity-room-plan 推荐确认制）：达阈值实体进 ready
 * 推荐池，用户确认后才创建 Room；未识别栏/最近归类保持人工治理入口。
 */
export function KnowledgePendingPanel({ onFocusAgent }: { onFocusAgent: () => void }) {
  const [recommended, setRecommended] = useState<KnowledgeEntityDto[]>([]);
  const [attachPool, setAttachPool] = useState<KnowledgeEntityDto[]>([]);
  const [unmatched, setUnmatched] = useState<KnowledgeUnmatchedItemDto[]>([]);
  const [recent, setRecent] = useState<KnowledgeDecisionDto[]>([]);
  const [attachSelection, setAttachSelection] = useState<Record<string, string>>({});
  const [attachDrafts, setAttachDrafts] = useState<Record<string, { name: string; kind: string }>>({});
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [uploading, setUploading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const promotionControllers = useRef(new Map<string, AbortController>());

  const refresh = useCallback(async () => {
    const knowledge = window.nxcore?.knowledge;
    if (!knowledge) return;
    try {
      // ready = 推荐池；weak+room 仅供未识别栏挂载下拉（该区块不动）
      const [ready, weak, rooms, unmatchedData, recentData] = await Promise.all([
        knowledge.listEntities('ready'),
        knowledge.listEntities('weak'),
        knowledge.listEntities('room'),
        knowledge.listUnmatched(),
        knowledge.listRecentDecisions(10),
      ]);
      setRecommended(
        [...ready.items].sort((a, b) => b.evidenceScore - a.evidenceScore).slice(0, RECOMMEND_LIMIT),
      );
      setAttachPool([...weak.items, ...rooms.items]);
      setUnmatched(unmatchedData.items);
      setRecent(recentData.items);
      setLoaded(true);
    } catch {
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
        showToast({ title: '正在创建 Room', message: `「${entity.name}」的 Room 与 wiki 开始构建` });
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
          showToast({ title: 'Room 已创建', message: `「${promoted.room?.title ?? entity.name}」已加入 Context Room` });
        } else if (!controller.signal.aborted) {
          showToast({ title: '仍在后台创建', message: '完成后会自动同步到 Context Room' });
        }
      } catch (cause) {
        showToast({ title: '创建失败', message: cause instanceof Error ? cause.message : undefined });
        throw cause;
      }
    });

  const attach = (item: KnowledgeUnmatchedItemDto) =>
    runBusy(`attach:${item.decisionId}`, async () => {
      const knowledge = window.nxcore?.knowledge;
      if (!knowledge) return;
      const selection = attachSelection[item.decisionId] ?? '';
      const draft = attachDrafts[item.decisionId];
      try {
        if (selection === NEW_ENTITY) {
          if (!draft?.name?.trim()) {
            showToast({ title: '请填写实体名称' });
            return;
          }
          await knowledge.attachDoc(item.sourceKind, item.sourceId, {
            createEntity: { name: draft.name.trim(), kind: draft.kind },
          });
          showToast({ title: '已挂载', message: `已为「${draft.name.trim()}」记入一份手动证据` });
        } else if (selection) {
          await knowledge.attachDoc(item.sourceKind, item.sourceId, { entityId: selection });
          showToast({ title: '已挂载', message: '资料已记入该实体的证据（manual +1.5）' });
        }
      } catch (cause) {
        showToast({ title: '挂载失败', message: cause instanceof Error ? cause.message : undefined });
        throw cause;
      }
    });

  const revert = (item: KnowledgeDecisionDto) =>
    runBusy(`decision:${item.decisionId}:revert`, async () => {
      try {
        await window.nxcore?.knowledge?.revertDecision(item.decisionId);
        showToast({ title: '已撤销', message: '资料已从该 Room 移除，正在重新归类' });
      } catch (cause) {
        showToast({ title: '撤销失败', message: cause instanceof Error ? cause.message : undefined });
        throw cause;
      }
    });

  const uploadFiles = async () => {
    const filesApi = window.nxcore?.files;
    if (!filesApi) return;
    setUploading(true);
    try {
      const results = await filesApi.pickAndImport();
      if (results.length === 0) return;
      const failed = results.filter((result) => result.error);
      const deduped = results.filter((result) => result.deduped).length;
      const succeeded = results.length - failed.length - deduped;
      if (succeeded > 0) {
        showToast({ title: `已提交 ${succeeded} 份文件`, message: '正在抽取实体并累积证据，达到阈值即进入推荐' });
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

  if (!loaded) return null;

  return (
    <section className="context-room-knowledge-panel" data-testid="context-room-knowledge-pending">
      <div className="context-room-my-title">
        <div className="context-room-home-section-title">
          <span>知识</span>
          <h2>推荐 Room</h2>
        </div>
        <div className="context-room-my-actions" aria-label="推荐 Room 操作">
          <button
            type="button"
            aria-label="上传文件自动归类"
            title="上传 Markdown 文件，抽取实体并累积证据"
            className="context-room-add-room"
            disabled={uploading}
            onClick={() => void uploadFiles()}
          >
            <Upload aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label="刷新推荐状态"
            title="刷新"
            className="context-room-add-room"
            onClick={() => void refresh()}
          >
            <RefreshCw aria-hidden="true" />
          </button>
        </div>
      </div>

      {recommended.length === 0 ? (
        <div className="context-room-knowledge-empty">
          <Inbox aria-hidden="true" />
          <h3>正在理解资料中</h3>
          <p>你也可以告诉 Agent 想创建什么 Room。</p>
          <button type="button" className="context-room-knowledge-empty-cta" onClick={onFocusAgent}>
            <span className="context-room-knowledge-empty-cta-icon">
              <MessageCircle aria-hidden="true" />
            </span>
            <span>和 Agent 说</span>
          </button>
        </div>
      ) : (
        <div className="context-room-knowledge-list">
          <h3 className="context-room-knowledge-group">推荐（按证据分排序，前 3）</h3>
          {recommended.map((entity) => {
            const scoreRatio = Math.min(1, entity.evidenceScore / entity.promoteScore);
            return (
              <article key={entity.id} className="context-room-knowledge-card" data-state="recommended">
                <header>
                  <strong>{entity.name}</strong>
                  <span className="context-room-knowledge-tag">{entity.kind}</span>
                </header>
                <div className="context-room-knowledge-progress" role="progressbar" aria-label="证据进度">
                  <div className="context-room-knowledge-progress-bar">
                    <div className="context-room-knowledge-progress-fill" style={{ width: `${Math.round(scoreRatio * 100)}%` }} />
                  </div>
                  <span>
                    证据 {entity.evidenceScore.toFixed(1)} · 资料 {entity.sourceCount} 份 · 达到推荐阈值
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
                    确认创建
                  </button>
                </footer>
              </article>
            );
          })}
        </div>
      )}

      {unmatched.length > 0 ? (
        <div className="context-room-knowledge-list">
          <h3 className="context-room-knowledge-group">未识别资料（等待挂载）</h3>
          {unmatched.map((item) => {
            const selection = attachSelection[item.decisionId] ?? '';
            const draft = attachDrafts[item.decisionId];
            return (
              <article key={item.decisionId} className="context-room-knowledge-card" data-state="unmatched">
                <header>
                  <strong>{item.title}</strong>
                  <span className="context-room-knowledge-tag">{sourceKindLabel(item.sourceKind)}</span>
                </header>
                {item.reason ? <p className="context-room-knowledge-reason">{item.reason}</p> : null}
                {item.summary ? <p className="context-room-knowledge-summary">{item.summary}</p> : null}
                <div className="context-room-knowledge-attach">
                  <Link2 aria-hidden="true" />
                  <select
                    className="context-room-knowledge-select"
                    value={selection}
                    onChange={(event) => setAttachSelection((current) => ({
                      ...current,
                      [item.decisionId]: event.target.value,
                    }))}
                  >
                    <option value="">挂载到实体…</option>
                    {attachPool.map((entity) => (
                      <option key={entity.id} value={entity.id}>
                        {entity.name}（{entity.status === 'room' ? '已晋升' : '孵化中'}）
                      </option>
                    ))}
                    <option value={NEW_ENTITY}>＋ 新建实体…</option>
                  </select>
                  <button
                    type="button"
                    className="context-room-knowledge-confirm"
                    disabled={!selection || busy.has(`attach:${item.decisionId}`)}
                    onClick={() => void attach(item)}
                  >
                    挂载
                  </button>
                </div>
                {selection === NEW_ENTITY ? (
                  <div className="context-room-knowledge-newentity">
                    <input
                      type="text"
                      placeholder="实体名称"
                      value={draft?.name ?? ''}
                      onChange={(event) => setAttachDrafts((current) => ({
                        ...current,
                        [item.decisionId]: {
                          name: event.target.value,
                          kind: current[item.decisionId]?.kind ?? KNOWLEDGE_ENTITY_KINDS[4],
                        },
                      }))}
                    />
                    <select
                      className="context-room-knowledge-select"
                      value={draft?.kind ?? KNOWLEDGE_ENTITY_KINDS[4]}
                      onChange={(event) => setAttachDrafts((current) => ({
                        ...current,
                        [item.decisionId]: { name: current[item.decisionId]?.name ?? '', kind: event.target.value },
                      }))}
                    >
                      {KNOWLEDGE_ENTITY_KINDS.map((kind) => (
                        <option key={kind} value={kind}>{kind}</option>
                      ))}
                    </select>
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      ) : null}

      {recent.length > 0 ? (
        <details className="context-room-knowledge-history">
          <summary>
            <span>历史记录</span>
            <small>{recent.length}</small>
            <ChevronDown aria-hidden="true" />
          </summary>
          <div className="context-room-knowledge-history-content">
            <div className="context-room-knowledge-recent">
              {recent.map((item) => (
                <div key={item.decisionId} className="context-room-knowledge-recent-row">
                  <span className="context-room-knowledge-recent-title">{item.title}</span>
                  <span className="context-room-knowledge-recent-room">→ {item.roomTitle ?? item.roomId ?? '未归类'}</span>
                  <button
                    type="button"
                    className="context-room-knowledge-revert"
                    disabled={busy.has(`decision:${item.decisionId}:revert`)}
                    title={item.reason ?? undefined}
                    onClick={() => void revert(item)}
                  >
                    <Undo2 aria-hidden="true" />
                    撤销
                  </button>
                </div>
              ))}
            </div>
          </div>
        </details>
      ) : null}
    </section>
  );
}
