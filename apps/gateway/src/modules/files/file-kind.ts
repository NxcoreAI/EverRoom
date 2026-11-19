import { ARTIFACT_SOURCE_KINDS } from "./service.js";

/** 扩展名 → Agent 路由用的文件类型标签（决定该用 file_read / word_agent_* / slides_*）。 */
export const FILE_KIND_BY_EXTENSION: Record<string, string> = {
  ".docx": "word",
  ".doc": "word",
  ".xlsx": "excel",
  ".xls": "excel",
  ".pptx": "slides",
  ".ppt": "slides",
  ".pdf": "pdf",
  ".md": "markdown",
  ".txt": "text",
  ".csv": "csv",
  ".png": "image",
  ".jpg": "image",
  ".jpeg": "image",
  ".webp": "image",
  ".gif": "image",
};

/**
 * 正文能被 file_read 读出来的类型：Office/PDF 走 document-understanding 解析，
 * 纯文本类靠入库时落下的 Markdown。图片只有字节，读不出正文。
 */
const READABLE_KINDS = new Set(["word", "excel", "slides", "pdf", "markdown", "text", "csv"]);

/** 取小写扩展名（带点）与该用哪种工具读它——file_search 与 library_browse 共用一份口径。 */
export function describeFileKind(originalName: string): { extension: string; kind: string; readable: boolean } {
  const match = /(\.[^./\\]+)$/.exec(originalName.trim());
  const extension = match?.[1]?.toLowerCase() ?? "";
  const kind = FILE_KIND_BY_EXTENSION[extension] ?? "file";
  return { extension, kind, readable: READABLE_KINDS.has(kind) };
}

/** 条目属于「产物」还是「资料」——与界面两个页签同一口径。 */
export function scopeLabelOf(sourceKind: string): { scope: "产物" | "资料"; scopeKey: "artifacts" | "library" } {
  const isArtifact = (ARTIFACT_SOURCE_KINDS as readonly string[]).includes(sourceKind);
  return isArtifact
    ? { scope: "产物", scopeKey: "artifacts" }
    : { scope: "资料", scopeKey: "library" };
}
