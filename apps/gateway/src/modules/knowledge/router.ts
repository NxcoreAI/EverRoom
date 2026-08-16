/**
 * 自动归类路由瀑布（plan §5.2）：① 入口确定性 → ② 链接/规则 →
 * ③ 实体候选 → ④ 向量候选 → ⑤ LLM 终审。
 *
 * ①② 是决策层（decidedBy=entry/link/rule，confidence=1）；
 * ③④ 只产候选与证据（分数进 evidence，不做决策）；
 * ⑤ 是唯一非确定性决策层（decidedBy=llm），未配置 LLM 时
 * 以 M1 形态收尾：候选连同证据落待归类队列，人工即仲裁者。
 *
 * 输出统一为：execute（可直接 ingest）或 review（待归类），
 * decision 行由本层创建，worker 据此驱动后续动作。
 */

import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import type { GatewayDatabase } from "../../infrastructure/database/client.js";
import {
  roomDocumentLinks,
  routeDecisions,
  routingRules,
  roomWikis,
  rooms,
} from "../../infrastructure/database/schema.js";
import { bigramDiceSimilarity, documentTerms, roomTerms, scoreEntityMatches, type EntityScore } from "./entity-index.js";
import type { DocEnvelope } from "./envelope.js";
import type { CandidateCard, KnowledgeLlm } from "./llm.js";
import { embeddingInputText, rankByCentroids, type EmbeddingClient, type VectorScore } from "./embedding.js";
import type { WikiPageIndex } from "./wiki-index.js";

/** create_new 重名去重阈值（plan §4.2：bigram Dice + aliases 比对）。 */
export const ROOM_NAME_DEDUP_THRESHOLD = 0.6;
/** ⑤ 卷宗候选上限（③④ 并集截断）。 */
const DOSSIER_CANDIDATE_LIMIT = 8;
/** ③④ 各自的 top N。 */
const CANDIDATE_TOP_N = 5;
/** ⑤ 卷宗里 Room 摘要截断（控制 prompt 体积）。 */
const ROOM_SUMMARY_CHARS = 200;

export interface RouterThresholds {
  auto: number;
  review: number;
  autoCreateRoomEnabled: boolean;
}

export interface RouterDeps {
  db: GatewayDatabase;
  wikiIndex: WikiPageIndex;
  llm: KnowledgeLlm | null;
  embedding: { client: EmbeddingClient; model: string } | null;
  thresholds: RouterThresholds;
  logger: { warn(bindings: Record<string, unknown>, message: string): void };
}

/** create_new 的 Room 提案（review 时是"按建议新建"卡片的素材）。 */
export interface NewRoomProposal {
  name: string;
  summary: string;
  kind?: string;
}

export interface RouteOutcome {
  /** execute = 已有主 Room 可直接 ingest；review = 待归类（人工或低置信）。 */
  disposition: "execute" | "review";
  roomId: string | null;
  linkedRoomIds: string[];
  decidedBy: "entry" | "link" | "rule" | "llm" | null;
  confidence: number;
  reason: string;
  evidence: Record<string, unknown> | null;
  newRoom?: NewRoomProposal;
}

export interface RouteResult extends RouteOutcome {
  decisionId: string;
}

interface RuleMatcher {
  sourceTag?: string;
  filenamePrefix?: string;
  threadId?: string;
  titleKeyword?: string;
  creatorId?: string;
}

/** ②b 规则具体度：线程/文件前缀 > 来源标签/创建者 > 标题关键词（plan §3.1）。 */
function matcherSpecificity(matcher: RuleMatcher): number {
  if (matcher.threadId || matcher.filenamePrefix) return 2;
  if (matcher.sourceTag || matcher.creatorId) return 1;
  return 0;
}

function matchesRule(matcher: RuleMatcher, envelope: DocEnvelope): boolean {
  if (matcher.sourceTag !== undefined && envelope.entrySignals?.sourceTag !== matcher.sourceTag) return false;
  if (matcher.threadId !== undefined && envelope.entrySignals?.threadId !== matcher.threadId) return false;
  if (matcher.filenamePrefix !== undefined) {
    const prefix = envelope.entrySignals?.filenamePrefix ?? "";
    if (!prefix.startsWith(matcher.filenamePrefix)) return false;
  }
  if (matcher.creatorId !== undefined && envelope.entrySignals?.creatorId !== matcher.creatorId) return false;
  if (matcher.titleKeyword !== undefined && !envelope.title.includes(matcher.titleKeyword)) return false;
  return true;
}

/** 摘要兜底：LLM 不可用时取 markdown 头部（剥 frontmatter 与标记符号）。 */
export function fallbackSummary(markdown: string, chars = 300): string {
  let text = markdown;
  if (text.startsWith("---")) {
    const end = text.indexOf("\n---", 3);
    if (end >= 0) text = text.slice(end + 4);
  }
  return text.replace(/[#>*`|\[\]()]/g, " ").replace(/\s+/g, " ").trim().slice(0, chars);
}

export class KnowledgeRouter {
  constructor(private readonly deps: RouterDeps) {}

  /**
   * 跑完整瀑布并落 decision 行。
   * skipEntry：revert 后重路由时跳过 ①（否则同 Room 直连死循环，plan §5.5）。
   */
  async route(envelope: DocEnvelope, options: { skipEntry?: boolean } = {}): Promise<RouteResult> {
    // ── ① 入口确定性：EverRoom 内文档天然带 Room（room_doc_links 首链即源 Room）
    if (!options.skipEntry && envelope.ref.kind === "everroom-doc") {
      const entry = this.resolveEntryRooms(envelope.ref.id);
      if (entry) {
        const [primaryRoomId, ...linkedRoomIds] = entry;
        return this.persist(envelope, {
          disposition: "execute",
          roomId: primaryRoomId ?? null,
          linkedRoomIds,
          decidedBy: "entry",
          confidence: 1,
          reason: "文档创建于该 Room（入口确定性）",
          evidence: null,
        });
      }
    }

    // ── ②a 链接：同源最近的已确认/自动决策（版本更新回原 Room，"更新不漂移"）
    const linked = this.resolveLinkedRoom(envelope.ref.kind, envelope.ref.id);
    if (linked) {
      return this.persist(envelope, {
        disposition: "execute",
        roomId: linked,
        linkedRoomIds: [],
        decidedBy: "link",
        confidence: 1,
        reason: "该资料此前已确认归属此 Room（版本更新回原 Room）",
        evidence: null,
      });
    }

    // ── ②b 规则：用户显式配置的逃生舱（默认空表，纯可选）
    const ruleHit = this.matchRule(envelope);
    if (ruleHit) {
      return this.persist(envelope, {
        disposition: "execute",
        roomId: ruleHit.roomId,
        linkedRoomIds: [],
        decidedBy: "rule",
        confidence: 1,
        reason: `命中路由规则 ${ruleHit.ruleId}（${ruleHit.describe}）`,
        evidence: { ruleId: ruleHit.ruleId },
      });
    }

    // ── ③④ 候选层：只产证据，不判决
    const { entityScores, vectorScores, candidateIds } = await this.collectCandidates(envelope);

    // ── ⑤ LLM 终审（未配置 → M1 形态：人工即仲裁者）
    if (this.deps.llm) {
      return this.persist(envelope, await this.arbitrate(envelope, candidateIds, entityScores, vectorScores));
    }

    return this.persist(envelope, {
      disposition: "review",
      roomId: null,
      linkedRoomIds: [],
      decidedBy: null,
      confidence: 0,
      reason: "路由候选已生成，等待人工确认（LLM 仲裁未配置）",
      evidence: this.evidenceOf(entityScores, vectorScores),
    });
  }

  // ───────────────────────── ①② 决策层 ─────────────────────────

  /**
   * everroom-doc 的源 Room：room_doc_links 按链接时间升序，首链为主，其余为附带。
   * 对 rooms 注册表松引用（plan §3.1：存量 roomId 无注册行不阻塞）——
   * leftJoin + deletedAt IS NULL 同时覆盖"无注册行"与"未删除"两种存活态。
   */
  private resolveEntryRooms(documentId: string): string[] | null {
    const rows = this.deps.db.select({ roomId: roomDocumentLinks.roomId })
      .from(roomDocumentLinks)
      .leftJoin(rooms, eq(rooms.id, roomDocumentLinks.roomId))
      .where(and(eq(roomDocumentLinks.documentId, documentId), isNull(rooms.deletedAt)))
      .orderBy(asc(roomDocumentLinks.linkedAt))
      .all();
    if (rows.length === 0) return null;
    return [...new Set(rows.map((row) => row.roomId))];
  }

  /** 同源最近的 confirmed/auto 决策（reverted 不算——撤销就是为了离开那个 Room）。 */
  private resolveLinkedRoom(sourceKind: DocEnvelope["ref"]["kind"], sourceId: string): string | null {
    const row = this.deps.db.select({ primaryRoomId: routeDecisions.primaryRoomId })
      .from(routeDecisions)
      .where(and(
        eq(routeDecisions.sourceKind, sourceKind),
        eq(routeDecisions.sourceId, sourceId),
        inArray(routeDecisions.status, ["confirmed", "auto"]),
      ))
      .orderBy(desc(routeDecisions.createdAt))
      .get();
    if (!row?.primaryRoomId) return null;
    // 松引用：注册表无行 = 存活；只有显式 deletedAt 才剔除
    const registry = this.deps.db.select({ deletedAt: rooms.deletedAt })
      .from(rooms).where(eq(rooms.id, row.primaryRoomId)).get();
    if (registry?.deletedAt) return null;
    return row.primaryRoomId;
  }

  private matchRule(envelope: DocEnvelope): { roomId: string; ruleId: string; describe: string } | null {
    const rules = this.deps.db.select().from(routingRules)
      .where(eq(routingRules.enabled, true))
      .all()
      .map((rule) => ({ rule, matcher: (rule.matcher ?? {}) as RuleMatcher }))
      .sort((a, b) =>
        matcherSpecificity(b.matcher) - matcherSpecificity(a.matcher)
        || a.rule.createdAt.getTime() - b.rule.createdAt.getTime());

    for (const { rule, matcher } of rules) {
      const alive = this.deps.db.select({ id: rooms.id })
        .from(rooms).where(and(eq(rooms.id, rule.targetRoomId), isNull(rooms.deletedAt))).get();
      if (!alive) continue; // 目标 Room 已删：规则本轮跳过（不自动禁用，用户可改指向）
      if (!matchesRule(matcher, envelope)) continue;
      this.deps.db.update(routingRules).set({
        hitCount: rule.hitCount + 1,
        lastHitAt: new Date(),
      }).where(eq(routingRules.id, rule.id)).run();
      const entries = Object.entries(matcher).filter(([, value]) => value !== undefined);
      return {
        roomId: rule.targetRoomId,
        ruleId: rule.id,
        describe: entries.map(([key, value]) => `${key}=${String(value)}`).join(" 且 "),
      };
    }
    return null;
  }

  // ───────────────────────── ③④ 候选层 ─────────────────────────

  private async collectCandidates(envelope: DocEnvelope): Promise<{
    entityScores: EntityScore[];
    vectorScores: VectorScore[];
    candidateIds: string[];
  }> {
    const aliveRooms = this.deps.db.select().from(rooms).where(isNull(rooms.deletedAt)).all();

    // ③ Room 侧术语表 = wiki 页面标题 ∪ Room 标题/别名（无 wiki 的 Room 也能被标题命中）
    let entityScores: EntityScore[] = [];
    try {
      const snapshot = await this.deps.wikiIndex.snapshot();
      const roomTokenSets = new Map<string, Set<string>>();
      for (const room of aliveRooms) {
        const snapshotEntry = snapshot.get(room.id);
        const terms = roomTerms([
          ...(snapshotEntry?.pageTitles ?? []),
          room.title,
          ...(room.aliases ?? []),
        ]);
        if (terms.size > 0) roomTokenSets.set(room.id, terms);
      }
      const terms = documentTerms(envelope.title, fallbackSummary(envelope.markdown, 2_000));
      entityScores = scoreEntityMatches(terms, roomTokenSets, CANDIDATE_TOP_N);
    } catch (error) {
      this.deps.logger.warn(
        { event: "knowledge.router.entity.failed", error: error instanceof Error ? error.message : String(error) },
        "entity candidate layer failed, continuing without it",
      );
    }

    // ④ 向量层：冷启动/换模型的 Room 在 rankByCentroids 内部被过滤
    let vectorScores: VectorScore[] = [];
    if (this.deps.embedding) {
      try {
        const centroids = this.deps.db.select().from(roomWikis).all();
        const documentVector = await this.deps.embedding.client.embed(
          embeddingInputText(envelope.title, envelope.markdown),
        );
        vectorScores = rankByCentroids(documentVector, centroids, this.deps.embedding.model, CANDIDATE_TOP_N);
      } catch (error) {
        this.deps.logger.warn(
          { event: "knowledge.router.vector.failed", error: error instanceof Error ? error.message : String(error) },
          "vector candidate layer failed, continuing without it",
        );
      }
    }

    const candidateIds = [...new Set([
      ...entityScores.map((score) => score.roomId),
      ...vectorScores.map((score) => score.roomId),
    ])].slice(0, DOSSIER_CANDIDATE_LIMIT);
    return { entityScores, vectorScores, candidateIds };
  }

  private evidenceOf(entityScores: EntityScore[], vectorScores: VectorScore[]): Record<string, unknown> {
    const evidence: Record<string, unknown> = {};
    if (entityScores.length > 0) {
      evidence.entity = entityScores.map((score) => ({
        roomId: score.roomId,
        score: score.score,
        tokens: score.matched.slice(0, 8).map((match) => match.token),
      }));
    }
    if (vectorScores.length > 0) {
      evidence.vector = vectorScores.map((score) => ({ roomId: score.roomId, similarity: score.similarity }));
    }
    return evidence;
  }

  // ───────────────────────── ⑤ LLM 终审 ─────────────────────────

  private async arbitrate(
    envelope: DocEnvelope,
    candidateIds: string[],
    entityScores: EntityScore[],
    vectorScores: VectorScore[],
  ): Promise<RouteOutcome> {
    const evidence = this.evidenceOf(entityScores, vectorScores);
    const cards = await this.buildCandidateCards(candidateIds, entityScores, vectorScores);

    let summary: string;
    try {
      summary = await this.deps.llm!.summarize(envelope.title, envelope.markdown);
    } catch {
      summary = fallbackSummary(envelope.markdown);
    }

    let verdict;
    try {
      verdict = await this.deps.llm!.arbitrate({
        documentTitle: envelope.title,
        documentSummary: summary,
        ...(envelope.occurredAt ? { occurredAt: envelope.occurredAt } : {}),
        candidates: cards,
      });
    } catch (error) {
      // ⑤ 失败不阻塞（D5 保守取向）：降级待归类，人工兜底
      this.deps.logger.warn(
        { event: "knowledge.router.arbitration.failed", error: error instanceof Error ? error.message : String(error) },
        "LLM arbitration failed, falling back to human review",
      );
      return {
        disposition: "review",
        roomId: null,
        linkedRoomIds: [],
        decidedBy: null,
        confidence: 0,
        reason: `LLM 仲裁失败：${error instanceof Error ? error.message : String(error)}（候选见证据）`,
        evidence: { ...evidence, summary },
      };
    }

    const { auto, review, autoCreateRoomEnabled } = this.deps.thresholds;

    // create_new + 高置信 + 开关开 → 重名去重后自动建 Room（plan §4.2）
    if (verdict.action === "create_new" && verdict.confidence >= auto && autoCreateRoomEnabled) {
      const duplicate = this.findDuplicateRoom(verdict.newRoom.name);
      if (duplicate) {
        return {
          disposition: "execute",
          roomId: duplicate.id,
          linkedRoomIds: [],
          decidedBy: "llm",
          confidence: verdict.confidence,
          reason: `${verdict.reason}（提议新 Room「${verdict.newRoom.name}」与现有「${duplicate.title}」重名，已归并）`,
          evidence: { ...evidence, summary, verdict },
        };
      }
      const newRoomId = `auto-${randomUUID().slice(0, 8)}`;
      this.deps.db.insert(rooms).values({
        id: newRoomId,
        title: verdict.newRoom.name,
        kind: verdict.newRoom.kind ?? "主题",
        origin: "auto",
        summary: verdict.newRoom.summary || null,
        createdAt: new Date(),
        updatedAt: new Date(),
      }).onConflictDoNothing().run();
      return {
        disposition: "execute",
        roomId: newRoomId,
        linkedRoomIds: [],
        decidedBy: "llm",
        confidence: verdict.confidence,
        reason: verdict.reason,
        evidence: { ...evidence, summary, verdict, createdRoom: newRoomId },
        newRoom: {
          name: verdict.newRoom.name,
          summary: verdict.newRoom.summary,
          ...(verdict.newRoom.kind ? { kind: verdict.newRoom.kind } : {}),
        },
      };
    }

    // create_new 降级（开关关 / 置信不足）：待归类卡片提供"按建议新建 Room"按钮
    if (verdict.action === "create_new") {
      return {
        disposition: "review",
        roomId: null,
        linkedRoomIds: [],
        decidedBy: null,
        confidence: verdict.confidence,
        reason: verdict.reason,
        evidence: { ...evidence, summary, verdict },
        newRoom: {
          name: verdict.newRoom.name,
          summary: verdict.newRoom.summary,
          ...(verdict.newRoom.kind ? { kind: verdict.newRoom.kind } : {}),
        },
      };
    }

    if (verdict.roomIds.length === 0 || verdict.confidence < review) {
      return {
        disposition: "review",
        roomId: null,
        linkedRoomIds: [],
        decidedBy: null,
        confidence: verdict.confidence,
        reason: verdict.reason,
        evidence: { ...evidence, summary, verdict },
      };
    }

    // existing + 置信达标：[review, auto) 区间限 existing，此处天然满足
    const [primaryRoomId, ...linkedRoomIds] = verdict.roomIds;
    return {
      disposition: "execute",
      roomId: primaryRoomId ?? null,
      linkedRoomIds,
      decidedBy: "llm",
      confidence: verdict.confidence,
      reason: verdict.reason,
      evidence: { ...evidence, summary, verdict },
    };
  }

  private async buildCandidateCards(
    candidateIds: string[],
    entityScores: EntityScore[],
    vectorScores: VectorScore[],
  ): Promise<CandidateCard[]> {
    if (candidateIds.length === 0) return [];
    const rows = this.deps.db.select().from(rooms)
      .where(and(inArray(rooms.id, candidateIds), isNull(rooms.deletedAt)))
      .all();
    const entityByRoom = new Map(entityScores.map((score) => [score.roomId, score]));
    const vectorByRoom = new Map(vectorScores.map((score) => [score.roomId, score]));

    const cards: CandidateCard[] = [];
    for (const row of rows) {
      let pageTitles: string[] = [];
      try {
        const wiki = this.deps.db.select().from(roomWikis).where(eq(roomWikis.roomId, row.id)).get();
        if (wiki) pageTitles = await this.deps.wikiIndex.representativeTitles(wiki.knowledgeId);
      } catch {
        pageTitles = [];
      }
      const entity = entityByRoom.get(row.id);
      const vector = vectorByRoom.get(row.id);
      const entityTokens = entity?.matched.map((match) => match.token);
      cards.push({
        roomId: row.id,
        title: row.title,
        summary: row.summary?.slice(0, ROOM_SUMMARY_CHARS) ?? null,
        pageTitles,
        ...(entity ? { entityScore: entity.score } : {}),
        ...(entityTokens && entityTokens.length > 0 ? { entityTokens } : {}),
        ...(vector ? { vectorSimilarity: vector.similarity } : {}),
      });
    }
    return cards;
  }

  /** create_new 重名去重：bigram Dice ≥ 阈值命中现有 Room（含曾用名）即归并。 */
  findDuplicateRoom(name: string): { id: string; title: string } | null {
    const rows = this.deps.db.select().from(rooms).where(isNull(rooms.deletedAt)).all();
    let best: { id: string; title: string; similarity: number } | null = null;
    for (const row of rows) {
      for (const candidate of [row.title, ...(row.aliases ?? [])]) {
        const similarity = bigramDiceSimilarity(name, candidate);
        if (similarity >= ROOM_NAME_DEDUP_THRESHOLD && (!best || similarity > best.similarity)) {
          best = { id: row.id, title: row.title, similarity };
        }
      }
    }
    return best ? { id: best.id, title: best.title } : null;
  }

  // ───────────────────────── 决策落库 ─────────────────────────

  private persist(envelope: DocEnvelope, outcome: RouteOutcome): RouteResult {
    const decisionId = randomUUID();
    this.deps.db.insert(routeDecisions).values({
      id: decisionId,
      sourceKind: envelope.ref.kind,
      sourceId: envelope.ref.id,
      sourceVersion: envelope.ref.version,
      // 外部信封没有 documents 行可回查，快照进决策（everroom-doc 可随时重建，不存省库）
      ...(envelope.ref.kind !== "everroom-doc" ? {
        sourceTitle: envelope.title,
        sourceMarkdown: envelope.markdown,
      } : {}),
      primaryRoomId: outcome.roomId,
      linkedRoomIds: outcome.linkedRoomIds.length > 0 ? outcome.linkedRoomIds : null,
      newRoomName: outcome.newRoom?.name ?? null,
      newRoomSummary: outcome.newRoom?.summary ?? null,
      newRoomKind: outcome.newRoom?.kind ?? null,
      confidence: outcome.confidence,
      decidedBy: outcome.decidedBy,
      evidence: outcome.evidence,
      reason: outcome.reason,
      status: outcome.disposition === "execute" ? "auto" : "awaiting_review",
      createdAt: new Date(),
      updatedAt: new Date(),
    }).run();
    return { ...outcome, decisionId };
  }
}
