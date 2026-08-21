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

const capability = (
  extensions: string[],
  dataType: string,
  parserId: string,
): FileFormatCapability[] => extensions.map((extension) => ({
  extension,
  dataType,
  parserId,
  parserVersion: 1,
  manualImport: true,
  autoScan: true,
  connectorImport: true,
  maxBytes: DEFAULT_FILE_MAX_BYTES,
}));

/** The only public-file allowlist. Internal JSON envelopes are intentionally absent. */
export const FILE_FORMAT_CAPABILITIES: readonly FileFormatCapability[] = [
  ...capability([".md", ".markdown", ".mdx"], "document", "markdown"),
  ...capability([".txt", ".text"], "document", "plain-text"),
  ...capability([".pdf"], "document", "pdf-unpdf"),
  ...capability([".docx", ".docm", ".dotx", ".dotm"], "office-doc", "docx-mammoth"),
  ...capability([".doc", ".dot", ".rtf", ".odt"], "office-doc", "legacy-word-soffice"),
  ...capability([".xlsx", ".xlsm", ".xltx", ".xltm", ".xlam"], "spreadsheet", "xlsx-exceljs"),
  ...capability([".xls", ".xlsb", ".xlt", ".xla", ".ods"], "spreadsheet", "legacy-sheet-soffice"),
  ...capability([".pptx", ".pptm", ".potx", ".potm", ".ppsx", ".ppsm", ".sldx", ".sldm"], "slides", "pptx-jszip"),
  ...capability([".ppt", ".pot", ".pps", ".odp"], "slides", "legacy-slides-soffice"),
  ...capability([".csv"], "spreadsheet", "csv-rfc4180"),
  ...capability([".html", ".htm"], "html", "html-turndown"),
];

const byExtension = new Map(FILE_FORMAT_CAPABILITIES.map((item) => [item.extension, item]));

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
