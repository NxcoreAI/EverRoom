/**
 * ③ 实体匹配候选层（plan §5.2）：纯字符串运算，只排序不判决。
 *
 * 文档侧：标题 + 正文首段抽 token（CJK bigram + 拉丁词）；
 * Room 侧：wiki 页面标题当术语表，token 命中按区分度加权——
 * weight = log(1 + Room总数 / 命中该 token 的 Room 数)（IDF 思想，
 * 平滑 +1 防单 Room 时除零），score = Σweight。
 * 各 Room 都有的词（"评审/方案"）权重趋零，独占词高权重。
 */

/** 中英混排停用词（高频无区分度，③ 层直接滤掉）。 */
const STOPWORDS = new Set([
  "以及", "可以", "我们", "他们", "这个", "那个", "一个", "没有", "进行", "通过",
  "对于", "相关", "如下", "目前", "之后", "之前", "如果", "但是", "因为", "所以",
  "the", "a", "an", "and", "or", "of", "to", "in", "for", "on", "with", "is",
  "are", "was", "were", "be", "been", "at", "by", "from", "as", "it", "this",
  "that", "we", "you", "they", "he", "she", "will", "would", "should", "can",
  "may", "not", "no", "yes", "into", "about", "over", "under", "then", "than",
]);

export function isStopword(token: string): boolean {
  return STOPWORDS.has(token);
}

/**
 * 切 token：CJK 连续段切 bigram（单字噪声大），拉丁/数字连续段小写整词。
 * 长度 ≤1 的 CJK 段丢弃；拉丁词需 ≥2 字符。
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const segments = text.match(/[一-鿿]+|[A-Za-z0-9][A-Za-z0-9_-]*/g) ?? [];
  for (const segment of segments) {
    if (/[一-鿿]/.test(segment)) {
      for (let i = 0; i + 1 < segment.length; i += 1) {
        tokens.push(segment.slice(i, i + 2));
      }
      // 三字及以上整词也入表：bigram 覆盖子串，整词给 ⑤ 卷宗更高可读性
      if (segment.length >= 3 && !isStopword(segment)) tokens.push(segment);
    } else {
      const lower = segment.toLowerCase();
      if (lower.length >= 2) tokens.push(lower);
    }
  }
  return tokens.filter((token) => !isStopword(token));
}

/** 文档侧术语集：标题 token 权重 ×2（标题比正文首段更具主题性），去重保序。 */
export function documentTerms(title: string, bodyHead: string): Map<string, number> {
  const weights = new Map<string, number>();
  for (const token of tokenize(title)) {
    weights.set(token, Math.max(weights.get(token) ?? 0, 2));
  }
  for (const token of tokenize(bodyHead)) {
    if (!weights.has(token)) weights.set(token, 1);
  }
  return weights;
}

/** Room 侧术语表：wiki 页面标题 token 集（去重）。 */
export function roomTerms(pageTitles: string[]): Set<string> {
  const terms = new Set<string>();
  for (const title of pageTitles) {
    for (const token of tokenize(title)) terms.add(token);
  }
  return terms;
}

export interface EntityScore {
  roomId: string;
  /** Σ 命中 token 的 IDF 权重（未归一；跨文档比较时同一候选池内可比）。 */
  score: number;
  /** 命中的 token 及各自权重，进 ⑤ 卷宗当证据。 */
  matched: Array<{ token: string; weight: number }>;
}

/**
 * 对候选池打分并取 top N。
 * roomTokenSets：roomId → 该 Room wiki 页面标题的 token 集。
 * df 统计在命中 token 维度上做：某 token 只出现在少数 Room 术语表里才高分。
 */
export function scoreEntityMatches(
  terms: Map<string, number>,
  roomTokenSets: Map<string, Set<string>>,
  topN = 5,
): EntityScore[] {
  const roomIds = [...roomTokenSets.keys()];
  if (roomIds.length === 0 || terms.size === 0) return [];

  // df：术语表里包含该 token 的 Room 数（文档 token 不在任何术语表中则 df=0，无信号）
  const df = new Map<string, number>();
  for (const token of terms.keys()) {
    let count = 0;
    for (const roomId of roomIds) {
      if (roomTokenSets.get(roomId)!.has(token)) count += 1;
    }
    df.set(token, count);
  }

  const results: EntityScore[] = [];
  for (const roomId of roomIds) {
    const tokenSet = roomTokenSets.get(roomId)!;
    let score = 0;
    const matched: Array<{ token: string; weight: number }> = [];
    for (const [token, termWeight] of terms) {
      if (!tokenSet.has(token)) continue;
      const documentFrequency = df.get(token) ?? 0;
      if (documentFrequency === 0) continue;
      const weight = Math.log(1 + roomIds.length / documentFrequency) * termWeight;
      score += weight;
      matched.push({ token, weight: Number(weight.toFixed(4)) });
    }
    if (score > 0) results.push({ roomId, score: Number(score.toFixed(4)), matched });
  }

  return results.sort((a, b) => b.score - a.score).slice(0, topN);
}

/**
 * bigram Dice 系数：⑤ create_new 提议名的重名去重（plan §4.2）。
 * ≥ threshold 视为同一 Room（归并而非新建）。
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
