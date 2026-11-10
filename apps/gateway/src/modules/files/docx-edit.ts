import JSZip from "jszip";

/**
 * Word（.docx）文本级编辑：在 OOXML 的 `word/document.xml` 上做段落粒度的
 * 文本替换 / 插入 / 删除。
 *
 * 为什么不做富文本重排：这次的目标是「改用户正开着的那份合同/报告」，正文
 * 文字改动必须保住原有段落样式、编号、分节与页面设置。这里只改 `w:t` 里的
 * 文字：替换时沿用被替换片段所在段落的格式（整段替换时沿用首段 run 的格式），
 * 不重建整篇文档。
 *
 * 已知边界（工具描述里如实告知模型）：
 * - 查找串必须落在同一段落内，不支持跨段落匹配。
 * - 图片/公式/域/批注/脚注等非文本内容原样保留。
 * - 同一段内混合格式（例如半句加粗）在整段替换后会统一为第一段 run 的格式。
 */

export type DocxEditOp =
  | {
    type: "replace_text";
    /** 要替换的文字（同一段落内的子串）。 */
    find: string;
    replace: string;
    /** true = 替换文档内全部匹配；缺省只替换第一处。 */
    all?: boolean;
  }
  | {
    type: "replace_paragraph";
    /** 用来定位段落的文字（该段落文本包含它，且必须唯一）。 */
    find: string;
    /** 段落的完整新文本。 */
    text: string;
  }
  | {
    type: "insert_paragraph_after";
    /** 定位锚点段落（文本包含它，且必须唯一）；在它后面插入新段落。 */
    find: string;
    /** 新段落的文本。 */
    text: string;
  }
  | {
    type: "append_paragraph";
    /** 追加到文档末尾的段落文本。 */
    text: string;
  }
  | {
    type: "delete_paragraph";
    /** 定位要删除的段落（文本包含它，且必须唯一）。 */
    find: string;
  };

export interface DocxEditOutcome {
  buffer: Buffer;
  /** 逐条操作的实际效果，回给 Agent 核对。 */
  changes: string[];
}

export class DocxEditError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "DocxEditError";
  }
}

const MAX_TEXT_LENGTH = 60_000;
const MAX_OPS = 20;

// ── XML 文本处理 ─────────────────────────────────────────────

function decodeXmlEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (whole, entity: string) => {
    if (entity === "amp") return "&";
    if (entity === "lt") return "<";
    if (entity === "gt") return ">";
    if (entity === "quot") return '"';
    if (entity === "apos") return "'";
    const numeric = entity.startsWith("#x") || entity.startsWith("#X")
      ? Number.parseInt(entity.slice(2), 16)
      : Number.parseInt(entity.slice(1), 10);
    return Number.isFinite(numeric) ? String.fromCodePoint(numeric) : whole;
  });
}

function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

interface TextNode {
  /** 在段落 XML 里的起始/结束偏移（含完整标签）。 */
  start: number;
  end: number;
  attrs: string;
  /** 解码后的文本。 */
  text: string;
}

const TEXT_NODE_PATTERN = /<w:t(\s[^>]*)?>([\s\S]*?)<\/w:t>/g;

function textNodesOf(paragraphXml: string): TextNode[] {
  TEXT_NODE_PATTERN.lastIndex = 0;
  const nodes: TextNode[] = [];
  for (const match of paragraphXml.matchAll(TEXT_NODE_PATTERN)) {
    nodes.push({
      start: match.index ?? 0,
      end: (match.index ?? 0) + match[0].length,
      attrs: match[1] ?? "",
      text: decodeXmlEntities(match[2] ?? ""),
    });
  }
  return nodes;
}

function paragraphText(paragraphXml: string): string {
  return textNodesOf(paragraphXml).map((node) => node.text).join("");
}

/**
 * 按「第 n 个 w:t → 新文本」重建段落 XML；保持 w:t 的属性（含 xml:space）。
 * 用下标对齐而不是对象身份：textNodesOf 每次都会新建对象，Map<TextNode,…> 永远对不上。
 */
function rebuildParagraph(paragraphXml: string, replacements: Array<string | undefined>): string {
  let output = "";
  let cursor = 0;
  textNodesOf(paragraphXml).forEach((node, index) => {
    const next = replacements[index];
    if (next === undefined) return;
    output += paragraphXml.slice(cursor, node.start);
    const needsSpace = /^\s|\s$/.test(next);
    const attrs = needsSpace && !/xml:space\s*=/.test(node.attrs)
      ? `${node.attrs} xml:space="preserve"`
      : node.attrs;
    output += `<w:t${attrs}>${escapeXmlText(next)}</w:t>`;
    cursor = node.end;
  });
  output += paragraphXml.slice(cursor);
  return output;
}

/** 在单段里把 find 换成 replace（可跨 run）；返回替换次数与新的段落 XML。 */
function replaceTextInParagraph(
  paragraphXml: string,
  find: string,
  replace: string,
  all: boolean,
): { xml: string; count: number } {
  let xml = paragraphXml;
  let count = 0;
  // 每次只处理一处，all 时循环到没有匹配；上限防止 replace 里含 find 造成死循环。
  for (let attempt = 0; attempt < (all ? 50 : 1); attempt += 1) {
    const nodes = textNodesOf(xml);
    const full = nodes.map((node) => node.text).join("");
    const index = full.indexOf(find);
    if (index < 0) break;
    const matchEnd = index + find.length;
    let offset = 0;
    let inserted = false;
    const updates: Array<string | undefined> = [];
    let changed = false;
    nodes.forEach((node) => {
      const nodeStart = offset;
      const nodeEnd = offset + node.text.length;
      offset = nodeEnd;
      if (nodeEnd <= index || nodeStart >= matchEnd) {
        updates.push(undefined);
        return;
      }
      const localStart = Math.max(0, index - nodeStart);
      const localEnd = Math.min(node.text.length, matchEnd - nodeStart);
      const prefix = node.text.slice(0, localStart);
      const suffix = node.text.slice(localEnd);
      updates.push(inserted ? `${prefix}${suffix}` : `${prefix}${replace}${suffix}`);
      inserted = true;
      changed = true;
    });
    if (!changed) break;
    xml = rebuildParagraph(xml, updates);
    count += 1;
    if (!all) break;
  }
  return { xml, count };
}

const PARAGRAPH_PATTERN = /<w:p\b[^>]*\/>|<w:p\b[^>]*>[\s\S]*?<\/w:p>/g;

interface ParagraphMatch {
  xml: string;
  start: number;
  end: number;
  text: string;
}

function paragraphsOf(documentXml: string): ParagraphMatch[] {
  PARAGRAPH_PATTERN.lastIndex = 0;
  return [...documentXml.matchAll(PARAGRAPH_PATTERN)].map((match) => ({
    xml: match[0],
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
    text: paragraphText(match[0]),
  }));
}

function paragraphProperties(paragraphXml: string): string {
  return /<w:pPr\b[^>]*>[\s\S]*?<\/w:pPr>/.exec(paragraphXml)?.[0] ?? "";
}

/** run 的 rPr：先定位第一个 <w:r>，再取它自己的 rPr（不能误取 pPr 里的段落标记 rPr）。 */
function firstRunProperties(paragraphXml: string): string {
  const run = /<w:r\b[^>]*>([\s\S]*?)<\/w:r>/.exec(paragraphXml);
  if (!run) return "";
  return /<w:rPr\b[^>]*>[\s\S]*?<\/w:rPr>/.exec(run[1] ?? "")?.[0] ?? "";
}

function buildParagraph(template: string, text: string): string {
  const pPr = paragraphProperties(template);
  const rPr = firstRunProperties(template);
  const run = `<w:r>${rPr}<w:t xml:space="preserve">${escapeXmlText(text)}</w:t></w:r>`;
  return `<w:p>${pPr}${run}</w:p>`;
}

/** 段落是否位于表格（w:tbl）内：表格单元格必须至少保留一个段落。 */
function insideTable(documentXml: string, index: number): boolean {
  const before = documentXml.slice(0, index);
  const opens = (before.match(/<w:tbl[\s>]/g) ?? []).length;
  const closes = (before.match(/<\/w:tbl>/g) ?? []).length;
  return opens > closes;
}

function requireUniqueParagraph(documentXml: string, find: string, action: string): ParagraphMatch {
  const hits = paragraphsOf(documentXml).filter((paragraph) => paragraph.text.includes(find));
  if (hits.length === 0) {
    throw new DocxEditError(
      "TEXT_NOT_FOUND",
      `文档里找不到包含「${find.slice(0, 80)}」的段落；先用 file_read 看正文，按原文逐字定位`,
    );
  }
  if (hits.length > 1) {
    throw new DocxEditError(
      "TEXT_AMBIGUOUS",
      `有 ${hits.length} 个段落都包含「${find.slice(0, 80)}」，无法确定${action}哪一段；请改用更长的原文片段`,
    );
  }
  return hits[0]!;
}

function validateText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new DocxEditError("INVALID_OP", `${field} 必须是非空字符串`);
  }
  if (value.length > MAX_TEXT_LENGTH) {
    throw new DocxEditError("INVALID_OP", `${field} 超过长度上限（${MAX_TEXT_LENGTH} 字符）`);
  }
  return value;
}

async function finalize(zip: JSZip, xml: string, changes: string[]): Promise<DocxEditOutcome> {
  zip.file("word/document.xml", xml);
  const output = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  return { buffer: Buffer.from(output), changes };
}

// ── 入口 ─────────────────────────────────────────────────────

export async function applyDocxOps(
  buffer: Buffer,
  inputOps: readonly DocxEditOp[],
): Promise<DocxEditOutcome> {
  if (!Array.isArray(inputOps) || inputOps.length === 0) {
    throw new DocxEditError("INVALID_OP", "ops 必须是非空数组");
  }
  if (inputOps.length > MAX_OPS) {
    throw new DocxEditError("INVALID_OP", `单次最多 ${MAX_OPS} 条操作`);
  }
  const zip = await JSZip.loadAsync(buffer);
  const entry = zip.file("word/document.xml");
  if (!entry) throw new DocxEditError("NOT_DOCX", "文件不是有效的 .docx（缺少 word/document.xml）");
  let xml = await entry.async("string");
  if (!/<w:body\b/.test(xml)) throw new DocxEditError("NOT_DOCX", "文件不是有效的 .docx（缺少 w:body）");

  const changes: string[] = [];
  for (const raw of inputOps) {
    const op = raw as Partial<DocxEditOp> & { type?: unknown };
    switch (op.type) {
      case "replace_text": {
        const find = validateText(op.find, "find");
        if (typeof op.replace !== "string") throw new DocxEditError("INVALID_OP", "replace 必须是字符串（可为空串）");
        const replace = op.replace;
        if (replace.length > MAX_TEXT_LENGTH) throw new DocxEditError("INVALID_OP", "replace 超长");
        if (replace === find) throw new DocxEditError("INVALID_OP", "replace 与 find 相同，不需要修改");
        let total = 0;
        let done = false;
        while (!done && total < 50) {
          const paragraphs = paragraphsOf(xml);
          done = true;
          for (const paragraph of paragraphs) {
            if (!paragraph.text.includes(find)) continue;
            const result = replaceTextInParagraph(paragraph.xml, find, replace, op.all === true);
            if (result.count === 0) continue;
            xml = `${xml.slice(0, paragraph.start)}${result.xml}${xml.slice(paragraph.end)}`;
            total += result.count;
            if (op.all !== true) { done = true; break; }
            done = false;
            break;
          }
        }
        if (total === 0) {
          throw new DocxEditError("TEXT_NOT_FOUND", `文档里找不到「${find.slice(0, 80)}」`);
        }
        changes.push(`替换文字 ${total} 处：${find} → ${replace}`);
        break;
      }
      case "replace_paragraph": {
        const find = validateText(op.find, "find");
        const text = validateText(op.text, "text");
        const paragraph = requireUniqueParagraph(xml, find, "替换");
        const nodes = textNodesOf(paragraph.xml);
        let nextXml: string;
        if (nodes.length === 0) {
          nextXml = paragraph.xml.replace(
            /<\/w:p>$/,
            `<w:r><w:t xml:space="preserve">${escapeXmlText(text)}</w:t></w:r></w:p>`,
          );
        } else {
          const updates = nodes.map((_, index) => (index === 0 ? text : ""));
          nextXml = rebuildParagraph(paragraph.xml, updates);
        }
        xml = `${xml.slice(0, paragraph.start)}${nextXml}${xml.slice(paragraph.end)}`;
        changes.push(`替换段落：${find.slice(0, 40)}… → ${text.slice(0, 40)}…`);
        break;
      }
      case "insert_paragraph_after": {
        const find = validateText(op.find, "find");
        const text = validateText(op.text, "text");
        const paragraph = requireUniqueParagraph(xml, find, "定位插入点");
        xml = `${xml.slice(0, paragraph.start)}${paragraph.xml}${buildParagraph(paragraph.xml, text)}${xml.slice(paragraph.end)}`;
        changes.push(`在「${find.slice(0, 40)}…」后插入段落：${text.slice(0, 40)}…`);
        break;
      }
      case "append_paragraph": {
        const text = validateText(op.text, "text");
        const paragraphs = paragraphsOf(xml);
        const last = paragraphs[paragraphs.length - 1];
        const newParagraph = buildParagraph(last?.xml ?? "<w:p></w:p>", text);
        const sectPrIndex = xml.lastIndexOf("<w:sectPr");
        const insertAt = sectPrIndex >= 0 ? sectPrIndex : xml.lastIndexOf("</w:body>");
        if (insertAt < 0) throw new DocxEditError("NOT_DOCX", "文档结构异常：找不到正文结尾");
        xml = `${xml.slice(0, insertAt)}${newParagraph}${xml.slice(insertAt)}`;
        changes.push(`在文末追加段落：${text.slice(0, 40)}…`);
        break;
      }
      case "delete_paragraph": {
        const find = validateText(op.find, "find");
        const paragraph = requireUniqueParagraph(xml, find, "删除");
        if (insideTable(xml, paragraph.start)) {
          throw new DocxEditError(
            "IN_TABLE",
            "目标段落在表格单元格里，不能整体删除（会让单元格没有段落、Word 打开报修复）；请改用 replace_paragraph 清空文字",
          );
        }
        xml = `${xml.slice(0, paragraph.start)}${xml.slice(paragraph.end)}`;
        changes.push(`删除段落：${find.slice(0, 40)}…`);
        break;
      }
      default:
        throw new DocxEditError("INVALID_OP", `不支持的操作类型：${String(op.type)}`);
    }
  }

  return finalize(zip, xml, changes);
}

export interface DocxParagraphSummary {
  index: number;
  text: string;
  /** 段落样式（Heading1、ListBullet 等）；普通正文为 null。 */
  style: string | null;
}

/** 按文档顺序列出段落纯文本：office_edit 的 find 必须照抄这里的原文。 */
export async function readDocxParagraphs(buffer: Buffer): Promise<DocxParagraphSummary[]> {
  const zip = await JSZip.loadAsync(buffer).catch(() => null);
  const entry = zip?.file("word/document.xml");
  if (!entry) throw new DocxEditError("NOT_DOCX", "文件不是有效的 .docx（缺少 word/document.xml）");
  const xml = await entry.async("string");
  return paragraphsOf(xml).map((paragraph, index) => {
    const pPr = paragraphProperties(paragraph.xml);
    const style = /<w:pStyle\s+w:val="([^"]+)"/.exec(pPr)?.[1] ?? null;
    return { index, text: paragraph.text, style };
  });
}
