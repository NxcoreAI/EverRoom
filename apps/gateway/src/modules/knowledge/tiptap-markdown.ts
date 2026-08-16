import type { TiptapJsonContent } from "@nxcore/agent-contract";

/**
 * Tiptap JSON → Markdown 导出（plan §4.3 DocEnvelope.markdown 的 everroom-doc 实现）。
 *
 * 覆盖文档编辑器的主流块：标题/段落/列表/代码块/引用/表格/分割线/图片；
 * 行内 mark 支持 bold/italic/code/strike/link。富块（画板、Base 嵌入等）
 * 降级为占位说明——KS ingest 靠 LLM 抽取，占位比丢块更可追溯。
 * 纯字符串运算，无依赖，可单测。
 */

interface TiptapMark {
  type: string;
  attrs?: Record<string, unknown>;
}

function escapeTableCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function renderInline(node: TiptapJsonContent): string {
  if (node.type === "text") {
    return applyMarks(node.text ?? "", node.marks ?? []);
  }
  if (node.type === "hardBreak") return "\n";
  if (node.type === "image") {
    const attrs = node.attrs ?? {};
    const alt = typeof attrs.alt === "string" ? attrs.alt : "";
    const src = typeof attrs.src === "string" ? attrs.src : "";
    return `![${alt}](${src})`;
  }
  // 行内未知节点（mention 等）：拍平子内容。
  return (node.content ?? []).map(renderInline).join("");
}

function applyMarks(text: string, marks: TiptapMark[]): string {
  let result = text;
  for (const mark of marks) {
    switch (mark.type) {
      case "bold":
        result = `**${result}**`;
        break;
      case "italic":
        result = `*${result}*`;
        break;
      case "code":
        result = `\`${result}\``;
        break;
      case "strike":
        result = `~~${result}~~`;
        break;
      case "link": {
        const href = typeof mark.attrs?.href === "string" ? mark.attrs.href : "";
        result = `[${result}](${href})`;
        break;
      }
      default:
        break;
    }
  }
  return result;
}

function renderBlocks(nodes: TiptapJsonContent[]): string {
  return nodes.map(renderBlock).filter((block) => block.length > 0).join("\n\n");
}

function renderBlock(node: TiptapJsonContent): string {
  switch (node.type) {
    case "heading": {
      const level = Number(node.attrs?.level ?? 2);
      const depth = Math.min(Math.max(Number.isFinite(level) ? level : 2, 1), 6);
      const text = (node.content ?? []).map(renderInline).join("").trim();
      return `${"#".repeat(depth)} ${text}`;
    }
    case "paragraph": {
      const text = (node.content ?? []).map(renderInline).join("").trim();
      return text.length > 0 ? text : "";
    }
    case "bulletList":
      return renderList(node, false);
    case "orderedList":
      return renderList(node, true);
    case "codeBlock": {
      const language = typeof node.attrs?.language === "string" ? node.attrs.language : "";
      const code = (node.content ?? [])
        .map((child) => child.text ?? "")
        .join("");
      return `\`\`\`${language}\n${code.replace(/\n$/, "")}\n\`\`\``;
    }
    case "blockquote": {
      const inner = renderBlocks(node.content ?? []);
      return inner.split("\n").map((line) => `> ${line}`).join("\n");
    }
    case "horizontalRule":
      return "---";
    case "table":
      return renderTable(node);
    case "image": {
      const attrs = node.attrs ?? {};
      const alt = typeof attrs.alt === "string" ? attrs.alt : "";
      const src = typeof attrs.src === "string" ? attrs.src : "";
      return `![${alt}](${src})`;
    }
    default: {
      if (node.content && node.content.length > 0) {
        return renderBlocks(node.content);
      }
      // 空的富块（画板/嵌入等）：降级为占位说明，保留可追溯性。
      return node.type === "doc" || (node.text ?? "").length > 0 ? (node.text ?? "") : `（未导出内容块：${node.type}）`;
    }
  }
}

function renderList(node: TiptapJsonContent, ordered: boolean): string {
  const lines: string[] = [];
  let index = 1;
  for (const item of node.content ?? []) {
    if (item.type !== "listItem") continue;
    const marker = ordered ? `${index++}. ` : "- ";
    // listItem 内容是块级（通常单个 paragraph）；嵌套列表保持缩进。
    const parts: string[] = [];
    let nested: string[] = [];
    for (const child of item.content ?? []) {
      if (child.type === "bulletList" || child.type === "orderedList") {
        nested = renderList(child, child.type === "orderedList").split("\n");
      } else {
        const block = renderBlock(child);
        if (block.length > 0) parts.push(block);
      }
    }
    const first = parts.shift() ?? "";
    lines.push(`${marker}${first.replace(/\n/g, " ")}`);
    for (const rest of parts) lines.push(`  ${rest}`);
    for (const nestedLine of nested) lines.push(`  ${nestedLine}`);
  }
  return lines.join("\n");
}

function renderTable(node: TiptapJsonContent): string {
  const rows = (node.content ?? []).filter((row) => row.type === "tableRow");
  if (rows.length === 0) return "";
  const cells = rows.map((row) =>
    (row.content ?? [])
      .filter((cell) => cell.type === "tableCell" || cell.type === "tableHeader")
      .map((cell) => escapeTableCell(renderBlocks(cell.content ?? []).replace(/\n+/g, " ").trim())),
  );
  const width = Math.max(...cells.map((row) => row.length));
  const normalized = cells.map((row) => {
    const padded = [...row];
    while (padded.length < width) padded.push("");
    return padded;
  });
  const [header, ...body] = normalized;
  if (!header) return "";
  const divider = `| ${Array.from({ length: width }, () => "---").join(" | ")} |`;
  const lines = [
    `| ${header.join(" | ")} |`,
    divider,
    ...body.map((row) => `| ${row.join(" | ")} |`),
  ];
  return lines.join("\n");
}

/** 导出入口：doc 根或任意块节点 → Markdown 文本。 */
export function tiptapToMarkdown(content: TiptapJsonContent): string {
  const markdown = content.type === "doc"
    ? renderBlocks(content.content ?? [])
    : renderBlock(content);
  return `${markdown.trim()}\n`;
}
