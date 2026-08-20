/**
 * 上传文件 → DocEnvelope.markdown（plan §4.3 资料导出约定的文件源实现）。
 *
 * 首期只接受 .md / .markdown（内容即 markdown，零转换成本）；
 * 其余格式（txt/docx/pdf…）后续按需加转换器。
 * KS 硬约束：单 raw 文件 ≤ 512KB——超限截断并附标注，不静默丢弃。
 */

/** 上传原件体积上限（base64 解码后的字节数）。 */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
/** 转换后 markdown 上限（对齐 KS 单文件 512KB 限制，plan §4.3）。 */
export const MARKDOWN_CAP_BYTES = 512 * 1024;
const TRUNCATION_MARKER = "\n\n> ⚠️ 内容超过 512KB 上限，已截断。\n";

export type FileConvertErrorCode = "unsupported_type" | "too_large" | "convert_failed";

export class FileConvertError extends Error {
  constructor(
    message: string,
    readonly code: FileConvertErrorCode,
  ) {
    super(message);
    this.name = "FileConvertError";
  }
}

export interface ConvertedFile {
  /** 信封标题：文件名去扩展名。 */
  title: string;
  markdown: string;
}

const MARKDOWN_EXTENSIONS = new Set(["md", "markdown"]);

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? filename.slice(dot + 1).trim().toLowerCase() : "";
}

/** 文件名 → 信封标题：去扩展名、剥路径分隔符、限长。 */
export function titleOfFilename(filename: string): string {
  const dot = filename.lastIndexOf(".");
  // dot>0 常规扩展名；dot===0 纯扩展名（".md"）→ 空基名；无扩展名 → 全名
  const base = dot > 0 ? filename.slice(0, dot) : dot === 0 ? "" : filename;
  return base.replace(/[\\/]/g, "-").trim().slice(0, 200) || "未命名文件";
}

function truncate(markdown: string): string {
  if (Buffer.byteLength(markdown, "utf8") <= MARKDOWN_CAP_BYTES) return markdown;
  // 按字节截断再对齐字符边界（中文 3 字节，粗暴 slice 会截出半个字符）
  const buffer = Buffer.from(markdown, "utf8").subarray(0, MARKDOWN_CAP_BYTES - Buffer.byteLength(TRUNCATION_MARKER));
  return buffer.toString("utf8").replace(/�+$/, "") + TRUNCATION_MARKER;
}

export function convertUploadedFile(filename: string, buffer: Buffer): ConvertedFile {
  if (buffer.byteLength === 0) {
    throw new FileConvertError("文件内容为空", "convert_failed");
  }
  if (buffer.byteLength > MAX_UPLOAD_BYTES) {
    throw new FileConvertError(
      `文件超过 ${Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024)}MB 上限`,
      "too_large",
    );
  }
  const extension = extensionOf(filename);
  if (!MARKDOWN_EXTENSIONS.has(extension)) {
    throw new FileConvertError(
      `暂不支持 .${extension || "未知"} 格式（当前仅支持 .md）`,
      "unsupported_type",
    );
  }
  const markdown = buffer.toString("utf8");
  if (!markdown.trim()) throw new FileConvertError("文件内容为空", "convert_failed");
  return { title: titleOfFilename(filename), markdown: truncate(markdown) };
}
