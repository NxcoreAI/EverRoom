/**
 * 组件层入口：参数化复合叶子的归一与展开分发。
 * 组件是页内积木——模型只给文案/条目/方向，内部结构与绘制由各展开器确定性生成。
 * 参数错误报 LAYOUT_TREE_INVALID（归一阶段自纠）；装不下报 LAYOUT_LEAF_INVALID（编译阶段缺陷）。
 */

import type { Frame } from "../../grid.js";
import type { ResolvedTheme } from "../../theme.js";
import type { SpecElement } from "../../elements.js";
import { ICON_NAMES } from "../icons.js";
import { expandTimeline, type TimelineItem } from "./timeline.js";
import { expandSteps, type StepItem } from "./steps.js";
import { expandStats, type StatItem } from "./stats.js";
import { expandFeatureCards, type FeatureItem } from "./feature-cards.js";
import { expandQuote } from "./quote.js";
import { expandComparison, type ComparisonSide, type ComparisonPoint } from "./comparison.js";
import { expandMatrix2x2, type Quadrant, type MatrixAxes } from "./matrix.js";
import { expandProsCons, type ProsConsInput } from "./pros-cons.js";
import { expandAgenda } from "./agenda.js";
import { expandChevron, type ChevronItem } from "./chevron.js";
import { expandPyramid, type TierItem } from "./pyramid.js";
import { expandFunnel, type FunnelItem } from "./funnel.js";
import { expandVenn, type VennInput } from "./venn.js";
import { expandCallout, type CalloutInput } from "./callout.js";
import { expandCycle, type CycleItem } from "./cycle.js";
import { expandProgress, type ProgressItem } from "./progress.js";
import { expandOrgChart, type OrgNode } from "./org-chart.js";
import { expandPersona, type PersonaInput } from "./persona.js";
import { expandBentoGrid, type BentoItem } from "./bento.js";
import { expandLayeredStack, type LayerItem } from "./layers.js";
import { expandTeamGrid, type TeamMember } from "./team-grid.js";
import { expandQuotes, type QuoteEntry } from "./quotes.js";
import { expandPricingTiers, type PricingTier } from "./pricing-tiers.js";
import { expandLogoWall, type LogoSlot } from "./logo-wall.js";
import { expandPointList, type PointItem } from "./point-list.js";

export type {
  TimelineItem, StepItem, StatItem, FeatureItem, ComparisonSide, ComparisonPoint,
  Quadrant, MatrixAxes, ProsConsInput, ChevronItem, TierItem,
  FunnelItem, VennInput, CalloutInput, CycleItem, ProgressItem,
  OrgNode, PersonaInput, BentoItem, LayerItem,
  TeamMember, QuoteEntry, PricingTier, LogoSlot, PointItem,
};

export type ComponentLeaf =
  | { type: "component"; name: "timeline"; direction?: "h" | "v"; items: TimelineItem[] }
  | { type: "component"; name: "steps"; items: StepItem[] }
  | { type: "component"; name: "stats"; items: StatItem[] }
  | { type: "component"; name: "featureCards"; items: FeatureItem[] }
  | { type: "component"; name: "quote"; text: string; author?: string }
  | { type: "component"; name: "comparison"; sides: ComparisonSide[]; featured?: number }
  | { type: "component"; name: "matrix2x2"; quadrants: Quadrant[]; axes?: MatrixAxes }
  | { type: "component"; name: "prosCons"; pros: string[]; cons: string[] }
  | { type: "component"; name: "agenda"; items: string[] }
  | { type: "component"; name: "chevron"; items: ChevronItem[] }
  | { type: "component"; name: "pyramid"; items: TierItem[] }
  | { type: "component"; name: "funnel"; items: FunnelItem[] }
  | { type: "component"; name: "venn"; a: string; b: string; both?: string }
  | { type: "component"; name: "calloutBox"; text: string; icon?: string }
  | { type: "component"; name: "cycle"; items: CycleItem[] }
  | { type: "component"; name: "progress"; items: ProgressItem[] }

  | { type: "component"; name: "orgChart"; root: OrgNode; children: OrgNode[] }
  | { type: "component"; name: "persona"; person: { name: string; role?: string }; points: string[]; image?: string }
  | { type: "component"; name: "bentoGrid"; items: BentoItem[] }
  | { type: "component"; name: "layeredStack"; items: LayerItem[] }
  | { type: "component"; name: "teamGrid"; members: TeamMember[] }
  | { type: "component"; name: "quotes"; items: QuoteEntry[] }
  | { type: "component"; name: "pricingTiers"; tiers: PricingTier[]; featured: number }
  | { type: "component"; name: "logoWall"; logos: LogoSlot[] }
  | { type: "component"; name: "pointList"; numbered?: true; items: PointItem[] };

export const COMPONENT_NAMES = [
  "timeline", "steps", "stats", "featureCards", "quote", "comparison",
  "matrix2x2", "prosCons", "agenda", "chevron", "pyramid", "funnel",
  "venn", "calloutBox", "cycle", "progress", "orgChart", "persona",
  "bentoGrid", "layeredStack", "teamGrid", "quotes", "pricingTiers", "logoWall", "pointList",
] as const;

function bad(message: string): never {
  throw new Error(`LAYOUT_TREE_INVALID: ${message}`);
}

function reqText(value: unknown, what: string, max: number): string {
  if (typeof value !== "string" || !value.trim()) bad(`缺少 ${what}（非空字符串）`);
  return value.trim().slice(0, max);
}

function optText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return value.trim().slice(0, max);
}

function itemArray(raw: unknown, path: string, min: number, max: number): Record<string, unknown>[] {
  if (!Array.isArray(raw) || raw.length < min || raw.length > max) {
    bad(`${path} 必须是 ${min}~${max} 项的数组，收到 ${Array.isArray(raw) ? raw.length : String(raw)}`);
  }
  return (raw as unknown[]).map((item, i) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) bad(`${path}[${i}] 必须是对象`);
    return item as Record<string, unknown>;
  });
}

function stringItems(raw: unknown, path: string, min: number, max: number, itemMax: number): string[] {
  if (!Array.isArray(raw) || raw.length < min || raw.length > max) {
    bad(`${path} 必须是 ${min}~${max} 项的字符串数组，收到 ${Array.isArray(raw) ? raw.length : String(raw)}`);
  }
  return (raw as unknown[]).map((item, i) => reqText(item, `${path}[${i}]`, itemMax));
}

function optIcon(value: unknown, what: string): string | undefined {
  const icon = optText(value, 40);
  if (icon && !ICON_NAMES.includes(icon)) {
    bad(`${what} 必须是引擎图标集内的名称（如 check-circle、light-bulb），收到 ${icon}`);
  }
  return icon;
}

function optImageUrl(value: unknown, what: string): string | undefined {
  const url = optText(value, 500);
  if (url && !/^(https?:\/\/|everroom-material:\/\/)/i.test(url)) {
    bad(`${what} 只接受 http(s) 直链或 everroom-material:// 素材引用，收到 ${url.slice(0, 60)}`);
  }
  return url;
}

function normalizeComponentLeaf(node: Record<string, unknown>, path: string): ComponentLeaf {
  const name = node.name;
  if (typeof name !== "string" || !(COMPONENT_NAMES as readonly string[]).includes(name)) {
    bad(`${path}.name 必须是 ${COMPONENT_NAMES.join("|")}，收到 ${String(name)}`);
  }
  switch (name as ComponentLeaf["name"]) {
    case "timeline": {
      const direction = node.direction;
      if (direction !== undefined && direction !== "h" && direction !== "v") {
        bad(`${path}.direction 必须是 h|v（缺省 h 横向）`);
      }
      const items = itemArray(node.items, `${path}.items`, 3, 6).map((item, i) => ({
        label: reqText(item.label, `${path}.items[${i}].label`, 24),
        text: reqText(item.text, `${path}.items[${i}].text`, 80),
      }));
      return { type: "component", name: "timeline", ...(direction === "v" ? { direction: "v" } : {}), items };
    }
    case "steps": {
      const items = itemArray(node.items, `${path}.items`, 3, 5).map((item, i) => {
        const title = reqText(item.title, `${path}.items[${i}].title`, 24);
        const text = optText(item.text, 80);
        return { title, ...(text ? { text } : {}) };
      });
      return { type: "component", name: "steps", items };
    }
    case "stats": {
      const items = itemArray(node.items, `${path}.items`, 2, 4).map((item, i) => {
        const value = reqText(item.value, `${path}.items[${i}].value`, 16);
        const label = reqText(item.label, `${path}.items[${i}].label`, 40);
        const unit = optText(item.unit, 8);
        return { value, label, ...(unit ? { unit } : {}) };
      });
      return { type: "component", name: "stats", items };
    }
    case "featureCards": {
      const items = itemArray(node.items, `${path}.items`, 2, 4).map((item, i) => {
        const title = reqText(item.title, `${path}.items[${i}].title`, 30);
        const body = optText(item.body, 200);
        const icon = optIcon(item.icon, `${path}.items[${i}].icon`);
        const image = optImageUrl(item.image, `${path}.items[${i}].image`);
        return { title, ...(body ? { body } : {}), ...(icon && !image ? { icon } : {}), ...(image ? { image } : {}) };
      });
      return { type: "component", name: "featureCards", items };
    }
    case "quote": {
      const text = reqText(node.text, `${path}.text`, 200);
      const author = optText(node.author, 40);
      return { type: "component", name: "quote", text, ...(author ? { author } : {}) };
    }
    case "comparison": {
      const sideOf = (raw: unknown, key: string): ComparisonSide => {
        if (typeof raw !== "object" || raw === null || Array.isArray(raw)) bad(`${path}.${key} 必须是 { title, points }`);
        const s = raw as Record<string, unknown>;
        const title = reqText(s.title, `${path}.${key}.title`, 24);
        const tag = optText(s.tag, 8);
        const pointsRaw = s.points;
        if (!Array.isArray(pointsRaw) || pointsRaw.length < 2 || pointsRaw.length > 5) {
          bad(`${path}.${key}.points 必须是 2~5 项的数组`);
        }
        const points = (pointsRaw as unknown[]).map((p, i): string | ComparisonPoint => {
          if (typeof p === "string") return reqText(p, `${path}.${key}.points[${i}]`, 60);
          if (typeof p === "object" && p !== null && !Array.isArray(p)) {
            const pt = p as Record<string, unknown>;
            const text = reqText(pt.text, `${path}.${key}.points[${i}].text`, 60);
            if (pt.mark !== undefined && pt.mark !== "yes" && pt.mark !== "mid" && pt.mark !== "no") {
              bad(`${path}.${key}.points[${i}].mark 必须是 yes|mid|no，收到 ${String(pt.mark)}`);
            }
            return { text, ...(pt.mark ? { mark: pt.mark as "yes" | "mid" | "no" } : {}) };
          }
          bad(`${path}.${key}.points[${i}] 必须是字符串或 { text, mark? }`);
        });
        return { title, ...(tag ? { tag } : {}), points };
      };
      if (node.sides !== undefined) {
        if (node.left !== undefined || node.right !== undefined) {
          bad(`${path}.sides 与 left/right 二选一`);
        }
        const sides = itemArray(node.sides, `${path}.sides`, 2, 4).map((s, i) => sideOf(s, `sides[${i}]`));
        let featured: number | undefined;
        if (node.featured !== undefined) {
          if (typeof node.featured !== "number" || !Number.isInteger(node.featured) || node.featured < 0 || node.featured >= sides.length) {
            bad(`${path}.featured 必须是 0~${sides.length - 1} 的整数，收到 ${String(node.featured)}`);
          }
          featured = node.featured;
        }
        return { type: "component", name: "comparison", sides, ...(featured !== undefined ? { featured } : {}) };
      }
      // 旧口径 left/right：转换为两方，右列为重点（沿用「右=建议项」语义）。
      if (node.left !== undefined || node.right !== undefined) {
        return {
          type: "component",
          name: "comparison",
          sides: [sideOf(node.left, "left"), sideOf(node.right, "right")],
          featured: 1,
        };
      }
      bad(`${path} 需要 sides（2~4 方）或 left/right`);
    }
    case "teamGrid": {
      const members = itemArray(node.members, `${path}.members`, 2, 6).map((m, i) => {
        const name = reqText(m.name, `${path}.members[${i}].name`, 16);
        const role = optText(m.role, 24);
        const bio = optText(m.bio, 48);
        const image = optImageUrl(m.image, `${path}.members[${i}].image`);
        return { name, ...(role ? { role } : {}), ...(bio ? { bio } : {}), ...(image ? { image } : {}) };
      });
      return { type: "component", name: "teamGrid", members };
    }
    case "quotes": {
      const items = itemArray(node.items, `${path}.items`, 2, 3).map((q, i) => {
        const text = reqText(q.text, `${path}.items[${i}].text`, 90);
        const name = reqText(q.name, `${path}.items[${i}].name`, 16);
        const role = optText(q.role, 28);
        const avatar = optImageUrl(q.avatar, `${path}.items[${i}].avatar`);
        let rating: number | undefined;
        if (q.rating !== undefined) {
          if (typeof q.rating !== "number" || !Number.isInteger(q.rating) || q.rating < 1 || q.rating > 5) {
            bad(`${path}.items[${i}].rating 必须是 1~5 的整数，收到 ${String(q.rating)}`);
          }
          rating = q.rating;
        }
        return { text, name, ...(role ? { role } : {}), ...(avatar ? { avatar } : {}), ...(rating ? { rating } : {}) };
      });
      return { type: "component", name: "quotes", items };
    }
    case "pricingTiers": {
      const tiers = itemArray(node.tiers, `${path}.tiers`, 2, 4).map((t, i) => {
        const name = reqText(t.name, `${path}.tiers[${i}].name`, 12);
        const price = reqText(t.price, `${path}.tiers[${i}].price`, 12);
        const unit = optText(t.unit, 10);
        const features = stringItems(t.features, `${path}.tiers[${i}].features`, 2, 4, 24);
        const cta = optText(t.cta, 8);
        return { name, price, ...(unit ? { unit } : {}), features, ...(cta ? { cta } : {}) };
      });
      if (typeof node.featured !== "number" || !Number.isInteger(node.featured) || node.featured < 0 || node.featured >= tiers.length) {
        bad(`${path}.featured 必须是 0~${tiers.length - 1} 的整数（恰一个重点档），收到 ${String(node.featured)}`);
      }
      return { type: "component", name: "pricingTiers", tiers, featured: node.featured as number };
    }
    case "logoWall": {
      const logos = itemArray(node.logos, `${path}.logos`, 4, 8).map((l, i) => {
        const image = optImageUrl(l.image, `${path}.logos[${i}].image`);
        const text = optText(l.text, 20);
        if (!image && !text) bad(`${path}.logos[${i}] 需要 image 或 text`);
        return { ...(image ? { image } : {}), ...(!image && text ? { text } : {}) } as LogoSlot;
      });
      return { type: "component", name: "logoWall", logos };
    }
    case "pointList": {
      if (node.numbered !== undefined && node.numbered !== true) {
        bad(`${path}.numbered 只接受 true（衬线序号 01/02/…）`);
      }
      const items = itemArray(node.items, `${path}.items`, 2, 5).map((item, i) => ({
        label: reqText(item.label, `${path}.items[${i}].label`, 12),
        body: reqText(item.body, `${path}.items[${i}].body`, 140),
      }));
      return { type: "component", name: "pointList", ...(node.numbered === true ? { numbered: true } : {}), items };
    }
    case "matrix2x2": {
      const quadrants = itemArray(node.quadrants, `${path}.quadrants`, 4, 4).map((item, i) => {
        const title = reqText(item.title, `${path}.quadrants[${i}].title`, 24);
        const pointsRaw = item.points;
        let points: string[] | undefined;
        if (pointsRaw !== undefined) {
          if (!Array.isArray(pointsRaw) || pointsRaw.length < 1 || pointsRaw.length > 4) {
            bad(`${path}.quadrants[${i}].points 必须是 1~4 项的数组`);
          }
          points = (pointsRaw as unknown[]).map((p, j) => reqText(p, `${path}.quadrants[${i}].points[${j}]`, 40));
        }
        return { title, ...(points ? { points } : {}) };
      });
      let axes: MatrixAxes | undefined;
      if (node.axes !== undefined) {
        if (typeof node.axes !== "object" || node.axes === null || Array.isArray(node.axes)) bad(`${path}.axes 必须是 { top?, right?, bottom?, left? }`);
        const a = node.axes as Record<string, unknown>;
        axes = {
          ...(optText(a.top, 20) ? { top: optText(a.top, 20)! } : {}),
          ...(optText(a.right, 20) ? { right: optText(a.right, 20)! } : {}),
          ...(optText(a.bottom, 20) ? { bottom: optText(a.bottom, 20)! } : {}),
          ...(optText(a.left, 20) ? { left: optText(a.left, 20)! } : {}),
        };
        if (Object.keys(axes).length === 0) axes = undefined;
      }
      return { type: "component", name: "matrix2x2", quadrants, ...(axes ? { axes } : {}) };
    }
    case "prosCons": {
      const list = (raw: unknown, key: string): string[] => {
        if (!Array.isArray(raw) || raw.length < 2 || raw.length > 5) bad(`${path}.${key} 必须是 2~5 项的数组`);
        return (raw as unknown[]).map((p, i) => reqText(p, `${path}.${key}[${i}]`, 60));
      };
      return { type: "component", name: "prosCons", pros: list(node.pros, "pros"), cons: list(node.cons, "cons") };
    }
    case "agenda": {
      const items = stringItems(node.items, `${path}.items`, 4, 8, 24);
      return { type: "component", name: "agenda", items };
    }
    case "chevron": {
      const items = itemArray(node.items, `${path}.items`, 3, 5).map((item, i) => {
        const title = reqText(item.title, `${path}.items[${i}].title`, 16);
        const text = optText(item.text, 40);
        return { title, ...(text ? { text } : {}) };
      });
      return { type: "component", name: "chevron", items };
    }
    case "pyramid": {
      const items = itemArray(node.items, `${path}.items`, 3, 5).map((item, i) => {
        const title = reqText(item.title, `${path}.items[${i}].title`, 16);
        const text = optText(item.text, 40);
        return { title, ...(text ? { text } : {}) };
      });
      return { type: "component", name: "pyramid", items };
    }
    case "funnel": {
      const items = itemArray(node.items, `${path}.items`, 3, 4).map((item, i) => {
        const stage = reqText(item.stage, `${path}.items[${i}].stage`, 16);
        const value = optText(item.value, 16);
        return { stage, ...(value ? { value } : {}) };
      });
      return { type: "component", name: "funnel", items };
    }
    case "venn": {
      const a = reqText(node.a, `${path}.a`, 10);
      const b = reqText(node.b, `${path}.b`, 10);
      const both = optText(node.both, 10);
      return { type: "component", name: "venn", a, b, ...(both ? { both } : {}) };
    }
    case "calloutBox": {
      const text = reqText(node.text, `${path}.text`, 120);
      const icon = optIcon(node.icon, `${path}.icon`);
      return { type: "component", name: "calloutBox", text, ...(icon ? { icon } : {}) };
    }
    case "cycle": {
      const items = itemArray(node.items, `${path}.items`, 3, 5).map((item, i) => ({
        title: reqText(item.title, `${path}.items[${i}].title`, 6),
      }));
      return { type: "component", name: "cycle", items };
    }
    case "progress": {
      const items = itemArray(node.items, `${path}.items`, 2, 4).map((item, i) => {
        const label = reqText(item.label, `${path}.items[${i}].label`, 24);
        const value = item.value;
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
          bad(`${path}.items[${i}].value 必须是 0~100 的数字，收到 ${String(value)}`);
        }
        const unit = optText(item.unit, 8);
        let target: number | undefined;
        if (item.target !== undefined) {
          if (typeof item.target !== "number" || !Number.isFinite(item.target) || item.target < 0 || item.target > 100) {
            bad(`${path}.items[${i}].target 必须是 0~100 的数字，收到 ${String(item.target)}`);
          }
          target = item.target;
        }
        return { label, value, ...(unit ? { unit } : {}), ...(target !== undefined ? { target } : {}) };
      });
      return { type: "component", name: "progress", items };
    }
    case "orgChart": {
      const nodeOf = (raw: unknown, key: string): OrgNode => {
        if (typeof raw !== "object" || raw === null || Array.isArray(raw)) bad(`${path}.${key} 必须是 { title, subtitle? }`);
        const n = raw as Record<string, unknown>;
        const title = reqText(n.title, `${path}.${key}.title`, 20);
        const subtitle = optText(n.subtitle, 30);
        return { title, ...(subtitle ? { subtitle } : {}) };
      };
      const root = nodeOf(node.root, "root");
      const children = itemArray(node.children, `${path}.children`, 2, 4).map((item, i) => nodeOf(item, `children[${i}]`));
      return { type: "component", name: "orgChart", root, children };
    }
    case "persona": {
      if (typeof node.person !== "object" || node.person === null || Array.isArray(node.person)) bad(`${path}.person 必须是 { name, role? }`);
      const p = node.person as Record<string, unknown>;
      const personName = reqText(p.name, `${path}.person.name`, 24);
      const role = optText(p.role, 40);
      const pointsRaw = node.points;
      if (!Array.isArray(pointsRaw) || pointsRaw.length < 2 || pointsRaw.length > 5) bad(`${path}.points 必须是 2~5 项的数组`);
      const points = (pointsRaw as unknown[]).map((pt, i) => reqText(pt, `${path}.points[${i}]`, 40));
      const image = optImageUrl(node.image, `${path}.image`);
      return { type: "component", name: "persona", person: { name: personName, ...(role ? { role } : {}) }, points, ...(image ? { image } : {}) };
    }
    case "bentoGrid": {
      const items = itemArray(node.items, `${path}.items`, 3, 5).map((item, i) => {
        const title = reqText(item.title, `${path}.items[${i}].title`, 24);
        const body = optText(item.body, 120);
        const icon = optIcon(item.icon, `${path}.items[${i}].icon`);
        const image = optImageUrl(item.image, `${path}.items[${i}].image`);
        return {
          title,
          ...(body ? { body } : {}),
          ...(icon && !image ? { icon } : {}),
          ...(image ? { image } : {}),
          ...(item.wide === true ? { wide: true } : {}),
        };
      });
      return { type: "component", name: "bentoGrid", items };
    }
    case "layeredStack": {
      const items = itemArray(node.items, `${path}.items`, 3, 5).map((item, i) => {
        const title = reqText(item.title, `${path}.items[${i}].title`, 16);
        const text = optText(item.text, 60);
        return { title, ...(text ? { text } : {}) };
      });
      return { type: "component", name: "layeredStack", items };
    }
  }
}

export { normalizeComponentLeaf };

/** 展开分发：组件 → 普通 PageSpec 元素（量测与上限对产物照常生效）。 */
export function expandComponent(leaf: ComponentLeaf, frame: Frame, theme: ResolvedTheme, what: string): SpecElement[] {
  switch (leaf.name) {
    case "timeline":
      return expandTimeline(leaf.direction ?? "h", leaf.items, frame, theme, what);
    case "steps":
      return expandSteps(leaf.items, frame, theme, what);
    case "stats":
      return expandStats(leaf.items, frame, theme, what);
    case "featureCards":
      return expandFeatureCards(leaf.items, frame, theme, what);
    case "quote":
      return expandQuote(leaf, frame, theme, what);
    case "comparison":
      return expandComparison(leaf.sides, leaf.featured, frame, theme, what);
    case "matrix2x2":
      return expandMatrix2x2(leaf.quadrants, leaf.axes ?? {}, frame, theme, what);
    case "prosCons":
      return expandProsCons(leaf, frame, theme, what);
    case "agenda":
      return expandAgenda(leaf.items, frame, theme, what);
    case "chevron":
      return expandChevron(leaf.items, frame, theme, what);
    case "pyramid":
      return expandPyramid(leaf.items, frame, theme, what);
    case "funnel":
      return expandFunnel(leaf.items, frame, theme, what);
    case "venn":
      return expandVenn(leaf, frame, theme, what);
    case "calloutBox":
      return expandCallout(leaf, frame, theme, what);
    case "cycle":
      return expandCycle(leaf.items, frame, theme, what);
    case "progress":
      return expandProgress(leaf.items, frame, theme, what);
    case "orgChart":
      return expandOrgChart(leaf.root, leaf.children, frame, theme, what);
    case "persona":
      return expandPersona(leaf, frame, theme, what);
    case "bentoGrid":
      return expandBentoGrid(leaf.items, frame, theme, what);
    case "layeredStack":
      return expandLayeredStack(leaf.items, frame, theme, what);
    case "teamGrid":
      return expandTeamGrid(leaf.members, frame, theme, what);
    case "quotes":
      return expandQuotes(leaf.items, frame, theme, what);
    case "pricingTiers":
      return expandPricingTiers(leaf.tiers, leaf.featured, frame, theme, what);
    case "logoWall":
      return expandLogoWall(leaf.logos, frame, theme, what);
    case "pointList":
      return expandPointList(leaf.items, frame, theme, what, leaf.numbered === true);
  }
}
