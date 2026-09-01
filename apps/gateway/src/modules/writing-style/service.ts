import { createHash } from "node:crypto";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { GatewayDatabase } from "../../infrastructure/database/client.js";
import {
  agentRuns,
  documentOperations,
  documentVersions,
  documents,
  jobs,
  roomDocumentLinks,
  writingStyleDocumentSketches,
  writingStyleProfiles,
  writingStyleSettings,
  writingStyleSignals,
  writingStyleUserContent,
} from "../../infrastructure/database/schema.js";
import {
  analyzeWritingStyle,
  deriveWritingStyleProfile,
  EMPTY_AGGREGATE,
  freshAggregate,
  mergeSketchStats,
  type WritingStyleAggregate,
  type WritingStyleSketchStats,
} from "./analyzer.js";
import { type WritingStyleLlm, type WritingStyleQualitative } from "./llm.js";
import { enqueueWritingStyleExtract, enqueueWritingStyleRefresh, WRITING_STYLE_EXTRACT_JOB_TYPE, WRITING_STYLE_REFRESH_JOB_TYPE } from "./jobs.js";
import { composeWritingStyleBlock } from "./compose.js";
import {
  classifyInstruction,
  clipSignal,
  computeRevisionDelta,
  instructionCategoryLabel,
  plainTextOf,
} from "./signals.js";

export const WRITING_STYLE_MIN_CHARS = 500;
export const WRITING_STYLE_USER_CONTENT_MAX = 2_000;

export type WritingStyleOrigin = "user" | "agent";
export type WritingStyleConfidenceTier = "empty" | "sparse" | "established" | "mature";

export interface WritingStyleSettingsDto {
  completionEnabled: boolean;
  generationEnabled: boolean;
  configVersion: number;
}

export interface WritingStyleProfileDto {
  profileVersion: number;
  confidenceTier: WritingStyleConfidenceTier;
  sampleDocumentCount: number;
  sampleCharCount: number;
  sections: {
    vocabulary: string[];
    sentence: string[];
    structure: string[];
    /** LLM 定性层展示行（可空——未触发或失败时为空数组）。 */
    qualitative: string[];
  };
  /** 合成好的注入块（§7.4 修订：当前画像文本单一来源）；两注入点各自按开关取用。 */
  injection: {
    completion: string | null;
    generation: string | null;
  };
  /** 行为信号摘要（§4 扩展：指令归类计数 + revision 方向统计）。 */
  behavior: WritingStyleBehaviorDto;
  lastRefreshedAt: string | null;
}

export interface WritingStyleBehaviorDto {
  /** 指令归类计数（label → 次数，含"其他"）。 */
  instructionCounts: Array<{ label: string; count: number }>;
  /** 最近指令原文（≤8 条，截断）。 */
  recentInstructions: string[];
  /** 用户手改 agent 输出的对数。 */
  revisionCount: number;
  /** 平均长度变化比（负 = 用户改短）；null = 无样本。 */
  averageLenDeltaRatio: number | null;
  /** 用户手改中感叹号净变化。 */
  exclamationDelta: number;
}

export interface WritingStyleCorpusEntryDto {
  documentId: string;
  roomId: string;
  title: string;
  charCount: number;
  origin: WritingStyleOrigin;
  excluded: boolean;
  status: string;
  extractedAt: string;
}

export class WritingStyleServiceError extends Error {
  constructor(
    readonly code:
      | "writing_style_content_invalid"
      | "writing_style_settings_invalid"
      | "writing_style_not_found",
    message: string,
  ) {
    super(`[${code}] ${message}`);
  }
}

function toIso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

/** sketch 集合指纹：LLM 消费过的语料快照（id:contentHash 排序哈希）。 */
function sketchSetCursor(rows: Array<typeof writingStyleDocumentSketches.$inferSelect>): string {
  const material = rows
    .map((row) => `${row.documentId}:${row.contentHash}`)
    .sort()
    .join("\n");
  return createHash("sha256").update(material).digest("hex");
}

function qualitativeDisplayLines(qualitative: WritingStyleQualitative | null): string[] {
  if (!qualitative) return [];
  const lines: string[] = [];
  if (qualitative.tone.length > 0) lines.push(`语气：${qualitative.tone.join("、")}`);
  if (qualitative.phrases.length > 0) lines.push(`惯用语：${qualitative.phrases.join("、")}`);
  if (qualitative.preferences.do.length > 0) lines.push(`倾向：${qualitative.preferences.do.join("；")}`);
  if (qualitative.preferences.dont.length > 0) lines.push(`避免：${qualitative.preferences.dont.join("；")}`);
  if (qualitative.summary) lines.push(qualitative.summary);
  return lines;
}

/** 从系统沉淀生成画像文本（regenerate / 自动维护 / 生成底稿共用）。 */
export function buildProfileTextFromSystem(
  sections: { vocabulary: string[]; sentence: string[]; structure: string[] },
  qualitative: WritingStyleQualitative | null,
  behaviorLines: string[] = [],
): string {
  const lines: string[] = [];
  if (behaviorLines.length > 0) {
    lines.push("行为偏好（来自你与 Agent 的协作记录）：");
    lines.push(...behaviorLines);
  }
  const qualitativeLines = qualitativeDisplayLines(qualitative);
  if (qualitativeLines.length > 0) lines.push(...qualitativeLines.slice(0, 5));
  if (sections.vocabulary.length > 0) lines.push(`用词：${sections.vocabulary[0] ?? ""}`);
  if (sections.sentence.length > 0) lines.push(`句式：${sections.sentence[0] ?? ""}`);
  if (sections.structure.length > 0) lines.push(`结构：${sections.structure[0] ?? ""}`);
  return lines.join("\n").slice(0, WRITING_STYLE_USER_CONTENT_MAX);
}

/** 行为偏好文本行（无需 LLM 即可进画像）。 */
function behaviorPreferenceLines(behavior: {
  instructionCounts: Array<{ label: string; count: number }>;
  recentInstructions: string[];
  revisionCount: number;
  averageLenDeltaRatio: number | null;
  exclamationDelta: number;
}): string[] {
  const lines: string[] = [];
  if (behavior.instructionCounts.length > 0) {
    lines.push(`- 你的修改指令偏好：${behavior.instructionCounts.slice(0, 4).map((entry) => `${entry.label}（${entry.count} 次）`).join("、")}`);
  }
  if (behavior.revisionCount > 0 && behavior.averageLenDeltaRatio !== null) {
    const direction = behavior.averageLenDeltaRatio <= -0.1 ? "改短" : behavior.averageLenDeltaRatio >= 0.1 ? "改长" : "保持长度微调";
    lines.push(`- 你常亲自修改 Agent 的输出（${behavior.revisionCount} 次），倾向${direction}（平均 ${Math.round(behavior.averageLenDeltaRatio * 100)}%）`);
  }
  if (behavior.exclamationDelta <= -2) {
    lines.push(`- 你累计删掉了 ${Math.abs(behavior.exclamationDelta)} 个感叹号——少用感叹`);
  }
  for (const instruction of behavior.recentInstructions.slice(0, 2)) {
    lines.push(`- 样例指令：「${instruction}」`);
  }
  return lines;
}

function parseSketchStats(raw: unknown): WritingStyleSketchStats | null {
  if (!raw || typeof raw !== "object") return null;
  const candidate = raw as Partial<WritingStyleSketchStats>;
  if (candidate.schemaVersion !== 1) return null;
  if (typeof candidate.charCount !== "number" || !candidate.sentences || !candidate.structure) return null;
  return candidate as WritingStyleSketchStats;
}

/** 定性层触发门槛（方案 §6）：总量 ≥3 篇 / ≥3000 字；增量 ≥2 篇或 ≥5000 字。 */
const LLM_MIN_DOCUMENTS = 3;
const LLM_MIN_CHARS = 3_000;
const LLM_DELTA_SKETCHES = 2;
const LLM_DELTA_CHARS = 5_000;

export class WritingStyleService {
  constructor(
    private readonly db: GatewayDatabase,
    /** LLM 定性层；null = 未配置（统计层照常，refresh 跳过定性）。 */
    private readonly llm: WritingStyleLlm | null = null,
    private readonly logger: { warn(bindings: Record<string, unknown>, message: string): void } = { warn: () => undefined },
  ) {}

  // ─── 设置 ───

  getSettings(): WritingStyleSettingsDto {
    const row = this.db.select().from(writingStyleSettings).where(eq(writingStyleSettings.ownerId, "local-user")).get();
    return {
      completionEnabled: row?.completionEnabled ?? false,
      generationEnabled: row?.generationEnabled ?? false,
      configVersion: row?.configVersion ?? 1,
    };
  }

  updateSettings(input: { completionEnabled?: boolean; generationEnabled?: boolean }): WritingStyleSettingsDto {
    if (
      input.completionEnabled === undefined && input.generationEnabled === undefined
    ) {
      throw new WritingStyleServiceError("writing_style_settings_invalid", "至少提供一个开关字段");
    }
    const now = new Date();
    const current = this.getSettings();
    const completionEnabled = input.completionEnabled ?? current.completionEnabled;
    const generationEnabled = input.generationEnabled ?? current.generationEnabled;
    const firstEnable = (!current.completionEnabled && completionEnabled) || (!current.generationEnabled && generationEnabled);
    this.db
      .insert(writingStyleSettings)
      .values({
        ownerId: "local-user",
        completionEnabled,
        generationEnabled,
        configVersion: current.configVersion + 1,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: writingStyleSettings.ownerId,
        set: { completionEnabled, generationEnabled, configVersion: current.configVersion + 1, updatedAt: now },
      })
      .run();
    if (firstEnable) this.backfill();
    return this.getSettings();
  }

  private behaviorSummaryDto(): WritingStyleBehaviorDto {
    const behavior = this.aggregateSignals();
    return {
      instructionCounts: behavior.instructionCounts,
      recentInstructions: behavior.recentInstructions,
      revisionCount: behavior.revisionCount,
      averageLenDeltaRatio: behavior.averageLenDeltaRatio,
      exclamationDelta: behavior.exclamationDelta,
    };
  }

  // ─── 风格画像正文（系统生成初稿 + 用户直接编辑；编辑即接管） ───

  private textRow(): typeof writingStyleUserContent.$inferSelect | undefined {
    return this.db.select().from(writingStyleUserContent)
      .where(eq(writingStyleUserContent.ownerId, "local-user")).get();
  }

  private currentCursor(): string | null {
    const rows = this.db.select().from(writingStyleDocumentSketches)
      .where(and(eq(writingStyleDocumentSketches.status, "extracted"), eq(writingStyleDocumentSketches.excluded, false)))
      .all();
    return this.combinedCursor(rows);
  }

  /** 语料指纹 = sketch 集 + 行为信号集（任一变化都算"有新沉淀"）。 */
  private combinedCursor(rows: Array<typeof writingStyleDocumentSketches.$inferSelect>): string | null {
    const signalIds = this.db.select({ id: writingStyleSignals.id }).from(writingStyleSignals).all();
    if (rows.length === 0 && signalIds.length === 0) return null;
    const material = [
      rows.map((row) => `${row.documentId}:${row.contentHash}`).sort().join("\n"),
      "|",
      signalIds.map((row) => row.id).sort().join(","),
    ].join("");
    return createHash("sha256").update(material).digest("hex");
  }

  getProfileText(): { content: string; userEdited: boolean; systemUpdateAvailable: boolean; updatedAt: string } {
    const row = this.textRow();
    const userEdited = row?.userEdited ?? false;
    const systemUpdateAvailable = Boolean(
      userEdited && row?.generatedFromCursor && this.currentCursor() !== row.generatedFromCursor,
    );
    return {
      content: row?.content ?? "",
      userEdited,
      systemUpdateAvailable,
      updatedAt: (row?.updatedAt ?? new Date()).toISOString(),
    };
  }

  /**
   * 用户编辑保存：标记接管，refresh 从此不再自动覆盖。
   * 保存空文本 = 解除接管并立即回填系统版本（有统计时），语义上是"清空回到自动维护"。
   */
  replaceUserContent(content: string): { content: string; userEdited: boolean; systemUpdateAvailable: boolean; updatedAt: string } {
    const trimmed = content.trim();
    if (trimmed.length > WRITING_STYLE_USER_CONTENT_MAX) {
      throw new WritingStyleServiceError(
        "writing_style_content_invalid",
        `画像正文不超过 ${WRITING_STYLE_USER_CONTENT_MAX} 字符`,
      );
    }
    const now = new Date();
    const current = this.textRow();
    this.db.insert(writingStyleUserContent)
      .values({
        ownerId: "local-user",
        content: trimmed,
        userEdited: trimmed.length > 0,
        // 保留原生成指纹：接管后仍能判断"系统是否有新沉淀"。
        generatedFromCursor: current?.generatedFromCursor ?? null,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: writingStyleUserContent.ownerId,
        set: { content: trimmed, userEdited: trimmed.length > 0, updatedAt: now },
      })
      .run();
    if (trimmed.length === 0) this.ensureProfileTextInitialized();
    return this.getProfileText();
  }

  /** 从当前系统沉淀重建画像文本（解除接管，恢复自动维护）。 */
  regenerateProfileText(): { content: string; userEdited: boolean; systemUpdateAvailable: boolean; updatedAt: string } {
    const profile = this.db.select().from(writingStyleProfiles)
      .where(eq(writingStyleProfiles.ownerId, "local-user")).get();
    const derived = deriveWritingStyleProfile(
      ((profile?.statsJson as unknown as { aggregate?: WritingStyleAggregate } | null)?.aggregate) ?? EMPTY_AGGREGATE,
    );
    const qualitative = (profile?.qualitativeJson as unknown as WritingStyleQualitative | null) ?? null;
    const content = buildProfileTextFromSystem(derived.sections, qualitative, behaviorPreferenceLines(this.aggregateSignals()));
    const now = new Date();
    this.db.insert(writingStyleUserContent)
      .values({
        ownerId: "local-user",
        content,
        userEdited: false,
        generatedFromCursor: this.currentCursor(),
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: writingStyleUserContent.ownerId,
        set: { content, userEdited: false, generatedFromCursor: this.currentCursor(), updatedAt: now },
      })
      .run();
    return this.getProfileText();
  }

  // ─── profile 读取 ───

  getProfile(): WritingStyleProfileDto {
    const row = this.db.select().from(writingStyleProfiles).where(eq(writingStyleProfiles.ownerId, "local-user")).get();
    if (!row) {
      return {
        profileVersion: 0,
        confidenceTier: "empty",
        sampleDocumentCount: 0,
        sampleCharCount: 0,
        sections: { vocabulary: [], sentence: [], structure: [], qualitative: [] },
        behavior: this.behaviorSummaryDto(),
        injection: this.composeInjectionBlocks(),
        lastRefreshedAt: null,
      };
    }
    const aggregate = (row.statsJson as unknown as { aggregate?: WritingStyleAggregate } | null)?.aggregate;
    const derived = deriveWritingStyleProfile(aggregate ?? EMPTY_AGGREGATE);
    const qualitative = row.qualitativeJson as unknown as WritingStyleQualitative | null;
    return {
      profileVersion: row.profileVersion,
      confidenceTier: row.confidenceTier,
      sampleDocumentCount: row.sampleDocumentCount,
      sampleCharCount: row.sampleCharCount,
      sections: { ...derived.sections, qualitative: qualitativeDisplayLines(qualitative) },
      behavior: this.behaviorSummaryDto(),
      injection: this.composeInjectionBlocks(),
      lastRefreshedAt: toIso(row.lastRefreshedAt),
    };
  }

  /** §7.4（修订版）：注入 = 当前画像文本（单一来源，无多段合成）。 */
  private composeInjectionBlocks(): { completion: string | null; generation: string | null } {
    const profileText = this.getProfileText().content || null;
    return {
      completion: composeWritingStyleBlock({ mode: "completion", profileText }),
      generation: composeWritingStyleBlock({ mode: "generation", profileText }),
    };
  }

  /** 生成侧注入段：gateway 强制读开关（方案 §7.2），关闭时返回 null。 */
  getGenerationPromptSection(): string | null {
    if (!this.getSettings().generationEnabled) return null;
    return composeWritingStyleBlock({
      mode: "generation",
      profileText: this.getProfileText().content || null,
    });
  }

  // ─── 语料 ───

  listCorpus(): WritingStyleCorpusEntryDto[] {
    const sketches = this.db.select().from(writingStyleDocumentSketches).orderBy(asc(writingStyleDocumentSketches.documentId)).all();
    if (sketches.length === 0) return [];
    const titles = new Map(
      this.db.select({ id: documents.id, title: documents.title })
        .from(documents)
        .where(inArray(documents.id, sketches.map((row) => row.documentId)))
        .all()
        .map((row) => [row.id, row.title]),
    );
    return sketches.map((row) => ({
      documentId: row.documentId,
      roomId: row.roomId,
      title: titles.get(row.documentId) ?? row.documentId,
      charCount: row.charCount,
      origin: row.origin,
      excluded: row.excluded,
      status: row.status,
      extractedAt: row.extractedAt.toISOString(),
    }));
  }

  setExclusion(documentId: string, excluded: boolean): void {
    const sketch = this.db.select().from(writingStyleDocumentSketches)
      .where(eq(writingStyleDocumentSketches.documentId, documentId)).get();
    if (!sketch) {
      throw new WritingStyleServiceError("writing_style_not_found", "该文档不在风格语料中");
    }
    this.db.update(writingStyleDocumentSketches)
      .set({ excluded, extractedAt: new Date() })
      .where(eq(writingStyleDocumentSketches.documentId, documentId)).run();
    this.db.transaction((tx) => enqueueWritingStyleRefresh(tx, new Date()));
  }

  // ─── 重算与回填 ───

  /** 全量重算：清空 sketches、profileVersion 重置；用户指令表物理隔离，零触碰。 */
  recompute(): { queuedDocuments: number } {
    const now = new Date();
    const eligible = this.eligibleDocuments();
    this.db.transaction((tx) => {
      tx.delete(writingStyleDocumentSketches).run();
      tx.delete(writingStyleSignals).run();
      tx.delete(jobs).where(eq(jobs.type, WRITING_STYLE_EXTRACT_JOB_TYPE)).run();
      tx.delete(jobs).where(eq(jobs.type, WRITING_STYLE_REFRESH_JOB_TYPE)).run();
      tx.update(writingStyleProfiles).set({
        profileVersion: 0,
        lastRefreshedAt: null,
        updatedAt: now,
      }).where(eq(writingStyleProfiles.ownerId, "local-user")).run();
      for (const entry of eligible) {
        enqueueWritingStyleExtract(tx, entry, now);
      }
      enqueueWritingStyleRefresh(tx, now);
    });
    return { queuedDocuments: eligible.length };
  }

  /** 首次开启时的存量回填：与增量同路径，不写独立批处理。 */
  backfill(): { queuedDocuments: number } {
    const pending = this.db.select({ id: jobs.id }).from(jobs)
      .where(and(eq(jobs.type, WRITING_STYLE_EXTRACT_JOB_TYPE), inArray(jobs.status, ["pending", "running"])))
      .limit(1).all();
    if (pending.length > 0) return { queuedDocuments: 0 };
    const profile = this.db.select().from(writingStyleProfiles)
      .where(eq(writingStyleProfiles.ownerId, "local-user")).get();
    if (profile && profile.sampleDocumentCount > 0) return { queuedDocuments: 0 };
    const now = new Date();
    const eligible = this.eligibleDocuments();
    this.db.transaction((tx) => {
      for (const entry of eligible) {
        enqueueWritingStyleExtract(tx, entry, now);
      }
      enqueueWritingStyleRefresh(tx, now);
    });
    return { queuedDocuments: eligible.length };
  }

  /** 合格语料：active、未删除、有 Room 归属。字数与 origin 在 extract 时判定。 */
  private eligibleDocuments(): Array<{ documentId: string; roomId: string; version: number }> {
    const rows = this.db
      .select({
        documentId: documents.id,
        version: documents.version,
        roomId: roomDocumentLinks.roomId,
      })
      .from(documents)
      .innerJoin(roomDocumentLinks, eq(roomDocumentLinks.documentId, documents.id))
      .where(and(eq(documents.status, "active"), isNull(documents.deletedAt)))
      .orderBy(asc(documents.createdAt))
      .all();
    const byDocument = new Map<string, { documentId: string; roomId: string; version: number }>();
    for (const row of rows) {
      if (!byDocument.has(row.documentId)) {
        byDocument.set(row.documentId, { documentId: row.documentId, roomId: row.roomId, version: row.version });
      }
    }
    return [...byDocument.values()];
  }

  // ─── Worker 入口 ───

  /**
   * 提取单文档 sketch。返回是否写入/更新了 extracted sketch（用于 refresh 触发判断）。
   * 幂等：contentHash 相同直接跳过；版本倒挂（旧 job 竞态）拒绝覆盖。
   */
  extractDocument(documentId: string, roomId: string, version: number): { changed: boolean; outcome: string } {
    const document = this.db.select().from(documents).where(eq(documents.id, documentId)).get();
    const existing = this.db.select().from(writingStyleDocumentSketches)
      .where(eq(writingStyleDocumentSketches.documentId, documentId)).get();
    if (!document || document.deletedAt || document.status !== "active") {
      if (existing) this.db.delete(writingStyleDocumentSketches)
        .where(eq(writingStyleDocumentSketches.documentId, documentId)).run();
      return { changed: false, outcome: "deleted_or_inactive" };
    }
    if (existing && existing.sourceVersion > version) {
      return { changed: false, outcome: "stale_version" };
    }
    const contentHash = createHash("sha256").update(JSON.stringify(document.contentJson ?? {})).digest("hex");
    if (existing && existing.contentHash === contentHash && existing.status !== "failed") {
      return { changed: false, outcome: "content_unchanged" };
    }

    const now = new Date();
    const origin = this.resolveOrigin(documentId);
    const stats = analyzeWritingStyle(document.contentJson);
    if (origin === "agent") {
      this.upsertSketch(documentId, roomId, version, contentHash, origin, false, "skipped", stats, false, now);
      return { changed: false, outcome: "agent_origin_skipped" };
    }
    if (stats.charCount < WRITING_STYLE_MIN_CHARS) {
      this.upsertSketch(documentId, roomId, version, contentHash, origin, false, "skipped", stats, false, now);
      return { changed: false, outcome: "too_short" };
    }
    this.upsertSketch(documentId, roomId, version, contentHash, origin, existing?.excluded ?? false, "extracted", stats, stats.truncated, now);
    return { changed: true, outcome: "extracted" };
  }

  /** origin 判定（方案 §4）：版本 1 由 agent 操作提交（sourceTransactionId 非空）→ agent。 */
  private resolveOrigin(documentId: string): WritingStyleOrigin {
    const firstVersion = this.db.select({ sourceTransactionId: documentVersions.sourceTransactionId })
      .from(documentVersions)
      .where(and(eq(documentVersions.documentId, documentId), eq(documentVersions.version, 1)))
      .get();
    return firstVersion?.sourceTransactionId ? "agent" : "user";
  }

  private upsertSketch(
    documentId: string,
    roomId: string,
    version: number,
    contentHash: string,
    origin: WritingStyleOrigin,
    excluded: boolean,
    status: "extracted" | "skipped",
    stats: WritingStyleSketchStats | null,
    truncated: boolean,
    now: Date,
  ): void {
    const charCount = stats?.charCount ?? 0;
    const values = {
      documentId,
      roomId,
      sourceVersion: version,
      contentHash,
      origin,
      excluded,
      charCount,
      status,
      statsJson: stats as unknown as Record<string, unknown> | null,
      truncated: Boolean(truncated),
      attempts: 0,
      extractedAt: now,
    };
    this.db.insert(writingStyleDocumentSketches)
      .values(values)
      .onConflictDoUpdate({
        target: writingStyleDocumentSketches.documentId,
        set: {
          roomId,
          sourceVersion: version,
          contentHash,
          origin,
          charCount,
          status,
          statsJson: values.statsJson,
          truncated: values.truncated,
          attempts: 0,
          extractedAt: now,
        },
      })
      .run();
  }

  /**
   * 聚合刷新：merge 全部 extracted 且未排除的 sketch → 派生 profile。
   * 统计层先落库（权威、可独立存活）；满足 §6 触发条件时再跑 LLM 定性层，
   * 失败只降级（保留上次定性结论），不回滚统计层。
   */
  async refreshProfile(): Promise<{ sketchCount: number; llm: "disabled" | "skipped" | "updated" | "failed" }> {
    this.scanSignals();
    const rows = this.db.select().from(writingStyleDocumentSketches)
      .where(and(eq(writingStyleDocumentSketches.status, "extracted"), eq(writingStyleDocumentSketches.excluded, false)))
      .all();
    let aggregate = freshAggregate();
    let charTotal = 0;
    for (const row of rows) {
      const stats = parseSketchStats(row.statsJson);
      if (!stats) continue;
      aggregate = mergeSketchStats(aggregate, stats);
      charTotal += row.charCount;
    }
    const derived = deriveWritingStyleProfile(aggregate);
    const now = new Date();
    const current = this.db.select().from(writingStyleProfiles)
      .where(eq(writingStyleProfiles.ownerId, "local-user")).get();
    this.db
      .insert(writingStyleProfiles)
      .values({
        ownerId: "local-user",
        profileVersion: (current?.profileVersion ?? 0) + 1,
        statsJson: { aggregate } as unknown as Record<string, unknown>,
        qualitativeJson: current?.qualitativeJson ?? null,
        sampleDocumentCount: aggregate.sketchCount,
        sampleCharCount: charTotal,
        confidenceTier: derived.confidenceTier,
        lastRefreshedAt: now,
        lastLlmAt: current?.lastLlmAt ?? null,
        llmMaterialCursor: current?.llmMaterialCursor ?? null,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: writingStyleProfiles.ownerId,
        set: {
          profileVersion: (current?.profileVersion ?? 0) + 1,
          statsJson: { aggregate } as unknown as Record<string, unknown>,
          qualitativeJson: current?.qualitativeJson ?? null,
          sampleDocumentCount: aggregate.sketchCount,
          sampleCharCount: charTotal,
          confidenceTier: derived.confidenceTier,
          lastRefreshedAt: now,
          updatedAt: now,
        },
      })
      .run();

    if (!this.shouldRunQualitative(rows, current)) {
      this.maintainProfileText(derived, null, rows);
      return { sketchCount: aggregate.sketchCount, llm: this.llm ? "skipped" : "disabled" };
    }
    try {
      const behavior = this.aggregateSignals();
      const qualitative = await this.llm!.summarize({
        sections: derived.sections,
        supportedTokens: derived.supportedTokens,
        sketchCount: aggregate.sketchCount,
        charCount: charTotal,
        evidenceLines: this.buildEvidenceLines(rows),
        behavior: {
          instructionCounts: behavior.instructionCounts,
          instructionSamples: behavior.instructionSamples,
          revisionCount: behavior.revisionCount,
          averageLenDeltaRatio: behavior.averageLenDeltaRatio,
          exclamationDelta: behavior.exclamationDelta,
          revisionSamples: behavior.revisionSamples,
        },
      });
      this.db.update(writingStyleProfiles).set({
        qualitativeJson: qualitative as unknown as Record<string, unknown>,
        lastLlmAt: now,
        llmMaterialCursor: this.combinedCursor(rows),
        updatedAt: now,
      }).where(eq(writingStyleProfiles.ownerId, "local-user")).run();
      this.maintainProfileText(derived, qualitative, rows);
      return { sketchCount: aggregate.sketchCount, llm: "updated" };
    } catch (error) {
      // §6 失败策略：保留上次 qualitativeJson，统计层与注入不受影响。
      this.logger.warn(
        { event: "writing-style.llm.failed", error: error instanceof Error ? error.message : String(error) },
        "writing style qualitative layer failed; keeping previous qualitative payload",
      );
      this.maintainProfileText(derived, null, rows);
      return { sketchCount: aggregate.sketchCount, llm: "failed" };
    }
  }

  // ─── 行为信号（§4 扩展）：只读回溯，不动文档提交链路 ───

  /**
   * 回溯扫描三类行为信号并幂等落库：
   * ① rewrite_instruction：划词改写 operation 的 input.instruction（completed）；
   * ② edit_instruction：document.edit/continue 的 operation（completed）反查 agent_runs.prompt 用户原话；
   * ③ revision_delta：doc_versions 中 agent 版本（sourceTransactionId 非空）→
   *    下一个用户版本（null）的手改对，做方向性轻统计 + 摘录。
   */
  scanSignals(now: Date = new Date()): number {
    const existing = new Set(
      this.db.select({ id: writingStyleSignals.id }).from(writingStyleSignals).all().map((row) => row.id),
    );
    const inserts: Array<typeof writingStyleSignals.$inferInsert> = [];

    const terminalRewrites = this.db.select().from(documentOperations)
      .where(and(eq(documentOperations.capabilityId, "document.selection-rewrite"), eq(documentOperations.status, "completed")))
      .orderBy(asc(documentOperations.createdAt)).limit(500).all();
    for (const operation of terminalRewrites) {
      const id = `rw:${operation.id}`;
      if (existing.has(id)) continue;
      const instruction = typeof operation.input?.instruction === "string" ? operation.input.instruction.trim() : "";
      if (!instruction) continue;
      inserts.push({
        id,
        type: "rewrite_instruction",
        documentId: operation.documentId,
        roomId: operation.roomId,
        instruction: clipSignal(instruction, 400),
        category: classifyInstruction(instruction),
        createdAt: now,
      });
    }

    const terminalEdits = this.db.select().from(documentOperations)
      .where(and(
        inArray(documentOperations.capabilityId, ["document.edit", "document.continue"]),
        eq(documentOperations.status, "completed"),
      ))
      .orderBy(asc(documentOperations.createdAt)).limit(500).all();
    if (terminalEdits.length > 0) {
      const prompts = new Map(this.db.select({ id: agentRuns.id, prompt: agentRuns.prompt })
        .from(agentRuns)
        .where(inArray(agentRuns.id, terminalEdits.map((operation) => operation.runId)))
        .all()
        .map((row) => [row.id, row.prompt]));
      for (const operation of terminalEdits) {
        const id = `edit:${operation.id}`;
        if (existing.has(id)) continue;
        const prompt = prompts.get(operation.runId)?.trim() ?? "";
        if (!prompt) continue;
        inserts.push({
          id,
          type: "edit_instruction",
          documentId: operation.documentId,
          roomId: operation.roomId,
          instruction: clipSignal(prompt, 400),
          category: classifyInstruction(prompt),
          createdAt: now,
        });
      }
    }

    // revision_delta：快照仍在的版本（Yjs 淘汰的版本 contentJson 为 null，跳过）
    const versions = this.db.select({
      documentId: documentVersions.documentId,
      version: documentVersions.version,
      sourceTransactionId: documentVersions.sourceTransactionId,
      contentJson: documentVersions.contentJson,
      createdAt: documentVersions.createdAt,
    }).from(documentVersions)
      .where(sql`${documentVersions.contentJson} IS NOT NULL AND ${documentVersions.createdAt} > ${now.getTime() - 90 * 24 * 3600 * 1000}`)
      .orderBy(asc(documentVersions.documentId), asc(documentVersions.version))
      .limit(5_000).all();
    const byDocument = new Map<string, typeof versions>();
    for (const version of versions) {
      const list = byDocument.get(version.documentId) ?? [];
      list.push(version);
      byDocument.set(version.documentId, list);
    }
    for (const [documentId, list] of byDocument) {
      const pairs: Array<{ before: typeof list[number]; after: typeof list[number] }> = [];
      let index = 0;
      while (index < list.length) {
        if (list[index]?.sourceTransactionId) {
          let last = index;
          while (last + 1 < list.length && list[last + 1]?.sourceTransactionId) last += 1;
          const after = list[last + 1];
          if (after && !after.sourceTransactionId) pairs.push({ before: list[last]!, after });
          index = last + 1;
        } else {
          index += 1;
        }
      }
      for (const pair of pairs.slice(-10)) {
        const id = `rev:${documentId}:${pair.before.version}`;
        if (existing.has(id)) continue;
        const beforeText = plainTextOf(pair.before.contentJson);
        const afterText = plainTextOf(pair.after.contentJson);
        // 过短配对噪音大（如只改了标题）；24 字 ≈ 一句完整中文。
        if (beforeText.length < 24 || afterText.length < 24) continue;
        inserts.push({
          id,
          type: "revision_delta",
          documentId,
          roomId: null,
          before: clipSignal(beforeText, 600),
          after: clipSignal(afterText, 600),
          deltaMeta: computeRevisionDelta(beforeText, afterText) as unknown as Record<string, number>,
          createdAt: now,
        });
        if (inserts.length > 200) break;
      }
      if (inserts.length > 200) break;
    }

    if (inserts.length > 0) this.db.insert(writingStyleSignals).values(inserts).run();
    return inserts.length;
  }

  private revisionSamplesCache: Array<{ before: string; after: string }> = [];

  aggregateSignals(): WritingStyleBehaviorDto & {
    instructionSamples: Array<{ category: string | null; instruction: string }>;
    revisionSamples: Array<{ before: string; after: string }>;
  } {
    const rows = this.db.select().from(writingStyleSignals)
      .orderBy(asc(writingStyleSignals.createdAt)).all();
    const counts = new Map<string, number>();
    const instructionSamples: Array<{ category: string | null; instruction: string }> = [];
    const recentInstructions: string[] = [];
    let revisionCount = 0;
    let exclamationDelta = 0;
    const revisionSamples: Array<{ before: string; after: string }> = [];
    const ratioSamples: number[] = [];
    for (const row of rows) {
      if (row.type === "revision_delta") {
        revisionCount += 1;
        const meta = row.deltaMeta ?? {};
        exclamationDelta += meta.exclamationDelta ?? 0;
        const lenBefore = meta.lenBefore ?? 0;
        const lenAfter = meta.lenAfter ?? 0;
        if (lenBefore > 0) ratioSamples.push((lenAfter - lenBefore) / lenBefore);
        if (revisionSamples.length < 3 && row.before && row.after) {
          revisionSamples.push({ before: clipSignal(row.before, 160), after: clipSignal(row.after, 160) });
        }
        continue;
      }
      if (!row.instruction) continue;
      const key = row.category ?? "other";
      counts.set(key, (counts.get(key) ?? 0) + 1);
      if (recentInstructions.length < 8) recentInstructions.push(clipSignal(row.instruction, 120));
      if (instructionSamples.length < 8) instructionSamples.push({ category: row.category, instruction: clipSignal(row.instruction, 120) });
    }
    this.revisionSamplesCache = revisionSamples;
    const averageLenDeltaRatio = ratioSamples.length > 0
      ? Math.round((ratioSamples.reduce((sum, value) => sum + value, 0) / ratioSamples.length) * 100) / 100
      : null;
    const instructionCounts = [...counts.entries()]
      .map(([key, count]) => ({ label: instructionCategoryLabel(key) ?? (key === "other" ? "其他" : key), count }))
      .sort((a, b) => b.count - a.count);
    return {
      instructionCounts,
      recentInstructions,
      revisionCount,
      averageLenDeltaRatio,
      exclamationDelta,
      instructionSamples,
      revisionSamples,
    };
  }

  /**
   * 启动兜底：统计画像已存在但画像文本为空（如升级到"单一画像"模型前已回填过
   * 语料、此后无新 refresh）时补生成。接管或已有文本时 no-op。
   */
  ensureProfileTextInitialized(): void {
    // 启动兜底同时捕获行为信号（升级库：让指令/手改历史立即可见）。
    this.scanSignals();
    const row = this.textRow();
    if (row?.userEdited) return;
    if (row && row.content.trim().length > 0) return;
    const profile = this.db.select().from(writingStyleProfiles)
      .where(eq(writingStyleProfiles.ownerId, "local-user")).get();
    if (!profile) return;
    const aggregate = (profile.statsJson as unknown as { aggregate?: WritingStyleAggregate } | null)?.aggregate;
    if (!aggregate || aggregate.sketchCount === 0) return;
    const rows = this.db.select().from(writingStyleDocumentSketches)
      .where(and(eq(writingStyleDocumentSketches.status, "extracted"), eq(writingStyleDocumentSketches.excluded, false)))
      .all();
    this.maintainProfileText(
      deriveWritingStyleProfile(aggregate),
      profile.qualitativeJson as unknown as WritingStyleQualitative | null,
      rows,
    );
  }

  /**
   * 自动维护画像文本：仅在用户未接管（userEdited=false）且有样本时重写。
   * 编辑即接管——refresh 永不覆盖用户版本，只通过 systemUpdateAvailable 提示。
   */
  private maintainProfileText(
    derived: ReturnType<typeof deriveWritingStyleProfile>,
    qualitative: WritingStyleQualitative | null,
    rows: Array<typeof writingStyleDocumentSketches.$inferSelect>,
  ): void {
    // 行为信号独立于文档统计：语料为 0 但已有行为信号时也生成画像文本。
    const behavior = this.aggregateSignals();
    const hasBehavior = behavior.recentInstructions.length > 0 || behavior.revisionCount > 0;
    if (derived.aggregate.sketchCount === 0 && !hasBehavior) return;
    const row = this.textRow();
    if (row?.userEdited) return;
    const content = buildProfileTextFromSystem(
      derived.sections,
      qualitative
        ?? (this.db.select().from(writingStyleProfiles).where(eq(writingStyleProfiles.ownerId, "local-user")).get()
          ?.qualitativeJson as unknown as WritingStyleQualitative | null),
      behaviorPreferenceLines(behavior),
    );
    if (!content) return;
    const now = new Date();
    this.db.insert(writingStyleUserContent)
      .values({
        ownerId: "local-user",
        content,
        userEdited: false,
        generatedFromCursor: this.combinedCursor(rows),
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: writingStyleUserContent.ownerId,
        set: { content, userEdited: false, generatedFromCursor: this.combinedCursor(rows), updatedAt: now },
      })
      .run();
  }

  private shouldRunQualitative(
    rows: Array<typeof writingStyleDocumentSketches.$inferSelect>,
    profile: typeof writingStyleProfiles.$inferSelect | undefined,
  ): boolean {
    if (!this.llm) return false;
    if (rows.length < LLM_MIN_DOCUMENTS) return false;
    if (rows.reduce((sum, row) => sum + row.charCount, 0) < LLM_MIN_CHARS) return false;
    if (this.combinedCursor(rows) === (profile?.llmMaterialCursor ?? null)) return false;
    const since = profile?.lastLlmAt ?? new Date(0);
    const fresh = rows.filter((row) => row.extractedAt > since);
    const freshChars = fresh.reduce((sum, row) => sum + row.charCount, 0);
    if (fresh.length >= LLM_DELTA_SKETCHES || freshChars >= LLM_DELTA_CHARS) return true;
    // 行为信号本身就是强素材：只要有信号且 cursor 已变（上方短路保证）即触发定性层。
    return this.db.select({ id: writingStyleSignals.id }).from(writingStyleSignals).limit(1).all().length > 0;
  }

  /** 采样证据行：最近 ≤12 篇 sketch 的摘录，总量 ≤40 行（不送全文，§6 隐私与成本约束）。 */
  private buildEvidenceLines(rows: Array<typeof writingStyleDocumentSketches.$inferSelect>): string[] {
    const recent = [...rows]
      .sort((a, b) => b.extractedAt.getTime() - a.extractedAt.getTime())
      .slice(0, 12);
    const lines: string[] = [];
    for (const row of recent) {
      const samples = parseSketchStats(row.statsJson)?.samples;
      if (!samples) continue;
      if (samples.openingExcerpt) lines.push(`开篇：${samples.openingExcerpt}`);
      if (samples.closingExcerpt) lines.push(`收尾：${samples.closingExcerpt}`);
      if (samples.longestSentence) lines.push(`长句样例：${samples.longestSentence}`);
      if (samples.shortestSentence) lines.push(`短句样例：${samples.shortestSentence}`);
      for (const [token, sentence] of samples.tokenExamples.slice(0, 2)) {
        lines.push(`高频词「${token}」用例：${sentence}`);
      }
      if (lines.length >= 40) return lines.slice(0, 40);
    }
    return lines;
  }

  /** 自上次 refresh 后的增量是否达到阈值（≥2 篇或 ≥5000 字，方案 §10）。 */
  shouldTriggerRefresh(): boolean {
    const profile = this.db.select().from(writingStyleProfiles)
      .where(eq(writingStyleProfiles.ownerId, "local-user")).get();
    const since = profile?.lastRefreshedAt ?? new Date(0);
    const rows = this.db.select({ charCount: writingStyleDocumentSketches.charCount })
      .from(writingStyleDocumentSketches)
      .where(and(
        eq(writingStyleDocumentSketches.status, "extracted"),
        eq(writingStyleDocumentSketches.excluded, false),
        sql`${writingStyleDocumentSketches.extractedAt} > ${since.getTime()}`,
      ))
      .all();
    if (rows.length === 0) return false;
    return rows.length >= 2 || rows.reduce((sum, row) => sum + row.charCount, 0) >= 5_000;
  }

}
