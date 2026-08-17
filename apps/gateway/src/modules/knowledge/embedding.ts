/**
 * 向量件（entity-room-plan §4.2）：文档 embedding 与实体质心的余弦代数。
 *
 * 质心载体从 room_wikis 迁到 entities：弱实体从第一份资料就累积（无冷启动
 * 阈值），用于同名异实体的消歧 tie-break（多命中 → 质心最近者）。
 * 规模：实体数量级百级以内，1 查询向量 vs N 质心纯内存余弦（微秒级），
 * 不引入向量数据库。centroid = norm(centroid·(1-α) + new·α)（EMA）。
 * centroidModel 不一致 = 换过 embedding 模型，旧质心不可比，作废重算。
 */

import type { KnowledgeLlmConfig } from "../../config.js";

/** EMA 新样本权重：偏保守，前 ~4 份资料后质心才近似收敛到新主题。 */
export const CENTROID_EMA_ALPHA = 0.25;
/** embedding 输入截断：标题 + 正文头部（模型侧另有 token 上限，这里保守）。 */
const EMBED_INPUT_MAX_CHARS = 4_000;
const EMBED_TIMEOUT_MS = 30_000;

export class EmbeddingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbeddingError";
  }
}

/** OpenAI 兼容 /embeddings 客户端（与 ⑤ LLM 共用 baseUrl/apiKey，模型名独立）。 */
export class EmbeddingClient {
  constructor(
    private readonly config: KnowledgeLlmConfig,
    private readonly model: string,
  ) {}

  async embed(text: string): Promise<number[]> {
    const input = text.slice(0, EMBED_INPUT_MAX_CHARS);
    let response: Response;
    try {
      response = await fetch(`${this.config.baseUrl.replace(/\/+$/, "")}/embeddings`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({ model: this.model, input }),
        signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
      });
    } catch (error) {
      throw new EmbeddingError(
        `embedding request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new EmbeddingError(`embedding HTTP ${response.status}: ${body.slice(0, 300)}`);
    }
    const payload = (await response.json()) as {
      data?: Array<{ embedding?: number[] }>;
    };
    const vector = payload.data?.[0]?.embedding;
    if (!Array.isArray(vector) || vector.length === 0) {
      throw new EmbeddingError("embedding response missing data[0].embedding");
    }
    return vector;
  }
}

// ───────────────────────── 质心代数（纯函数，单测覆盖） ─────────────────────────

export function encodeCentroid(vector: number[]): string {
  return Buffer.from(new Float32Array(vector).buffer).toString("base64");
}

export function decodeCentroid(encoded: string): number[] {
  const buffer = Buffer.from(encoded, "base64");
  const floats = new Float32Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.byteLength / 4));
  return [...floats];
}

function magnitude(vector: number[]): number {
  let sum = 0;
  for (const value of vector) sum += value * value;
  return Math.sqrt(sum);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * EMA 合成新质心并归一化。旧质心为空（首个样本）直接归一化新向量。
 * 维度不一致（换模型）按"旧质心作废"处理，从新向量重建。
 */
export function blendCentroid(previous: number[] | null, incoming: number[], alpha = CENTROID_EMA_ALPHA): number[] {
  if (!previous || previous.length === 0 || previous.length !== incoming.length) {
    return normalize(incoming);
  }
  const blended = incoming.map((value, index) => value * alpha + previous[index]! * (1 - alpha));
  return normalize(blended);
}

function normalize(vector: number[]): number[] {
  const norm = magnitude(vector);
  if (norm === 0) return vector;
  return vector.map((value) => value / norm);
}

// ───────────────────────── 消歧 tie-break 与质心维护 ─────────────────────────

/** 质心载体（entities 行的向量态）。 */
export interface CentroidRecord {
  id: string;
  centroid: string | null;
  centroidDocs: number;
  centroidModel: string | null;
}

/**
 * 同名多命中时的质心最近者（plan §4.2 步骤 1）：
 * 模型不一致或无质心的候选不参与；无任何可用质心返回 null（调用方
 * 回退证据分高者）。不设冷启动阈值——弱实体从第一份资料就累积质心。
 */
export function nearestByCentroid(
  documentVector: number[],
  candidates: CentroidRecord[],
  model: string,
): { id: string; similarity: number } | null {
  let best: { id: string; similarity: number } | null = null;
  for (const record of candidates) {
    if (!record.centroid || record.centroidModel !== model) continue;
    const similarity = cosineSimilarity(documentVector, decodeCentroid(record.centroid));
    if (!best || similarity > best.similarity) best = { id: record.id, similarity };
  }
  return best;
}

/** embedding 输入文本：标题显式前置 + 正文头部。 */
export function embeddingInputText(title: string, markdown: string): string {
  return `${title}\n\n${markdown}`.slice(0, EMBED_INPUT_MAX_CHARS);
}
