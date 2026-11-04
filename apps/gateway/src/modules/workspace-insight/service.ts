import type { AgentService } from "../agent/service.js";
import { composeWorkspaceInsight, type WorkspaceInsightComposition, type WorkspaceInsightEvidence } from "./composer.js";

/**
 * 工作空间洞察服务：供料 → LLM 提炼（模板兜底）→ 内存缓存。
 *
 * 洞察是派生物（product-data-map §9「不建表」），只在内存里按「证据指纹」缓存：
 * 指纹 = 会话 id:status:相对时间 + 资料库规模，变了才重新提炼；
 * 同指纹 5 分钟内直接复用（省模型调用），单飞去并发。
 */

const CACHE_TTL_MS = 5 * 60 * 1000;
/** 每个空间最多 1 份缓存 + 最多 32 个空间（LRU 淘汰）。 */
const MAX_CACHED_WORKSPACES = 32;

interface CacheEntry {
  composition: WorkspaceInsightComposition;
  fingerprint: string;
  capturedAt: number;
}

export interface WorkspaceInsightServiceOptions {
  agent: Pick<AgentService, "listSessions" | "getSnapshot">;
  /** 资料库计数（files service 的 catalogCounts 视图）。 */
  libraryCountSource: { catalogCounts(options?: { workspaceId?: string }): { library: number; artifacts: number; total: number } } | null;
  compose: (evidence: WorkspaceInsightEvidence) => Promise<WorkspaceInsightComposition>;
  workspaceName?: (workspaceId: string) => string;
  /** 相对时间格式化（默认「N 分钟前」式简版；注入以便测试）。 */
  relativeLabel?: (iso: string, now: number) => string;
  now?: () => number;
  logger?: (level: "info" | "warn" | "error", event: string, fields?: Record<string, unknown>) => void;
}

function defaultRelativeLabel(iso: string, now: number): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return "";
  const deltaMinutes = Math.max(0, Math.round((now - time) / 60_000));
  if (deltaMinutes < 1) return "刚刚";
  if (deltaMinutes < 60) return `${deltaMinutes} 分钟前`;
  const deltaHours = Math.round(deltaMinutes / 60);
  if (deltaHours < 24) return `${deltaHours} 小时前`;
  const deltaDays = Math.round(deltaHours / 24);
  if (deltaDays === 1) return "昨天";
  if (deltaDays < 7) return `${deltaDays} 天前`;
  const date = new Date(time);
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

/** 最近正文截断：证据里每条工作最多带 160 字。 */
function excerptLastText(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 160 ? `${flat.slice(0, 159)}…` : flat;
}

export class WorkspaceInsightService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<WorkspaceInsightComposition>>();
  private readonly options: WorkspaceInsightServiceOptions;

  constructor(options: WorkspaceInsightServiceOptions) {
    this.options = options;
  }

  /** 证据指纹：会话状态集合 + 资料库规模（updatedLabel 已含时效，不重复进指纹）。 */
  private fingerprintOf(
    sessions: readonly { id: string; status: string; updatedLabel: string }[],
    inventory: { total: number } | null,
  ): string {
    return this.fingerprintOfRaw(
      sessions.map((session) => `${session.id}:${session.status}:${session.updatedLabel}`),
      inventory,
    );
  }

  private fingerprintOfRaw(parts: readonly string[], inventory: { total: number } | null): string {
    const sessions = parts.join("|");
    return [
      sessions,
      inventory ? `inv:${inventory.total}` : "inv:-",
    ].join("#");
  }

  /** 组装证据：本空间会话（updatedAt 倒序，最多 8 条）+ 每条的最后 assistant 正文 + 资料库规模。 */
  private buildEvidence(workspaceId: string): WorkspaceInsightEvidence {
    const now = this.options.now?.() ?? Date.now();
    const sessions = this.options.agent
      .listSessions(undefined, undefined, workspaceId)
      .slice(0, 8)
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));

    const relativeLabel = this.options.relativeLabel ?? defaultRelativeLabel;
    const evidenceSessions = sessions.map((session) => {
      let lastText: string | null = null;
      try {
        const snapshot = this.options.agent.getSnapshot(session.id);
        const messages = snapshot?.messages ?? [];
        for (let index = messages.length - 1; index >= 0; index -= 1) {
          const message = messages[index]!;
          if (message.role !== "assistant") continue;
          const text = message.content.replace(/\s+/g, " ").trim();
          if (text) {
            lastText = excerptLastText(text);
            break;
          }
        }
      } catch {
        lastText = null;
      }
      return {
        id: session.id,
        title: session.title?.trim() || "未命名工作",
        status: session.status,
        updatedLabel: relativeLabel(session.updatedAt, now),
        lastText,
      };
    });

    let inventory: WorkspaceInsightEvidence["inventory"] = null;
    try {
      const counts = this.options.libraryCountSource?.catalogCounts({ workspaceId });
      if (counts && counts.total > 0) {
        inventory = {
          library: Math.max(0, counts.library),
          artifacts: Math.max(0, counts.artifacts),
          total: Math.max(0, counts.total),
        };
      }
    } catch {
      inventory = null;
    }

    return {
      workspaceId,
      workspaceName: this.options.workspaceName?.(workspaceId) ?? "项目空间",
      sessions: evidenceSessions,
      inventory,
    };
  }

  /**
   * 取洞察：指纹命中且未过期 → 缓存；否则提炼（单飞）。
   * `force` 跳过缓存（手动刷新）。
   */
  async get(workspaceId: string, options: { force?: boolean } = {}): Promise<WorkspaceInsightComposition & { cached: boolean }> {
    const evidence = this.buildEvidence(workspaceId);
    const fingerprint = this.fingerprintOf(evidence.sessions, evidence.inventory);
    const now = this.options.now?.() ?? Date.now();

    if (!options.force) {
      const cached = this.cache.get(workspaceId);
      if (cached && cached.fingerprint === fingerprint && now - cached.capturedAt < CACHE_TTL_MS) {
        return { ...cached.composition, cached: true };
      }
    }

    let task = this.inflight.get(workspaceId);
    if (!task) {
      task = this.options.compose(evidence).finally(() => {
        this.inflight.delete(workspaceId);
      });
      this.inflight.set(workspaceId, task);
    }
    const composition = await task;

    this.cache.set(workspaceId, { composition, fingerprint, capturedAt: now });
    if (this.cache.size > MAX_CACHED_WORKSPACES) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    if (this.options.logger) {
      this.options.logger("info", "workspace-insight.generated", {
        workspaceId,
        model: composition.model,
        advice: composition.advice.length,
        sessions: evidence.sessions.length,
      });
    }
    return { ...composition, cached: false };
  }
}
