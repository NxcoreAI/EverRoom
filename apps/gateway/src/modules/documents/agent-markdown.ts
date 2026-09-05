import Image from "@tiptap/extension-image";
import { TableKit } from "@tiptap/extension-table";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import { MarkdownManager } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";
import type { TiptapJsonContent } from "@nxcore/agent-contract";
import { tiptapText } from "./content-model.js";
import { BlockIndexMarkHeadless } from "./block-index-mark.js";

export const agentDocumentMarkdown = new MarkdownManager({
  extensions: [
    StarterKit,
    // 图片节点（Room 文档截图等）：缺了它 markdown 序列化会静默丢图。
    Image,
    TaskList,
    TaskItem.configure({ nested: true }),
    TableKit.configure({ table: { resizable: false } }),
    BlockIndexMarkHeadless,
  ],
});

export function sanitizeAgentDocumentTables(
  source: TiptapJsonContent,
): { content: TiptapJsonContent; changed: boolean } {
  let changed = false;
  const visit = (node: TiptapJsonContent): TiptapJsonContent | null => {
    const content = node.content?.flatMap((child) => {
      const normalized = visit(child);
      return normalized ? [normalized] : [];
    });
    let normalized: TiptapJsonContent = content ? { ...node, content } : node;
    if (node.content && content?.length !== node.content.length) changed = true;
    if (normalized.type !== "table") return normalized;

    const rows = (normalized.content ?? []).filter((row) => {
      const keep = row.type !== "tableRow" || tiptapText(row).trim().length > 0;
      if (!keep) changed = true;
      return keep;
    });
    if (rows.length === 0) {
      changed = true;
      return null;
    }
    if (rows.length !== normalized.content?.length) normalized = { ...normalized, content: rows };
    return normalized;
  };
  const content = visit(source) ?? { type: "doc", content: [] };
  return { content, changed };
}
