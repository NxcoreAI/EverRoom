/**
 * v2 页面视觉丰富度闸门：内容/数据/表格/流程页不能只有文字 + 白底。
 * 至少要有 1 个信息图形原子（image/chart/table/stats/component/icon/path），
 * 或一个非全屏的装饰 shape（短线/色块/分隔）。封面/收尾/引语页不强制。
 *
 * group 是分区容器、不再是视觉锚点本身：统计要钻到子节点里算
 * （group 里塞一个 icon 也算有图形；只有 text 的 group 不算）。
 */

import type { V2GroupChild, V2Node, V2Page } from "./schema.js";

const VISUAL_TYPES = new Set(["image", "chart", "table", "stats", "component", "icon", "path", "connector"]);
const GATED_ROLES = new Set(["content", "data", "table", "flow"]);

function slotArea(page: V2Page, slot: { col: [number, number]; row: [number, number] }): number {
  const cols = page.grid?.cols ?? 12;
  const rows = page.grid?.rows ?? 8;
  return ((slot.col[1] - slot.col[0] + 1) / cols) * ((slot.row[1] - slot.row[0] + 1) / rows);
}

interface RichnessScan {
  /** 递归后的节点总数（group 子节点也算）。 */
  count: number;
  /** 是否有信息图形原子。 */
  visual: boolean;
  /** 是否有非全屏装饰 shape。 */
  decorative: boolean;
}

/**
 * @param area 该层节点可用的页面面积占比：页面级固定 1，group 子节点继承 group 自己的面积
 *             （子节点没有 slot，只能按父分区判断"是不是全屏色块"）。
 */
function scanNodes(nodes: ReadonlyArray<V2Node | V2GroupChild>, page: V2Page, area: number): RichnessScan {
  const scan: RichnessScan = { count: 0, visual: false, decorative: false };
  for (const node of nodes) {
    scan.count += 1;
    if (node.type === "group") {
      // 页面级 group 有自己的 slot；嵌套 group 继承父分区面积。
      const groupArea = "slot" in node && node.slot ? slotArea(page, node.slot) : area;
      const sub = scanNodes(node.children, page, groupArea);
      scan.count += sub.count;
      scan.visual = scan.visual || sub.visual;
      scan.decorative = scan.decorative || sub.decorative;
      continue;
    }
    if (VISUAL_TYPES.has(node.type)) scan.visual = true;
    if (node.type === "shape") {
      // 页面级 shape 看自己的 slot 面积；group 子节点没有 slot，按父分区面积判。
      const shapeArea = "slot" in node && node.slot ? slotArea(page, node.slot) : area;
      if (shapeArea < 0.65 || Boolean(node.stroke)) scan.decorative = true;
    }
  }
  return scan;
}

export function visualRichnessIssues(page: V2Page): string[] {
  if (!GATED_ROLES.has(page.role)) return [];
  const scan = scanNodes(page.nodes, page, 1);
  const issues: string[] = [];
  if (!scan.visual && !scan.decorative) {
    issues.push("页面只有文字和白底，缺少视觉锚点：至少加一个 icon/path/table/chart/stats/component，或一条非全屏装饰色块/短线");
  }
  // 参考 BP 的内容页至少 4 个模块（标题带/标题/主内容/结论或脚注）；<4 通常是一块内容撑不满。
  if (scan.count < 4) {
    issues.push(`页面只有 ${scan.count} 个节点（含 group 子节点），模块过少：参考级页面至少 4 个模块（标题带/标题/主内容/结论或导航）`);
  }
  return issues;
}
