import { and, desc, eq, isNull } from "drizzle-orm";
import type { PiAgentRuntimeTool } from "@nxcore/agent-runtime-pi";
import { Type } from "@sinclair/typebox";
import type { TiptapJsonContent } from "@nxcore/agent-contract";
import type { GatewayDatabase } from "../../infrastructure/database/client.js";
import {
  contextRooms,
  documents,
  entities,
  roomContextCorrections,
  roomDocumentLinks,
  roomEntityFacts,
  roomEntityMentions,
  roomSourceMemberships,
} from "../../infrastructure/database/schema.js";
import type { MemoryService } from "../memory/service.js";
import { tiptapToMarkdown } from "../knowledge/tiptap-markdown.js";

/** room_context_get 单文档与总量 Markdown 预算：约束子 Agent 输入体积。 */
const PER_DOCUMENT_MARKDOWN_LIMIT = 12_000;
const TOTAL_MARKDOWN_LIMIT = 80_000;
const MAX_DOCUMENTS = 30;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function memoryToolErrorText(label: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `${label}失败：${message}`;
}

/**
 * 注册给 context-room 子 Agent 的网关只读工具（SubagentRuntimeManager.registerAgentTools）。
 *
 * dispatch 子 Agent 的 Pi 配置由 SubagentRuntimeManager 从 backgroundPi 剥除
 * memory/knowledge/mcp 构建，因此检索能力在这里以显式只读工具提供：
 * - memory_search / conversation_search：复用 MemoryService（与主 Agent 记忆工具同源）。
 * - room_context_get：Room 信息、事实、来源、纠正与文档正文，供总览生成与资料分析。
 */
export function createContextRoomAgentTools(deps: {
  db: GatewayDatabase;
  memory: MemoryService | null;
}): PiAgentRuntimeTool[] {
  const { db, memory } = deps;

  const memorySearch: PiAgentRuntimeTool = {
    name: "memory_search",
    label: "记忆检索",
    description: "检索长期记忆（L1 原子记忆：用户偏好、事实、约束、决策）。整理 Room 前必须先用标题与描述调用。",
    parameters: Type.Object({
      query: Type.String({ minLength: 1, maxLength: 500 }),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 20 })),
    }, { additionalProperties: false }),
    execute: async (_run, params) => {
      if (!memory?.enabled) {
        return { content: "记忆检索不可用（Memory 未配置）。", details: { count: 0, enabled: false } };
      }
      try {
        const { items } = await memory.searchAtomic(String(params.query ?? ""), Number(params.limit ?? 5));
        const text = items.length === 0
          ? "没有匹配的长期记忆。"
          : items.map((item) => `- ${item.content}${item.updatedAt ? `（${item.updatedAt}）` : ""}`).join("\n");
        return { content: text, details: { count: items.length } };
      } catch (error) {
        return {
          content: memoryToolErrorText("记忆检索", error),
          details: { count: 0 },
          isError: true,
        };
      }
    },
  };

  const conversationSearch: PiAgentRuntimeTool = {
    name: "conversation_search",
    label: "历史对话检索",
    description: "全文检索历史对话（L0 原始消息，跨会话）。整理 Room 前必须先用标题与描述调用。",
    parameters: Type.Object({
      query: Type.String({ minLength: 1, maxLength: 500 }),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 20 })),
    }, { additionalProperties: false }),
    execute: async (_run, params) => {
      if (!memory?.enabled) {
        return { content: "历史对话检索不可用（Memory 未配置）。", details: { count: 0, enabled: false } };
      }
      try {
        const { messages } = await memory.searchConversations(String(params.query ?? ""), Number(params.limit ?? 5));
        const text = messages.length === 0
          ? "没有匹配的历史对话。"
          : messages.map((message) => `- ${message.role === "assistant" ? "助手" : "用户"}：${message.content}`).join("\n");
        return { content: text, details: { count: messages.length } };
      } catch (error) {
        return {
          content: memoryToolErrorText("历史对话检索", error),
          details: { count: 0 },
          isError: true,
        };
      }
    },
  };

  const roomContextGet: PiAgentRuntimeTool = {
    name: "room_context_get",
    label: "读取 Room 资料",
    description: "读取指定 Room 的信息、结构化事实、来源、已应用纠正，以及文档 Markdown 正文（超长截断）。用于总览生成与资料分析。",
    parameters: Type.Object({
      roomId: Type.String({ minLength: 1, maxLength: 128 }),
    }, { additionalProperties: false }),
    execute: async (_run, params) => {
      const roomId = String(params.roomId ?? "").trim();
      if (!roomId) throw new Error("room_context_room_id_required");
      const room = db.select().from(contextRooms).where(and(
        eq(contextRooms.id, roomId),
        isNull(contextRooms.deletedAt),
      )).get();
      if (!room || room.lifecycle !== "active") throw new Error("context_room_not_found");
      const rows = db.select({ document: documents })
        .from(roomDocumentLinks)
        .innerJoin(documents, eq(roomDocumentLinks.documentId, documents.id))
        .where(and(eq(roomDocumentLinks.roomId, roomId), isNull(documents.deletedAt)))
        .orderBy(desc(documents.updatedAt))
        .all()
        .filter(({ document }) => document.status === "active")
        .slice(0, MAX_DOCUMENTS);
      let totalCharacters = 0;
      let truncatedDocuments = 0;
      const collected = rows.flatMap(({ document }) => {
        const markdown = tiptapToMarkdown(document.contentJson as TiptapJsonContent);
        const budget = Math.min(
          PER_DOCUMENT_MARKDOWN_LIMIT,
          Math.max(TOTAL_MARKDOWN_LIMIT - totalCharacters, 0),
        );
        if (budget <= 0) {
          truncatedDocuments += 1;
          return [{
            documentId: document.id,
            title: document.title,
            version: document.version,
            updatedAt: document.updatedAt.toISOString(),
            markdown: "",
            truncated: true,
          }];
        }
        const clipped = markdown.length > budget;
        if (clipped) truncatedDocuments += 1;
        totalCharacters += Math.min(markdown.length, budget);
        return [{
          documentId: document.id,
          title: document.title,
          version: document.version,
          updatedAt: document.updatedAt.toISOString(),
          markdown: clipped ? `${markdown.slice(0, budget)}\n…（已截断）` : markdown,
          truncated: clipped,
        }];
      });
      const payload = {
        roomId,
        room: {
          title: room.title,
          kind: room.kind,
          brief: isRecord(room.data.brief) ? room.data.brief : {},
          timeline: Array.isArray(room.data.timeline) ? room.data.timeline.slice(0, 100) : [],
        },
        facts: db.select({
          factId: roomEntityFacts.factId,
          content: roomEntityFacts.content,
          type: roomEntityFacts.type,
          sourceKind: roomEntityFacts.sourceKind,
          sourceId: roomEntityFacts.sourceId,
          sourceTitle: roomSourceMemberships.sourceTitle,
          updatedAt: roomEntityFacts.updatedAt,
        }).from(roomEntityFacts).leftJoin(roomSourceMemberships, and(
          eq(roomSourceMemberships.roomId, roomEntityFacts.roomId),
          eq(roomSourceMemberships.sourceKind, roomEntityFacts.sourceKind),
          eq(roomSourceMemberships.sourceId, roomEntityFacts.sourceId),
        )).where(eq(roomEntityFacts.roomId, roomId)).all().slice(0, 200).map((fact) => ({
          ...fact,
          updatedAt: fact.updatedAt.toISOString(),
        })),
        entities: db.select({
          id: entities.id,
          name: entities.name,
          kind: entities.kind,
          summary: entities.summary,
          evidence: roomEntityMentions.evidence,
          sourceKind: roomEntityMentions.sourceKind,
          sourceId: roomEntityMentions.sourceId,
        }).from(roomEntityMentions).innerJoin(entities, eq(entities.id, roomEntityMentions.entityId))
          .where(eq(roomEntityMentions.roomId, roomId)).all().slice(0, 200),
        appliedCorrections: db.select().from(roomContextCorrections).where(and(
          eq(roomContextCorrections.roomId, roomId),
          eq(roomContextCorrections.status, "applied"),
        )).all().map((correction) => ({
          operation: correction.operation,
          section: correction.section,
          originalText: correction.originalText,
          replacementText: correction.replacementText,
          rationale: correction.rationale,
        })),
        documentCount: rows.length,
        ...(rows.length > collected.length ? { omittedDocuments: rows.length - collected.length } : {}),
        ...(truncatedDocuments > 0 ? { truncatedDocuments } : {}),
        documents: collected,
      };
      return {
        content: JSON.stringify(payload),
        details: { roomId, count: rows.length, isRecord: isRecord(payload) },
      };
    },
  };

  return [memorySearch, conversationSearch, roomContextGet];
}
