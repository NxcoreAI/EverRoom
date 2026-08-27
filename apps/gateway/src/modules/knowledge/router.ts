/**
 * 自动归类路由瀑布（entity-room-plan §2.1）：
 * ① 入口确定性 → ② 规则 → ③′ LLM 实体抽取 → ③″ 实体解析（含 LLM
 * 同一性判定）→ ④ 链接落库 + 推荐检查（达阈值 → ready 推荐池）。
 *
 * ①② 是决策层（decidedBy=entry/rule，confidence=1，零 LLM 成本）；
 * ③′ 是唯一非确定性抽取环节（开集，无候选菜单——菜单偏差的根源被拆除）；
 * ③″④ 确定性累积证据；达阈值只进推荐池（ready），建 Room 由用户确认。
 * 出口三种：
 * - execute：链接实体中有已晋升者 → 正文 ingest 进其全部 Room wiki（多对多沉淀）
 * - linked：实体已挂链但都未晋升（弱实体孵化中）
 * - awaiting_review：抽取空/失败 → 「未识别实体」栏人工挂载
 *
 * 单份资料永远无法直接造出 Room（晋升只能靠证据累积或手动转正）。
 */

import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull } from "drizzle-orm";
import type { GatewayDatabase } from "../../infrastructure/database/client.js";
import { roomDocumentLinks, routeDecisions, routingRules, rooms } from "../../infrastructure/database/schema.js";
import {
  bestMatch,
  bigramDiceSimilarity,
  normalizeEntityName,
} from "./entity-index.js";
import {
  derivePrimaryRoles,
  EntityRegistry,
  type EntityRow,
  type LinkRole,
  type SourceKind,
} from "./entity-registry.js";
import { embeddingInputText, nearestByCentroid, type EmbeddingClient } from "./embedding.js";
import type { DocEnvelope } from "./envelope.js";
import { KnowledgeLlm } from "./llm.js";
import type { ExtractedEntity } from "./llm.js";

export interface RouterThresholds {
  promoteScore: number;
  promoteSources: number;
  /** 弱-弱确定性自动合并线（免 LLM）。 */
  mergeAutoDice: number;
  /** LLM 同一性判定带下限（[judge, auto) 走判定）。 */
  mergeJudgeDice: number;
}

export interface RouterDeps {
  db: GatewayDatabase;
  registry: EntityRegistry;
  llm: KnowledgeLlm | null;
  embedding: { client: EmbeddingClient; model: string } | null;
  thresholds: RouterThresholds;
  logger: {
    info(bindings: Record<string, unknown>, message: string): void;
    warn(bindings: Record<string, unknown>, message: string): void;
  };
}

export interface RouteResult {
  /** execute=已晋升链接实体可直接 ingest；linked=挂链未晋升；awaiting_review=未识别。 */
  disposition: "execute" | "linked" | "awaiting_review";
  roomId: string | null;
  /** execute 的全部目标房（多对多沉淀，roomId 为其之首）；linked/awaiting_review 为空。 */
  roomIds: string[];
  decidedBy: "entry" | "rule" | "resolution" | null;
  confidence: number;
  reason: string;
  evidence: Record<string, unknown> | null;
  decisionId: string;
}

interface RuleMatcher {
  sourceTag?: string;
  filenamePrefix?: string;
  threadId?: string;
  titleKeyword?: string;
  creatorId?: string;
}

/** ②b 规则具体度：线程/文件前缀 > 来源标签/创建者 > 标题关键词。 */
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

/**
 * 批内去重（plan §4.2）：同 kind + Dice ≥0.75 视为同一实体——
 * 保留先出现（通常是更规范的叫法）的名字，salience 取 max，依据句拼接。
 */
export function dedupeExtraction(extracted: ExtractedEntity[]): ExtractedEntity[] {
  const kept: ExtractedEntity[] = [];
  for (const item of extracted) {
    const duplicate = kept.find((candidate) =>
      candidate.kind === item.kind && bigramDiceSimilarity(candidate.name, item.name) >= 0.75);
    if (!duplicate) {
      kept.push(item);
      continue;
    }
    duplicate.salience = Math.max(duplicate.salience, item.salience);
    if (item.evidence && !duplicate.evidence.includes(item.evidence)) {
      duplicate.evidence = [duplicate.evidence, item.evidence].filter(Boolean).join("；").slice(0, 300);
    }
  }
  return kept;
}

/**
 * execute 目标挑选（多对多沉淀）：全部已晋升链接实体——不分角色，
 * mention 链接的实体晋升后同样收正文；salience 高者领房（roomId），
 * 并列看证据分。角色只用于计分，不再决定沉淀归属。
 */
export function pickPromotedTargets(
  linked: Array<{ entity: EntityRow; role: LinkRole; salience: number }>,
): Array<{ entity: EntityRow; role: LinkRole; salience: number }> {
  return linked
    .filter((item) => item.entity.status === "room" && item.entity.roomId)
    .sort((a, b) =>
      b.salience - a.salience
      || b.entity.evidenceScore - a.entity.evidenceScore);
}

export class KnowledgeRouter {
  constructor(private readonly deps: RouterDeps) {}

  /** runtime config 变更后替换消歧 tie-break 的 embedding 端点（null = 关闭）。 */
  replaceEmbedding(embedding: RouterDeps["embedding"]): void {
    this.deps.embedding = embedding;
  }

  /** runtime config 变更后替换抽取/判定 LLM（null = 关闭：抽取落未识别栏）。 */
  replaceLlm(llm: RouterDeps["llm"]): void {
    this.deps.llm = llm;
  }

  /**
   * 跑完整瀑布并落 decision 行。
   * skipEntry：revert 后重路由时跳过 ①（否则同 Room 直连死循环）。
   */
  async route(envelope: DocEnvelope, options: { skipEntry?: boolean; entryRoomId?: string } = {}): Promise<RouteResult> {
    // ── ① 入口确定性：EverRoom 内文档天然带 Room（ED5：不跑抽取，零 LLM 成本）
    if (!options.skipEntry && options.entryRoomId) {
      const entry = this.deps.db.select({ id: rooms.id }).from(rooms)
        .where(and(eq(rooms.id, options.entryRoomId), isNull(rooms.deletedAt))).get();
      if (entry) {
        return this.persist(envelope, {
          disposition: "execute",
          roomId: entry.id,
          decidedBy: "entry",
          confidence: 1,
          reason: "文档创建于该 Room（入口确定性）",
          evidence: null,
        });
      }
    }
    if (!options.skipEntry && envelope.ref.kind === "everroom-doc") {
      const entry = this.resolveEntryRooms(envelope.ref.id);
      if (entry) {
        const [primaryRoomId] = entry;
        return this.persist(envelope, {
          disposition: "execute",
          roomId: primaryRoomId ?? null,
          decidedBy: "entry",
          confidence: 1,
          reason: "文档创建于该 Room（入口确定性）",
          evidence: null,
        });
      }
    }

    // ── ②b 规则：用户显式配置的逃生舱（默认空表，纯可选）
    const ruleHit = this.matchRule(envelope);
    if (ruleHit) {
      return this.persist(envelope, {
        disposition: "execute",
        roomId: ruleHit.roomId,
        decidedBy: "rule",
        confidence: 1,
        reason: `命中路由规则 ${ruleHit.ruleId}（${ruleHit.describe}）`,
        evidence: { ruleId: ruleHit.ruleId },
      });
    }

    // ── ③′ 实体抽取：未配置 LLM / 抽取失败 → 未识别栏（不硬塞、不自动建实体）
    if (!this.deps.llm) {
      return this.persist(envelope, {
        disposition: "awaiting_review",
        roomId: null,
        decidedBy: null,
        confidence: 0,
        reason: "抽取 LLM 未配置，资料进入未识别栏等待人工挂载",
        evidence: { summary: fallbackSummary(envelope.markdown) },
      });
    }
    let extraction;
    try {
      extraction = await this.deps.llm.extract(envelope.title, envelope.markdown);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 速率限制是瞬时态：抛错交 worker 退避重试，不落 awaiting_review——
      // 否则该资料被永久定罪为"抽取失败"，限速过后也不会重新抽取。
      if (KnowledgeLlm.isRateLimited(error)) {
        this.deps.logger.warn(
          { event: "knowledge.router.extract.rate_limited", sourceId: envelope.ref.id },
          "entity extraction rate-limited, job will retry",
        );
        throw error;
      }
      this.deps.logger.warn(
        { event: "knowledge.router.extract.failed", sourceId: envelope.ref.id, error: message },
        "entity extraction failed, falling back to unmatched",
      );
      return this.persist(envelope, {
        disposition: "awaiting_review",
        roomId: null,
        decidedBy: null,
        confidence: 0,
        reason: `实体抽取失败：${message}`,
        evidence: { summary: fallbackSummary(envelope.markdown) },
      });
    }

    const entities = dedupeExtraction(extraction.entities);
    // 抽取结果可视化：批内去重后的实体清单（name/kind/salience/依据句）
    this.deps.logger.info(
      {
        event: "knowledge.router.extracted",
        sourceId: envelope.ref.id,
        title: envelope.title,
        summary: extraction.summary,
        entities: entities.map((item) => ({
          name: item.name,
          kind: item.kind,
          salience: Number(item.salience.toFixed(2)),
          evidence: item.evidence,
        })),
      },
      entities.length > 0
        ? `抽取实体 ${entities.length} 个：${entities.map((item) => item.name).join("、")}`
        : "抽取未发现实体",
    );
    if (entities.length === 0) {
      // 空数组是合法的新版本结果：移除旧 resolution 链接并回扣分数；
      // user 手动链接由 replaceResolutionLinks 保留。
      this.deps.registry.replaceResolutionLinks(envelope.ref.kind, envelope.ref.id, []);
      return this.persist(envelope, {
        disposition: "awaiting_review",
        roomId: null,
        decidedBy: null,
        confidence: 0,
        reason: extraction.summary ? `抽取未发现实体：${extraction.summary.slice(0, 120)}` : "抽取未发现实体",
        evidence: { summary: extraction.summary || fallbackSummary(envelope.markdown) },
      });
    }

    // ── ③″ 解析 + ④ 链接落库（含晋升检查）
    const roles = derivePrimaryRoles(entities);
    const userPinned = new Set(
      this.deps.registry.linksOfSource(envelope.ref.kind, envelope.ref.id)
        .filter((link) => link.decidedBy === "user")
        .map((link) => link.entityId),
    );
    const documentVector = await this.embedDocument(envelope);

    const pool = this.deps.registry.loadResolutionPool();
    const resolvedLinks: Array<{ entity: EntityRow; role: LinkRole; salience: number; evidence: string }> = [];
    const linked: Array<{ entity: EntityRow; role: LinkRole; salience: number; evidence: string }> = [];

    for (const item of entities) {
      const role = roles.get(item.name) ?? "mention";
      const resolved = await this.resolveEntity(item, pool, documentVector);
      if (resolved) pool.push(resolved);
      const entity = resolved ?? this.deps.registry.createEntity({ name: item.name, kind: item.kind });
      if (userPinned.has(entity.id)) continue; // 用户手动挂载优先，不被重抽取覆盖
      resolvedLinks.push({ entity, role, salience: item.salience, evidence: item.evidence });
    }

    const updatedEntities = new Map(this.deps.registry.replaceResolutionLinks(
      envelope.ref.kind,
      envelope.ref.id,
      resolvedLinks.map(({ entity, role, salience, evidence }) => ({
        entityId: entity.id,
        sourceVersion: envelope.ref.version,
        role,
        salience,
        evidence: evidence || null,
      })),
    ).map((entity) => [entity.id, entity]));

    for (const item of resolvedLinks) {
      const updated = updatedEntities.get(item.entity.id) ?? item.entity;
      linked.push({ ...item, entity: updated });
      if (documentVector) {
        try {
          this.deps.registry.advanceEntityCentroid(item.entity.id, documentVector, this.deps.embedding!.model);
        } catch { /* best-effort */ }
      }
    }

    if (linked.length === 0) {
      return this.persist(envelope, {
        disposition: "awaiting_review",
        roomId: null,
        decidedBy: null,
        confidence: 0,
        reason: "全部实体链接为用户手动挂载，无自动动作",
        evidence: { summary: extraction.summary, entities: [] },
      });
    }

    // ── 出口判定：已晋升链接实体 → execute（解析命中即归属，多对多沉淀）
    const targets = pickPromotedTargets(linked);
    if (targets.length > 0) {
      const lead = targets[0]!.entity;
      return this.persist(envelope, {
        disposition: "execute",
        roomId: lead.roomId,
        roomIds: targets.map((item) => item.entity.roomId!),
        decidedBy: "resolution",
        confidence: 1,
        reason: targets.length === 1
          ? `解析命中已晋升实体「${lead.name}」（证据分 ${lead.evidenceScore.toFixed(1)}）`
          : `解析命中 ${targets.length} 个已晋升实体（主「${lead.name}」），正文多房沉淀`,
        evidence: this.evidenceOf(extraction.summary, linked),
      });
    }
    return this.persist(envelope, {
      disposition: "linked",
      roomId: null,
      decidedBy: "resolution",
      confidence: 1,
      reason: `挂链 ${linked.length} 个实体（均未晋升，孵化中）`,
      evidence: this.evidenceOf(extraction.summary, linked),
    });
  }

  // ───────────────────────── ①② 决策层 ─────────────────────────

  /**
   * everroom-doc 的源 Room：room_doc_links 按链接时间升序，首链为主。
   * 对 rooms 注册表松引用——leftJoin + deletedAt IS NULL 同时覆盖
   * "无注册行"与"未删除"两种存活态。
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

  // ───────────────────────── ③″ 实体解析（plan §4.2） ─────────────────────────

  /**
   * 解析单个抽取实体：精确（归一化 name/alias）→ 多命中消歧（质心/证据分）
   * → 模糊（Dice 带 + 必要时 LLM 同一性判定）。返回命中的注册表实体；
   * null = 未命中（调用方新建 weak）。
   * 命中后按需累积 alias（fuzzy 命中的叫法进曾用名）。
   */
  private async resolveEntity(
    item: ExtractedEntity,
    pool: EntityRow[],
    documentVector: number[] | null,
  ): Promise<EntityRow | null> {
    const query = normalizeEntityName(item.name);

    // 1. 精确：name/alias 归一化比对
    const exact = pool.filter((entity) =>
      [entity.name, ...entity.aliases].some((candidate) => normalizeEntityName(candidate) === query));
    if (exact.length === 1) return exact[0]!;
    if (exact.length > 1) {
      // 同名异实体（两个"张三"）：质心最近者；未配置 embedding → 证据分高者
      if (documentVector && this.deps.embedding) {
        const nearest = nearestByCentroid(documentVector, exact, this.deps.embedding.model);
        if (nearest) return exact.find((entity) => entity.id === nearest.id)!;
      }
      return [...exact].sort((a, b) => b.evidenceScore - a.evidenceScore)[0]!;
    }

    // 2. 模糊：逐实体取 name+aliases 全量最优 Dice（避免跨实体同名 alias 串分）
    let target: EntityRow | null = null;
    let bestScore = 0;
    for (const entity of pool) {
      const match = bestMatch(item.name, [entity.name, ...entity.aliases]);
      if (match && match.score > bestScore) {
        target = entity;
        bestScore = match.score;
      }
    }
    if (!target || bestScore < this.deps.thresholds.mergeJudgeDice) return null;
    const autoMerge = bestScore >= this.deps.thresholds.mergeAutoDice
      && target.kind === item.kind
      // 双方皆无 wiki（weak/ready 推荐池）才免判定（低风险）
      && (target.status === "weak" || target.status === "ready");

    if (autoMerge) {
      this.deps.registry.updateEntityIdentity(target.id, { addAliases: [item.name] });
      return this.deps.registry.getEntity(target.id) ?? target;
    }

    // 模糊带：LLM 同一性判定（ED8：系统自主收敛）；失败/判不同 → 分立累积
    if (this.deps.llm) {
      try {
        const judge = await this.deps.llm.judgeEntityIdentity(
          {
            name: item.name,
            aliases: [],
            kind: item.kind,
            evidenceSamples: item.evidence ? [item.evidence] : [],
          },
          {
            name: target.name,
            aliases: target.aliases,
            kind: target.kind,
            evidenceSamples: this.deps.registry.linksOfEntity(target.id)
              .map((link) => link.evidence)
              .filter((evidence): evidence is string => Boolean(evidence))
              .slice(0, 5),
          },
        );
        if (judge.same) {
          this.deps.registry.updateEntityIdentity(target.id, { addAliases: [item.name] });
          return this.deps.registry.getEntity(target.id) ?? target;
        }
      } catch (error) {
        this.deps.logger.warn(
          {
            event: "knowledge.router.judge.failed",
            entityId: target.id,
            name: item.name,
            error: error instanceof Error ? error.message : String(error),
          },
          "identity judge failed, keeping entities separate",
        );
      }
    }
    return null;
  }

  /** 文档向量（消歧 tie-break + 实体质心推进共用）；未配置/失败返回 null。 */
  private async embedDocument(envelope: DocEnvelope): Promise<number[] | null> {
    if (!this.deps.embedding) return null;
    try {
      return await this.deps.embedding.client.embed(
        embeddingInputText(envelope.title, envelope.markdown),
      );
    } catch (error) {
      this.deps.logger.warn(
        { event: "knowledge.router.embed.failed", error: error instanceof Error ? error.message : String(error) },
        "document embedding failed, continuing without tie-break",
      );
      return null;
    }
  }

  private evidenceOf(
    summary: string,
    linked: Array<{ entity: EntityRow; role: LinkRole; salience: number; evidence: string }>,
  ): Record<string, unknown> {
    return {
      summary: summary || null,
      entities: linked.map(({ entity, role, salience, evidence }) => ({
        entityId: entity.id,
        name: entity.name,
        kind: entity.kind,
        status: entity.status,
        role,
        salience,
        evidence: evidence || null,
        evidenceScore: entity.evidenceScore,
        sourceCount: entity.sourceCount,
      })),
    };
  }

  // ───────────────────────── 决策落库 ─────────────────────────

  private persist(
    envelope: DocEnvelope,
    // roomIds 可省略：单房出口（entry/rule）由 roomId 派生，非 execute 恒空
    outcome: Omit<RouteResult, "decisionId" | "roomIds"> & { roomIds?: string[] },
  ): RouteResult {
    const decisionId = randomUUID();
    const roomIds = outcome.roomIds ?? (outcome.roomId ? [outcome.roomId] : []);
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
      decidedBy: outcome.decidedBy,
      confidence: outcome.confidence,
      evidence: outcome.evidence,
      reason: outcome.reason,
      status: outcome.disposition === "execute"
        ? "auto"
        : outcome.disposition === "linked"
          ? "linked"
          : "awaiting_review",
      createdAt: new Date(),
      updatedAt: new Date(),
    }).run();
    return { ...outcome, roomIds, decisionId };
  }
}

/** SourceKind 复导出（service/routes 的 payload 类型引用）。 */
export type { SourceKind };
