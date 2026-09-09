import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { Ajv, type ValidateFunction } from "ajv";
import jsonata from "jsonata";
import type { NormalizedCalendarChange, NormalizedMailChange } from "@nxcore/connector-contract";
import {
  CANONICAL_ADDRESS_ROLES,
  CanonicalCalendarEventSchema,
  CanonicalMailSchema,
} from "@nxcore/connector-contract";
import { connectorFormatMappings } from "../../infrastructure/database/schema.js";
import type { GatewayDatabase } from "../../infrastructure/database/client.js";
import { FormatMappingPendingError, type FormatMapperPort } from "@nxcore/connectors-module/format-mapper-port.js";
import type { PiAgentRuntimeTool } from "@nxcore/agent-runtime-pi";

/** 映射规格：逐字段 JSONata 表达式 + 可选 tombstone 判定/取 id 表达式。 */
export interface FormatMappingSpec {
  record?: Record<string, string>;
  isTombstone?: string;
  tombstoneId?: string;
}

const RECORD_KINDS = ["mail", "calendar"] as const;
export type FormatRecordKind = (typeof RECORD_KINDS)[number];

const MAX_SAMPLES = 8;
const GENERATION_TIMEOUT_MS = 300_000;
const MAX_MAPPING_FIELDS = 40;
const MAX_EXPR_LENGTH = 4_000;

interface CompiledMapping {
  record: Array<[string, ReturnType<typeof jsonata>]>;
  isTombstone?: ReturnType<typeof jsonata>;
  tombstoneId?: ReturnType<typeof jsonata>;
}

/** 样本与表达式的结构化哈希（样本去重/日志用）。 */
function shapeHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

/** 把任意表达式求值结果收敛为可判定存在性的值（JSONata 无匹配返回 undefined）。 */
async function evalExpr(expr: ReturnType<typeof jsonata>, input: unknown): Promise<unknown> {
  const result = await expr.evaluate(input);
  return result === null ? undefined : result;
}

/** jsonata 编译/求值抛的是普通对象（非 Error 实例），String() 会变成 [object Object]。 */
function fmtError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/**
 * JSONata 求值产物可能是 null-prototype 对象（对象构造 `{...}` 生成）或内部
 * Sequence 数组；克隆为普通 JS 结构，避免下游（投影层/测试深度比较）踩原型坑。
 */
function plainify(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(plainify);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = plainify(item);
    return out;
  }
  return value;
}

export class FormatMappingService implements FormatMapperPort {
  private agentRuntime: import("@nxcore/agent-runtime").AgentRuntime | null = null;
  private readonly compiled = new Map<string, CompiledMapping>();
  private readonly generating = new Map<string, Promise<void>>();
  private readonly mailValidate: ReturnType<Ajv["compile"]>;
  private readonly calendarValidate: ReturnType<Ajv["compile"]>;

  private readonly log: { info(bindings: unknown, msg: string): void; warn(bindings: unknown, msg: string): void } | undefined;

  constructor(
    private readonly db: GatewayDatabase,
    log?: { info(bindings: unknown, msg: string): void; warn(bindings: unknown, msg: string): void },
  ) {
    this.log = log;
    const ajv = new Ajv({ strict: false, allErrors: true });
    this.mailValidate = ajv.compile(CanonicalMailSchema as unknown as object);
    this.calendarValidate = ajv.compile(CanonicalCalendarEventSchema as unknown as object);
  }

  attachAgentRuntime(runtime: NonNullable<typeof this.agentRuntime> | null): void {
    this.agentRuntime = runtime;
  }

  /** submit_format_mapping 工具（connector-mapper agent 的唯一提交通道）。 */
  createSubmitTool(): PiAgentRuntimeTool {
    return {
      name: "submit_format_mapping",
      label: "Submit format mapping",
      description: "提交 provider 原始格式 → canonical schema 的 JSONata 映射；服务端立即用样本回放校验，失败会返回具体错误供迭代。",
      parameters: {
        type: "object",
        properties: {
          service: { type: "string", minLength: 1, maxLength: 64 },
          recordKind: { type: "string", enum: [...RECORD_KINDS] },
          record: {
            type: "object",
            description: "canonical 字段名 → JSONata 表达式（对单条原始记录求值）；至少覆盖必需字段",
            additionalProperties: { type: "string", maxLength: MAX_EXPR_LENGTH },
          },
          isTombstone: { type: "string", maxLength: MAX_EXPR_LENGTH, description: "可选：判定原始记录为删除墓碑的 JSONata 表达式" },
          tombstoneId: { type: "string", maxLength: MAX_EXPR_LENGTH, description: "isTombstone 命中时从原始记录取记录 id 的表达式" },
        },
        required: ["service", "recordKind"],
        additionalProperties: false,
      },
      execute: async (_input, params) => {
        const outcome = await this.submitMapping(params.service as string, params.recordKind as string, {
          ...(params.record && typeof params.record === "object" ? { record: params.record as Record<string, string> } : {}),
          ...(typeof params.isTombstone === "string" ? { isTombstone: params.isTombstone } : {}),
          ...(typeof params.tombstoneId === "string" ? { tombstoneId: params.tombstoneId } : {}),
        });
        return { content: JSON.stringify(outcome), details: { ok: outcome.ok } };
      },
    };
  }

  /** FormatMapperPort：provider 原始记录 → canonical 变更（缓存直通快路径）。 */
  async normalizeMail(provider: string, raw: unknown): Promise<NormalizedMailChange> {
    return (await this.normalize(provider, "mail", raw)) as NormalizedMailChange;
  }

  async normalizeCalendar(provider: string, raw: unknown): Promise<NormalizedCalendarChange> {
    return (await this.normalize(provider, "calendar", raw)) as NormalizedCalendarChange;
  }

  private async normalize(provider: string, kind: FormatRecordKind, raw: unknown): Promise<NormalizedMailChange | NormalizedCalendarChange> {
    const row = this.getRow(provider, kind);
    if (row?.status === "active" && row.mappingJson) {
      try {
        const compiled = await this.compiledFor(row);
        return await this.apply(compiled, raw, kind);
      } catch (error) {
        // 应用失败是确定性的（同一 raw 必然复现），多次重试无意义：立即捕获崩溃
        // 样本并失效重生成——否则过拟合映射会让该源永久卡死在 pending。
        this.captureSample(provider, kind, raw);
        this.markFailed(provider, kind, `mapping_apply_failed: ${fmtError(error)}`);
        this.kickGeneration(provider, kind, "apply_failed");
        throw new FormatMappingPendingError(provider, kind, "映射应用失败，已失效并安排重新生成");
      }
    }
    this.captureSample(provider, kind, raw);
    this.kickGeneration(provider, kind, "no_mapping");
    throw new FormatMappingPendingError(provider, kind);
  }

  /** 后台生成（单飞）：映射不存在/失效时由 normalize 触发。 */
  private kickGeneration(service: string, kind: FormatRecordKind, reason: string): void {
    const key = `${service}:${kind}`;
    if (this.generating.has(key)) return;
    const task = this.runGeneration(service, kind, reason)
      .catch((error) => {
        const message = fmtError(error);
        this.log?.warn({ service, kind }, `[format-mapping] 生成失败: ${message}`);
      })
      .finally(() => this.generating.delete(key));
    this.generating.set(key, task);
  }

  private async runGeneration(service: string, kind: FormatRecordKind, reason: string): Promise<void> {
    if (!this.agentRuntime) {
      this.log?.warn({ service, kind }, "[format-mapping] agent runtime 未配置，映射生成不可用（该源将持续 pending）");
      return;
    }
    const row = this.ensureRow(service, kind);
    if (row.status === "active") return;
    const samples = (row.samplesJson ?? []) as unknown[];
    if (samples.length === 0) {
      this.markFailed(service, kind, "no_samples_captured");
      return;
    }
    this.updateRow(service, kind, { status: "generating", error: null });
    const prompt = this.buildPrompt(service, kind, samples, reason);
    const runId = randomUUID();
    const runtimeRun = await this.agentRuntime.start({
      runId,
      sessionId: `format-mapping:${service}:${kind}:${runId}`,
      runtimeSessionRef: null,
      prompt,
      pageLabel: `格式映射 Agent · ${service}/${kind}`,
      roomId: null,
      captureMemory: false,
      recallMemory: false,
    });
    // 失败/超时即取消 runtime run：不取消的话 agent 会继续迭代（烧 token），
    // 其迟到提交还会在废弃生成之上反复激活新版本。
    try {
      await Promise.race([
        (async () => {
          for await (const event of runtimeRun.events) {
            if (event.type === "run.failed" || event.type === "run.cancelled" || event.type === "run.interrupted") {
              const message = (event.payload as { message?: unknown }).message;
              throw new Error(typeof message === "string" ? message : "format-mapping agent run failed");
            }
          }
        })(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`format_mapping_generation_timeout:${GENERATION_TIMEOUT_MS}ms`)), GENERATION_TIMEOUT_MS),
        ),
      ]);
    } catch (error) {
      try {
        await this.agentRuntime.cancel(runId);
      } catch {
        // 取消失败不影响失败语义（run 可能已自行结束）。
      }
      throw error;
    }
    const after = this.getRow(service, kind);
    if (after && after.status !== "active") {
      this.markFailed(service, kind, "agent_finished_without_valid_submission");
    }
  }

  /**
   * agent 提交入口（submit_format_mapping 工具的落点）：语法编译 + 全样本回放 +
   * canonical schema 校验，全部通过才置 active；否则返回逐条错误供 agent 迭代。
   */
  async submitMapping(service: string, kind: string, spec: FormatMappingSpec): Promise<{ ok: boolean; errors?: string[]; version?: number }> {
    if (!(RECORD_KINDS as readonly string[]).includes(kind)) return { ok: false, errors: [`未知 recordKind: ${kind}`] };
    const record = spec.record ?? {};
    const fields = Object.keys(record);
    if (fields.length === 0 && !spec.isTombstone) return { ok: false, errors: ["映射为空：至少需要 record 字段表达式或 isTombstone"] };
    if (fields.length > MAX_MAPPING_FIELDS) return { ok: false, errors: [`字段数超限（>${MAX_MAPPING_FIELDS}）`] };
    if (spec.isTombstone && !spec.tombstoneId) return { ok: false, errors: ["提供 isTombstone 时必须同时提供 tombstoneId"] };
    const row = this.getRow(service, kind as FormatRecordKind);
    const samples = (row?.samplesJson ?? []) as unknown[];
    if (samples.length === 0) return { ok: false, errors: ["无可用样本（samples 为空），无法回放校验"] };
    const errors: string[] = [];
    const compiled: CompiledMapping = { record: [] };
    for (const [field, exprText] of Object.entries(record)) {
      try {
        compiled.record.push([field, jsonata(String(exprText))]);
      } catch (error) {
        errors.push(`字段 ${field} 表达式编译失败: ${fmtError(error)}`);
      }
    }
    try {
      if (spec.isTombstone) compiled.isTombstone = jsonata(spec.isTombstone);
      if (spec.tombstoneId) compiled.tombstoneId = jsonata(spec.tombstoneId);
    } catch (error) {
      errors.push(`tombstone 表达式编译失败: ${fmtError(error)}`);
    }
    if (errors.length > 0) return { ok: false, errors };
    const validate = this.validatorFor(kind as FormatRecordKind);
    for (let i = 0; i < samples.length; i++) {
      try {
        const raw = (samples[i] as { raw?: unknown }).raw ?? samples[i];
        if (compiled.isTombstone && (await evalExpr(compiled.isTombstone, raw)) === true) {
          const id = compiled.tombstoneId ? await evalExpr(compiled.tombstoneId, raw) : undefined;
          if (typeof id !== "string" || id.length === 0) errors.push(`样本#${i}: 墓碑命中但 tombstoneId 未得到字符串`);
          continue;
        }
        const out: Record<string, unknown> = {};
        for (const [field, expr] of compiled.record) {
          const value = await evalExpr(expr, raw);
          if (value !== undefined) out[field] = plainify(value);
        }
        if (!validate(out)) {
          const detail = (validate.errors ?? []).map((e: { instancePath?: string; message?: string }) => `${e.instancePath || "/"} ${e.message ?? ""}`.trim()).join("; ") || "schema 校验失败";
          errors.push(`样本#${i}: canonical 校验失败 — ${detail}`);
        }
      } catch (error) {
        errors.push(`样本#${i} 求值异常: ${fmtError(error)}`);
      }
    }
    if (errors.length > 0) return { ok: false, errors };
    const version = this.activate(service, kind as FormatRecordKind, spec);
    return { ok: true, version };
  }

  private getRow(service: string, kind: FormatRecordKind) {
    return this.db
      .select()
      .from(connectorFormatMappings)
      .where(and(eq(connectorFormatMappings.service, service), eq(connectorFormatMappings.recordKind, kind)))
      .get();
  }

  private ensureRow(service: string, kind: FormatRecordKind) {
    const existing = this.getRow(service, kind);
    if (existing) return existing;
    this.db.insert(connectorFormatMappings).values({
      id: randomUUID(),
      service,
      recordKind: kind,
      status: "generating",
      samplesJson: [],
    }).onConflictDoNothing().run();
    return this.getRow(service, kind)!;
  }

  private updateRow(service: string, kind: FormatRecordKind, patch: Partial<typeof connectorFormatMappings.$inferInsert>) {
    this.db.update(connectorFormatMappings)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(connectorFormatMappings.service, service), eq(connectorFormatMappings.recordKind, kind)))
      .run();
  }

  /** 首见格式样本捕获（cap 内去重；持久化供回放与生成提示词）。 */
  private captureSample(service: string, kind: FormatRecordKind, raw: unknown): void {
    try {
      const row = this.ensureRow(service, kind);
      const samples = ((row?.samplesJson ?? []) as unknown[]).slice();
      if (samples.length >= MAX_SAMPLES) return;
      const hash = shapeHash(raw);
      if (samples.some((s) => (s as { __hash?: string }).__hash === hash)) return;
      samples.push({ __hash: hash, raw });
      this.updateRow(service, kind, { samplesJson: samples });
    } catch (error) {
      this.log?.warn({ service, kind }, `[format-mapping] 样本捕获失败: ${fmtError(error)}`);
    }
  }

  private async compiledFor(row: typeof connectorFormatMappings.$inferSelect): Promise<CompiledMapping> {
    const cacheKey = `${row.service}:${row.recordKind}:v${row.version}`;
    const cached = this.compiled.get(cacheKey);
    if (cached) return cached;
    const spec = row.mappingJson as FormatMappingSpec | null;
    if (!spec) throw new Error("mapping_json_missing");
    const compiled: CompiledMapping = { record: [] };
    for (const [field, exprText] of Object.entries(spec.record ?? {})) compiled.record.push([field, jsonata(String(exprText))]);
    if (spec.isTombstone) compiled.isTombstone = jsonata(spec.isTombstone);
    if (spec.tombstoneId) compiled.tombstoneId = jsonata(spec.tombstoneId);
    this.compiled.set(cacheKey, compiled);
    return compiled;
  }

  /** 求值 + canonical 校验；任何一步失败抛错（上层计连续失败并失效映射）。 */
  private async apply(compiled: CompiledMapping, raw: unknown, kind: FormatRecordKind): Promise<NormalizedMailChange | NormalizedCalendarChange> {
    if (compiled.isTombstone && (await evalExpr(compiled.isTombstone, raw)) === true) {
      const id = compiled.tombstoneId ? await evalExpr(compiled.tombstoneId, raw) : undefined;
      if (typeof id !== "string" || id.length === 0) throw new Error("tombstone_id_not_string");
      return kind === "mail"
        ? { kind: "tombstone", providerMessageId: id } as NormalizedMailChange
        : { kind: "tombstone", providerEventId: id } as NormalizedCalendarChange;
    }
    const out: Record<string, unknown> = {};
    for (const [field, expr] of compiled.record) {
      const value = await evalExpr(expr, raw);
      if (value !== undefined) out[field] = plainify(value);
    }
    const validate = this.validatorFor(kind);
    if (!validate(out)) {
      const detail = (validate.errors ?? []).map((e: { instancePath?: string; message?: string }) => `${e.instancePath || "/"} ${e.message ?? ""}`.trim()).join("; ") || "invalid";
      throw new Error(`canonical_validate_failed: ${detail}`);
    }
    if (kind === "mail") return { kind: "upsert", message: out } as unknown as NormalizedMailChange;
    return { kind: "upsert", event: out } as unknown as NormalizedCalendarChange;
  }

  private validatorFor(kind: FormatRecordKind) {
    return kind === "mail" ? this.mailValidate : this.calendarValidate;
  }

  private activate(service: string, kind: FormatRecordKind, spec: FormatMappingSpec): number {
    const row = this.ensureRow(service, kind);
    const version = row.version + 1;
    this.updateRow(service, kind, {
      status: "active",
      mappingJson: spec as unknown as Record<string, unknown>,
      version,
      error: null,
      activatedAt: new Date(),
    });
    this.compiled.delete(`${service}:${kind}:v${row.version}`);
    this.compiled.delete(`${service}:${kind}:v${version}`);
    this.log?.info({ service, kind, version }, "[format-mapping] 映射已激活");
    return version;
  }

  private markFailed(service: string, kind: FormatRecordKind, error: string): void {
    const row = this.getRow(service, kind);
    if (row?.status === "active") this.compiled.delete(`${service}:${kind}:v${row.version}`);
    this.updateRow(service, kind, { status: "failed", error });
    this.log?.warn({ service, kind }, `[format-mapping] 映射失效: ${error}`);
  }

  /** 生成提示词：canonical schema + 逐字段表达式要求 + 全部样本（agent 对比差异产出映射）。 */
  private buildPrompt(service: string, kind: FormatRecordKind, samples: unknown[], reason: string): string {
    const canonical = JSON.stringify(kind === "mail" ? CanonicalMailSchema : CanonicalCalendarEventSchema, null, 2);
    const sampleText = samples
      .map((s, i) => {
        const raw = (s as { raw?: unknown }).raw ?? s;
        return `### 样本 #${i}\n\`\`\`json\n${JSON.stringify(raw, null, 2).slice(0, 12_000)}\n\`\`\``;
      })
      .join("\n");
    return [
      `任务：为数据源 ${service} 的 ${kind} 记录产出「原始格式 → canonical schema」的可复用映射（触发原因：${reason}）。`,
      "",
      "## canonical schema（目标格式，映射输出必须通过它的 ajv 校验）",
      "```json",
      canonical,
      "```",
      "",
      "## 规则",
      "- mapping.record 的每个值是一条 JSONata 表达式，输入为单条原始记录（根对象）。",
      "- 只映射原始记录中真实存在的字段，禁止臆造或猜测数据；缺失字段留空（表达式无匹配即可）。",
      "- 必须保证 providerMessageId / providerEventId 从原始记录的 id 类字段确定性地取出。",
      "- 时间字段输出 ISO-8601（JSONata：$fromMillis($number(...))；已是 ISO 则直接透传）。",
      "- 地址 role 只允许：" + CANONICAL_ADDRESS_ROLES.join(" / ") + "。",
      "- 删除/取消类记录（如 @removed、status=cancelled）用 isTombstone + tombstoneId 表达，不产出 record。",
      "- 样本中 personal_data 已按原样提供，映射只引用字段路径，不在表达式里内联任何具体值。",
      "",
      "完成后调用 submit_format_mapping 工具提交；提交会立即用下方样本回放校验，若有错误请根据返回的错误逐条修正后重新提交，直到 ok=true。",
      "",
      "## 原始格式样本",
      sampleText,
    ].join("\n");
  }
}
