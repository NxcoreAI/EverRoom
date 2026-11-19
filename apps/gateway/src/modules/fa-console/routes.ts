/**
 * FA 全阶段分析控制台（fa-analysis-console）网关侧。
 *
 * 只做两件事，不新造业务逻辑：
 * 1. 节点注册表（GET /v1/fa-console/nodes）：把 FA 全流程每个工作节点映射到
 *    真实输入来源（数据表/接口）、真实执行通道（现有 REST 或 agent run）与
 *    真实产出。控制台页面按注册表直连执行，网关不代执行、不造模拟数据。
 * 2. 模板纯读（POST /v1/fa-console/bp-template）：bp_template_get 此前只暴露
 *    给主 Agent 工具链，这里用同一渲染函数出 REST，控制台"模板选型→模块
 *    骨架"节点直接拿到与 Agent 完全相同的真实模板产物。
 *
 * 提示词节点（DD 清单、BP 直生等）走既有 POST /v1/agent/sessions/:id/runs，
 * 工具调用/解析链路从 agent-debug trace（run events）读取，同样真实。
 */
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import { and, eq, isNull } from "drizzle-orm";
import type { GatewayDatabase } from "../../infrastructure/database/client.js";
import { roomEntityFacts, rooms } from "../../infrastructure/database/schema.js";
import {
  BP_ADDONS,
  BP_TRACKS,
  BP_X01_MODULES,
} from "../bp-template/data.js";
import { BP_NARRATIVE_ORDER_COUNT } from "../bp-template/selection.js";
// renderTrackBrief 定义在 tool.ts（与 bp_template_get 工具共用同一实现）；
// 其对 agent-runtime-pi 的引用是 type-only，运行时引入无副作用。
import { renderTrackBrief } from "../bp-template/tool.js";

type FaConsoleMethod = "GET" | "POST";

export interface FaConsoleNodeIo {
  /** 输入/产出的名字（数据表、接口、工具产物）。 */
  label: string;
  /** 真实来源或内容的说明（表名/接口路径/工具名，不给示意数据）。 */
  detail: string;
}

export interface FaConsoleNodeExecute {
  method: FaConsoleMethod;
  /** 控制台直接调用的路径（含路径参数占位说明）。 */
  path: string;
  /** POST 节点的示例请求体（真实 schema 的样例值）。 */
  sampleBody?: Record<string, unknown>;
  /** 该节点输入由哪条查询先取数（GET 路径，用于输入区自动预填）。 */
  inputQuery?: string;
  /** 枚举参数的下拉选项（如赛道 T01-T18）。 */
  paramOptions?: Record<string, Array<{ value: string; label: string }>>;
}

export interface FaConsoleNode {
  id: string;
  /** 流水线站点（对齐 FA 全流程八站）。 */
  stage: "intake" | "verification" | "archive" | "materials" | "matching" | "meeting" | "feedback" | "loopback";
  name: string;
  /** data = 纯数据节点；prompt = 经主 Agent run 执行；template = 纯读模板渲染。 */
  kind: "data" | "prompt" | "template";
  description: string;
  inputs: FaConsoleNodeIo[];
  outputs: FaConsoleNodeIo[];
  /** 涉及的真实工具/接口名（与 agent-debug trace、SYSTEM.md 口径一致）。 */
  tools: string[];
  /** 控制台可直接执行的通道；prompt 节点经 agent run 通道。 */
  execute: FaConsoleNodeExecute | null;
}

/** 房间列表项（控制台输入区选择器用）。 */
export interface FaConsoleRoom {
  id: string;
  title: string;
  kind: string;
}

const NODES: FaConsoleNode[] = [
  {
    id: "intake",
    stage: "intake",
    name: "资料进入 Room",
    kind: "data",
    description: "材料进入项目/人物/机构 Room；实体抽取与关系解析是 knowledge 模块的真实产物，不是示意。",
    inputs: [
      { label: "rooms 表", detail: "项目/人物/机构 Room（origin=user/auto）" },
      { label: "room_entity_facts 表", detail: "按 Room 聚合的事实/关系行（source_kind 十类来源）" },
    ],
    outputs: [
      { label: "Room 清单", detail: "GET /v1/fa-console/rooms" },
      { label: "Room 事实流", detail: "GET /v1/fa-console/rooms/:roomId/facts?grade=" },
    ],
    tools: ["entity-extraction（抽取 Skill）", "实体晋升（knowledge 模块）"],
    execute: { method: "GET", path: "/v1/fa-console/rooms/:roomId/facts", inputQuery: "/v1/fa-console/rooms" },
  },
  {
    id: "verification",
    stage: "verification",
    name: "核实事实（五档分级）",
    kind: "data",
    description: "事实五档（fact/analysis/forecast/opinion/unknown）+ 数字元数据；BP 与尽调取数只认 fact。",
    inputs: [
      { label: "room_entity_facts 表", detail: "grade 五档 + numeric（value/unit/period/currency/audited）" },
    ],
    outputs: [
      { label: "已核事实", detail: "GET /v1/fa/rooms/:roomId/verified-facts（缺省 grade=fact）" },
    ],
    tools: ["entity-extraction 五档标注", "/v1/fa/rooms/:roomId/verified-facts"],
    execute: { method: "GET", path: "/v1/fa/rooms/:roomId/verified-facts", inputQuery: "/v1/fa-console/rooms" },
  },
  {
    id: "archive",
    stage: "archive",
    name: "机构档案（三表 + 确认制）",
    kind: "data",
    description: "fa_funds / fa_investments / fa_positions 结构化档案；投资事件不可变，修正走删除重录。",
    inputs: [
      { label: "机构 Room", detail: "rooms.kind=机构" },
      { label: "三表", detail: "fa_funds / fa_investments / fa_positions（confirmed_at 确认制）" },
    ],
    outputs: [
      { label: "基金档案", detail: "GET /v1/fa/institutions/:roomId/funds" },
      { label: "投资记录", detail: "GET /v1/fa/institutions/:roomId/investments" },
      { label: "关键任职", detail: "GET /v1/fa/institutions/:roomId/positions" },
    ],
    tools: ["/v1/fa/institutions/:roomId/{funds,investments,positions}"],
    execute: { method: "GET", path: "/v1/fa/institutions/:roomId/funds", inputQuery: "/v1/fa-console/rooms?kind=机构" },
  },
  {
    id: "bp-template",
    stage: "materials",
    name: "DD/BP 模板选型 → 模块骨架",
    kind: "template",
    description: "与主 Agent bp_template_get 工具同一渲染：T01-T18 赛道 × early/growth/mature 阶段 → 13 模块骨架（应填内容/证据图表/检查重点）。",
    inputs: [
      { label: "赛道模板配置库", detail: "BP_TRACKS/BP_MODULES/BP_STAGE_TUNINGS（bp-template 配置数据）" },
      { label: "选型参数", detail: "trackId、stage、narrativeOrderIndex?、includeX01?、addonIds?" },
    ],
    outputs: [
      { label: "模块骨架 brief", detail: "POST /v1/fa-console/bp-template（与 bp_template_get 返回一致）" },
    ],
    tools: ["bp_template_get（同一渲染函数）"],
    execute: {
      method: "POST",
      path: "/v1/fa-console/bp-template",
      sampleBody: { trackId: "T01", stage: "early" },
      paramOptions: {
        trackId: BP_TRACKS.map((t) => ({ value: t.id, label: `${t.id} ${t.name}` })),
        stage: [
          { value: "early", label: "early · 早期与非共识" },
          { value: "growth", label: "growth · 增长与规模复制" },
          { value: "mature", label: "mature · 成熟经营与较后期" },
        ],
        narrativeOrderIndex: [
          { value: "0", label: "0 · 需求尚未形成共识" },
          { value: "1", label: "1 · 产品与数据已验证" },
          { value: "2", label: "2 · 技术与工程验证驱动" },
          { value: "3", label: "3 · 服务或资产交付驱动" },
        ],
        addonIds: BP_ADDONS.map((a) => ({ value: a.id, label: a.name })),
      },
    },
  },
  {
    id: "dd-list",
    stage: "materials",
    name: "DD 清单生成（提示词节点）",
    kind: "prompt",
    description: "以项目 Room 已核事实为底稿，经主 Agent run 生成尽调清单；提示词、工具调用、解析过程从 run trace 实时可见。",
    inputs: [
      { label: "项目 Room 已核事实", detail: "GET /v1/fa/rooms/:roomId/verified-facts（输入区可改写提示词）" },
      { label: "提示词", detail: "你输入的 prompt（可自选输入）" },
    ],
    outputs: [
      { label: "Agent run 产物", detail: "会话消息 + run trace（工具调用/解析/耗时）" },
    ],
    tools: ["POST /v1/agent/sessions/:sessionId/runs", "agent-debug run events"],
    execute: null,
  },
  {
    id: "bp-slides",
    stage: "materials",
    name: "BP 直生（提示词节点）",
    kind: "prompt",
    description: "主 Agent 读模板骨架后写 pptxgenjs 脚本直生 PPT；模板读取与脚本产出全部在 run trace 里可查。",
    inputs: [
      { label: "模板骨架", detail: "bp_template_get（run 内工具调用）" },
      { label: "项目已核事实", detail: "GET /v1/fa/rooms/:roomId/verified-facts" },
    ],
    outputs: [
      { label: "slides 产物", detail: "会话消息 + 生成文件 + run trace" },
    ],
    tools: ["bp_template_get", "slides_create（pptxgenjs 脚本直生）"],
    execute: null,
  },
  {
    id: "matching",
    stage: "matching",
    name: "投资人匹配（硬筛 + 适配排序）",
    kind: "data",
    description: "两阶段：硬筛出局带理由、unknown 不判死；适配评分每项带依据，可比公司带认知/冲突双解释。",
    inputs: [
      { label: "机构档案三表", detail: "fa_funds / fa_investments / fa_positions" },
      { label: "项目侧条件", detail: "round/askAmount/sectors/comparableCompanies（可自选输入）" },
    ],
    outputs: [
      { label: "候选名单", detail: "POST /v1/fa/match（passed/fitScore/scoreBreakdown/portfolioNotes）" },
    ],
    tools: ["screenInstitutions（matching.ts）"],
    execute: {
      method: "POST",
      path: "/v1/fa/match",
      sampleBody: { projectRoomId: "<项目 Room id>", round: "A", comparableCompanies: [] },
    },
  },
  {
    id: "meeting-brief",
    stage: "meeting",
    name: "会前简报",
    kind: "data",
    description: "聚合基金投资期/任职（投委会、可领投）/投资案例冲突/历史反馈/重启条件/项目已核事实。",
    inputs: [
      { label: "项目 Room", detail: "projectRoomId" },
      { label: "机构 Room", detail: "institutionRoomId（人物 Room 可选）" },
    ],
    outputs: [
      { label: "会前 Brief", detail: "GET /v1/fa/meeting-brief（buildMeetingBrief 聚合）" },
    ],
    tools: ["buildMeetingBrief（brief.ts）"],
    execute: { method: "GET", path: "/v1/fa/meeting-brief", inputQuery: "/v1/fa-console/rooms" },
  },
  {
    id: "feedback",
    stage: "feedback",
    name: "会后反馈（四分类 + 原因码）",
    kind: "data",
    description: "disposition 四分类/十项标准原因码/重启条件；确认制回写三路信号。",
    inputs: [
      { label: "fa_meeting_feedbacks 表", detail: "draft → confirmed/dismissed 全量（可按 status 过滤）" },
    ],
    outputs: [
      { label: "反馈清单", detail: "GET /v1/fa/feedbacks?roomId=&status=" },
    ],
    tools: ["FaFeedbackService（feedback.ts）", "/v1/fa/feedbacks CRUD + confirm/dismiss"],
    execute: { method: "GET", path: "/v1/fa/feedbacks", inputQuery: "/v1/fa-console/rooms" },
  },
  {
    id: "loopback",
    stage: "loopback",
    name: "知识回流（三路信号各回各房）",
    kind: "data",
    description: "确认后的反馈信号回写：项目进展挂项目房、个人观点挂人物房、机构姿态挂机构房，均落 room_entity_facts。",
    inputs: [
      { label: "已确认反馈", detail: "GET /v1/fa/feedbacks?status=confirmed" },
    ],
    outputs: [
      { label: "Room 事实流", detail: "GET /v1/fa-console/rooms/:roomId/facts（回流信号事实）" },
    ],
    tools: ["FaFeedbackService.confirm（applyScopes 三路回写）"],
    execute: { method: "GET", path: "/v1/fa-console/rooms/:roomId/facts", inputQuery: "/v1/fa-console/rooms" },
  },
];

const BpTemplateBody = Type.Object({
  trackId: Type.String({ minLength: 2, maxLength: 4 }),
  stage: Type.Union([Type.Literal("early"), Type.Literal("growth"), Type.Literal("mature")]),
  narrativeOrderIndex: Type.Optional(Type.Integer({ minimum: 0, maximum: BP_NARRATIVE_ORDER_COUNT - 1 })),
  includeX01: Type.Optional(Type.Boolean()),
  addonIds: Type.Optional(Type.Array(Type.String({ maxLength: 40 }), { maxItems: BP_ADDONS.length })),
});

const RoomIdParams = Type.Object({ roomId: Type.String({ minLength: 1, maxLength: 128 }) });

/** bp_template_get 同源校验：非法 trackId/addon 统一 422，错误码与工具链一致。 */
function bpTemplateErrorReply(code: string): { ok: false; error: string } {
  return { ok: false, error: code };
}

export function faConsoleRoutes(db: GatewayDatabase): FastifyPluginAsyncTypebox {
  return async function routes(app) {
    // ── 节点注册表 ──
    app.get("/v1/fa-console/nodes", {
      schema: { tags: ["fa"], response: { 200: Type.Object({ nodes: Type.Array(Type.Unknown()) }) } },
    }, async () => ({ nodes: NODES }));

    // ── Room 选择器数据（控制台输入区预填）──
    app.get("/v1/fa-console/rooms", {
      schema: {
        tags: ["fa"],
        querystring: Type.Object({ kind: Type.Optional(Type.String({ maxLength: 20 })) }),
        response: { 200: Type.Object({ items: Type.Array(Type.Object({
          id: Type.String(),
          title: Type.String(),
          kind: Type.String(),
        })) }) },
      },
    }, async (request) => {
      const kind = (request.query as { kind?: string }).kind;
      const rows = db.select({
        id: rooms.id, title: rooms.title, kind: rooms.kind,
      }).from(rooms)
        .where(kind ? and(isNull(rooms.deletedAt), eq(rooms.kind, kind)) : isNull(rooms.deletedAt))
        .orderBy(rooms.title)
        .limit(500)
        .all();
      return { items: rows };
    });

    // ── bp-template 纯读渲染（与 bp_template_get 工具同一数据与校验）──
    app.post("/v1/fa-console/bp-template", {
      schema: {
        tags: ["fa"],
        body: BpTemplateBody,
      },
    }, async (request, reply) => {
      const body = request.body as {
        trackId: string;
        stage: "early" | "growth" | "mature";
        narrativeOrderIndex?: number;
        includeX01?: boolean;
        addonIds?: string[];
      };
      const trackId = body.trackId.trim();
      const addonIds = body.addonIds ?? [];
      const knownAddons = new Set(BP_ADDONS.map((a) => a.id));
      const unknown = addonIds.filter((id) => !knownAddons.has(id));
      if (unknown.length > 0) {
        return reply.code(422).send(bpTemplateErrorReply("BP_TEMPLATE_UNKNOWN_ADDON"));
      }
      try {
        const sections: string[] = [renderTrackBrief(trackId as never, body.stage, body.narrativeOrderIndex)];
        if (body.includeX01 === true) {
          sections.push("【X01 资产运营扩展（叠加）】\n" + BP_X01_MODULES
            .map((x) => `- ${x.id}：${x.required}（证据与图表：${x.evidenceHints.join("、")}）`).join("\n"));
        }
        for (const id of addonIds) {
          const addon = BP_ADDONS.find((a) => a.id === id)!;
          sections.push(`【专项叠加：${addon.name}】${addon.requirements}`);
        }
        sections.push("【硬约束】事实、分析与假设分开表述；关键数字带来源、口径与日期；优先指标优先呈现；常见错误所列表述不得出现。");
        return reply.status(200).send({
          ok: true,
          trackId,
          stage: body.stage,
          moduleCount: 13,
          brief: sections.join("\n\n"),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // 错误码保留完整格式（含参数，如 BP_TEMPLATE_UNKNOWN_TRACK:T99），与工具链一致。
        return reply.code(message.startsWith("BP_TEMPLATE_") ? 422 : 500).send(bpTemplateErrorReply(message));
      }
    });

    // ── Room 事实流（节点输入区取真实底稿；比 verified-facts 多出全部五档与来源）──
    app.get("/v1/fa-console/rooms/:roomId/facts", {
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
        response: { 200: Type.Unknown() },
      },
    }, async (request) => {
      const { grade, limit } = request.query as { grade?: string; limit?: number };
      // 与 fa-archive verified-facts 相同的五档收窄：非法值由 typebox enum 挡下。
      const gradeKey = grade as "fact" | "analysis" | "forecast" | "opinion" | "unknown" | undefined;
      const rows = db.select().from(roomEntityFacts)
        .where(gradeKey
          ? and(eq(roomEntityFacts.roomId, request.params.roomId), eq(roomEntityFacts.grade, gradeKey))
          : eq(roomEntityFacts.roomId, request.params.roomId))
        .limit(Math.min(limit ?? 200, 500))
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
          createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : null,
        })),
      };
    });
  };
}
