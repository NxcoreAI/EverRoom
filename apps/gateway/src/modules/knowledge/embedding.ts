/**
 * ④ 向量候选层（plan §5.2）：文档 embedding vs 各 Room 质心的暴力余弦。
 *
 * 规模分析：Room 质心数量级为百级以内，1 查询向量 vs N 质心纯内存
 * 余弦即可（微秒级），不引入向量数据库。质心存 room_wikis.centroid
 * （float32 数组 base64，~4KB），ingest 成功后指数滑动平均增量更新：
 *   centroid = norm(centroid·(1-α) + new·α)
 * 不存逐文档向量；centroid_docs < 5 视为冷启动，本级跳过。
 * centroidModel 不一致 = 换过 embedding 模型，旧质心不可比，作废重算。
 */

import type { KnowledgeLlmConfig } from "../../config.js";

/** EMA 新样本权重：偏保守，前 ~4 份文档后质心才近似收敛到新主题。 */
export const CENTROID_EMA_ALPHA = 0.25;
/** 冷启动阈值：参与质心的文档数低于此值时 ④ 层不产候选（plan §5.2）。 */
export const CENTROID_COLD_START_DOCS = 5;
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

// ───────────────────────── 候选产出与质心维护 ─────────────────────────

export interface VectorScore {
  roomId: string;
  similarity: number;
}

export interface CentroidRecord {
  roomId: string;
  knowledgeId: string;
  centroid: string | null;
  centroidDocs: number;
  centroidModel: string | null;
}

/** 候选池过滤 + 打分：冷启动与模型不一致的 Room 不参与本轮 ④。 */
export function rankByCentroids(
  documentVector: number[],
  centroids: CentroidRecord[],
  model: string,
  topN = 5,
): VectorScore[] {
  const results: VectorScore[] = [];
  for (const record of centroids) {
    if (record.centroidDocs < CENTROID_COLD_START_DOCS) continue;
    if (record.centroidModel !== model || !record.centroid) continue;
    const similarity = cosineSimilarity(documentVector, decodeCentroid(record.centroid));
    if (similarity > 0) results.push({ roomId: record.roomId, similarity: Number(similarity.toFixed(4)) });
  }
  return results.sort((a, b) => b.similarity - a.similarity).slice(0, topN);
}

/** ingest 成功后的质心推进（best-effort：失败只记日志，不影响 ingest 结果）。 */
export function advanceCentroid(
  previous: CentroidRecord,
  documentVector: number[],
  model: string,
): { centroid: string; centroidDocs: number; centroidModel: string } {
  // 换模型 / 未初始化：从当前文档向量重建
  const base = previous.centroidModel === model && previous.centroid
    ? decodeCentroid(previous.centroid)
    : null;
  const blended = blendCentroid(base, documentVector);
  return {
    centroid: encodeCentroid(blended),
    centroidDocs: (previous.centroidModel === model ? previous.centroidDocs : 0) + 1,
    centroidModel: model,
  };
}

/** embedding 输入文本：标题显式前置 + 正文头部。 */
export function embeddingInputText(title: string, markdown: string): string {
  return `${title}\n\n${markdown}`.slice(0, EMBED_INPUT_MAX_CHARS);
}
