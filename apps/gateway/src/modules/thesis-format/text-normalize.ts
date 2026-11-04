/**
 * 论文排版 v2 的标题归一化与相似度（方案 §6.1 / §6.2）。
 *
 * 模板槽位匹配与内容章节识别必须用同一套归一化，否则「一、业务场景分析」和
 * 「业务场景分析」永远对不上。这里只做纯函数，零依赖，方便单测与复用。
 */

/** 章节编号前缀（剥离用）：一、/（二）/1./1.1.1/第3章/§2 等。 */
const NUMBERING_PREFIX = [
  /^\s*第\s*[0-9一二三四五六七八九十百千]+\s*[章节篇部]\s*[、.．:：]?\s*/,
  /^\s*[（(]\s*[0-9一二三四五六七八九十百千]+\s*[)）]\s*/,
  /^\s*[0-9]+(?:\s*[.．]\s*[0-9]+)*\s*[.．、)）]?\s*/,
  /^\s*[一二三四五六七八九十百千]+\s*[、.．:：]\s*/,
  /^\s*[A-Za-z]\s*[.、)）]\s*/,
  /^\s*[§#]+\s*[0-9.]*\s*/,
];

/**
 * 剥掉标题开头的编号，返回 { text, number }。
 * number 保留原文编号（诊断与"编号体系是否同类"的判断要用）。
 */
export function stripNumbering(raw: string): { text: string; number?: string } {
  let text = (raw ?? "").replace(/\u3000/g, " ").trim();
  for (const pattern of NUMBERING_PREFIX) {
    const match = pattern.exec(text);
    if (!match) continue;
    const rest = text.slice(match[0].length).trim();
    // 整段都是编号（如单独的 "1.1"）就别剥了，否则得到空标题
    if (!rest) continue;
    return { text: rest, number: match[0].trim().replace(/\s+/g, "") };
  }
  return { text };
}

/** 编号体系归类：判断两个标题的编号是否同一套（一/1./（一））。 */
export type NumberingFamily = "cn" | "decimal" | "parenthesized" | "alpha" | "none";

export function numberingFamily(number: string | undefined): NumberingFamily {
  if (!number) return "none";
  if (/^[（(]/.test(number)) return "parenthesized";
  if (/^第\s*[0-9一二三四五六七八九十]/.test(number)) return "cn";
  if (/^[一二三四五六七八九十百千]/.test(number)) return "cn";
  if (/^[0-9]/.test(number)) return "decimal";
  if (/^[A-Za-z]/.test(number)) return "alpha";
  return "none";
}

/**
 * 标题归一化：剥编号 → NFKC（全角转半角）→ 去标点与空白 → 小写。
 * 结果用于精确匹配与 token 生成；展示仍用原文。
 */
export function normalizeTitle(raw: string): string {
  const { text } = stripNumbering(raw ?? "");
  return text
    .normalize("NFKC")
    .replace(/[\s\u3000]+/g, "")
    .replace(/[·・、，,。.；;：:!！?？"'“”‘’（）()【】\[\]《》<>—–\-_/\\|]+/g, "")
    .toLowerCase();
}

/** 中文按 2-gram、英文按词切分（归一化之后）。 */
export function titleTokens(normalized: string): string[] {
  const tokens = new Set<string>();
  for (const chunk of normalized.split(/[^0-9a-z\u4e00-\u9fa5]+/).filter(Boolean)) {
    if (/^[0-9a-z]+$/.test(chunk)) {
      tokens.add(chunk);
      continue;
    }
    if (chunk.length === 1) {
      tokens.add(chunk);
      continue;
    }
    for (let index = 0; index < chunk.length - 1; index += 1) tokens.add(chunk.slice(index, index + 2));
    tokens.add(chunk.slice(-2));
  }
  return [...tokens];
}

/** Jaccard 相似度（0–1）。 */
export function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setB = new Set(b);
  let shared = 0;
  for (const token of new Set(a)) if (setB.has(token)) shared += 1;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : shared / union;
}

/** 归一化标题的 tokens（常用组合，省得调用方每次写两步）。 */
export function tokensOfTitle(raw: string): string[] {
  return titleTokens(normalizeTitle(raw));
}
