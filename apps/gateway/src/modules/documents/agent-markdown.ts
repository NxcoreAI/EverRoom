import Image from "@tiptap/extension-image";
import { TableKit } from "@tiptap/extension-table";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import { MarkdownManager } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";
import { Window as HappyDomWindow } from "happy-dom";
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

// —— 无头 HTML 解析 ——————————————————————————————————————————————
// @tiptap/core 的 generateJSON 依赖全局 window.DOMParser；网关是 Node 进程
// 没有 window，@tiptap/markdown 会把 markdown 内嵌的 HTML 片段（飞书导入
// 正文里的 <p>/<strong>/<table> 等）降级成字面文本，编辑器随之显示源码。
// 解析期间临时挂一个 happy-dom Window（@tiptap/html 官方无头方案同款），
// 解析完立即恢复，避免污染网关进程的全局环境。
let headlessDomWindow: HappyDomWindow | undefined;

function withHeadlessDom<T>(run: () => T): T {
  const globals = globalThis as { window?: unknown };
  if (typeof globals.window === "object" && globals.window !== null
    && typeof (globals.window as { DOMParser?: unknown }).DOMParser === "function") {
    return run();
  }
  headlessDomWindow ??= new HappyDomWindow();
  globals.window = headlessDomWindow;
  try {
    return run();
  } finally {
    if (globals.window === headlessDomWindow) delete globals.window;
  }
}

// —— 外部文档 HTML 标签归一化 ————————————————————————————————————
// 飞书 markdown 正文内嵌非标准标签（<callout>/<cite type="user">/<title>），
// 它们不在 Tiptap schema 里，即便有 DOMParser 也会被字面化，必须在解析前
// 转成 markdown 语义等价物。标准 HTML（<p>/<strong>/<table>…）不在此处理，
// 由 withHeadlessDom 下的 tiptap 解析承载。
const CITE_PATTERN = /<cite\b([^>]*)>([\s\S]*?)<\/cite>/gi;
const TITLE_PATTERN = /<title\b[^>]*>([\s\S]*?)<\/title>/gi;
const CALLOUT_PATTERN = /<callout\b([^>]*)>([\s\S]*?)<\/callout>/gi;
const CALLOUT_EMOJI_PATTERN = /\bemoji\s*=\s*(["']?)(.*?)\1/i;

function citeAttributeIsUser(attributes: string): boolean {
  return /\btype\s*=\s*["']?user\b/i.test(attributes);
}

function calloutInnerToLines(inner: string): string[] {
  return inner
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>\s*<p[^>]*>/gi, "\n")
    .replace(/<\/?p[^>]*>/gi, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export function normalizeImportedMarkdown(markdown: string): string {
  let normalized = markdown
    // 行内先行：用户提及保留可见语义，其余 cite 取内部文本加粗。
    .replace(CITE_PATTERN, (_match, attributes: string, inner: string) => {
      const text = inner.trim();
      return citeAttributeIsUser(attributes) ? `**@${text}**` : `**${text}**`;
    })
    // 文档内 <title> 与文档标题重复，保留为加粗行避免丢失信息。
    .replace(TITLE_PATTERN, (_match, inner: string) => `**${inner.trim()}**`);
  // 块级最后：callout → 引用块（首行带 emoji 前缀）。
  normalized = normalized.replace(CALLOUT_PATTERN, (_match, attributes: string, inner: string) => {
    const emoji = CALLOUT_EMOJI_PATTERN.exec(attributes)?.[2]?.trim() ?? "";
    const prefix = emoji ? `${emoji} ` : "";
    return calloutInnerToLines(inner)
      .map((line, index) => `> ${index === 0 ? prefix : ""}${line}`)
      .join("\n");
  });
  return normalized;
}

/** 外部导入 markdown → Tiptap JSON 的统一入口（归一化 + 无头 HTML 解析）。 */
export function parseImportedMarkdown(markdown: string): TiptapJsonContent {
  return withHeadlessDom(
    () => agentDocumentMarkdown.parse(normalizeImportedMarkdown(markdown)) as TiptapJsonContent,
  );
}

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
