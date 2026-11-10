import type { SlidesProgressPage } from "./slides-draft-doc.js";

/**
 * 素材检索单条命中（原 modules/materials 退役后内联：slides 配图预取仅消费
 * 该结构，检索源由调用方通过 `searchMaterials` 注入）。
 */
export interface MaterialHit {
  ref: string;
  kind: "screenshot" | "photo" | "web-clip" | "document";
  desc: string;
  meta: string;
  rank: number;
}

/**
 * arrange 前置素材预取：网关在派发 slides-planner 之前，按确认稿的每页配图意图
 * （`materialHints`，缺省用标题+要点）做一次确定性本地素材检索，把命中随输入下发。
 *
 * 为什么不在模型里检索：2026-10-22 实测 27 页 deck 的 arrange 用了 21~40 次
 * `material_search`，每轮都是一次完整模型往返（思考 10~80s），420s 预算被检索
 * 循环吃光；把检索移到网关后，模型只负责从 `materialHits` 里挑图或写 imagePrompt。
 *
 * 这里的 query 提取是纯启发式（不做中文分词）：对每页文本取 2 字窗口 + ASCII 词，
 * 按出现频次排序、滤掉功能词/泛化词——材料库检索本身是 `includes` 子串匹配，
 * 2 字窗口（如「摩托」「雪山」）足以命中「雪地摩托」「雪山背景」这类摘要。
 */

export interface SlidesPrefetchedMaterialHit {
  /** `everroom-material://<hash>`，可直接放进 materials.url / image block assetRef。 */
  ref: string;
  kind: string;
  desc: string;
  meta: string;
}

export interface SlidesPageMaterialHits {
  /** 0 起，与输入 `draftPages` 顺序一致（注意：prewarm 的 pageIndex 从 1 起）。 */
  pageIndex: number;
  /** 本页实际用于检索的词组；供 planner 判断命中是否切题。 */
  query: string;
  hits: SlidesPrefetchedMaterialHit[];
}

export interface PrefetchSlidesMaterialsInput {
  pages: SlidesProgressPage[];
  /** MaterialsService.search 的同构入口（同步 DB 查询）。 */
  search: (query: string, limit?: number) => MaterialHit[];
  /** 每页最多带几条命中；缺省 3，上限 6。 */
  limitPerPage?: number;
}

const MAX_PAGES = 32;
const DEFAULT_HITS_PER_PAGE = 3;
const MAX_HITS_PER_PAGE = 6;
const MAX_TERMS_PER_QUERY = 6;
/** 每页最多拆成几次检索：长配图描述会拆成多个 6 词 query，覆盖多张不同画面。 */
const MAX_SEARCHES_PER_PAGE = 4;
const MAX_QUERY_CHARS = 160;
const MAX_DESC_CHARS = 120;
const MAX_META_CHARS = 48;
/** 整册命中总量上限：防止素材库很大时把 32 页 × N 条命中全灌进上下文。 */
const MAX_TOTAL_HITS = 72;

/**
 * 这些字符出现在 2 字窗口里，基本可判定该窗口不是画面词（数量词、虚词、泛化量词）。
 * 例：「三张」「张等」「等宽」「两人」「我们」「一个」都被滤掉。
 */
const FUNCTION_CHARS = new Set([
  ..."的了在是和与及或是有为以于把被让从到对等各这那每张幅并满全一二三四五六七八九十两",
]);

/** 高频泛化词：命中它们只会把整库图片都捞回来，没有区分度。 */
const STOP_TERMS = new Set([
  "我们", "你们", "他们", "一个", "一种", "可以", "进行", "通过", "以及", "其中",
  "因为", "所以", "这个", "那个", "这些", "那些", "同时", "用于", "位于", "主要",
  "核心", "包括", "支持", "实现", "提升", "增长", "相关", "内容", "信息", "数据",
  "页面", "部分", "整体", "视觉", "设计", "风格", "照片", "图片", "图像", "画面",
  "素材", "示意", "展示", "呈现", "场景", "背景", "左右", "大约", "以及", "并且",
  "实景", "摄影", "镜头", "视角", "构图", "光线", "色调", "氛围",
]);

function truncate(value: string, maximum: number): string {
  const chars = [...value.trim()];
  return chars.length <= maximum ? chars.join("") : chars.slice(0, maximum).join("");
}

/** 只保留汉字/字母/数字，其余（中英标点、破折号、括号）一律视为分隔符。 */
function normalize(value: string): string {
  return value
    .replace(/[^\p{Script=Han}a-zA-Z0-9]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * 文本 → 检索词（最多 24 个，供拆成 4 个 query）。
 *
 * 分词策略：汉字取 2 字窗口（含重叠），ASCII 取整词；不做精确分词——材料库检索
 * 是 `includes` 子串匹配，2 字窗口足以命中「雪地摩托」「雪山背景」这类摘要。
 * 排序按「段间轮转」：一个配图描述常列多张不同画面（雪地摩托 / 哈雷 / 越野车），
 * 先每个分句取一个词再回头加深，保证前 6 词就能覆盖多个概念；段内按全页词频排。
 */
export function materialSearchTerms(parts: string[]): string[] {
  const counts = new Map<string, number>();
  const isTerm = (term: string): boolean =>
    term.length >= 2
    && !STOP_TERMS.has(term)
    && ![...term].some((char) => FUNCTION_CHARS.has(char));
  const record = (term: string, weight = 1): boolean => {
    if (!isTerm(term)) return false;
    counts.set(term, (counts.get(term) ?? 0) + weight);
    return true;
  };

  const segments: string[][] = [];
  for (const part of parts) {
    for (const segment of normalize(part).split(" ")) {
      if (!segment) continue;
      const terms: string[] = [];
      const seen = new Set<string>();
      const push = (term: string, weight = 1): void => {
        if (!record(term, weight) || seen.has(term)) return;
        seen.add(term);
        terms.push(term);
      };
      if (/^[a-z0-9][a-z0-9._-]*$/.test(segment)) {
        // 型号/品牌名（polaris / evtol / dji）区分度最高，加权排前。
        push(segment, 2);
      } else {
        const chars = [...segment];
        for (let index = 0; index + 1 < chars.length; index += 1) {
          push(chars[index]! + chars[index + 1]!);
        }
      }
      if (terms.length > 0) {
        // 段内按全页词频降序；同频保持出现顺序。
        segments.push(terms.slice().sort((left, right) =>
          (counts.get(right) ?? 0) - (counts.get(left) ?? 0)
          || terms.indexOf(left) - terms.indexOf(right)));
      }
    }
  }

  const limit = MAX_TERMS_PER_QUERY * MAX_SEARCHES_PER_PAGE;
  const result: string[] = [];
  const emitted = new Set<string>();
  for (let round = 0; result.length < limit; round += 1) {
    let advanced = false;
    for (const terms of segments) {
      const term = terms[round];
      if (term === undefined) continue;
      advanced = true;
      if (emitted.has(term)) continue;
      emitted.add(term);
      result.push(term);
      if (result.length >= limit) break;
    }
    if (!advanced) break;
  }
  return result;
}

/** 长词表拆成多个 ≤6 词的 query：材料库单次检索最多吃 6 个词。 */
function chunkTerms(terms: string[]): string[][] {
  const chunks: string[][] = [];
  for (let index = 0; index < terms.length; index += MAX_TERMS_PER_QUERY) {
    chunks.push(terms.slice(index, index + MAX_TERMS_PER_QUERY));
  }
  return chunks.slice(0, MAX_SEARCHES_PER_PAGE);
}

/**
 * 每页两组 query：优先用用户确认稿里的配图意图；零命中时再用标题+要点兜底一次
 * （标题/要点常包含「竞品产品图」「团队合影」这类可检索词）。
 */
function queriesForPage(page: SlidesProgressPage): { primary: string[]; fallback: string[] } {
  const hint = (page.materialHints ?? "").trim();
  const title = (page.title ?? "").trim();
  const points = (page.points ?? []).slice(0, 3).map((point) => String(point ?? "").trim()).filter(Boolean);
  return {
    primary: hint ? materialSearchTerms([hint]) : [],
    // 标题+要点只是兜底，取第一组词就够；避免每页再打 4 次库。
    fallback: materialSearchTerms([title, ...points]).slice(0, MAX_TERMS_PER_QUERY),
  };
}

function toPrefetchedHit(hit: MaterialHit): SlidesPrefetchedMaterialHit | null {
  const ref = truncate(String(hit.ref ?? ""), 500);
  if (!ref) return null;
  return {
    ref,
    kind: truncate(String(hit.kind ?? ""), 40),
    desc: truncate(String(hit.desc ?? ""), MAX_DESC_CHARS),
    meta: truncate(String(hit.meta ?? ""), MAX_META_CHARS),
  };
}

/**
 * 按页预取素材命中。只返回**有命中**的页（无命中的页由 planner 写 imagePrompt），
 * 单页与整册都有上限；search 抛错按零命中处理，素材检索失败不能拖垮生成。
 */
export function prefetchSlidesMaterials(input: PrefetchSlidesMaterialsInput): SlidesPageMaterialHits[] {
  const limitPerPage = Math.min(
    Math.max(input.limitPerPage ?? DEFAULT_HITS_PER_PAGE, 1),
    MAX_HITS_PER_PAGE,
  );
  const cache = new Map<string, MaterialHit[]>();
  const searchChunk = (chunk: string[]): MaterialHit[] => {
    if (chunk.length === 0) return [];
    const query = truncate(chunk.join(" "), MAX_QUERY_CHARS);
    const cached = cache.get(query);
    if (cached) return cached;
    let hits: MaterialHit[] = [];
    try {
      hits = input.search(query, limitPerPage);
    } catch {
      hits = [];
    }
    cache.set(query, hits);
    return hits;
  };
  /** 长词表拆成多个 query 再合并：同一 ref 的 rank 累加，命中词越多的图排越前。 */
  const search = (terms: string[]): MaterialHit[] => {
    const merged = new Map<string, { hit: MaterialHit; score: number }>();
    for (const chunk of chunkTerms(terms)) {
      for (const hit of searchChunk(chunk)) {
        const existing = merged.get(hit.ref);
        if (existing) existing.score += hit.rank + 1;
        else merged.set(hit.ref, { hit, score: hit.rank + 1 });
      }
    }
    return [...merged.values()]
      .sort((left, right) => right.score - left.score)
      .map(({ hit }) => hit);
  };

  const results: SlidesPageMaterialHits[] = [];
  let total = 0;
  input.pages.slice(0, MAX_PAGES).forEach((page, pageIndex) => {
    if (total >= MAX_TOTAL_HITS) return;
    const { primary, fallback } = queriesForPage(page);
    let terms = primary.length > 0 ? primary : fallback;
    let hits = search(terms);
    if (hits.length === 0 && primary.length > 0) {
      const retryTerms = fallback.filter((term) => !primary.includes(term));
      if (retryTerms.length > 0) {
        terms = retryTerms;
        hits = search(retryTerms);
      }
    }
    if (hits.length === 0) return;
    const seen = new Set<string>();
    const mapped: SlidesPrefetchedMaterialHit[] = [];
    for (const hit of hits) {
      const prefetched = toPrefetchedHit(hit);
      if (!prefetched || seen.has(prefetched.ref) || total >= MAX_TOTAL_HITS) continue;
      seen.add(prefetched.ref);
      mapped.push(prefetched);
      total += 1;
      if (mapped.length >= limitPerPage) break;
    }
    if (mapped.length === 0) return;
    results.push({ pageIndex, query: truncate(terms.join(" "), MAX_QUERY_CHARS), hits: mapped });
  });
  return results;
}
