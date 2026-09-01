/**
 * 注入块合成（方案 §7.4 修订版）：单一画像文本——系统生成初稿、
 * 用户直接在其上编辑；注入的就是当前这份文本，无多段合成。
 * 是否注入由各注入点自查开关（补全 renderer / 生成 gateway）。
 */

const BUDGET = {
  completion: 350,
  generation: 700,
} as const;

const SENTENCE_END = /[。！？；\n]/;

/** 预算内截断：优先落在最后一个句末边界，无边界则硬切加省略号。 */
export function clipToBudget(text: string, budget: number): string {
  if (text.length <= budget) return text;
  const window = text.slice(0, budget);
  let cut = -1;
  for (let i = window.length - 1; i >= Math.floor(budget * 0.6); i -= 1) {
    if (SENTENCE_END.test(window[i] ?? "")) {
      cut = i + 1;
      break;
    }
  }
  return cut > 0 ? window.slice(0, cut) : `${window.slice(0, budget - 1)}…`;
}

export function composeWritingStyleBlock(options: {
  mode: "completion" | "generation";
  /** 当前画像文本（系统生成或用户编辑后的版本）。 */
  profileText: string | null;
}): string | null {
  const content = options.profileText?.trim() ?? "";
  if (!content) return null;
  return [
    "<writing_style>",
    clipToBudget(content, BUDGET[options.mode]),
    "</writing_style>",
  ].join("\n");
}
