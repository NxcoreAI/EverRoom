export const DOCUMENT_ARTIFACT_SCHEMA_VERSION = 2 as const;
export const DOCUMENT_PARSER_REVISION = "document-understanding@2";

export type CanonicalDocumentFormat = "pdf" | "docx" | "xlsx" | "pptx" | "legacy-office";

export type DocumentBlockType =
  | "heading"
  | "paragraph"
  | "list-item"
  | "table"
  | "figure"
  | "chart"
  | "formula"
  | "header"
  | "footer";

export type DocumentEvidenceMethod = "native" | "text-layer" | "ocr" | "vlm" | "fused";

export interface DocumentEvidence {
  method: DocumentEvidenceMethod;
  nativeRef?: string;
  assetId?: string;
}

export interface CanonicalDocumentPage {
  pageNo: number;
  width: number | null;
  height: number | null;
  imageAssetId: string | null;
  renderStatus: "not-run" | "completed" | "failed";
  textLayerStatus: "present" | "absent" | "low-confidence" | "not-applicable";
  ocrStatus: "not-needed" | "not-run" | "completed" | "failed";
}

export interface CanonicalDocumentBlock {
  id: string;
  type: DocumentBlockType;
  pageNo: number | null;
  bbox: [number, number, number, number] | null;
  readingOrder: number;
  content: string;
  confidence: number;
  source: DocumentEvidence;
}

export interface CanonicalDocumentTableCell {
  row: number;
  column: number;
  rowSpan: number;
  columnSpan: number;
  content: string;
  nativeRef?: string;
}

export interface CanonicalDocumentTable {
  id: string;
  pageNo: number | null;
  sheetName?: string;
  bbox: [number, number, number, number] | null;
  cells: CanonicalDocumentTableCell[];
  confidence: number;
  source: DocumentEvidence;
}

export interface CanonicalDocumentAsset {
  id: string;
  kind: "page-image" | "embedded-image" | "chart" | "attachment";
  pageNo: number | null;
  mime: string;
  contentHash: string | null;
  storageRef: string | null;
  sourceRef?: string;
}

export interface DocumentParseQuality {
  status: "complete" | "partial" | "failed";
  nativeTextCoverage: number;
  ocrCoverage: number;
  visualCoverage: number;
  requiresReview: boolean;
}

export interface CanonicalDocumentArtifact {
  schemaVersion: typeof DOCUMENT_ARTIFACT_SCHEMA_VERSION;
  document: {
    fileEntryId: string;
    fileVersionId: string;
    contentHash: string;
    filename: string;
    format: CanonicalDocumentFormat;
    parserRevision: string;
    visualRevision: string | null;
    visualModel: string | null;
  };
  pages: CanonicalDocumentPage[];
  blocks: CanonicalDocumentBlock[];
  tables: CanonicalDocumentTable[];
  assets: CanonicalDocumentAsset[];
  warnings: string[];
  quality: DocumentParseQuality;
}

export interface ParsedDocumentResult {
  id: string;
  artifact: CanonicalDocumentArtifact;
  markdown: string;
  deduplicated: boolean;
  createdAt: string;
  updatedAt: string;
}
