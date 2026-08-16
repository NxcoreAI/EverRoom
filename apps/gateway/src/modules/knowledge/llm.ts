/**
 * ⑤ LLM 仲裁（plan §5.2）：唯一非确定性决策层。
 *
 * 输入卷宗（文档摘要 + 各候选 Room 身份卡 + ③④ 分数证据），
 * 输出严格 JSON 判决。解析失败重试一次，再失败抛错交 worker 退避。
 * summarize / arbitrate 各自独立 prompt；温度压低换稳定。
 */

import type { KnowledgeLlmConfig } from "../../config.js";

const CHAT_TIMEOUT_MS = 60_000;
const MAX_RESPONSE_CHARS = 4_000;

export class KnowledgeLlmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KnowledgeLlmError";
  }
}

export interface CandidateCard {
  roomId: string;
  title: string;
  summary: string | null;
  pageTitles: string[];
  entityScore?: number;
  entityTokens?: string[];
  vectorSimilarity?: number;
}

export interface ArbitrationDossier {
  documentTitle: string;
  documentSummary: string;
  occurredAt?: string;
  candidates: CandidateCard[];
}

export interface ArbitrationVerdict {
  action: "existing" | "create_new";
  /** action=existing 时：主 Room 为第一个，其余为附带。 */
  roomIds: string[];
  newRoom: { name: string; summary: string; kind?: string };
  confidence: number;
  reason: string;
}

export class KnowledgeLlm {
  constructor(private readonly config: KnowledgeLlmConfig) {}

  /** 文档预摘要（≤300 字）；LLM 不可用时调用方回退 markdown 头部。 */
  async summarize(title: string, markdown: string): Promise<string> {
    const content = await this.chat([
      {
        role: "system",
        content:
          "你是资料归档助手。用不超过 300 字概括以下资料的主题、涉及的对象与结论，"
          + "只输出概括本身，不要任何前缀、标题或列表符号。",
      },
      { role: "user", content: `标题：${title}\n\n${markdown.slice(0, 8_000)}` },
    ]);
    return content.trim().slice(0, 400);
  }

  /** ⑤ 终审：卷宗 → 判决。JSON 解析失败带错误反馈重试一次。 */
  async arbitrate(dossier: ArbitrationDossier): Promise<ArbitrationVerdict> {
    const prompt = buildArbitrationPrompt(dossier);
    let lastError = "";
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const content = await this.chat([
        { role: "system", content: ARBITRATION_SYSTEM_PROMPT },
        { role: "user", content: lastError ? `${prompt}\n\n上一次输出无法解析：${lastError}\n请严格只输出合法 JSON。` : prompt },
      ]);
      try {
        return parseArbitrationResponse(content, dossier);
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
    throw new KnowledgeLlmError(`arbitration response unparsable: ${lastError}`);
  }

  private async chat(messages: Array<{ role: "system" | "user" | "assistant"; content: string }>): Promise<string> {
    let response: Response;
    try {
      response = await fetch(`${this.config.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model: this.config.model,
          messages,
          temperature: 0.1,
          max_tokens: 1_024,
        }),
        signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
      });
    } catch (error) {
      throw new KnowledgeLlmError(
        `knowledge LLM request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new KnowledgeLlmError(`knowledge LLM HTTP ${response.status}: ${body.slice(0, 300)}`);
    }
    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.length === 0) {
      throw new KnowledgeLlmError("knowledge LLM response missing choices[0].message.content");
    }
    return content.slice(0, MAX_RESPONSE_CHARS);
  }
}

const ARBITRATION_SYSTEM_PROMPT = [
  "你是资料归档的路由仲裁员。根据资料卷宗判断它应该归属哪个 Room。",
  "规则：",
  "1. 按主题归属判断，不只看字面重叠；资料可以多归属（room_ids 给多个）。",
  "2. 候选列表外的 Room 一律不允许出现在 room_ids 里。",
  "3. 只有当某候选确实是这份资料的主题归属（资料的核心主题就是该 Room 的主题）时才选它；"
    + "若所有候选都只是弱相关、或仅靠个别词句沾边，不要为了归档而硬塞："
    + "内容构成连贯的新主题时判 create_new（confidence 必须 >= 0.8），否则输出低 confidence（< 0.6）交人工处理。",
  "4. 拿不准就输出较低的 confidence（< 0.6），不要硬猜。",
  "5. 参考信号只是线索，可能有噪声：实体匹配分没有绝对刻度，取决于命中词的稀有度；"
    + "命中的 token 若是「用户」「API」「系统」这类任何资料都会出现的通用词，不构成主题相关；"
    + "向量相似度对不相关文本也有不低的基线值。",
  "6. kind 从这些里选：人物/项目/主题/长期目标/议题/事件。",
  "只输出一个 JSON 对象，不要 markdown 代码块、不要解释。格式：",
  '{"action":"existing|create_new","room_ids":["..."],"new_room":{"name":"...","summary":"...","kind":"..."},"confidence":0.0,"reason":"..."}',
].join("\n");

function buildArbitrationPrompt(dossier: ArbitrationDossier): string {
  const lines: string[] = [];
  lines.push(`资料标题：${dossier.documentTitle}`);
  if (dossier.occurredAt) lines.push(`发生时间：${dossier.occurredAt}`);
  lines.push(`资料摘要：${dossier.documentSummary}`);
  lines.push("");
  lines.push(`候选 Room（共 ${dossier.candidates.length} 个）：`);
  for (const candidate of dossier.candidates) {
    lines.push(`- id=${candidate.roomId} 名称=${candidate.title}`);
    if (candidate.summary) lines.push(`  简介：${candidate.summary}`);
    if (candidate.pageTitles.length > 0) {
      lines.push(`  已沉淀页面：${candidate.pageTitles.slice(0, 10).join("、")}`);
    }
    const signals: string[] = [];
    if (candidate.entityScore !== undefined) {
      signals.push(`实体匹配分=${candidate.entityScore}${candidate.entityTokens?.length ? `（命中：${candidate.entityTokens.slice(0, 8).join("、")}）` : ""}`);
    }
    if (candidate.vectorSimilarity !== undefined) signals.push(`向量相似度=${candidate.vectorSimilarity}`);
    if (signals.length > 0) lines.push(`  参考信号：${signals.join("；")}`);
  }
  lines.push("");
  lines.push("请给出判决 JSON。");
  return lines.join("\n");
}

/**
 * 严格解析判决（导出供单测）：
 * 剥离 ```json 围栏 → JSON.parse → 逐字段校验 + 越界修正。
 * room_ids 必须是候选 id 的子集；create_new 必须带 name。
 */
export function parseArbitrationResponse(content: string, dossier: ArbitrationDossier): ArbitrationVerdict {
  const stripped = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start < 0 || end <= start) throw new KnowledgeLlmError("no JSON object found");
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped.slice(start, end + 1));
  } catch (error) {
    throw new KnowledgeLlmError(`invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const raw = parsed as Record<string, unknown>;

  const action = raw.action;
  if (action !== "existing" && action !== "create_new") {
    throw new KnowledgeLlmError(`invalid action: ${String(action)}`);
  }

  const candidateIds = new Set(dossier.candidates.map((candidate) => candidate.roomId));
  const roomIds = Array.isArray(raw.room_ids)
    ? raw.room_ids.filter((id): id is string => typeof id === "string" && candidateIds.has(id))
    : [];
  // 去重保序
  const uniqueRoomIds = [...new Set(roomIds)];

  const newRoomRaw = (raw.new_room ?? {}) as Record<string, unknown>;
  const newName = typeof newRoomRaw.name === "string" ? newRoomRaw.name.trim().slice(0, 120) : "";
  if (action === "create_new" && !newName) {
    throw new KnowledgeLlmError("create_new requires new_room.name");
  }

  const confidenceRaw = typeof raw.confidence === "number" ? raw.confidence : Number(raw.confidence);
  if (!Number.isFinite(confidenceRaw)) throw new KnowledgeLlmError("invalid confidence");
  const confidence = Math.min(1, Math.max(0, confidenceRaw));

  const reason = typeof raw.reason === "string" ? raw.reason.trim().slice(0, 1_000) : "";
  const summary = typeof newRoomRaw.summary === "string" ? newRoomRaw.summary.trim().slice(0, 500) : "";
  const kindRaw = typeof newRoomRaw.kind === "string" ? newRoomRaw.kind.trim() : "";
  const kind = ["人物", "项目", "主题", "长期目标", "议题", "事件"].includes(kindRaw) ? kindRaw : undefined;

  if (action === "existing" && uniqueRoomIds.length === 0) {
    // 判 existing 却没有合法 room_id：语义等价于拿不准，交给阈值层降级
    return {
      action: "existing",
      roomIds: [],
      newRoom: { name: "", summary },
      confidence: 0,
      reason: reason || "仲裁未给出任何合法 Room",
    };
  }
  if (action === "create_new") {
    // 候选里已有高度重名者由 router 层的 Dice 去重归并，这里原样透传
    return {
      action,
      roomIds: [],
      newRoom: { name: newName, summary, ...(kind ? { kind } : {}) },
      confidence,
      reason,
    };
  }
  return { action, roomIds: uniqueRoomIds, newRoom: { name: "", summary }, confidence, reason };
}
