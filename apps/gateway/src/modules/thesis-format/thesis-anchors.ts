/**
 * 论文排版 v2：锚点词典（固定槽位识别，方案 §6.3）。
 *
 * 模板侧与内容侧共用：模板里的「参考资料」识别为参考文献槽位，内容里的
 * 「参考文献」也直达同一槽位。词典只登记"结构性"标题，不登记正文章节名。
 */

import { normalizeTitle } from "./text-normalize.js";

/** 固定槽位类型（与 ThesisSlot.kind 对齐）。 */
export type AnchorKind =
  | "commitment"
  | "abstract_zh"
  | "abstract_en"
  | "toc"
  | "reference"
  | "acknowledgement"
  | "appendix";

/** 锚点 → 归一化后的精确写法（归一化已去标点空格并转小写，故这里同样写归一化形式）。 */
const ANCHORS: Array<{ kind: AnchorKind; exact: string[]; pattern?: RegExp }> = [
  { kind: "commitment", exact: ["诚信承诺书", "原创性声明", "学位论文原创性声明", "授权书", "论文使用授权书"] },
  { kind: "abstract_zh", exact: ["摘要", "内容摘要", "中文摘要", "中文摘要与关键词", "摘要与关键词"] },
  { kind: "abstract_en", exact: ["abstract", "summary", "abstractandkeywords"], pattern: /^abstract/ },
  { kind: "toc", exact: ["目录", "contents", "tableofcontents"], pattern: /^(目录|contents|tableofcontents)$/ },
  { kind: "reference", exact: ["参考文献", "参考资料", "引用文献", "文献参考", "bibliography", "references"], pattern: /^(references|bibliography)/ },
  { kind: "acknowledgement", exact: ["致谢", "谢辞", "鸣谢", "acknowledgement", "acknowledgment", "acknowledgements"], pattern: /^acknowledg/ },
  { kind: "appendix", exact: ["附录", "附录a", "附录b", "附件"], pattern: /^(附录|附件|appendix)/ },
];

/** 识别固定槽位；不是结构标题则返回 null。 */
export function anchorKindOf(rawTitle: string): AnchorKind | null {
  const normalized = normalizeTitle(rawTitle);
  if (!normalized) return null;
  for (const entry of ANCHORS) {
    if (entry.exact.includes(normalized)) return entry.kind;
    if (entry.pattern?.test(normalized)) return entry.kind;
  }
  return null;
}

/** 该锚点类型在输出里是否为「保留模板原标题」的固定槽位。 */
export function isContainerKind(kind: AnchorKind | undefined): boolean {
  return kind === "reference" || kind === "appendix" || kind === "acknowledgement";
}