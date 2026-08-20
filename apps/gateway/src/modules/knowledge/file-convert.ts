import { converterOfExtension } from "../ingest/converters.js";

/**
 * 文件名 → 信封标题的派生（plan §4.3 资料导出约定）。
 *
 * 上传字节的归一化（含格式识别与转换）已统一收口到理解引擎
 * `modules/ingest`（unified-ingest-plan U1/U5）；本文件只保留标题
 * 派生函数供引擎的 normalizers 复用。
 */

/** 文件名 → 信封标题：去扩展名、剥路径分隔符、限长。 */
export function titleOfFilename(filename: string): string {
  const dot = filename.lastIndexOf(".");
  // dot>0 常规扩展名；dot===0 纯扩展名（".md"）→ 空基名；无扩展名 → 全名
  const base = dot > 0 ? filename.slice(0, dot) : dot === 0 ? "" : filename;
  return base.replace(/[\\/]/g, "-").trim().slice(0, 200) || "未命名文件";
}

/** 上传入口使用的轻量转换适配器；统一 ingest 负责具体格式解析。 */
export async function convertUploadedFile(filename: string, buffer: Buffer): Promise<{
  title: string;
  markdown: string;
}> {
  const extension = filename.lastIndexOf(".") > 0
    ? filename.slice(filename.lastIndexOf(".") + 1).toLowerCase()
    : "";
  const converter = converterOfExtension(extension);
  const markdown = converter
    ? await converter(buffer)
    : buffer.toString("utf8");
  if (!markdown.trim()) throw new Error("文件内容为空");
  return { title: titleOfFilename(filename), markdown };
}
