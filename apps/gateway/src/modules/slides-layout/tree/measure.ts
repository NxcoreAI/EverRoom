/**
 * 量测器：编译产物 + 树 + 契约 → 结构化缺陷清单。
 * 全部确定性检查（估算系数与引擎对齐），供 validate 工具回传布局代理自纠。
 * shrinkToFit 为迭代环耗尽后的引擎兜底：文字叶子逐档降字号，到下限为止。
 */

import type { CompileResult } from "./compile.js";
import { compileTree } from "./compile.js";
import { variantSize } from "./compile.js";
import type { LayoutContract, TextVariant } from "./layout-contract.js";
import type { LayoutTree } from "./schema.js";
import { contractFromStyleParams } from "./layout-contract.js";
import { estimateLineHeight, estimateTextWidth } from "../text-metrics.js";
import type { PageSpec } from "../elements.js";

export type DefectType = "schema" | "overflow" | "min_size" | "font_floor" | "element_cap" | "image_ar" | "canvas" | "overlap" | "emoji" | "contrast";

export interface LayoutDefect {
  path: string;
  type: DefectType;
  detail: string;
  hint: string;
}

export interface MeasureInput {
  /** 图片 url → 长宽比（宽/高）；取不到的 url 不进 Map。 */
  imageArs?: Map<string, number>;
}

const OVERFLOW_TOLERANCE_PX = 2;
const OVERLAP_TOLERANCE_PX = 6;
/** overlay 子节点的最小尺寸下限（角标类小件，低于常规叶子下限）。 */
const OVERLAY_MIN_W = 48;
const OVERLAY_MIN_H = 32;
/** 与 genoffice 引擎同口径的 emoji 判定（含变体选择符/零宽连接符区段）。 */
const EMOJI_PATTERN = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/u;

interface InkBox { label: string; x: number; y: number; w: number; h: number }

/** 引擎 estimateTextInk 同口径的墨迹框（引擎墨迹重叠闸门的镜像，超限即被拒页）。 */
function inkBoxesOf(spec: PageSpec): InkBox[] {
  const boxes: InkBox[] = [];
  for (const el of spec.elements) {
    if (el.type !== "text" && !(el.type === "shape" && el.paragraphs)) continue;
    const paragraphs = el.type === "text" ? el.paragraphs : el.paragraphs!;
    let contentH = 0;
    let label = "";
    for (const p of paragraphs) {
      const size = Math.max(18, ...p.runs.map((r) => r.sizePt ?? 18));
      let textW = 0;
      for (const r of p.runs) {
        label += r.text;
        textW += estimateTextWidth(r.text, r.sizePt ?? 18);
      }
      contentH += Math.max(1, Math.ceil(textW / Math.max(1, el.w))) * estimateLineHeight(size, p.lineSpacingPct);
    }
    const anchor = el.valign ?? (el.type === "shape" ? "middle" : "top");
    const y = anchor === "top" ? el.y : anchor === "bottom" ? el.y + el.h - contentH : el.y + (el.h - contentH) / 2;
    boxes.push({ label: label.slice(0, 16), x: el.x, y, w: el.w, h: contentH });
  }
  return boxes;
}

function boxesOverlap(a: InkBox, b: InkBox): boolean {
  const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return ox > OVERLAP_TOLERANCE_PX && oy > OVERLAP_TOLERANCE_PX;
}

export function measureDefects(result: CompileResult, contract: LayoutContract, input: MeasureInput = {}): LayoutDefect[] {
  const defects: LayoutDefect[] = [];
  const push = (path: string, type: DefectType, detail: string, hint: string) =>
    defects.push({ path, type, detail, hint });

  for (const compileDefect of result.defects) {
    push(compileDefect.path, "overflow", compileDefect.detail, "调整该区域的权重/比例，或精简内容");
  }

  for (const placement of result.placements) {
    const { frame } = placement;
    // justify 打包的叶子框高=内容自然高（刻意贴合），只查宽度下限；
    // overlay 子节点与 icon 是小件定位（角标/压图短句/图标），下限单独放宽；
    // divider 是 1px 装饰线，天然窄条，豁免尺寸下限。
    const small = placement.overlay === true || placement.kind === "icon";
    const isThin = placement.kind === "divider";
    const minW = isThin ? 0 : small ? OVERLAY_MIN_W : contract.minLeaf.w;
    const minHeight = placement.packed || isThin ? 0 : small ? OVERLAY_MIN_H : contract.minLeaf.h;
    if (frame.w < minW || frame.h < minHeight) {
      push(
        placement.path,
        "min_size",
        `区域过小（${Math.round(frame.w)}×${Math.round(frame.h)}px，下限 ${minW}×${minHeight}px）`,
        "加大该子树的权重，或减少兄弟节点数量",
      );
      continue;
    }
    if (placement.kind === "text" && placement.neededHeight !== undefined) {
      if (placement.neededHeight > frame.h + OVERFLOW_TOLERANCE_PX) {
        push(
          placement.path,
          "overflow",
          `文字估算 ${Math.round(placement.neededHeight)}px 超出区域 ${Math.round(frame.h)}px（${placement.variant} ${placement.sizePt}pt）`,
          "加大权重/换更宽的区域，精简文字，或拆成多个文字叶子",
        );
      }
    }
    if (placement.kind === "image" && placement.contain && placement.url && input.imageArs) {
      const ar = input.imageArs.get(placement.url);
      if (ar !== undefined && ar > 0) {
        const frameAr = frame.w / frame.h;
        const deviation = Math.abs(frameAr / ar - 1);
        if (deviation > contract.imageArTolerance) {
          push(
            placement.path,
            "image_ar",
            `contain 模式下框长宽比 ${frameAr.toFixed(2)} 与图 ${ar.toFixed(2)} 偏差 ${Math.round(deviation * 100)}%（空带过宽）`,
            "调整区域比例贴近图片长宽比，或改用 cover 裁切填满",
          );
        }
      }
    }
  }

  // 引擎硬闸镜像①：emoji 直接拒页（任何元素的任何文本都不允许）。
  if (EMOJI_PATTERN.test(JSON.stringify(result.spec.elements))) {
    push("root", "emoji", "页面文本含 emoji（引擎直接拒页）", "删除 emoji；装饰用 path，图标留给后续 icon 叶子");
  }

  // 背景图未压纱罩且存在非深色调文字：图上直排文字对比度无保障。
  if (result.bg && !result.bg.scrim) {
    const onDark = contract.theme.colors.onDarkText;
    const offender = result.spec.elements.find(
      (el) =>
        (el.type === "text" || (el.type === "shape" && el.paragraphs)) &&
        el.paragraphs!.some((p) => p.runs.some((r) => r.color !== undefined && r.color !== onDark)),
    );
    if (offender) {
      push(
        "root.bg",
        "contrast",
        "背景图未压纱罩（bg.scrim: none）且存在非 inverse 文字——图上直排文字对比度无保障",
        "去掉 bg.scrim 让引擎自动压深纱罩，或把压图文字全部改 tone: inverse",
      );
    }
  }

  // 引擎硬闸镜像②：有字元素墨迹两两相交（6px 容差）直接拒页。
  const inkBoxes = inkBoxesOf(result.spec);
  for (let i = 0; i < inkBoxes.length; i++) {
    for (let j = i + 1; j < inkBoxes.length; j++) {
      if (boxesOverlap(inkBoxes[i]!, inkBoxes[j]!)) {
        push(
          "root",
          "overlap",
          `「${inkBoxes[i]!.label}」与「${inkBoxes[j]!.label}」墨迹重叠（引擎会整页拒绝）`,
          "加大该区域的权重/比例，或精简其中一方的内容——通常是区域太小装不下内容",
        );
      }
    }
  }

  if (result.stats.elements > contract.caps.elements) {
    push("root", "element_cap", `元素总数 ${result.stats.elements} 超过上限 ${contract.caps.elements}`, "减少叶子数量或降低嵌套密度");
  }
  if (result.stats.images > contract.caps.images) {
    push("root", "element_cap", `图片数 ${result.stats.images} 超过上限 ${contract.caps.images}`, "减少图片叶子");
  }
  if (result.stats.paths > contract.caps.paths) {
    push("root", "element_cap", `路径数 ${result.stats.paths} 超过上限 ${contract.caps.paths}`, "减少路径叶子");
  }

  for (const element of result.spec.elements) {
    if (
      element.x < 0 || element.y < 0 ||
      element.x + element.w > contract.canvas.w + 1 ||
      element.y + element.h > contract.canvas.h + 1
    ) {
      push("root", "canvas", `元素越出画布（x=${Math.round(element.x)} y=${Math.round(element.y)} w=${Math.round(element.w)} h=${Math.round(element.h)}）`, "检查嵌套 pad 与缝隙总和");
      break;
    }
  }

  return defects;
}

export interface ShrinkResult {
  result: CompileResult;
  defects: LayoutDefect[];
  /** 降档是否生效过（生效即标记 degraded，供 VLM 终检重点看）。 */
  degraded: boolean;
  overrides: Map<string, number>;
}

/**
 * 迭代环耗尽后的兜底：对溢出的文字叶子逐档降字号（-1pt）重编，
 * 到契约字号下限为止。卡片/表格类溢出不在此兜底（保持内容不丢，交 VLM 终检）。
 */
export function shrinkToFit(tree: LayoutTree, contract: LayoutContract, input: MeasureInput = {}, maxIterations = 12): ShrinkResult {
  const overrides = new Map<string, number>();
  let degraded = false;
  let current = compileTree(tree, contract, overrides);
  let defects = measureDefects(current, contract, input);

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    const overflowTexts = defects.filter(
      (defect) => defect.type === "overflow" && defect.path !== "root.title",
    );
    if (overflowTexts.length === 0) break;

    let reduced = false;
    for (const defect of overflowTexts) {
      const placement = current.placements.find((p) => p.path === defect.path && p.kind === "text");
      if (!placement || placement.variant === undefined || placement.sizePt === undefined) continue;
      const floor = contract.fontFloors[placement.variant as TextVariant];
      const nextSize = placement.sizePt - 1;
      if (nextSize < floor) {
        if (!defects.some((d) => d.path === defect.path && d.type === "font_floor")) {
          defects.push({
            path: defect.path,
            type: "font_floor",
            detail: `${placement.variant} 已降到下限 ${floor}pt 仍溢出`,
            hint: "内容超出单页容量——精简文字或拆两页",
          });
        }
        continue;
      }
      overrides.set(defect.path, nextSize);
      reduced = true;
      degraded = true;
    }
    if (!reduced) break;

    current = compileTree(tree, contract, overrides);
    defects = measureDefects(current, contract, input);
  }

  return { result: current, defects, degraded, overrides };
}

/** 便捷入口：树 + styleParams → 编译 + 量测（validate 工具与测试共用）。 */
export function compileAndMeasure(tree: LayoutTree, styleParams: unknown, input: MeasureInput = {}): { result: CompileResult; defects: LayoutDefect[] } {
  const contract = contractFromStyleParams(styleParams as never);
  const result = compileTree(tree, contract);
  const defects = measureDefects(result, contract, input);
  return { result, defects };
}
