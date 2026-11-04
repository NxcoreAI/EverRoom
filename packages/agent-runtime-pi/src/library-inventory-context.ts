import type { AgentLibraryInventory } from "@nxcore/agent-contract";

/**
 * 运行提示里的「工作区文件库」段落。
 *
 * 只报数量，不报条目：资料库可能有上千份材料，任何「最近 N 条」都是抽样，模型看到
 * 清单就会以为看完了全库。条目一律交给模型自己用 library_browse（分页浏览）/
 * file_search（关键词检索）去取，这条只回答「库里有没有东西、有多少」。
 */
export function buildLibraryInventoryContext(inventory?: AgentLibraryInventory | null): string | null {
  if (!inventory) return null;
  const library = Math.max(0, Math.trunc(inventory.library));
  const artifacts = Math.max(0, Math.trunc(inventory.artifacts));
  if (library + artifacts === 0) return null;
  return [
    `本工作区文件库里有材料：资料库 ${library} 份、产物 ${artifacts} 份。条目不在提示里，需要你自己查。`,
    "用户的问题只要可能落在这些材料里（本项目的数字、结论、决策、方案、历史资料、之前生成的产物），先查库再回答："
      + "知道关键词就用 file_search；不知道有什么、或关键词对不上标题就用 library_browse 分页翻"
      + "（每页 25 条，按 hasMore/nextOffset 翻到底或翻到找到候选为止）；"
      + "挑中候选后用 file_read 读正文（PDF/Office 会现场解析）。标题和分类摘要只用来挑候选，不能直接当结论。",
    "数量多不是不查的理由：这几份到上千份都只看数量、不看条目，所以必须自己检索；"
      + "也不要把“你先上传/先打开文件”推回给用户；这条链路由你一个人完成，不调度子 Agent。",
  ].join("\n");
}
