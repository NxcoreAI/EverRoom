import { createHash } from "node:crypto";

/**
 * 同一 run 内的重复工具结果折叠。
 *
 * 实测故障：模型对一个 Excel 连调三次无参 `sheets_agent_read`，三次返回字节级相同
 * （每次约 82KB，其中指南正文占 69KB），全部留在历史里，上下文冲到 80%，末轮思考
 * 把输出额度烧完 → `stopReason=length` 整轮失败。
 *
 * 这里只折叠"完全一致且足够大"的结果：短回执重复无伤大雅，留原文更利于模型比对。
 */
export interface ToolResultDedupeState {
  seen: Map<string, { ordinal: number; name: string; chars: number }>;
  ordinal: number;
}

/** 低于这个长度的结果不参与折叠（重复的小回执没有压缩价值）。 */
export const TOOL_RESULT_DEDUPE_MIN_CHARS = 2_000;

export function createToolResultDedupeState(): ToolResultDedupeState {
  return { seen: new Map(), ordinal: 0 };
}

/** 返回折叠后的文本：重复的大结果换成指向首次出现的占位说明。 */
export function dedupeToolResult(
  state: ToolResultDedupeState,
  name: string,
  text: string,
): string {
  if (text.length < TOOL_RESULT_DEDUPE_MIN_CHARS) return text;
  const hash = createHash("sha1").update(text).digest("hex");
  const previous = state.seen.get(hash);
  if (previous) {
    return (
      `[已省略重复结果] 这次 ${name} 的返回与第 ${previous.ordinal} 次完全相同` +
      `（${previous.chars} 字符）。若要拿到不同的数据请改参数（例如指定具体范围或换工作表）。`
    );
  }
  state.ordinal += 1;
  state.seen.set(hash, { ordinal: state.ordinal, name, chars: text.length });
  return text;
}
