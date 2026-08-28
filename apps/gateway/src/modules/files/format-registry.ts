import { extname } from "node:path";

export interface FileFormatCapability {
  extension: string;
  dataType: string;
  parserId: string;
  parserVersion: number;
  manualImport: boolean;
  autoScan: boolean;
  connectorImport: boolean;
  maxBytes: number;
}

export const DEFAULT_FILE_MAX_BYTES = 20 * 1024 * 1024;
/** 富媒体文档（演示/表格/文字/PDF）常内嵌高分辨率媒体，超过默认上限是常态而非例外。 */
export const RICH_MEDIA_FILE_MAX_BYTES = 100 * 1024 * 1024;

const capability = (
  extensions: string[],
  dataType: string,
  parserId: string,
  maxBytes: number = DEFAULT_FILE_MAX_BYTES,
): FileFormatCapability[] => extensions.map((extension) => ({
  extension,
  dataType,
  parserId,
  parserVersion: 1,
  manualImport: true,
  autoScan: true,
  connectorImport: true,
  maxBytes,
}));

/** The only public-file allowlist. Internal JSON envelopes are intentionally absent. */
export const FILE_FORMAT_CAPABILITIES: readonly FileFormatCapability[] = [
  ...capability([".md", ".markdown", ".mdx"], "document", "markdown"),
  ...capability([".txt", ".text"], "document", "plain-text"),
  ...capability([".pdf"], "document", "pdf-unpdf", RICH_MEDIA_FILE_MAX_BYTES),
  ...capability([".docx", ".docm", ".dotx", ".dotm"], "office-doc", "docx-mammoth", RICH_MEDIA_FILE_MAX_BYTES),
  ...capability([".doc", ".dot", ".rtf", ".odt"], "office-doc", "legacy-word-soffice", RICH_MEDIA_FILE_MAX_BYTES),
  ...capability([".xlsx", ".xlsm", ".xltx", ".xltm", ".xlam"], "spreadsheet", "xlsx-exceljs", RICH_MEDIA_FILE_MAX_BYTES),
  ...capability([".xls", ".xlsb", ".xlt", ".xla", ".ods"], "spreadsheet", "legacy-sheet-soffice", RICH_MEDIA_FILE_MAX_BYTES),
  ...capability([".pptx", ".pptm", ".potx", ".potm", ".ppsx", ".ppsm", ".sldx", ".sldm"], "slides", "pptx-jszip", RICH_MEDIA_FILE_MAX_BYTES),
  ...capability([".ppt", ".pot", ".pps", ".odp"], "slides", "legacy-slides-soffice", RICH_MEDIA_FILE_MAX_BYTES),
  ...capability([".csv"], "spreadsheet", "csv-rfc4180"),
  ...capability([".html", ".htm"], "html", "html-turndown"),
];

const byExtension = new Map(FILE_FORMAT_CAPABILITIES.map((item) => [item.extension, item]));

/** 传输层兜底：全格式 maxBytes 的最大值，路由据此设置 multipart fileSize / bodyLimit。 */
export const MAX_FORMAT_FILE_BYTES = Math.max(...FILE_FORMAT_CAPABILITIES.map((item) => item.maxBytes));

export function normalizedFileExtension(filename: string): string {
  return extname(filename.split(/[\\/]/).pop() ?? filename).toLowerCase();
}

export function fileFormatCapability(filename: string): FileFormatCapability | null {
  return byExtension.get(normalizedFileExtension(filename)) ?? null;
}

export function fileParserVersion(capabilityValue: FileFormatCapability): string {
  return `${capabilityValue.parserId}@${capabilityValue.parserVersion}`;
}

export function isPublicFileSupported(filename: string): boolean {
  return fileFormatCapability(filename) !== null;
}
