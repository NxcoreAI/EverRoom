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
