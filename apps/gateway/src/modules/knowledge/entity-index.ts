/**
 * 实体名匹配纯函数（entity-room-plan §4.2）：③″ 解析层的字面比对件。
 *
 * 比对目标从 wiki 页标题换成实体注册表（name + aliases）；
 * 精确层用 normalizeEntityName，模糊层用 bigram Dice。
 * 零 API 成本、零状态，单测直接覆盖。
 */

/**
 * 实体名归一化：NFC → 去首尾空白 → 折叠连续空白为单空格 → 小写。
 * 精确匹配与 Dice 比对都在归一化形态上进行。
 */
export function normalizeEntityName(name: string): string {
  return name.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * bigram Dice 系数：模糊匹配/同名扫描的统一量尺。
 * ≥0.75 且同 kind 且双方 weak → 确定性自动合并；
 * [0.6, 0.75) → LLM 同一性判定带；<0.6 → 分立。
 */
export function bigramDiceSimilarity(a: string, b: string): number {
  const gramsOf = (text: string): string[] => {
    const normalized = text.replace(/\s+/g, "").toLowerCase();
    if (normalized.length < 2) return normalized.length === 1 ? [normalized] : [];
    const grams: string[] = [];
    for (let i = 0; i + 1 < normalized.length; i += 1) grams.push(normalized.slice(i, i + 2));
    return grams;
  };
  const gramsA = gramsOf(a);
  const gramsB = gramsOf(b);
  if (gramsA.length === 0 || gramsB.length === 0) return 0;
  const counter = new Map<string, number>();
  for (const gram of gramsA) counter.set(gram, (counter.get(gram) ?? 0) + 1);
  let overlap = 0;
  for (const gram of gramsB) {
    const count = counter.get(gram) ?? 0;
    if (count > 0) {
      overlap += 1;
      counter.set(gram, count - 1);
    }
  }
  return (2 * overlap) / (gramsA.length + gramsB.length);
}

/**
 * 中文姓氏称谓的确定性解析（FA 场景）：「陈总」「沈老师」「李董」这类
 * 姓氏+称谓指代在 bigram Dice 上与全名相似度为 0（"陈总" vs "陈砚秋"），
 * 永远进不了模糊合并带。这条纯函数把称谓折叠为姓氏锚点：给定抽取名与
 * 候选池（name+aliases），当且仅当抽取名是「单姓+称谓后缀」且候选池中
 * 存在**唯一**同姓的人物实体时，返回该实体名——多候选（两个陈姓）不猜。
 */
const SURNAME_TITLES = ["总", "董", "老师", "教授", "博士", "哥", "姐", "叔", "阿姨"];

/** 判定 name 是否为「单姓 + 称谓后缀」形态（如"陈总""王老师"）。 */
export function isSurnameTitle(name: string): boolean {
  const trimmed = name.trim();
  if (trimmed.length < 2 || trimmed.length > 3) return false;
  const surname = trimmed.slice(0, 1);
  const title = trimmed.slice(1);
  // 2 字：姓+称谓（陈总）；3 字仅允许双字称谓（X老师/X教授/X博士）
  if (trimmed.length === 3 && !["老师", "教授", "博士", "阿姨"].includes(title)) return false;
  if (trimmed.length === 2 && !SURNAME_TITLES.includes(title)) return false;
  // 姓氏必须是 CJK（排除"OK""AI"这类拉丁串）
  return /[\u4e00-\u9fff]/u.test(surname);
}

/**
 * 称谓解析：input 为称谓形态时，在 personNames（同池人物实体的 name+aliases
 * 原样值）里找唯一同姓者。命中返回该实体名；无候选或多候选返回 null。
 * 复姓（欧阳/司马等）不在本规则处理范围——称谓形态本身已排除。
 */
export function resolveSurnameTitle(
  input: string,
  personNames: string[],
): string | null {
  if (!isSurnameTitle(input)) return null;
  const surname = input.trim().slice(0, 1);
  const matches = [...new Set(personNames)].filter((candidate) => {
    const normalized = candidate.trim();
    return normalized.startsWith(surname) && /[\u4e00-\u9fff]/u.test(normalized.slice(1, 2));
  });
  return matches.length === 1 ? matches[0]! : null;
}

/** bestMatch 结果：命中的候选（归一化前的原样值）与得分。 */
export interface NameMatch {
  value: string;
  score: number;
}

/**
 * 在候选池（name + aliases 全量、已归一化）里找与 input 最接近的一个。
 * 并列取先出现者；池空或 input 归一化后为空返回 null。
 */
export function bestMatch(input: string, pool: string[]): NameMatch | null {
  const query = normalizeEntityName(input);
  if (!query || pool.length === 0) return null;
  let best: NameMatch | null = null;
  const seen = new Set<string>();
  for (const candidate of pool) {
    const normalized = normalizeEntityName(candidate);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    const score = normalized === query ? 1 : bigramDiceSimilarity(query, normalized);
    if (!best || score > best.score) best = { value: candidate, score };
  }
  return best;
}
