/**
 * flex 树编译器：LayoutTree + 契约 → PageSpec。
 * agent 只出结构与比例；坐标、字号、配色全部在这里确定性算出。
 * 同父子框相接（划分构造），文本墨迹重叠由引擎闸门兜底。
 * 叶子渲染器抛的 LAYOUT_LEAF_INVALID 在这里转成缺陷（不中断整页编译）。
 */

import { padFrame, type Frame } from "../grid.js";
import { darkPageTheme, mixHex, snap4, withAlpha, type ResolvedTheme } from "../theme.js";
import { imageElement, shapeElement, textElement, type PageSpec, type SpecElement } from "../elements.js";
import { estimateLineHeight, estimateLines } from "../text-metrics.js";
import type { LayoutContract, TextVariant } from "./layout-contract.js";
import type { ChildNode, ContainerNode, Direction, LayoutTree, LeafNode, PanelSpec, TreeNode } from "./schema.js";
import { isLeaf } from "./schema.js";
import {
  isTreeErrorLike,
  renderChartLeaf,
  renderTableLeaf,
  renderTextLeaf,
  titleBand,
} from "./leaf-renderers.js";
import { expandComponent } from "./components/index.js";

export interface LeafPlacement {
  path: string;
  kind: LeafNode["type"];
  frame: Frame;
  variant?: TextVariant;
  sizePt?: number;
  /** 文字叶子的估算内容高（px）。 */
  neededHeight?: number;
  url?: string;
  contain?: boolean;
  /** justify 打包分配（框高=内容自然高，豁免 min_size 检查）。 */
  packed?: boolean;
  /** overlay place 定位的子节点（min_size 下限放宽，允许小件）。 */
  overlay?: boolean;
}

export interface CompileDefect {
  path: string;
  type: "overflow";
  detail: string;
}

export interface CompileResult {
  spec: PageSpec;
  placements: LeafPlacement[];
  defects: CompileDefect[];
  stats: { elements: number; leaves: number; depth: number; images: number; paths: number };
  /** 页级背景摘要（量测 contrast 检查用）。 */
  bg?: { image: string; scrim: boolean };
}

/** 深色纱罩：深色页背景色 + 65% 透明度（引擎 alphaXml 转 <a:alpha>）。 */
const SCRIM_ALPHA = "A6";

function scrimFill(darkBackground: string): string {
  return `${darkBackground}${SCRIM_ALPHA}`;
}

function panelFill(tone: PanelSpec["tone"], theme: ResolvedTheme): string {
  if (tone === "dark") return theme.colors.darkBackground;
  if (tone === "soft") return theme.colors.primarySoft;
  if (tone === "tint") return withAlpha(theme.colors.primary, 0.08);
  return theme.colors.cardSurface;
}

/** 容器面板：按 tone 分发五种视觉变种；返回子节点基框（nested 返回内卡框，其余返回面板框）。 */
function emitPanel(panel: PanelSpec, frame: Frame, state: WalkState): Frame {
  const { theme } = state.contract;
  const shape = panel.radius === false ? "rect" : "roundRect";
  const radiusAdj = (w: number, h: number, px = theme.spacing.cornerRadius) =>
    px > 0 ? Math.min(50000, Math.round((px / Math.max(1, Math.min(w, h))) * 100000)) : undefined;
  const primary = theme.colors.primary;
  switch (panel.tone) {
    case "tint": {
      // 渐层釉面：primary 8.5%→3.5% 上下渐层 + 16% 发丝描边——表面有微光、边缘有定义。
      state.elements.push({
        type: "shape",
        shape,
        gradient: {
          stops: [
            { pos: 0, color: withAlpha(primary, 0.085) },
            { pos: 100, color: withAlpha(primary, 0.035) },
          ],
          angle: 90,
        },
        stroke: { color: withAlpha(primary, 0.16), widthPt: 1 },
        x: Math.round(frame.x),
        y: Math.round(frame.y),
        w: Math.round(frame.w),
        h: Math.round(frame.h),
        adj: radiusAdj(frame.w, frame.h),
      });
      state.stats.elements += 1;
      return frame;
    }
    case "leftBar": {
      // 刻标卡：白卡（背景向白收 70%）+ hairline + 左缘 3px 主色胶囊刻标 + 柔投影。
      const cardFill = mixHex(theme.colors.background, "#FFFFFF", 0.7);
      state.elements.push({
        type: "shape",
        shape,
        fill: cardFill,
        stroke: { color: theme.colors.divider, widthPt: 1 },
        shadow: panel.stroke === false ? undefined : "soft",
        x: Math.round(frame.x),
        y: Math.round(frame.y),
        w: Math.round(frame.w),
        h: Math.round(frame.h),
        adj: radiusAdj(frame.w, frame.h),
      });
      const barInset = Math.min(12, theme.spacing.cornerRadius);
      state.elements.push({
        type: "shape",
        shape: panel.radius === false ? "rect" : "roundRect",
        fill: primary,
        x: Math.round(frame.x),
        y: Math.round(frame.y + barInset),
        w: 3,
        h: Math.round(frame.h - barInset * 2),
        adj: 50000,
      });
      state.stats.elements += 2;
      return frame;
    }
    case "nested": {
      // 双层嵌套：通栏 tint 洗地（radius 加大 10px）+ 内白卡（四向缩进）浮起；
      // 子节点改落在内卡框上。
      state.elements.push({
        type: "shape",
        shape,
        fill: withAlpha(primary, 0.06),
        x: Math.round(frame.x),
        y: Math.round(frame.y),
        w: Math.round(frame.w),
        h: Math.round(frame.h),
        adj: radiusAdj(frame.w, frame.h, theme.spacing.cornerRadius + 10),
      });
      const insetX = 44;
      const insetY = 34;
      const card: Frame = {
        x: frame.x + insetX,
        y: frame.y + insetY,
        w: Math.max(1, frame.w - insetX * 2),
        h: Math.max(1, frame.h - insetY * 2),
      };
      state.elements.push({
        type: "shape",
        shape,
        fill: mixHex(theme.colors.background, "#FFFFFF", 0.7),
        shadow: "medium",
        x: Math.round(card.x),
        y: Math.round(card.y),
        w: Math.round(card.w),
        h: Math.round(card.h),
        adj: radiusAdj(card.w, card.h, theme.spacing.cornerRadius + 2),
        stroke: { color: theme.colors.divider, widthPt: 0.75 },
      });
      state.stats.elements += 2;
      return card;
    }
    case "outline": {
      // 细线框：零填充（全透明占位，防主题色渗透）+ hairline 描边 + 近直角。
      state.elements.push({
        type: "shape",
        shape,
        fill: "#00000000",
        stroke: { color: theme.colors.divider, widthPt: 1 },
        x: Math.round(frame.x),
        y: Math.round(frame.y),
        w: Math.round(frame.w),
        h: Math.round(frame.h),
        adj: radiusAdj(frame.w, frame.h, 4),
      });
      state.stats.elements += 1;
      return frame;
    }
    case "dark": {
      // 墨面：深底三档对角渐层（亮部→纯深→沉部），子节点沿用深色页文字口径。
      state.elements.push({
        type: "shape",
        shape,
        gradient: {
          stops: [
            { pos: 0, color: mixHex(theme.colors.darkBackground, "#FFFFFF", 0.05) },
            { pos: 55, color: theme.colors.darkBackground },
            { pos: 100, color: mixHex(theme.colors.darkBackground, "#0B0A08", 0.22) },
          ],
          angle: 135,
        },
        x: Math.round(frame.x),
        y: Math.round(frame.y),
        w: Math.round(frame.w),
        h: Math.round(frame.h),
        adj: radiusAdj(frame.w, frame.h),
      });
      state.stats.elements += 1;
      return frame;
    }
    default: {
      // surface / soft：主题卡面平贴（圆角/描边/阴影随主题与开关）。
      state.elements.push(
        shapeElement(frame, shape, theme, {
          fill: panelFill(panel.tone, theme),
          shadow: panel.stroke === false ? "none" : "soft",
        }),
      );
      state.stats.elements += 1;
      return frame;
    }
  }
}

const VARIANT_SIZE_KEY: Record<TextVariant, "coverTitle" | "sectionTitle" | "subtitle" | "body" | "caption"> = {
  display: "coverTitle",
  heading: "sectionTitle",
  subtitle: "subtitle",
  body: "body",
  caption: "caption",
};

/** 文字变体 → 契约主题字号档。 */
export function variantSize(variant: TextVariant, contract: LayoutContract): number {
  return contract.theme.sizes[VARIANT_SIZE_KEY[variant]];
}

/** 多段文字（\n 拆段）在框宽下的估算内容高。 */
function neededHeightFor(text: string, sizePt: number, boxWidth: number): number {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .reduce((sum, line) => sum + estimateLines(line, sizePt, boxWidth), 0);
  return lines * estimateLineHeight(sizePt) + estimateLineHeight(sizePt) * 0.35;
}

interface WalkState {
  elements: SpecElement[];
  placements: LeafPlacement[];
  defects: CompileDefect[];
  stats: { elements: number; leaves: number; depth: number; images: number; paths: number };
  sizeOverrides: Map<string, number>;
  packedPaths: Set<string>;
  overlayPaths: Set<string>;
  dark: boolean;
  /** 页级 dark/bg 时的深色组件主题视图（懒生成、整页复用）。 */
  darkTheme?: ResolvedTheme;
  contract: LayoutContract;
}

function gapFor(node: { gapScale?: number }, contract: LayoutContract): number {
  const scale = node.gapScale ?? 1;
  return Math.max(0, snap4(contract.theme.spacing.gutter * scale));
}

/** 容器内子框分配：先扣缝隙，再按权重分（snap 取整，余数给末位，至少 1px）。 */
function splitFrame(frame: Frame, node: ContainerNode, contract: LayoutContract, direction: "row" | "column"): Frame[] {
  const count = node.children.length;
  const span = direction === "row" ? frame.w : frame.h;
  let gap = gapFor(node, contract);
  const totalGap = gap * (count - 1);
  if (count > 1 && totalGap > span - 40) {
    gap = Math.max(0, Math.floor((span - 40) / (count - 1)));
  }
  const usable = Math.max(count, span - gap * (count - 1));
  const weights = node.weights ?? node.children.map(() => 1);
  const weightSum = weights.reduce((a, b) => a + b, 0);
  const sizes: number[] = [];
  let allocated = 0;
  for (let i = 0; i < count; i++) {
    if (i === count - 1) {
      sizes.push(Math.max(1, usable - allocated));
    } else {
      const size = Math.max(1, Math.round((usable * weights[i]!) / weightSum));
      sizes.push(size);
      allocated += size;
    }
  }
  const frames: Frame[] = [];
  let offset = direction === "row" ? frame.x : frame.y;
  for (let i = 0; i < count; i++) {
    const size = sizes[i]!;
    if (direction === "row") {
      frames.push({ x: offset, y: frame.y, w: size, h: frame.h });
      offset += size + gap;
    } else {
      frames.push({ x: frame.x, y: offset, w: frame.w, h: size });
      offset += size + gap;
    }
  }
  return frames;
}

function walk(node: TreeNode, frame: Frame, path: string, depth: number, state: WalkState, panelDark: boolean): void {
  state.stats.depth = Math.max(state.stats.depth, depth);
  if (isLeaf(node)) {
    renderLeaf(node, frame, path, state, panelDark);
    return;
  }
  let base = frame;
  if (node.panel) {
    base = emitPanel(node.panel, frame, state);
    if (node.panel.tone === "dark") panelDark = true;
  }
  const inner = node.pad ? padFrame(base, snap4(node.pad)) : base;
  const childFrames = layoutChildren(node, inner, path, state);
  node.children.forEach((child, i) => walk(child, childFrames[i]!, `${path}/${i}`, depth + 1, state, panelDark));
}

/**
 * justify 打包（仅 column）：text 叶子按内容自然高，其余叶子均分剩余空间，
 * 整组按 start/center/end 落位。缺省（无 justify）走 weights 满分。
 */
function packColumn(
  inner: Frame,
  node: ContainerNode,
  path: string,
  state: WalkState,
): Frame[] {
  const count = node.children.length;
  const gap = gapFor(node, state.contract);
  const totalGap = gap * (count - 1);
  const naturals = node.children.map((child, i) => {
    if (!isLeaf(child) || child.type !== "text") return null;
    state.packedPaths.add(`${path}/${i}`);
    const sizePt = state.sizeOverrides.get(`${path}/${i}`) ?? variantSize(child.variant, state.contract);
    return neededHeightFor(child.text, sizePt, inner.w);
  });
  const naturalSum = naturals.reduce<number>((sum, value) => sum + (value ?? 0), 0);
  if (naturalSum + totalGap > inner.h) {
    state.defects.push({
      path,
      type: "overflow",
      detail: `justify 打包内容高约 ${Math.round(naturalSum + totalGap)}px 超过容器 ${Math.round(inner.h)}px——精简文字、减少子节点或去掉 justify`,
    });
  }
  const flexible = naturals.filter((value) => value === null).length;
  const remaining = Math.max(flexible, inner.h - totalGap - naturalSum);
  const share = flexible > 0 ? Math.floor(remaining / flexible) : 0;
  const contentTotal = naturalSum + share * flexible + totalGap;
  const rawOffset = node.justify === "center"
    ? (inner.h - contentTotal) / 2
    : node.justify === "end"
      ? inner.h - contentTotal
      : 0;
  let y = inner.y + Math.max(0, Math.round(rawOffset));
  return node.children.map((_, i) => {
    const h = naturals[i] ?? Math.max(1, share);
    const childFrame: Frame = { x: inner.x, y, w: inner.w, h };
    y += h + gap;
    return childFrame;
  });
}

function layoutChildren(
  node: { direction: Direction; weights?: number[]; gapScale?: number; justify?: string; children: ChildNode[] },
  inner: Frame,
  path: string,
  state: WalkState,
): Frame[] {
  if (node.direction === "overlay") {
    return node.children.map((child, i) => {
      const place = child.place ?? { x: 0, y: 0, w: 100, h: 100 };
      state.overlayPaths.add(`${path}/${i}`);
      return {
        x: Math.round(inner.x + (inner.w * place.x) / 100),
        y: Math.round(inner.y + (inner.h * place.y) / 100),
        w: Math.max(1, Math.round((inner.w * place.w) / 100)),
        h: Math.max(1, Math.round((inner.h * place.h) / 100)),
      };
    });
  }
  if (node.justify && node.direction === "column") {
    return packColumn(inner, node as ContainerNode, path, state);
  }
  return splitFrame(inner, node as ContainerNode, state.contract, node.direction);
}

function renderLeaf(leaf: LeafNode, frame: Frame, path: string, state: WalkState, panelDark = false): void {
  const { contract } = state;
  const theme = contract.theme;
  state.stats.leaves += 1;
  try {
    switch (leaf.type) {
      case "text": {
        const sizePt = state.sizeOverrides.get(path) ?? variantSize(leaf.variant, contract);
        const element = renderTextLeaf(leaf, frame, theme, sizePt, state.dark || panelDark);
        state.elements.push(element);
        state.stats.elements += 1;
        state.placements.push({
          path,
          kind: "text",
          frame,
          variant: leaf.variant,
          sizePt,
          neededHeight: neededHeightFor(leaf.text, sizePt, frame.w),
          ...(state.packedPaths.has(path) ? { packed: true } : {}),
          ...(state.overlayPaths.has(path) ? { overlay: true } : {}),
        });
        return;
      }
      case "image": {
        const { element, extra } = imageElement(
          frame,
          leaf.url,
          theme,
          leaf.contain === true ? "contain" : "cover",
          {
            radius: leaf.radius === true,
            circle: leaf.circle === true,
            ...(leaf.focus ? { focus: leaf.focus } : {}),
            duotone: leaf.duotone === true,
            grayscale: leaf.grayscale === true,
            ...(leaf.caption ? { caption: leaf.caption } : {}),
          },
        );
        state.elements.push(element);
        state.stats.elements += 1;
        state.stats.images += 1;
        for (const item of extra) {
          state.elements.push(item);
          state.stats.elements += 1;
        }
        state.placements.push({ path, kind: "image", frame, url: leaf.url, contain: leaf.contain === true });
        return;
      }
      case "component": {
        // 深色页（页级 dark/bg）或深色面板上的组件换深色主题视图——
        // 与文字叶子换色口径同源（text→onDarkText），渐隐/卡面/翻字自动随行
        const componentTheme =
          state.dark || panelDark ? (state.darkTheme ??= darkPageTheme(theme)) : theme;
        const elements = expandComponent(leaf, frame, componentTheme, `${path} ${leaf.name}`);
        state.elements.push(...elements);
        state.stats.elements += elements.length;
        state.placements.push({
          path,
          kind: "component",
          frame,
          ...(state.overlayPaths.has(path) ? { overlay: true } : {}),
        });
        return;
      }
      case "path": {
        state.elements.push({
          type: "path",
          d: leaf.d,
          fill: theme.colors.primarySoft,
          x: Math.round(frame.x),
          y: Math.round(frame.y),
          w: Math.round(frame.w),
          h: Math.round(frame.h),
        });
        state.stats.elements += 1;
        state.stats.paths += 1;
        state.placements.push({ path, kind: "path", frame });
        return;
      }
      case "divider": {
        const vertical = frame.h >= frame.w;
        state.elements.push(
          vertical
            ? {
                type: "shape",
                shape: "rect",
                fill: theme.colors.divider,
                x: Math.round(frame.x + (frame.w - 1) / 2),
                y: Math.round(frame.y),
                w: 1,
                h: Math.round(frame.h),
              }
            : {
                type: "shape",
                shape: "rect",
                fill: theme.colors.divider,
                x: Math.round(frame.x),
                y: Math.round(frame.y + (frame.h - 1) / 2),
                w: Math.round(frame.w),
                h: 1,
              },
        );
        state.stats.elements += 1;
        state.placements.push({ path, kind: "divider", frame });
        return;
      }
      case "icon": {
        state.elements.push({
          type: "icon",
          icon: leaf.icon,
          color: theme.colors.primary,
          x: Math.round(frame.x),
          y: Math.round(frame.y),
          w: Math.round(frame.w),
          h: Math.round(frame.h),
        });
        state.stats.elements += 1;
        state.placements.push({
          path,
          kind: "icon",
          frame,
          ...(state.overlayPaths.has(path) ? { overlay: true } : {}),
        });
        return;
      }
      case "chart": {
        const elements = renderChartLeaf(leaf, frame, theme);
        state.elements.push(...elements);
        state.stats.elements += elements.length;
        state.placements.push({ path, kind: "chart", frame });
        return;
      }
      case "table": {
        const elements = renderTableLeaf(leaf, frame, theme, `${path} 表格`);
        state.elements.push(...elements);
        state.stats.elements += elements.length;
        state.placements.push({ path, kind: "table", frame });
        return;
      }
    }
  } catch (error) {
    if (isTreeErrorLike(error)) {
      state.defects.push({ path, type: "overflow", detail: error.message.replace(/^LAYOUT_LEAF_INVALID: /, "") });
      return;
    }
    throw error;
  }
}

export interface CompileOptions {
  /** 当前页码（1 基，注入页脚用）；未传则不注入页码文本。 */
  pageIndex?: number;
  /** 总页数（页脚 "07 / 24" 的分母）。 */
  pageCount?: number;
}

export function compileTree(
  tree: LayoutTree,
  contract: LayoutContract,
  sizeOverrides?: Map<string, number>,
  options: CompileOptions = {},
): CompileResult {
  const dark = tree.dark === true || tree.bg !== undefined;
  const state: WalkState = {
    elements: [],
    placements: [],
    defects: [],
    stats: { elements: 0, leaves: 0, depth: 0, images: 0, paths: 0 },
    sizeOverrides: sizeOverrides ?? new Map(),
    packedPaths: new Set(),
    overlayPaths: new Set(),
    dark,
    contract,
  };
  const theme = contract.theme;
  const spec: PageSpec = {
    background: dark ? theme.colors.darkBackground : theme.colors.background,
    elements: state.elements,
  };
  if (tree.bg) {
    // 背景图铺满整页（cover 裁切不变形），元素顺序即 z 序：背景最底、纱罩其上。
    state.elements.push({
      type: "image",
      url: tree.bg.image,
      fit: "cover",
      x: 0,
      y: 0,
      w: contract.canvas.w,
      h: contract.canvas.h,
    });
    state.stats.elements += 1;
    state.stats.images += 1;
    if (tree.bg.scrim === "gradient") {
      // 渐层纱罩：顶部深（90%）向底部透（15%）——标题区可读、图片下缘保留细节。
      state.elements.push({
        type: "shape",
        shape: "rect",
        gradient: {
          stops: [
            { pos: 0, color: withAlpha(theme.colors.darkBackground, 0.9) },
            { pos: 100, color: withAlpha(theme.colors.darkBackground, 0.15) },
          ],
          angle: 90,
        },
        x: 0,
        y: 0,
        w: contract.canvas.w,
        h: contract.canvas.h,
      });
      state.stats.elements += 1;
    } else if (tree.bg.scrim !== "none") {
      state.elements.push({
        type: "shape",
        shape: "rect",
        fill: scrimFill(theme.colors.darkBackground),
        x: 0,
        y: 0,
        w: contract.canvas.w,
        h: contract.canvas.h,
      });
      state.stats.elements += 1;
    }
  }
  if (tree.title) {
    const bandFrame: Frame = {
      x: contract.contentFrame.x,
      y: contract.titleBand.y,
      w: contract.contentFrame.w,
      h: contract.titleBand.maxBottom - contract.titleBand.y,
    };
    try {
      state.elements.push(...titleBand(tree.title, bandFrame, theme, dark));
      state.stats.elements += 1;
    } catch (error) {
      if (isTreeErrorLike(error)) {
        state.defects.push({ path: "root.title", type: "overflow", detail: error.message.replace(/^LAYOUT_LEAF_INVALID: /, "") });
      } else {
        throw error;
      }
    }
  }
  const rootContainer: ContainerNode = {
    direction: tree.direction,
    ...(tree.weights ? { weights: tree.weights } : {}),
    ...(tree.gapScale !== undefined ? { gapScale: tree.gapScale } : {}),
    ...(tree.pad !== undefined ? { pad: tree.pad } : {}),
    ...(tree.justify !== undefined ? { justify: tree.justify } : {}),
    ...(tree.panel ? { panel: tree.panel } : {}),
    children: tree.children,
  };
  let rootPanelDark = false;
  let rootBase: Frame = contract.contentFrame;
  if (tree.panel) {
    rootBase = emitPanel(tree.panel, contract.contentFrame, state);
    if (tree.panel.tone === "dark") rootPanelDark = true;
  }
  const inner = tree.pad ? padFrame(rootBase, snap4(tree.pad)) : rootBase;
  const childFrames = layoutChildren(rootContainer, inner, "root", state);
  tree.children.forEach((child, i) => walk(child, childFrames[i]!, `root/${i}`, 1, state, rootPanelDark));
  emitFooter(tree, contract, state, options);
  return {
    spec,
    placements: state.placements,
    defects: state.defects,
    stats: state.stats,
    ...(tree.bg ? { bg: { image: tree.bg.image, scrim: tree.bg.scrim !== "none" } } : {}),
  };
}

/**
 * 页脚注入（deck 契约，非逐页词汇）：细分隔线 + 左侧标识 + 中部分类 + 右侧页码。
 * 只落在有标题带的常规内容页——封面/章节等整页构图（省略 title）自动跳过；
 * 深色页与 bg 图页沿用换色口径（muted→深色页口径，同 darkPageTheme 的 45% 混底）。
 */
function emitFooter(tree: LayoutTree, contract: LayoutContract, state: WalkState, options: CompileOptions): void {
  const { footer } = contract.theme;
  const { colors, sizes } = contract.theme;
  const { contentFrame, canvas } = contract;
  if (!footer.brand && !footer.label && !footer.pageNumbers) return;
  // 整页构图（省略 title）= 封面/章节，不放页脚。
  if (!tree.title) return;
  const muted = state.dark
    ? mixHex(colors.onDarkText, colors.darkBackground, 0.45)
    : colors.textMuted;
  const lineY = canvas.h - 40;
  state.elements.push({
    type: "shape",
    shape: "rect",
    fill: colors.divider,
    x: contentFrame.x,
    y: lineY,
    w: contentFrame.w,
    h: 1,
  });
  state.stats.elements += 1;
  const sizePt = sizes.caption;
  const colH = 22;
  const colY = lineY + 10;
  // 三段等分，盒子互不重叠（同排多文本的墨迹闸门口径）。
  const colW = Math.round(contentFrame.w / 3);
  if (footer.brand) {
    state.elements.push(
      textElement(
        { x: contentFrame.x, y: colY, w: colW, h: colH },
        [{ runs: [{ text: footer.brand, sizePt, bold: true, color: muted }] }],
      ),
    );
    state.stats.elements += 1;
  }
  if (footer.label) {
    state.elements.push(
      textElement(
        { x: contentFrame.x + colW, y: colY, w: colW, h: colH },
        [{ runs: [{ text: footer.label, sizePt, color: muted }], align: "center" }],
      ),
    );
    state.stats.elements += 1;
  }
  if (footer.pageNumbers && options.pageIndex !== undefined) {
    const pageNo = `${options.pageIndex}${options.pageCount !== undefined ? ` / ${options.pageCount}` : ""}`;
    state.elements.push(
      textElement(
        { x: contentFrame.x + colW * 2, y: colY, w: contentFrame.w - colW * 2, h: colH },
        [{ runs: [{ text: pageNo, sizePt, color: muted }], align: "right" }],
      ),
    );
    state.stats.elements += 1;
  }
}
