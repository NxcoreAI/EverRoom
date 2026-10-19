/**
 * 统一搜索 bigram 切词器（PRD 0.2.0 §2.5 决策：滑切，零依赖）。
 * 中文/CJK 连续段切两字滑窗；拉丁字母词保留整词并补写字符 bigram（支持词中前缀命中）；
 * 数字串只保留整串。产物为空格分隔 token 串，喂给 FTS5（unicode61 按空白切）。
 */

const CJK_RANGE = "\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\uac00-\\ud7af";
const RUN_PATTERN = new RegExp(`[${CJK_RANGE}]+|[a-z0-9]+`, "g");
const CJK_FIRST = new RegExp(`^[${CJK_RANGE}]`);

export function normalizeForSearch(input: string): string {
  return input.normalize("NFC").toLowerCase();
}

export function tokenize(input: string): string[] {
  const normalized = normalizeForSearch(input);
  const runs = normalized.match(RUN_PATTERN) ?? [];
  const tokens: string[] = [];
  for (const run of runs) {
    if (CJK_FIRST.test(run)) {
      if (run.length === 1) {
        tokens.push(run);
        continue;
      }
      for (let i = 0; i + 1 < run.length; i += 1) {
        tokens.push(run.slice(i, i + 2));
      }
    } else if (/^[0-9]+$/.test(run)) {
      tokens.push(run);
    } else {
      tokens.push(run);
      if (run.length > 2) {
        for (let i = 0; i + 1 < run.length; i += 1) {
          tokens.push(run.slice(i, i + 2));
        }
      }
    }
  }
  return tokens;
}

export function tokenizeJoined(input: string): string {
  return [...new Set(tokenize(input))].join(" ");
}

/** 单字查询无法走 bigram FTS（索引里没有单字 token），调用方降级为 LIKE。 */
export function isSingleCharQuery(query: string): boolean {
  const trimmed = query.trim();
  return trimmed.length === 1;
}
