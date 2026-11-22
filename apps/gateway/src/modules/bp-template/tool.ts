/**
 * 主 Agent 直生路径的 BP 模板读取工具（bp_template_get）。
 *
 * PPT 生成切换为只走主 Agent 脚本直生（slides_create/pptxgenjs）后，主 Agent
 * 在写脚本前用本工具按赛道取模板：模块骨架（13 模块顺序 + 各模块应填内容/
 * 证据图表/检查重点）、赛道专项要求、优先指标、常见错误、阶段调整、专项叠加。
 * 选型由用户确认后传入；渲染纯读，无副作用。
 */
import type { PiAgentRuntimeTool } from "@nxcore/agent-runtime-pi";
import {
  BP_ADDONS,
  BP_MODULES,
  BP_NARRATIVE_ORDERS,
  BP_STAGE_TUNINGS,
  BP_TRACKS,
  BP_X01_MODULES,
  type BpModuleId,
  type BpTrackId,
} from "./data.js";
import { BP_NARRATIVE_ORDER_COUNT, buildPlannerInjection, reorderForNarrative } from "./selection.js";

const MODULE_BY_ID = new Map<BpModuleId, (typeof BP_MODULES)[number]>(BP_MODULES.map((m) => [m.id, m]));

function renderTrackBrief(trackId: BpTrackId, stage: "early" | "growth" | "mature", narrativeOrderIndex?: number): string {
  const track = BP_TRACKS.find((t) => t.id === trackId);
  if (!track) throw new Error(`BP_TEMPLATE_UNKNOWN_TRACK:${trackId}`);
  const order = narrativeOrderIndex === undefined
    ? [...track.moduleOrder]
    : reorderForNarrative(track.moduleOrder, narrativeOrderIndex);
  const lines: string[] = [];
  lines.push(`【赛道】${track.id} ${track.name}`);
  lines.push(`【适用范围】${track.intro}`);
  lines.push(`【核心判断】${track.coreQuestion}`);
  lines.push(`【优先指标】${track.metrics}`);
  lines.push(`【常见错误】${track.antiPatterns.join("；")}`);
  lines.push(`【阶段口径（${stage}）】`);
  for (const t of BP_STAGE_TUNINGS) {
    lines.push(`- ${t.dimension}：${stage === "early" ? t.early : stage === "growth" ? t.growth : t.mature}`);
  }
  if (narrativeOrderIndex !== undefined && BP_NARRATIVE_ORDERS[narrativeOrderIndex]) {
    const n = BP_NARRATIVE_ORDERS[narrativeOrderIndex];
    lines.push(`【讲述顺序】${n.evidencePattern}：${n.orderNote}`);
  }
  lines.push("【模块骨架（按此顺序逐模块成页，可相邻合并，不得增删模块）】");
  order.forEach((id, i) => {
    const m = MODULE_BY_ID.get(id)!;
    const ov = track.overrides[id];
    lines.push(`${i + 1}. ${m.title}（${id}）——${m.question}`);
    lines.push(`   应填：${ov ? ov.required : m.content}`);
    lines.push(`   证据与图表：${ov ? ov.evidenceHints.join("、") : m.evidence}`);
    lines.push(`   检查重点：${m.pitfalls}`);
  });
  return lines.join("\n");
}

export function createBpTemplatePiTool(): PiAgentRuntimeTool {
  return {
    name: "bp_template_get",
    label: "读取 BP 赛道模板",
    description: "生成融资 BP（商业计划书）PPT 前读取赛道模板：返回模块骨架（13 模块顺序与各模块应填内容/证据图表/检查重点）、赛道专项要求、优先指标、常见错误、发展阶段口径与讲述顺序调整。"
      + "参数：trackId（T01-T18，按项目主营业务选）、stage（early 早期与非共识 / growth 增长与规模复制 / mature 成熟经营与较后期，按已验证程度而非轮次）、narrativeOrderIndex 可选（0 需求尚未形成共识 / 1 产品与数据已验证 / 2 技术与工程验证驱动 / 3 服务或资产交付驱动）。"
      + "选型须用户确认后再调用；返回的模块骨架即写 pptxgenjs 脚本的逐页依据，一个模块一页（相邻可合并），不得增删模块。"
      + "资产运营类项目另传 includeX01=true 叠加资产模块；专项叠加（跨境与全球化/政府与大型机构客户/AI与数据能力/农业与生物投入品）传 addonIds。",
    parameters: {
      type: "object",
      properties: {
        trackId: { type: "string", description: "赛道模板 ID：T01-T18" },
        stage: { type: "string", enum: ["early", "growth", "mature"], description: "发展阶段档位（按已验证程度）" },
        narrativeOrderIndex: { type: "integer", minimum: 0, maximum: 3, description: "可选：讲述顺序序号" },
        includeX01: { type: "boolean", description: "可选：叠加 X01 资产运营扩展模块" },
        addonIds: { type: "array", items: { type: "string" }, maxItems: 3, description: "可选：专项叠加 ID" },
      },
      required: ["trackId", "stage"],
    },
    async execute(_run, params) {
      const trackId = String(params.trackId ?? "").trim() as BpTrackId;
      const stage = params.stage === "early" || params.stage === "growth" || params.stage === "mature"
        ? params.stage
        : null;
      if (!stage) {
        return { content: JSON.stringify({ ok: false, error: "BP_TEMPLATE_INVALID_STAGE", stage: String(params.stage ?? "") }) };
      }
      const narrativeOrderIndex = typeof params.narrativeOrderIndex === "number" ? params.narrativeOrderIndex : undefined;
      if (narrativeOrderIndex !== undefined && (narrativeOrderIndex < 0 || narrativeOrderIndex >= BP_NARRATIVE_ORDER_COUNT)) {
        return { content: JSON.stringify({ ok: false, error: "BP_TEMPLATE_INVALID_NARRATIVE", narrativeOrderIndex }) };
      }
      const addonIds = Array.isArray(params.addonIds) ? params.addonIds.map((a) => String(a)) : [];
      const knownAddons = new Set(BP_ADDONS.map((a) => a.id));
      const unknown = addonIds.filter((a) => !knownAddons.has(a));
      if (unknown.length > 0) {
        return { content: JSON.stringify({ ok: false, error: "BP_TEMPLATE_UNKNOWN_ADDON", addons: unknown }) };
      }
      try {
        const brief = renderTrackBrief(trackId, stage, narrativeOrderIndex);
        const sections: string[] = [brief];
        if (params.includeX01 === true) {
          sections.push("【X01 资产运营扩展（叠加）】\n" + BP_X01_MODULES.map((x) => `- ${x.id}：${x.required}（证据与图表：${x.evidenceHints.join("、")}）`).join("\n"));
        }
        for (const id of addonIds) {
          const addon = BP_ADDONS.find((a) => a.id === id)!;
          sections.push(`【专项叠加：${addon.name}】${addon.requirements}`);
        }
        sections.push("【硬约束】事实、分析与假设分开表述；关键数字带来源、口径与日期；优先指标优先呈现；常见错误所列表述不得出现。");
        return {
          content: JSON.stringify({
            ok: true,
            trackId,
            stage,
            moduleCount: 13,
            brief: sections.join("\n\n"),
          }),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: JSON.stringify({ ok: false, error: message }) };
      }
    },
  };
}

/** 供测试使用的渲染函数导出。 */
export { renderTrackBrief, buildPlannerInjection };
