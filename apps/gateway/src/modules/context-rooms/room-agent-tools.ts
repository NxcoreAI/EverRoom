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
  roomLocalActions,
  roomSourceMemberships,
} from "../../infrastructure/database/schema.js";
import type { MemoryService } from "../memory/service.js";
import type { RoomOverviewService } from "./overview-service.js";
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
 * 注册给 context-room 子 Agent 的网关工具（SubagentRuntimeManager.registerAgentTools）。
 *
 * dispatch 子 Agent 的 Pi 配置由 SubagentRuntimeManager 从 backgroundPi 剥除
 * memory/knowledge/mcp 构建，因此检索能力在这里以显式工具提供：
 * - memory_search / conversation_search：复用 MemoryService（与主 Agent 记忆工具同源）。
 * - room_context_get：Room 信息、事实、来源、纠正与文档正文，供总览生成与资料分析。
 * - room_task_create / room_schedule_create：总览再生后把「有明确动作 + 时间」的
 *   nextStep 落地为本地待办/日程（不回写第三方账号；幂等不重复）。
 */
export function createContextRoomAgentTools(deps: {
  db: GatewayDatabase;
  memory: MemoryService | null;
  overview: RoomOverviewService;
}): PiAgentRuntimeTool[] {
  const { db, memory, overview } = deps;

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
        // 本地待办/日程（agent/用户创建，未删）：供落地步骤查重与避免重复建议。
        localActions: db.select({
          id: roomLocalActions.id,
          kind: roomLocalActions.kind,
          title: roomLocalActions.title,
          dueAt: roomLocalActions.dueAt,
          startedAt: roomLocalActions.startedAt,
          completedAt: roomLocalActions.completedAt,
        }).from(roomLocalActions).where(and(
          eq(roomLocalActions.roomId, roomId),
          isNull(roomLocalActions.deletedAt),
        )).all().map((action) => ({
          ...action,
          dueAt: action.dueAt?.toISOString() ?? null,
          startedAt: action.startedAt?.toISOString() ?? null,
          completedAt: action.completedAt?.toISOString() ?? null,
        })).slice(0, 100),
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

  const roomTaskCreate: PiAgentRuntimeTool = {
    name: "room_task_create",
    label: "创建 Room 本地待办",
    description: "在指定 Room 创建一条本地待办（不写入第三方账号）。总览再生后，把 nextSteps 中有明确动作的建议落地时调用；同名未完成待办已存在则不重复创建。",
    parameters: Type.Object({
      roomId: Type.String({ minLength: 1, maxLength: 128 }),
      title: Type.String({ minLength: 1, maxLength: 500 }),
      dueAt: Type.Optional(Type.Union([Type.String({ maxLength: 120 }), Type.Null()])),
      priority: Type.Optional(Type.Union([Type.String({ maxLength: 40 }), Type.Null()])),
      notes: Type.Optional(Type.Union([Type.String({ maxLength: 4_000 }), Type.Null()])),
    }, { additionalProperties: false }),
    execute: async (_run, params) => {
      try {
        const result = overview.createLocalAction(String(params.roomId), {
          kind: "task",
          title: String(params.title),
          ...(params.dueAt != null ? { dueAt: String(params.dueAt) } : {}),
          ...(params.priority != null ? { priority: String(params.priority) } : {}),
          ...(params.notes != null ? { notes: String(params.notes) } : {}),
        }, { createdBy: "agent" });
        return {
          content: result.duplicate
            ? `待办「${result.action.title}」已存在，未重复创建。`
            : `已创建本地待办「${result.action.title}」。`,
          details: { roomId: result.action.roomId, action: result.action, duplicate: result.duplicate },
        };
      } catch (error) {
        return { content: memoryToolErrorText("创建本地待办", error), details: { created: false }, isError: true };
      }
    },
  };

  const roomScheduleCreate: PiAgentRuntimeTool = {
    name: "room_schedule_create",
    label: "创建 Room 本地日程",
    description: "在指定 Room 创建一条本地日程（不写入第三方日历账号）。总览再生后，把 nextSteps 中有明确时间的事项落地时调用；startedAt 必须是可解析时间，同名日程已存在则不重复创建。",
    parameters: Type.Object({
      roomId: Type.String({ minLength: 1, maxLength: 128 }),
      title: Type.String({ minLength: 1, maxLength: 500 }),
      startedAt: Type.String({ minLength: 1, maxLength: 120 }),
      endAt: Type.Optional(Type.Union([Type.String({ maxLength: 120 }), Type.Null()])),
      allDay: Type.Optional(Type.Boolean()),
      location: Type.Optional(Type.Union([Type.String({ maxLength: 200 }), Type.Null()])),
      notes: Type.Optional(Type.Union([Type.String({ maxLength: 4_000 }), Type.Null()])),
    }, { additionalProperties: false }),
    execute: async (_run, params) => {
      try {
        const result = overview.createLocalAction(String(params.roomId), {
          kind: "schedule",
          title: String(params.title),
          startedAt: String(params.startedAt),
          ...(params.endAt != null ? { endAt: String(params.endAt) } : {}),
          ...(params.allDay === true ? { allDay: true } : {}),
          ...(params.location != null ? { location: String(params.location) } : {}),
          ...(params.notes != null ? { notes: String(params.notes) } : {}),
        }, { createdBy: "agent" });
        return {
          content: result.duplicate
            ? `日程「${result.action.title}」已存在，未重复创建。`
            : `已创建本地日程「${result.action.title}」（${result.action.startedAt ?? ""}）。`,
          details: { roomId: result.action.roomId, action: result.action, duplicate: result.duplicate },
        };
      } catch (error) {
        return { content: memoryToolErrorText("创建本地日程", error), details: { created: false }, isError: true };
      }
    },
  };

  return [memorySearch, conversationSearch, roomContextGet, roomTaskCreate, roomScheduleCreate];
}
