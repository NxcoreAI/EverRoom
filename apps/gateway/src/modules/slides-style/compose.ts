/**
 * 提取合成管线：选定纵览图 →（聚类+角色+字体气质+装饰档）→ styler 复核
 * → StyleParams。编排层（tools.ts 风格阶段）只面对这四个函数。
 *
 * 韧性原则：styler 是「复核与微调」不是唯一产出——它失败或输出越界时
 * 链路降级到确定性基线（启发式角色 + 档位映射 + 缺省字号），风格卡
 * 照常出，只是少了微调。
 */

import type { VlmPromptAnalyzer } from "../vision/vlm-client.js";
import type { StyleColorCluster, StyleParams } from "./types.js";
import {
  assignPaletteRoles,
  extractColorClusters,
  type PaletteRoles,
} from "./extract.js";
import {
  decorationToEngine,
  readDecoration,
  readFontTemperament,
  type DecorationReading,
  type FontTemperament,
} from "./vlm-extract.js";
import { defaultStyleParams, normalizeStyleParams } from "./validate.js";

export interface OverviewExtraction {
  clusters: StyleColorCluster[];
  roles: PaletteRoles;
  font: FontTemperament;
  decoration: DecorationReading;
}

export async function extractFromOverview(
  image: { buffer: Buffer; mime: string },
  vlm: VlmPromptAnalyzer,
  signal?: AbortSignal,
): Promise<OverviewExtraction> {
  const clusters = await extractColorClusters(image);
  const roles = assignPaletteRoles(clusters);
  const [font, decoration] = await Promise.all([
    readFontTemperament(vlm, image, signal),
    readDecoration(vlm, image, signal),
  ]);
  return { clusters, roles, font, decoration };
}

/** 视觉档位 → 缺省基线的圆角/阴影取值。 */
function decorationDefaults(decoration: DecorationReading): { cornerRadius: number; shadow: "none" | "soft" | "medium" | "strong" } {
  const engine = decorationToEngine(decoration);
  return { cornerRadius: engine.cornerRadiusPx, shadow: engine.shadow };
}

export interface SettleOutcome {
  params: StyleParams;
  /** true = styler 输出不可用，回落到确定性基线。 */
  fellBack: boolean;
  reason?: string;
  /** 色板关系闸门的确定性修复记录（排查用，不进用户面）。 */
  repairs?: string[];
}

/** styler settle 输出 → StyleParams：先严格归一+关系修复，失败降级基线。 */
export function styleParamsFromStyler(
  raw: unknown,
  extraction: OverviewExtraction,
): SettleOutcome {
  const candidate = (raw as { styleParams?: unknown } | null)?.styleParams ?? raw;
  try {
    const repairs: string[] = [];
    const params = normalizeStyleParams(candidate, repairs);
    return { params, fellBack: false, ...(repairs.length > 0 ? { repairs } : {}) };
  } catch (error) {
    const fallback = defaultStyleParams(
      extraction.roles,
      decorationDefaults(extraction.decoration),
    );
    return { params: fallback, fellBack: true, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** 无 styler 时的完整确定性基线（自校闭环起点 / 兜底路径）。 */
export function baselineStyleParams(extraction: OverviewExtraction): StyleParams {
  return defaultStyleParams(extraction.roles, decorationDefaults(extraction.decoration));
}
