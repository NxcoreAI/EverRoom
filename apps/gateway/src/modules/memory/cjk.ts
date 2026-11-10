import { Jieba } from "@node-rs/jieba";
import { dict } from "@node-rs/jieba/dict.js";

/**
 * 中文适配层。
 *
 * 背景：hippo-memory 的 BM25 语料构建是
 *   `entryText = content + tags.join(' ')` → `tokenize()`，
 * 而 `tokenize` 实现为 `text.replace(/[^\w\s]/g, ' ').split(/\s+/)`。
 * JavaScript 的 `\w` 等价 `[A-Za-z0-9_]`，**汉字会被整段替换成空格**，
 * 结果是纯中文记忆与纯中文 query 在 BM25 里 0 命中（实测 npm 2.2.0）。
 *
 * 解决：写入时把中文分词结果做 codepoint 转写（`用户` → `zh7528_6237`），
 * 作为检索键追加进 tags（tags 参与 entryText 拼接，因此进入 BM25 语料）；
 * 检索时对 query 做同样转写。原句仍作为 content 原样保存与展示。
 *
 * 该转写对 ASCII 词原样保留，因此中英混合记忆的英文部分不退化。
 */

/** 检索键前缀：`zh` + 逐字 codepoint 十六进制，下划线连接。 */
const SEARCH_KEY_PREFIX = "zh";
const SEARCH_KEY_PATTERN = /^zh(?:[0-9a-f]{2,6})(?:_[0-9a-f]{2,6})*$/;
/** 与 hippo 自身的分词过滤规则对齐：丢弃单字符 token。 */
const MIN_TOKEN_LENGTH = 2;

let jieba: Jieba | null = null;

/** jieba 单例：词典约 5MB，进程内只加载一次。 */
function jiebaInstance(): Jieba {
  if (!jieba) {
    jieba = Jieba.withDict(dict);
  }
  return jieba;
}

/** 中文分词。ASCII 段落由 jieba 原样（按空白）返回，无需额外处理。 */
export function segment(text: string): string[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  return jiebaInstance()
    .cut(trimmed)
    .map((token) => token.trim())
    .filter((token) => token.length >= MIN_TOKEN_LENGTH);
}

/** 把单个中文 token 转写成 `\w` 可匹配的检索键；已是 ASCII 词的返回 null。 */
function tokenToSearchKey(token: string): string | null {
  if (/^[\w]+$/.test(token)) return null;
  const codepoints = [...token]
    .map((char) => char.codePointAt(0))
    .filter((code): code is number => code !== undefined)
    .map((code) => code.toString(16));
  if (codepoints.length === 0) return null;
  return `${SEARCH_KEY_PREFIX}${codepoints.join("_")}`;
}

/**
 * 文本 → 检索键数组（含 ASCII 原词与中文转写键，均已小写）。
 * 写入侧追加到 tags，检索侧拼成 query 字符串。
 */
export function searchKeys(text: string): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const token of segment(text)) {
    const key = tokenToSearchKey(token) ?? token.toLowerCase();
    if (!SEARCH_KEY_PATTERN.test(key) && !/^[\w]+$/.test(key)) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  return keys;
}

/** 检索 query → hippo 可用的 query 字符串（空格分隔检索键）。 */
export function toHippoQuery(text: string): string {
  return searchKeys(text).join(" ");
}

/** 判断某个 tag 是否是本层生成的检索键（展示与回传时应过滤）。 */
export function isSearchKey(tag: string): boolean {
  return SEARCH_KEY_PATTERN.test(tag);
}

/** 是否含有需要转写的非 ASCII 片段（用于跳过纯英文文本的分词开销）。 */
export function needsSegmentation(text: string): boolean {
  return /[^\x00-\x7F]/.test(text);
}
