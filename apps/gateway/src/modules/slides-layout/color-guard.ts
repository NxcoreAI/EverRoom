/**
 * 颜色守门：把"对比度与饱和度"从审美判断变成可计算的规则。
 *
 * 背景（为什么需要它）：风格卡的色板来自风格图的像素聚类，聚类只回答"这张图有什么颜色"，
 * 不回答"这个颜色配不配占 90% 画布"。真实产物里出现过：满屏高饱和深红 + 同色系暗红柱子 +
 * 数据标签用系列色压在柱子上（深红字压深红柱，基本不可读）。这些都用同一个算式就能拦住。
 *
 * 规则（与 docs/slides-quality-batch1-plan.zh-CN.md §2.4 一致）：
 *   C1 正文对比度 ≥ 4.5:1（≥24pt 大字 ≥ 3:1）—— 违反则改色
 *   C2 非文本图元对比 ≥ 3:1 —— 违反则改色
 *   C3 APCA Lc ≥ 60 —— **只记录不修改**（法定标准是 WCAG 2，APCA 只作感知预警）
 *   C4 同色相并置明度差 ΔL* ≥ 0.15 —— 违反则拉开明度
 *   C5 大面积（背景/色带）饱和度 ≤ 0.35 —— 违反则降饱和（保持色相）
 *   C6 图表数据标签禁用系列色 —— 在 leaf-renderers 落地，不在这里
 *
 * 设计原则：**色相继承，明度与饱和由代码算**。风格卡提供色相（品牌识别度靠色相），
 * L 与 S 由本模块按场景与面积反推。
 */

// 本模块的规则与场景无关：阈值是全局的（对比度/明度差/饱和度上限）。
// 场景只影响字号与字数，不影响颜色规则。

// ---------------------------------------------------------------- 颜色空间基础

export type Rgb = { r: number; g: number; b: number };

/** 是否为可精确计算的 6 位 hex（8 位带 alpha 的填充要先合成到实际底色，这里不猜）。 */
export function isPlainHex(hex: string | undefined): hex is string {
  return typeof hex === "string" && /^#?[0-9a-fA-F]{6}$/.test(hex.trim());
}

export function hexToRgb(hex: string): Rgb {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return { r: 0, g: 0, b: 0 };
  const v = m[1]!;
  return {
    r: parseInt(v.slice(0, 2), 16),
    g: parseInt(v.slice(2, 4), 16),
    b: parseInt(v.slice(4, 6), 16),
  };
}

export function rgbToHex(rgb: Rgb): string {
  const part = (v: number) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0");
  return `#${part(rgb.r)}${part(rgb.g)}${part(rgb.b)}`;
}

/** sRGB 相对亮度（WCAG 2 口径）。 */
export function relativeLuminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  const channel = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG 2 对比度（1~21）。 */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * CIE L*（0~100）：感知明度。**同色相并置的"看起来是不是一个东西"要用 L\* 判断**，
 * 用相对亮度判断会把深色区放大、浅色区压缩，导致深底上的两个暗色误判为可区分。
 */
export function lstar(hex: string): number {
  const y = relativeLuminance(hex);
  const f = y > 0.008856 ? Math.cbrt(y) : 7.787 * y + 16 / 116;
  return 116 * f - 16;
}

/** 两个颜色的感知明度差（0~100）。 */
export function deltaLstar(a: string, b: string): number {
  return Math.abs(lstar(a) - lstar(b));
}

export type Hsl = { h: number; s: number; l: number };

export function rgbToHsl(hex: string): Hsl {
  const { r, g, b } = hexToRgb(hex);
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
  else if (max === gn) h = ((bn - rn) / d + 2) / 6;
  else h = ((rn - gn) / d + 4) / 6;
  return { h: h * 360, s, l };
}

export function hslToHex({ h, s, l }: Hsl): string {
  const hh = ((h % 360) + 360) % 360 / 360;
  const ss = Math.min(1, Math.max(0, s));
  const ll = Math.min(1, Math.max(0, l));
  if (ss === 0) {
    const v = Math.round(ll * 255);
    return rgbToHex({ r: v, g: v, b: v });
  }
  const q = ll < 0.5 ? ll * (1 + ss) : ll + ss - ll * ss;
  const p = 2 * ll - q;
  const channel = (t: number) => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  return rgbToHex({
    r: channel(hh + 1 / 3) * 255,
    g: channel(hh) * 255,
    b: channel(hh - 1 / 3) * 255,
  });
}

/** 色相距离（0~180）。 */
export function hueDistance(a: string, b: string): number {
  const d = Math.abs(rgbToHsl(a).h - rgbToHsl(b).h);
  return Math.min(d, 360 - d);
}

/**
 * APCA 近似 Lc（只作次级预警，不是法定标准）。返回值约 -108~108。
 * 采用 APCA-W3 公开算法：黑电平软钳制 + 按正/负极性分别取幂 + 低对比度裁剪。
 */
export function apcaLc(textHex: string, backgroundHex: string): number {
  const BLACK_THRESHOLD = 0.022;
  const BLACK_CLAMP = 1.414;
  const SCALE = 1.14;
  const OFFSET = 0.027;
  const DELTA_Y_MIN = 0.0005;
  const LO_CLIP = 0.1;

  const clampBlack = (y: number) => (y > BLACK_THRESHOLD ? y : y + (BLACK_THRESHOLD - y) ** BLACK_CLAMP);
  const yText = clampBlack(relativeLuminance(textHex));
  const yBg = clampBlack(relativeLuminance(backgroundHex));
  if (Math.abs(yBg - yText) < DELTA_Y_MIN) return 0;

  if (yBg > yText) {
    // 深字浅底
    const sapc = (yBg ** 0.56 - yText ** 0.57) * SCALE;
    return sapc < LO_CLIP ? 0 : (sapc - OFFSET) * 100;
  }
  // 浅字深底（极性为负）
  const sapc = (yBg ** 0.65 - yText ** 0.62) * SCALE;
  return sapc > -LO_CLIP ? 0 : (sapc + OFFSET) * 100;
}

// ---------------------------------------------------------------- 修正工具

/** 保持色相与饱和度，只把明度朝某个方向推，直到满足断言或推到端点。 */
export function stepLightness(
  hex: string,
  target: string,
  predicate: (candidate: string) => boolean,
  steps = 24,
): string {
  if (predicate(hex)) return hex;
  const start = rgbToHsl(hex);
  const end = rgbToHsl(target);
  // 近中性色的色相是噪声（#FAFAF8 的 s 来自两个通道差 2），拉明度时按纯灰走，
  // 否则会算出一个"橄榄灰"这种谁也没选过的颜色。
  const saturation = start.s < 0.08 ? 0 : start.s;
  for (let i = 1; i <= steps; i += 1) {
    const l = start.l + ((end.l - start.l) * i) / steps;
    const candidate = hslToHex({ h: start.h, s: saturation, l });
    if (predicate(candidate)) return candidate;
  }
  return hslToHex({ h: end.h, s: end.s, l: end.l });
}

/** 保持色相与明度，只把饱和度压到上限（C5：大面积必须低饱和）。 */
export function capSaturation(hex: string, maxSaturation: number): string {
  const hsl = rgbToHsl(hex);
  if (hsl.s <= maxSaturation) return hex;
  return hslToHex({ ...hsl, s: maxSaturation });
}

/** 色相不变、明度朝 `toward` 拉开，直到两色 ΔL* 达标（C4：同色相并置）。 */
export function separateLightness(hex: string, other: string, minDelta: number, toward: "darker" | "lighter"): string {
  if (deltaLstar(hex, other) >= minDelta) return hex;
  const hsl = rgbToHsl(hex);
  const target = toward === "darker" ? 0 : 100;
  for (let i = 1; i <= 24; i += 1) {
    const l = hsl.l + ((target / 100 - hsl.l) * i) / 24;
    const candidate = hslToHex({ h: hsl.h, s: hsl.s, l });
    if (deltaLstar(candidate, other) >= minDelta) return candidate;
  }
  return hslToHex({ h: hsl.h, s: hsl.s, l: target / 100 });
}

// ---------------------------------------------------------------- 阈值（单一出处）

export const COLOR_RULES = {
  /** C1 正文对比度下限。 */
  bodyContrast: 4.5,
  /** C1 大字（≥24pt）对比度下限。 */
  largeTextContrast: 3,
  /** C2 非文本图元对比度下限。 */
  graphicContrast: 3,
  /** C3 APCA 次级预警线（只记录）。 */
  apcaBody: 60,
  /** C4 同色相并置的最小感知明度差（L* 0~100 制）。 */
  minDeltaLstar: 15,
  /** C5 大面积（背景/色带）饱和度上限。 */
  largeAreaSaturation: 0.35,
  /** C5 大面积占比判定线（占画布比例）。 */
  largeAreaShare: 0.3,
  /** 图形色（主色/强调色）饱和度上限：小面积允许鲜，但不能荧光。 */
  graphicSaturation: 0.9,
} as const;

export interface ColorViolation {
  rule: "C1" | "C2" | "C3" | "C4" | "C5";
  role: string;
  detail: string;
  before: string;
  after: string;
}

export interface GuardPaletteInput {
  background: string;
  surface: string;
  primary: string;
  accent: string;
  text: string;
  textMuted: string;
  onDarkText: string;
}

export interface GuardPaletteResult {
  palette: GuardPaletteInput;
  violations: ColorViolation[];
  /** 给人看的修正说明（进 styleParams notes，不进用户界面）。 */
  notes: string[];
}

/**
 * 色板守门：**色相全部保留**，只重算 L 与 S。
 *
 * 顺序很重要：先降大面积饱和（C5，它改变颜色的"体质"），再按对比度调明度（C1/C2/C4），
 * 否则先调明度会让饱和度修正把刚调好的对比度又破坏掉。
 */
export function guardPalette(input: GuardPaletteInput): GuardPaletteResult {
  const violations: ColorViolation[] = [];
  const notes: string[] = [];

  const push = (rule: ColorViolation["rule"], role: string, detail: string, before: string, after: string) => {
    if (before.toLowerCase() === after.toLowerCase()) return;
    violations.push({ rule, role, detail, before, after });
    notes.push(`${rule} ${role}：${detail}（${before} → ${after}）`);
  };

  // ---- C5：底色是最大面积，饱和度必须压住。图 01 的「满屏饱和深红」由这条拦住。
  const background = capSaturation(input.background, COLOR_RULES.largeAreaSaturation);
  push("C5", "background", "大面积底色饱和度超上限", input.background, background);

  // 底色定下来后，判断是深底还是浅底：后续明度都朝远离底色的方向推。
  const darkBg = relativeLuminance(background) < 0.35;
  const inkTarget = darkBg ? "#ffffff" : "#000000";

  // ---- C1 正文：≥4.5:1
  const text = stepLightness(
    input.text,
    inkTarget,
    (candidate) => contrastRatio(candidate, background) >= COLOR_RULES.bodyContrast,
  );
  push("C1", "text", "正文对比度不足 4.5:1", input.text, text);

  // ---- C1 静音字：≥3:1（它承载来源与注释，掉到 2.x 就变成"看不清的小字"）
  const textMuted = stepLightness(
    input.textMuted,
    text,
    (candidate) => contrastRatio(candidate, background) >= COLOR_RULES.graphicContrast,
  );
  push("C1", "textMuted", "静音字对比度不足 3:1", input.textMuted, textMuted);

  // ---- C5 图形色：允许鲜，但不允许荧光；然后 C2 保证图形在底色上看得见
  const cappedPrimary = capSaturation(input.primary, COLOR_RULES.graphicSaturation);
  const primary = stepLightness(
    cappedPrimary,
    inkTarget,
    (candidate) => contrastRatio(candidate, background) >= COLOR_RULES.graphicContrast,
  );
  push("C2", "primary", "主色在底色上对比度不足 3:1", input.primary, primary);

  const cappedAccent = capSaturation(input.accent, COLOR_RULES.graphicSaturation);
  const accent = stepLightness(
    cappedAccent,
    inkTarget,
    (candidate) => contrastRatio(candidate, background) >= COLOR_RULES.graphicContrast,
  );
  push("C2", "accent", "强调色在底色上对比度不足 3:1", input.accent, accent);

  // ---- C4：主色与底色同色相时必须拉开明度（暗红柱压深红底就是这条）
  let separatedPrimary = primary;
  if (hueDistance(primary, background) <= 30 && deltaLstar(primary, background) < COLOR_RULES.minDeltaLstar) {
    separatedPrimary = separateLightness(primary, background, COLOR_RULES.minDeltaLstar, darkBg ? "lighter" : "darker");
    push("C4", "primary", "与底色同色相且明度差不足", primary, separatedPrimary);
  }

  // ---- 卡面：与底色必须可辨（否则卡片在白上白隐形），但又不能抢眼
  const surface = ensureSurface(input.surface, background);

  // ---- C3：只记录，不改
  for (const [role, hex] of [
    ["text", text],
    ["textMuted", textMuted],
  ] as const) {
    const lc = apcaLc(hex, background);
    if (lc < COLOR_RULES.apcaBody) notes.push(`C3 ${role}：APCA Lc ${lc.toFixed(1)} < ${COLOR_RULES.apcaBody}（仅预警，未修改）`);
  }

  return {
    palette: {
      background,
      surface,
      primary: separatedPrimary,
      accent,
      text,
      textMuted,
      onDarkText: input.onDarkText,
    },
    violations,
    notes,
  };
}

/**
 * 图表系列色守门：每一条都必须**在其承载底色上可辨**（C2 ≥3:1）且与底色不是同一块（C4 ΔL* ≥15）。
 *
 * 真实产物里的典型失效：暗红柱压在深红底上、系列色等于底色、第六条系列与第五条几乎同色。
 * 这里只做"可见性"修复，不改色相——品牌色相必须保住。
 */
export function ensureSeriesVisible(
  series: string[],
  background: string,
): { series: string[]; notes: string[] } {
  const notes: string[] = [];
  const darkBg = relativeLuminance(background) < 0.35;
  const toward = darkBg ? "#ffffff" : "#000000";
  const patched = series.slice(0, 6).map((hex, index) => {
    let out = stepLightness(hex, toward, (candidate) => contrastRatio(candidate, background) >= COLOR_RULES.graphicContrast);
    if (deltaLstar(out, background) < COLOR_RULES.minDeltaLstar) {
      out = separateLightness(out, background, COLOR_RULES.minDeltaLstar, darkBg ? "lighter" : "darker");
    }
    if (out.toLowerCase() !== hex.toLowerCase()) {
      notes.push(`C2/C4 chartSeries[${String(index)}] 在底色上不可辨，已调明度（${hex} → ${out}）`);
    }
    return out;
  });
  return { series: patched, notes };
}

/** 卡面：与底色保持可辨但不抢眼（相对亮度差落在 0.02~0.12）。 */
function ensureSurface(surface: string, background: string): string {
  const base = relativeLuminance(background);
  const current = relativeLuminance(surface);
  const delta = Math.abs(current - base);
  if (delta >= 0.02) return surface;
  return mix(surface, base > 0.5 ? "#000000" : "#ffffff", 0.06);
}

function mix(a: string, b: string, amount: number): string {
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  return rgbToHex({
    r: ca.r + (cb.r - ca.r) * amount,
    g: ca.g + (cb.g - ca.g) * amount,
    b: ca.b + (cb.b - ca.b) * amount,
  });
}

/**
 * 节点级守门（供编译期使用）：给定文字色与其身后真实的承载色，返回可读的替代色。
 * 用途：`tone: primary` 压在 `panel: tint` 上、`stats` 落在墨面板上这类组合。
 *
 * 注意：本册只在色板级与图表标签落地；节点级调用留给第二册（需要把承载面色
 * 贯穿编译递归），函数先就位并带测试，避免第二册重新设计。
 */
export function ensureContrast(foreground: string, backdrop: string, minRatio: number): string {
  if (!isPlainHex(foreground) || !isPlainHex(backdrop)) return foreground;
  if (contrastRatio(foreground, backdrop) >= minRatio) return foreground;
  const darkBackdrop = relativeLuminance(backdrop) < 0.35;
  return stepLightness(
    foreground,
    darkBackdrop ? "#ffffff" : "#000000",
    (candidate) => contrastRatio(candidate, backdrop) >= minRatio,
  );
}

export function guardToneOn(foreground: string, backdrop: string, kind: "text" | "graphic" = "text"): string {
  return ensureContrast(foreground, backdrop, kind === "text" ? COLOR_RULES.bodyContrast : COLOR_RULES.graphicContrast);
}
