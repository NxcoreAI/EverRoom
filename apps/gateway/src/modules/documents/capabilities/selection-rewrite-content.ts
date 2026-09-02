import type {
  RoomDocument,
  SubagentInvocation,
  TiptapJsonContent,
} from "@nxcore/agent-contract";
import { DOCUMENT_TITLE_NODE_TYPE } from "@nxcore/document-model";
import { agentDocumentMarkdown, sanitizeAgentDocumentTables } from "../agent-markdown.js";
import { DocumentServiceError } from "../errors.js";

/**
 * 改写信任收口（agent-architecture-optimization-plan §3.2）：
 * 服务端从 invocation 完成态输出重建"权威文档 + 替换文本"的完整提议内容，
 * 客户端不再回传全文。本文件只做纯转换与依赖注入组装，
 * 不 import subagents / context-rooms 模块（边界由 create-server 装配）。
 */

export interface SelectionRewriteContentResolverDependencies {
  /** 取 invocation 完成态（SubagentOrchestrator.getInvocation 的注入形态）。 */
  getInvocation(invocationId: string): SubagentInvocation | null;
  /** 授权判定（isSelectionRewriteInvocationAuthorized 的注入形态）。 */
  isInvocationAuthorized(invocation: SubagentInvocation | null, roomId: string): boolean;
  /** 取权威文档（DocumentService.get 的注入形态）。 */
  getDocument(documentId: string): RoomDocument | null;
}

export interface SelectionRewriteResolvedContent {
  /** 解析出的完整提议文档体（type: "doc"）。 */
  contentJson: TiptapJsonContent;
  /** 以下归因字段均取自 invocation 输入/输出，不采信客户端回传。 */
  originalText: string;
  replacementText: string;
  instruction: string;
  /** true = 内容按用户编辑过的替换文本重建（归因语义：Agent 提案 + 用户修改）。 */
  userModified?: boolean;
}

export type SelectionRewriteContentResolver = (input: {
  invocationId: string;
  documentId: string;
  roomId: string;
  /**
   * 用户在预览框编辑过替换文本时的覆盖文本（出路二）：
   * 重放选区替换时用它替代 invocation 输出，编辑内容不再被静默丢弃。
   */
  userEditedReplacementText?: string;
}) => SelectionRewriteResolvedContent | null;

/**
 * 与渲染端 sanitizeSelectionRewriteOutput 同款的输出净化：
 * 剥离包裹代码围栏与"改写内容如下："式前缀，代码块选区保留空白。
 */
export function sanitizeSelectionRewriteReplacement(
  value: string,
  options: { preserveWhitespace?: boolean } = {},
): string {
  const preserveWhitespace = options.preserveWhitespace === true;
  let output = preserveWhitespace ? value : value.trimStart();
  const openingFence = /^```([^\r\n]*)(?:\r?\n|$)/.exec(output);
  const fenceLanguage = openingFence?.[1]?.trim().toLowerCase() ?? "";
  const unwrapFence = preserveWhitespace
    || fenceLanguage === ""
    || fenceLanguage === "text"
    || fenceLanguage === "plain"
    || fenceLanguage === "plaintext"
    || fenceLanguage === "markdown"
    || fenceLanguage === "md";
  if (openingFence && unwrapFence) {
    output = output.slice(openingFence[0].length);
    output = output.replace(/(\r?\n)```[ \t]*$/, "$1");
  }
  if (preserveWhitespace) return output;
  output = output.replace(/^(?:改写|重写)(?:(?:的)?(?:文档)?(?:选区)?(?:内容|文本|结果)(?:如下)?)?\s*[:：]\s*/i, "");
  output = output.replace(/^replacement\s*[:：]\s*/i, "");
  return output.trimEnd();
}

const TEXT_BLOCK_TYPES = new Set(["paragraph", "heading", "codeBlock"]);
const LIST_TYPES = new Set(["bulletList", "orderedList", "taskList"]);

interface TextblockSeat {
  node: TiptapJsonContent;
  parent: TiptapJsonContent;
  index: number;
  text: string;
}

/** 对齐编辑器 textBetween（无 leafText）：行内叶子（hardBreak 等）不贡献字符。 */
function selectionTextOf(node: TiptapJsonContent): string {
  if (typeof node.text === "string") return node.text;
  if (node.type === "hardBreak") return "";
  return (node.content ?? []).map(selectionTextOf).join("");
}

function collectTextblocks(
  node: TiptapJsonContent,
  parent: TiptapJsonContent,
  index: number,
  seats: TextblockSeat[],
): void {
  if (node.type === DOCUMENT_TITLE_NODE_TYPE) return;
  if (TEXT_BLOCK_TYPES.has(node.type)) {
    seats.push({ node, parent, index, text: selectionTextOf(node) });
    return;
  }
  (node.content ?? []).forEach((child, childIndex) => collectTextblocks(child, node, childIndex, seats));
}

function inlineLength(node: TiptapJsonContent): number {
  if (typeof node.text === "string") return node.text.length;
  if (node.type === "hardBreak") return 0;
  return (node.content ?? []).reduce((total, child) => total + inlineLength(child), 0);
}

/** 按 selectionTextOf 的文本坐标切分行内内容（与编辑器选区文本度量一致）。 */
function splitInlineChildren(
  children: TiptapJsonContent[],
  offset: number,
): [TiptapJsonContent[], TiptapJsonContent[]] {
  const before: TiptapJsonContent[] = [];
  const after: TiptapJsonContent[] = [];
  let remaining = offset;
  for (const child of children) {
    const length = inlineLength(child);
    if (remaining <= 0) {
      after.push(child);
    } else if (remaining >= length) {
      before.push(child);
      remaining -= length;
    } else if (typeof child.text === "string") {
      const left = child.text.slice(0, remaining);
      const right = child.text.slice(remaining);
      if (left) before.push({ ...child, text: left });
      if (right) after.push({ ...child, text: right });
      remaining = 0;
    } else {
      // 非文本行内节点内部不可再切分：整体留在前段（罕见，仅防御）。
      before.push(child);
      remaining = 0;
    }
  }
  return [before, after];
}

function replaceCodeText(seat: TextblockSeat, code: string): void {
  seat.node.content = code ? [{ type: "text", text: code }] : [];
}

function removeSeat(seat: TextblockSeat): void {
  (seat.parent.content ?? []).splice(seat.index, 1);
}

function applyCodeBlockReplacement(
  covered: Array<{ seat: TextblockSeat; from: number; to: number }>,
  replacement: string,
): void {
  if (covered.length === 1) {
    const { seat, from, to } = covered[0]!;
    replaceCodeText(seat, seat.text.slice(0, from) + replacement + seat.text.slice(to));
    return;
  }
  // 对齐编辑器行为：行数与覆盖块数一致时逐块替换，否则整体并入首块、其余移除。
  const lines = replacement.replace(/\r\n?/g, "\n").split("\n");
  if (lines.length === covered.length) {
    covered.forEach(({ seat, from, to }, position) => {
      replaceCodeText(seat, seat.text.slice(0, from) + lines[position]! + seat.text.slice(to));
    });
    return;
  }
  const [first, ...rest] = covered;
  replaceCodeText(first!.seat, first!.seat.text.slice(0, first!.from) + replacement + first!.seat.text.slice(first!.to));
  for (const { seat } of rest.reverse()) removeSeat(seat);
}

function parseReplacementBlocks(replacement: string): TiptapJsonContent[] {
  try {
    const parsed = sanitizeAgentDocumentTables(
      agentDocumentMarkdown.parse(replacement) as TiptapJsonContent,
    );
    return parsed.content.content ?? [];
  } catch (error) {
    if (error instanceof DocumentServiceError) throw error;
    throw new DocumentServiceError(
      "INVALID_MARKDOWN",
      error instanceof Error ? error.message : "Replacement Markdown could not be parsed",
    );
  }
}

function partialBlock(
  seat: TextblockSeat,
  content: TiptapJsonContent[],
  keepId: boolean,
): TiptapJsonContent | null {
  if (!content.length) return null;
  const attrs = { ...(seat.node.attrs ?? {}) };
  if (!keepId) delete attrs.id;
  return { ...seat.node, attrs, content: structuredClone(content) };
}

function spliceIntoParent(
  parent: TiptapJsonContent,
  index: number,
  removeCount: number,
  nodes: TiptapJsonContent[],
): void {
  if (!parent.content) parent.content = [];
  // 列表容器与同型列表结果合并（对齐 patch 流的 nodesForParent 语义）。
  if (LIST_TYPES.has(parent.type) && nodes.length === 1 && nodes[0]!.type === parent.type) {
    parent.content.splice(index, removeCount, ...(nodes[0]!.content ?? []));
    return;
  }
  parent.content.splice(index, removeCount, ...nodes);
}

function applyMarkdownReplacement(
  covered: Array<{ seat: TextblockSeat; from: number; to: number }>,
  replacement: string,
): void {
  const nodes = parseReplacementBlocks(replacement);
  const first = covered[0]!;
  const last = covered[covered.length - 1]!;
  const firstPartial = first.from > 0;
  const lastPartial = last.to < last.seat.text.length;

  // 对齐编辑器：选区落在单个文本块内部且替换解析为单段时，保持块结构做行内拼接。
  if (covered.length === 1 && (firstPartial || lastPartial)
    && nodes.length === 1 && nodes[0]!.type === "paragraph") {
    const [prefix] = splitInlineChildren(first.seat.node.content ?? [], first.from);
    const [, suffix] = splitInlineChildren(first.seat.node.content ?? [], first.to);
    first.seat.node.content = [
      ...structuredClone(prefix),
      ...structuredClone(nodes[0]!.content ?? []),
      ...structuredClone(suffix),
    ];
    return;
  }

  // 块级替换：首尾未选中的残段保留，覆盖区替换为解析结果（跨父容器时结果落在首组）。
  const groups: Array<{ parent: TiptapJsonContent; ranges: typeof covered }> = [];
  for (const range of covered) {
    const current = groups[groups.length - 1];
    if (current && current.parent === range.seat.parent) current.ranges.push(range);
    else groups.push({ parent: range.seat.parent, ranges: [range] });
  }
  for (const [groupIndex, group] of groups.entries()) {
    const groupFirst = group.ranges[0]!;
    const groupLast = group.ranges[group.ranges.length - 1]!;
    const insert: TiptapJsonContent[] = [];
    if (groupIndex === 0 && firstPartial) {
      const [prefix] = splitInlineChildren(groupFirst.seat.node.content ?? [], groupFirst.from);
      const head = partialBlock(groupFirst.seat, prefix, true);
      if (head) insert.push(head);
    }
    if (groupIndex === 0) insert.push(...structuredClone(nodes));
    if (groupIndex === groups.length - 1 && lastPartial) {
      const [, suffix] = splitInlineChildren(groupLast.seat.node.content ?? [], groupLast.to);
      const tail = partialBlock(groupLast.seat, suffix, false);
      if (tail) insert.push(tail);
    }
    spliceIntoParent(
      group.parent,
      groupFirst.seat.index,
      groupLast.seat.index - groupFirst.seat.index + 1,
      insert,
    );
  }
}

/**
 * 在权威文档体上重放"选区替换"：以 invocation 输入的 selectedText 定位选区
 * （编辑器 textBetween 文本坐标），按选区形态应用净化后的替换文本，
 * 返回完整提议文档体与净化后的替换文本。定位失败抛 SELECTION_NOT_FOUND。
 */
export function buildSelectionRewriteProposedContent(
  source: TiptapJsonContent,
  input: { selectedText: string; replacementText: string },
): { content: TiptapJsonContent; replacementText: string } {
  const content = structuredClone(source);
  const seats: TextblockSeat[] = [];
  (content.content ?? []).forEach((child, index) => collectTextblocks(child, content, index, seats));
  const joined = seats.map((seat) => seat.text).join("\n");
  const selectionStart = joined.indexOf(input.selectedText);
  if (!input.selectedText || selectionStart < 0) {
    throw new DocumentServiceError(
      "SELECTION_NOT_FOUND",
      "The selection text from the invocation could not be located in the document body",
      409,
      { retryable: true },
    );
  }
  const selectionEnd = selectionStart + input.selectedText.length;

  const covered: Array<{ seat: TextblockSeat; from: number; to: number }> = [];
  let blockStart = 0;
  for (const seat of seats) {
    const length = seat.text.length;
    const from = Math.min(Math.max(selectionStart - blockStart, 0), length);
    const to = Math.min(Math.max(selectionEnd - blockStart, 0), length);
    if (to > from || (length === 0 && selectionStart < blockStart && blockStart < selectionEnd)) {
      covered.push({ seat, from, to });
    }
    blockStart += length + 1;
  }
  if (!covered.length) {
    throw new DocumentServiceError(
      "SELECTION_NOT_FOUND",
      "The selection text from the invocation could not be located in the document body",
      409,
      { retryable: true },
    );
  }

  const insideCodeBlock = covered.every((range) => range.seat.node.type === "codeBlock");
  const replacement = sanitizeSelectionRewriteReplacement(input.replacementText, {
    preserveWhitespace: insideCodeBlock,
  });
  if (!insideCodeBlock && !replacement.trim()) {
    throw new DocumentServiceError(
      "INVALID_CONTENT",
      "Selection rewrite invocation produced no replacement text",
    );
  }
  if (insideCodeBlock) applyCodeBlockReplacement(covered, replacement);
  else applyMarkdownReplacement(covered, replacement);
  return { content, replacementText: replacement };
}

/**
 * 组装 resolver：getInvocation → 授权复核 → invocation 输入/输出解析 → 重建提议内容。
 * 返回 null 表示 invocation 缺失、未完成、未授权、无可用于本文档的输出。
 */
export function createSelectionRewriteContentResolver(
  dependencies: SelectionRewriteContentResolverDependencies,
): SelectionRewriteContentResolver {
  const { getInvocation, isInvocationAuthorized, getDocument } = dependencies;
  return ({ invocationId, documentId, roomId, userEditedReplacementText }) => {
    const invocation = getInvocation(invocationId);
    if (!invocation || !isInvocationAuthorized(invocation, roomId)) return null;
    const rawInput = invocation.input;
    const input = rawInput && typeof rawInput === "object" && !Array.isArray(rawInput)
      ? rawInput as Record<string, unknown>
      : {};
    const selectedText = typeof input.selectedText === "string" ? input.selectedText : "";
    // M2（doc-writer-subagent-plan §8）：doc-writer 带 outputSchema，替换文本在
    // structuredOutput.replacementText；text 回退兼容迁移期存量的 context-room invocation。
    const structured = invocation.result?.structuredOutput;
    const structuredReplacement = structured !== null
      && typeof structured === "object"
      && !Array.isArray(structured)
      ? (structured as Record<string, unknown>).replacementText
      : null;
    const resultText = typeof structuredReplacement === "string" && structuredReplacement
      ? structuredReplacement
      : invocation.result?.text;
    if (!selectedText || typeof resultText !== "string") return null;
    const document = getDocument(documentId);
    if (!document || document.roomId !== roomId || document.deletedAt) return null;
    const userEdited = typeof userEditedReplacementText === "string";
    const built = buildSelectionRewriteProposedContent(document.contentJson, {
      selectedText,
      // 出路二：用户编辑过预览文本时按用户文本重放，否则用 invocation 输出。
      replacementText: userEdited ? userEditedReplacementText : resultText,
    });
    return {
      contentJson: built.content,
      originalText: selectedText,
      replacementText: built.replacementText,
      instruction: typeof input.instruction === "string" ? input.instruction : "",
      ...(userEdited ? { userModified: true } : {}),
    };
  };
}
