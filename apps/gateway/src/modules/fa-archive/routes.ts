/**
 * FA 机构档案 + 已核事实 REST（fa-industry-iteration 第一批）。
 *
 * 机构档案：/v1/fa/institutions/:roomId/{funds,investments,positions}
 * 已核事实：/v1/fa/rooms/:roomId/verified-facts（grade=fact 且已确认，或按
 * grade 过滤的全量分级视图）——BP 材料与尽调问答的取数入口。
 */
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { GatewayDatabase } from "../../infrastructure/database/client.js";
import { roomEntityFacts } from "../../infrastructure/database/schema.js";
import { FaArchiveService, FaArchiveError } from "./service.js";
import { FaFeedbackService, FaFeedbackError, FA_PASS_REASONS } from "./feedback.js";
import { buildMeetingBrief } from "./brief.js";
import { screenInstitutions } from "./matching.js";

const iso = (value: Date | number | null): string | null =>
  value === null ? null : (value instanceof Date ? value : new Date(value)).toISOString();

const RoomIdParams = Type.Object({ roomId: Type.String({ minLength: 1, maxLength: 128 }) });
const IdParams = Type.Object({ id: Type.String({ minLength: 1, maxLength: 128 }) });

const FundDto = Type.Object({
  id: Type.String(),
  institutionRoomId: Type.String(),
  name: Type.String(),
  sequence: Type.Union([Type.String(), Type.Null()]),
  currency: Type.Union([Type.String(), Type.Null()]),
  vintageYear: Type.Union([Type.Number(), Type.Null()]),
  targetSize: Type.Union([Type.Number(), Type.Null()]),
  sizeUnit: Type.Union([Type.String(), Type.Null()]),
  investmentPeriodEnd: Type.Union([Type.Number(), Type.Null()]),
  constraints: Type.Union([Type.Array(Type.String()), Type.Null()]),
  status: Type.String(),
  confirmedBy: Type.Union([Type.String(), Type.Null()]),
  confirmedAt: Type.Union([Type.String(), Type.Null()]),
  note: Type.Union([Type.String(), Type.Null()]),
});

const InvestmentDto = Type.Object({
  id: Type.String(),
  institutionRoomId: Type.String(),
  fundId: Type.Union([Type.String(), Type.Null()]),
  portfolioCompany: Type.String(),
  projectRoomId: Type.Union([Type.String(), Type.Null()]),
  round: Type.Union([Type.String(), Type.Null()]),
  investedOn: Type.Union([Type.String(), Type.Null()]),
  role: Type.String(),
  ticketSize: Type.Union([Type.Number(), Type.Null()]),
  ticketCurrency: Type.Union([Type.String(), Type.Null()]),
  relationToPortfolio: Type.String(),
  sourceUrl: Type.Union([Type.String(), Type.Null()]),
  confirmedBy: Type.Union([Type.String(), Type.Null()]),
  confirmedAt: Type.Union([Type.String(), Type.Null()]),
  note: Type.Union([Type.String(), Type.Null()]),
});

const PositionDto = Type.Object({
  id: Type.String(),
  personRoomId: Type.String(),
  institutionRoomId: Type.String(),
  title: Type.Union([Type.String(), Type.Null()]),
  fromYear: Type.Union([Type.Number(), Type.Null()]),
  toYear: Type.Union([Type.Number(), Type.Null()]),
  icMember: Type.Union([Type.Boolean(), Type.Null()]),
  canLead: Type.Union([Type.Boolean(), Type.Null()]),
  sectors: Type.Union([Type.Array(Type.String()), Type.Null()]),
  confirmedBy: Type.Union([Type.String(), Type.Null()]),
  confirmedAt: Type.Union([Type.String(), Type.Null()]),
  note: Type.Union([Type.String(), Type.Null()]),
});

const VerifiedFactDto = Type.Object({
  id: Type.String(),
  factId: Type.String(),
  content: Type.String(),
  type: Type.String(),
  grade: Type.String(),
  numeric: Type.Unknown(),
  entityIds: Type.Union([Type.Array(Type.String()), Type.Null()]),
  sourceKind: Type.String(),
  sourceId: Type.String(),
  createdAt: Type.Union([Type.String(), Type.Null()]),
});

const FundInputSchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 200 }),
  sequence: Type.Optional(Type.String({ maxLength: 40 })),
  currency: Type.Optional(Type.String({ maxLength: 8 })),
  vintageYear: Type.Optional(Type.Integer({ minimum: 1990, maximum: 2100 })),
  targetSize: Type.Optional(Type.Number({ minimum: 0 })),
  sizeUnit: Type.Optional(Type.String({ maxLength: 16 })),
  investmentPeriodEnd: Type.Optional(Type.Integer({ minimum: 1990, maximum: 2100 })),
  constraints: Type.Optional(Type.Array(Type.String({ maxLength: 300 }), { maxItems: 20 })),
  status: Type.Optional(Type.Union([Type.Literal("active"), Type.Literal("inactive"), Type.Literal("unknown")])),
  sourceKind: Type.Optional(Type.String({ maxLength: 40 })),
  sourceId: Type.Optional(Type.String({ maxLength: 128 })),
  note: Type.Optional(Type.String({ maxLength: 2000 })),
});

const InvestmentInputSchema = Type.Object({
  fundId: Type.Optional(Type.String({ maxLength: 128 })),
  portfolioCompany: Type.String({ minLength: 1, maxLength: 200 }),
  projectRoomId: Type.Optional(Type.String({ maxLength: 128 })),
  round: Type.Optional(Type.String({ maxLength: 40 })),
  investedOn: Type.Optional(Type.String({ maxLength: 10 })),
  role: Type.Optional(Type.Union([Type.Literal("lead"), Type.Literal("follow"), Type.Literal("unknown")])),
  ticketSize: Type.Optional(Type.Number({ minimum: 0 })),
  ticketCurrency: Type.Optional(Type.String({ maxLength: 8 })),
  relationToPortfolio: Type.Optional(Type.Union([
    Type.Literal("synergy"), Type.Literal("conflict"), Type.Literal("neutral"), Type.Literal("unknown"),
  ])),
  sourceKind: Type.Optional(Type.String({ maxLength: 40 })),
  sourceId: Type.Optional(Type.String({ maxLength: 128 })),
  sourceUrl: Type.Optional(Type.String({ maxLength: 1000 })),
  note: Type.Optional(Type.String({ maxLength: 2000 })),
});

const PositionInputSchema = Type.Object({
  personRoomId: Type.Optional(Type.String({ maxLength: 128 })),
  institutionRoomId: Type.Optional(Type.String({ maxLength: 128 })),
  title: Type.Optional(Type.String({ maxLength: 120 })),
  fromYear: Type.Optional(Type.Integer({ minimum: 1950, maximum: 2100 })),
  toYear: Type.Optional(Type.Integer({ minimum: 1950, maximum: 2100 })),
  icMember: Type.Optional(Type.Boolean()),
  canLead: Type.Optional(Type.Boolean()),
  sectors: Type.Optional(Type.Array(Type.String({ maxLength: 60 }), { maxItems: 12 })),
  sourceKind: Type.Optional(Type.String({ maxLength: 40 })),
  sourceId: Type.Optional(Type.String({ maxLength: 128 })),
  note: Type.Optional(Type.String({ maxLength: 2000 })),
});

const ConfirmBody = Type.Object({ confirmedBy: Type.String({ minLength: 1, maxLength: 120 }) });

/** FaArchiveError → HTTP 状态映射：*_not_found → 404，其余（kind 不匹配等）→ 422。 */
// biome-ignore lint/suspicious/noExplicitAny: fastify reply 泛型随路由签名变化，错误路径只用到 code/send。
function faErrorReply(reply: any, error: unknown): void {
  if (error instanceof FaArchiveError) {
    const reason = error.message.split(":")[0] ?? "";
    const notFound = reason.endsWith("_not_found");
    reply.code(notFound ? 404 : 422).send({ error: error.message });
    return;
  }
  throw error;
}

export function faArchiveRoutes(db: GatewayDatabase): FastifyPluginAsyncTypebox {
  const service = new FaArchiveService(db);
  const feedback = new FaFeedbackService(db);
  return async function routes(app) {
    // 错误映射 helper 也覆盖 FaFeedbackError
    const errorReply = (reply: unknown, error: unknown): void => {
      if (error instanceof FaArchiveError || error instanceof FaFeedbackError) {
        const reason = error.message.split(":")[0] ?? "";
        const notFound = reason.endsWith("_not_found");
        // biome-ignore lint/suspicious/noExplicitAny: reply 泛型随路由变化
        (reply as any).code(notFound ? 404 : 422).send({ error: error.message });
        return;
      }
      throw error;
    };
    // ── 基金 ──
    app.get("/v1/fa/institutions/:roomId/funds", {
      schema: { tags: ["fa"], params: RoomIdParams, response: { 200: Type.Object({ items: Type.Array(FundDto) }) } },
    }, async (request) => ({
      items: service.listFunds(request.params.roomId).map((f) => ({
        ...f, confirmedAt: iso(f.confirmedAt),
      })),
    }));

    app.post("/v1/fa/institutions/:roomId/funds", {
      schema: { tags: ["fa"], params: RoomIdParams, body: FundInputSchema, response: { 201: FundDto } },
    }, async (request, reply) => {
      try {
        const fund = service.upsertFund({
          institutionRoomId: request.params.roomId,
          ...request.body,
        });
        return reply.status(201).send({ ...fund, confirmedAt: iso(fund.confirmedAt) });
      } catch (error) {
        return faErrorReply(reply, error);
      }
    });

    app.post("/v1/fa/funds/:id/confirm", {
      schema: { tags: ["fa"], params: IdParams, body: ConfirmBody, response: { 200: FundDto } },
    }, async (request, reply) => {
      try {
        const fund = service.confirmFund(request.params.id, request.body.confirmedBy);
        return reply.status(200).send({ ...fund, confirmedAt: iso(fund.confirmedAt) });
      } catch (error) {
        return faErrorReply(reply, error);
      }
    });

    app.delete("/v1/fa/funds/:id", {
      schema: { tags: ["fa"], params: IdParams, response: { 204: Type.Null() } },
    }, async (request, reply) => {
      try {
        service.deleteFund(request.params.id);
        return reply.status(204).send(null);
      } catch (error) {
        return faErrorReply(reply, error);
      }
    });

    // ── 投资记录 ──
    app.get("/v1/fa/institutions/:roomId/investments", {
      schema: { tags: ["fa"], params: RoomIdParams, response: { 200: Type.Object({ items: Type.Array(InvestmentDto) }) } },
    }, async (request) => ({
      items: service.listInvestments(request.params.roomId).map((i) => ({
        ...i, confirmedAt: iso(i.confirmedAt),
      })),
    }));

    app.post("/v1/fa/institutions/:roomId/investments", {
      schema: { tags: ["fa"], params: RoomIdParams, body: InvestmentInputSchema, response: { 201: InvestmentDto } },
    }, async (request, reply) => {
      try {
        const investment = service.upsertInvestment({
          institutionRoomId: request.params.roomId,
          ...request.body,
        });
        return reply.status(201).send({ ...investment, confirmedAt: iso(investment.confirmedAt) });
      } catch (error) {
        return faErrorReply(reply, error);
      }
    });

    app.post("/v1/fa/investments/:id/confirm", {
      schema: { tags: ["fa"], params: IdParams, body: ConfirmBody, response: { 200: InvestmentDto } },
    }, async (request, reply) => {
      try {
        const investment = service.confirmInvestment(request.params.id, request.body.confirmedBy);
        return reply.status(200).send({ ...investment, confirmedAt: iso(investment.confirmedAt) });
      } catch (error) {
        return faErrorReply(reply, error);
      }
    });

    app.delete("/v1/fa/investments/:id", {
      schema: { tags: ["fa"], params: IdParams, response: { 204: Type.Null() } },
    }, async (request, reply) => {
      try {
        service.deleteInvestment(request.params.id);
        return reply.status(204).send(null);
      } catch (error) {
        return faErrorReply(reply, error);
      }
    });

    // ── 任职 ──
    app.get("/v1/fa/institutions/:roomId/positions", {
      schema: { tags: ["fa"], params: RoomIdParams, response: { 200: Type.Object({ items: Type.Array(PositionDto) }) } },
    }, async (request) => ({
      items: service.listPositionsByInstitution(request.params.roomId).map((p) => ({
        ...p, confirmedAt: iso(p.confirmedAt),
      })),
    }));

    app.get("/v1/fa/persons/:roomId/positions", {
      schema: { tags: ["fa"], params: RoomIdParams, response: { 200: Type.Object({ items: Type.Array(PositionDto) }) } },
    }, async (request) => ({
      items: service.listPositionsByPerson(request.params.roomId).map((p) => ({
        ...p, confirmedAt: iso(p.confirmedAt),
      })),
    }));

    app.post("/v1/fa/positions", {
      schema: { tags: ["fa"], body: Type.Intersect([
        Type.Object({
          personRoomId: Type.String({ minLength: 1, maxLength: 128 }),
          institutionRoomId: Type.String({ minLength: 1, maxLength: 128 }),
        }),
        PositionInputSchema,
      ]), response: { 201: PositionDto } },
    }, async (request, reply) => {
      try {
        const position = service.upsertPosition(request.body as never);
        return reply.status(201).send({ ...position, confirmedAt: iso(position.confirmedAt) });
      } catch (error) {
        return faErrorReply(reply, error);
      }
    });

    app.post("/v1/fa/positions/:id/confirm", {
      schema: { tags: ["fa"], params: IdParams, body: ConfirmBody, response: { 200: PositionDto } },
    }, async (request, reply) => {
      try {
        const position = service.confirmPosition(request.params.id, request.body.confirmedBy);
        return reply.status(200).send({ ...position, confirmedAt: iso(position.confirmedAt) });
      } catch (error) {
        return faErrorReply(reply, error);
      }
    });

    app.delete("/v1/fa/positions/:id", {
      schema: { tags: ["fa"], params: IdParams, response: { 204: Type.Null() } },
    }, async (request, reply) => {
      try {
        service.deletePosition(request.params.id);
        return reply.status(204).send(null);
      } catch (error) {
        return faErrorReply(reply, error);
      }
    });

    // ── 投资人匹配（fa-industry-iteration 工作项五）：硬筛 + 适配排序 ──
    app.post("/v1/fa/match", {
      schema: {
        tags: ["fa"],
        body: Type.Object({
          projectRoomId: Type.String({ minLength: 1, maxLength: 128 }),
          round: Type.Optional(Type.String({ maxLength: 40 })),
          askAmount: Type.Optional(Type.Number({ minimum: 0 })),
          askCurrency: Type.Optional(Type.String({ maxLength: 8 })),
          sectors: Type.Optional(Type.Array(Type.String({ maxLength: 60 }), { maxItems: 8 })),
          comparableCompanies: Type.Optional(Type.Array(Type.String({ maxLength: 200 }), { maxItems: 20 })),
          includeRejectedWithUnmetConditions: Type.Optional(Type.Boolean()),
        }),
        response: { 200: Type.Object({ items: Type.Array(Type.Unknown()) }) },
      },
    }, async (request) => ({
      items: screenInstitutions(db, request.body as never),
    }));

    // ── 会前简报（fa-industry-iteration 工作项四）：聚合机构档案/人物信号/历史反馈/已核事实 ──
    app.get("/v1/fa/meeting-brief", {
      schema: {
        tags: ["fa"],
        querystring: Type.Object({
          projectRoomId: Type.String({ minLength: 1, maxLength: 128 }),
          institutionRoomId: Type.String({ minLength: 1, maxLength: 128 }),
          personRoomId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
        }),
        response: { 200: Type.Unknown() },
      },
    }, async (request) => buildMeetingBrief(db, request.query as never));

    // ── 会后反馈闭环（fa-industry-iteration 工作项三）──
    app.get("/v1/fa/feedbacks", {
      schema: {
        tags: ["fa"],
        querystring: Type.Object({
          roomId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
          status: Type.Optional(Type.Union([Type.Literal("draft"), Type.Literal("confirmed"), Type.Literal("dismissed")])),
        }),
        response: { 200: Type.Object({ items: Type.Array(Type.Unknown()) }),
        },
      },
    }, async (request) => ({
      items: feedback.list(
        (request.query as { roomId?: string }).roomId,
        (request.query as { status?: "draft" | "confirmed" | "dismissed" }).status,
      ),
    }));

    app.post("/v1/fa/feedbacks", {
      schema: {
        tags: ["fa"],
        body: Type.Object({
          roomId: Type.String({ minLength: 1, maxLength: 128 }),
          sourceKind: Type.Optional(Type.String({ maxLength: 40 })),
          sourceId: Type.Optional(Type.String({ maxLength: 128 })),
          institutionRoomId: Type.Optional(Type.String({ maxLength: 128 })),
          personRoomId: Type.Optional(Type.String({ maxLength: 128 })),
          meetingAt: Type.Optional(Type.String({ maxLength: 20 })),
          disposition: Type.Union([
            Type.Literal("strong_interest"), Type.Literal("interest"),
            Type.Literal("watch"), Type.Literal("pass"), Type.Literal("unknown"),
          ]),
          passReasons: Type.Optional(Type.Array(Type.Union(FA_PASS_REASONS.map((r) => Type.Literal(r))), { maxItems: 5 })),
          reopenConditions: Type.Optional(Type.String({ maxLength: 1000 })),
          projectUpdates: Type.Optional(Type.String({ maxLength: 4000 })),
          personSignals: Type.Optional(Type.String({ maxLength: 4000 })),
          institutionSignals: Type.Optional(Type.String({ maxLength: 4000 })),
          meetingNotes: Type.Optional(Type.String({ maxLength: 8000 })),
        }),
        response: { 201: Type.Unknown() },
      },
    }, async (request, reply) => {
      try {
        const row = feedback.createDraft(request.body as never);
        return reply.status(201).send(row);
      } catch (error) {
        errorReply(reply, error);
      }
    });

    app.post("/v1/fa/feedbacks/:id/confirm", {
      schema: {
        tags: ["fa"],
        params: IdParams,
        body: Type.Object({
          confirmedBy: Type.String({ minLength: 1, maxLength: 120 }),
          edits: Type.Optional(Type.Object({
            projectUpdates: Type.Optional(Type.String({ maxLength: 4000 })),
            personSignals: Type.Optional(Type.String({ maxLength: 4000 })),
            institutionSignals: Type.Optional(Type.String({ maxLength: 4000 })),
            reopenConditions: Type.Optional(Type.String({ maxLength: 1000 })),
            followUpTitle: Type.Optional(Type.String({ maxLength: 200 })),
            followUpDueAt: Type.Optional(Type.String({ maxLength: 30 })),
          })),
          applyScopes: Type.Optional(Type.Array(Type.Union([
            Type.Literal("project"), Type.Literal("person"), Type.Literal("institution"),
          ]), { maxItems: 3 })),
          createFollowUpTask: Type.Optional(Type.Boolean()),
        }),
        response: { 200: Type.Unknown() },
      },
    }, async (request, reply) => {
      try {
        const row = feedback.confirm(request.params.id, request.body.confirmedBy, {
          ...(request.body.edits ? { edits: request.body.edits } : {}),
          ...(request.body.applyScopes ? { applyScopes: request.body.applyScopes as never } : {}),
          ...(request.body.createFollowUpTask !== undefined ? { createFollowUpTask: request.body.createFollowUpTask } : {}),
        });
        return reply.status(200).send(row);
      } catch (error) {
        errorReply(reply, error);
      }
    });

    app.post("/v1/fa/feedbacks/:id/dismiss", {
      schema: { tags: ["fa"], params: IdParams, response: { 200: Type.Unknown() } },
    }, async (request, reply) => {
      try {
        return reply.status(200).send(feedback.dismiss(request.params.id));
      } catch (error) {
        errorReply(reply, error);
      }
    });

    // ── 已核事实（BP 取数入口）──
    app.get("/v1/fa/rooms/:roomId/verified-facts", {
      schema: {
        tags: ["fa"],
        params: RoomIdParams,
        querystring: Type.Object({
          grade: Type.Optional(Type.Union([
            Type.Literal("fact"), Type.Literal("analysis"), Type.Literal("forecast"),
            Type.Literal("opinion"), Type.Literal("unknown"),
          ])),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
        }),
        response: { 200: Type.Object({ items: Type.Array(VerifiedFactDto) }) },
      },
    }, async (request) => {
      const { grade, limit } = request.query as { grade?: string; limit?: number };
      const rows = db
        .select()
        .from(roomEntityFacts)
        .where(and(
          eq(roomEntityFacts.roomId, request.params.roomId),
          // 缺省只出已核事实（grade=fact）；显式传 grade 时出该档全量。
          eq(roomEntityFacts.grade, (grade ?? "fact") as "fact" | "analysis" | "forecast" | "opinion" | "unknown"),
        ))
        .orderBy(desc(roomEntityFacts.createdAt))
        .limit(Math.min(limit ?? 100, 500))
        .all();
      return {
        items: rows.map((r) => ({
          id: r.id,
          factId: r.factId,
          content: r.content,
          type: r.type,
          grade: r.grade,
          numeric: r.numeric ?? null,
          entityIds: r.entityIds ?? null,
          sourceKind: r.sourceKind,
          sourceId: r.sourceId,
          createdAt: iso(r.createdAt),
        })),
      };
    });
  };
}
