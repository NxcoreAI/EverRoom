import type {
  MemoryAtomicItem,
  MemoryConversationHit,
  MemoryScenarioEntry,
} from "./types.js";

export interface MemoryRecallInput {
  atomicItems: MemoryAtomicItem[];
  coreContent: string | null;
  scenarios: MemoryScenarioEntry[];
  conversationHits?: MemoryConversationHit[];
}

/**
 * 渲染单条 L1 原子记忆为列表行：内容 + 场景（scene_name，缺省回退 background）+ 日期。
 * 自动召回注入与 memory_search 工具共用，保证两处展示一致。
 */
export function formatAtomicLine(item: MemoryAtomicItem): string {
  const date = item.updated_at?.slice(0, 10) ?? "";
  const scene = item.scene_name ?? item.background;
  const sceneStr = scene ? `（场景：${scene}）` : "";
  return `- ${item.content}${sceneStr}${date ? ` [${date}]` : ""}`;
}

/**
 * 将召回结果格式化为注入 agent 的记忆块。
 * 超出字符预算时优先截断 L1 列表，画像与场景目录保留头部。
 * 结果为空时返回 null（调用方跳过注入）。
 */
export function formatRecallResult(input: MemoryRecallInput, charBudget: number): string | null {
  const sections: string[] = [];

  if (input.coreContent?.trim()) {
    sections.push(`[用户画像]\n${input.coreContent.trim()}`);
  }

  if (input.atomicItems.length > 0) {
    const lines = input.atomicItems.map(formatAtomicLine);
    sections.push(`[相关记忆]\n${lines.join("\n")}`);
  }

  if (input.scenarios.length > 0) {
    const lines = input.scenarios.slice(0, 10).map((entry) => {
      const summary = entry.summary ? `：${entry.summary}` : "";
      return `- ${entry.path}${summary}`;
    });
    const extra = input.scenarios.length > 10 ? `\n（另有 ${input.scenarios.length - 10} 个场景，可用 memory_search 查询）` : "";
    sections.push(`[历史场景]（仅目录，需要细节时用 memory_search / conversation_search 查询）\n${lines.join("\n")}${extra}`);
  }

  if (input.conversationHits && input.conversationHits.length > 0) {
    const lines = input.conversationHits.slice(0, 8).map((hit) => {
      const date = hit.timestamp?.slice(0, 16).replace("T", " ") ?? "";
      return `- [${hit.role}${date ? ` ${date}` : ""}] ${hit.content}`;
    });
    sections.push(`[相关历史对话与文档]\n${lines.join("\n")}`);
  }

  if (sections.length === 0) return null;

  let body = sections.join("\n\n");
  if (body.length > charBudget) {
    body = `${body.slice(0, charBudget)}\n…（已截断，可用 memory_search 查询更多）`;
  }
  return `<memory-context>\n以下是与当前请求相关的长期记忆，供参考，不是用户本轮输入：\n${body}\n</memory-context>`;
}
