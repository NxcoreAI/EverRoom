import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { and, eq } from "drizzle-orm";
import type { GatewayDatabase } from "../../infrastructure/database/client.js";
import { fileEntries, parsedDocuments } from "../../infrastructure/database/schema.js";
import type { FilesService } from "../files/service.js";
import { converterOfExtension } from "../ingest/converters.js";
import type { DocumentOcrClient } from "../perception/vlm-client.js";
import { extractOoxmlAssets } from "./assets.js";
import { extractPdfAssets, parsePdfNative, renderPdfPage, storePageAsset } from "./pdf.js";
import {
  DOCUMENT_ARTIFACT_SCHEMA_VERSION,
  DOCUMENT_PARSER_REVISION,
  type CanonicalDocumentArtifact,
  type CanonicalDocumentBlock,
  type CanonicalDocumentFormat,
  type CanonicalDocumentPage,
  type CanonicalDocumentTable,
  type ParsedDocumentResult,
} from "./types.js";

const SUPPORTED_EXTENSIONS = new Set([
  "pdf",
  "doc", "docx", "docm", "dot", "dotx", "dotm", "rtf",
  "xls", "xlsx", "xlsm", "xlsb", "xlt", "xltx", "xltm", "xla", "xlam", "ods",
  "ppt", "pptx", "pptm", "pot", "potx", "potm", "pps", "ppsx", "ppsm", "sldx", "sldm", "odp",
]);

function extensionOf(filename: string): string {
  return extname(filename).slice(1).toLowerCase();
}

function formatOf(extension: string): CanonicalDocumentFormat {
  if (extension === "pdf") return "pdf";
  if (["docx", "docm", "dotx", "dotm"].includes(extension)) return "docx";
  if (["xlsx", "xlsm", "xltx", "xltm", "xlam"].includes(extension)) return "xlsx";
  if (["pptx", "pptm", "potx", "potm", "ppsx", "ppsm", "sldx", "sldm"].includes(extension)) return "pptx";
  return "legacy-office";
}

function pageSections(markdown: string): Array<{ pageNo: number; title: string | null; content: string }> {
  const matches = [...markdown.matchAll(/^## 第 (\d+) 页(?:：([^\n]*))?\s*$/gm)];
  if (matches.length === 0) return [];
  return matches.map((match, index) => ({
    pageNo: Number(match[1]),
    title: match[2]?.trim() || null,
    content: markdown.slice(match.index! + match[0].length, matches[index + 1]?.index ?? markdown.length).trim(),
  }));
}

function isSpreadsheet(extension: string): boolean {
  return ["xls", "xlsx", "xlsm", "xlsb", "xlt", "xltx", "xltm", "xla", "xlam", "ods"].includes(extension);
}

function logicalPages(format: CanonicalDocumentFormat, markdown: string, extension: string): CanonicalDocumentPage[] {
  const sections = pageSections(markdown);
  if (sections.length > 0) {
    return sections.map(({ pageNo, content }) => ({
      pageNo,
      width: null,
      height: null,
      imageAssetId: null,
      renderStatus: "not-run",
      textLayerStatus: content ? "present" : "absent",
      ocrStatus: content ? "not-needed" : "not-run",
    }));
  }
  if (isSpreadsheet(extension)) return [];
  return [{
    pageNo: 1,
    width: null,
    height: null,
    imageAssetId: null,
    renderStatus: "not-run",
    textLayerStatus: "not-applicable",
    ocrStatus: "not-run",
  }];
}

function blocksOf(markdown: string, format: CanonicalDocumentFormat, extension: string): CanonicalDocumentBlock[] {
  const sections = pageSections(markdown);
  const sources = sections.length > 0
    ? sections.map((section) => ({ pageNo: section.pageNo, title: section.title, content: section.content }))
    : [{ pageNo: isSpreadsheet(extension) ? null : 1, title: null, content: markdown }];
  const blocks: CanonicalDocumentBlock[] = [];
  let readingOrder = 0;
  for (const source of sources) {
    if (source.title) {
      readingOrder += 1;
      blocks.push({
        id: `block-${readingOrder}`,
        type: "heading",
        pageNo: source.pageNo,
        bbox: null,
        readingOrder,
        content: source.title,
        confidence: 1,
        source: { method: "native", nativeRef: `${format}:page:${source.pageNo}:title` },
      });
    }
    for (const raw of source.content.split(/\n{2,}/)) {
      const content = raw.trim();
      if (!content) continue;
      const heading = /^(#{1,6})\s+(.+)$/.exec(content);
      const listItem = /^[-*]\s+/.test(content);
      const table = /^\|.+\|$/m.test(content) && /\n\|(?:\s*:?-+:?\s*\|)+/m.test(content);
      readingOrder += 1;
      blocks.push({
        id: `block-${readingOrder}`,
        type: table ? "table" : heading ? "heading" : listItem ? "list-item" : "paragraph",
        pageNo: source.pageNo,
        bbox: null,
        readingOrder,
        content: heading?.[2]?.trim() ?? content,
        confidence: 1,
        source: {
          method: format === "pdf" ? "text-layer" : "native",
          nativeRef: `${format}:block:${readingOrder}`,
        },
      });
    }
  }
  return blocks;
}

function markdownCells(line: string): string[] {
  const cells: string[] = [];
  let value = "";
  for (let index = 1; index < line.length - 1; index += 1) {
    const char = line[index]!;
    if (char === "\\" && line[index + 1] === "|") {
      value += "|";
      index += 1;
    } else if (char === "|") {
      cells.push(value.trim());
      value = "";
    } else {
      value += char;
    }
  }
  cells.push(value.trim());
  return cells;
}

function tablesOf(blocks: CanonicalDocumentBlock[], format: CanonicalDocumentFormat): CanonicalDocumentTable[] {
  const tables: CanonicalDocumentTable[] = [];
  let lastHeading: string | undefined;
  for (const block of blocks) {
    if (block.type === "heading") {
      lastHeading = block.content;
      continue;
    }
    if (block.type !== "table") continue;
    const index = tables.length;
    const rows = block.content.split("\n")
      .filter((line) => /^\|.+\|$/.test(line.trim()))
      .filter((line) => !/^\|(?:\s*:?-+:?\s*\|)+$/.test(line.trim()));
    tables.push({
      id: `table-${index + 1}`,
      pageNo: block.pageNo,
      ...(format === "xlsx" && lastHeading ? { sheetName: lastHeading } : {}),
      bbox: null,
      cells: rows.flatMap((line, row) => markdownCells(line).map((value, column) => ({
        row,
        column,
        rowSpan: 1,
        columnSpan: 1,
        content: value,
        nativeRef: `${format}:table:${index + 1}:r${row + 1}c${column + 1}`,
      }))),
      confidence: 0.9,
      source: { method: "native", nativeRef: `${format}:table:${index + 1}` },
    });
  }
  return tables;
}

function dtoOf(row: typeof parsedDocuments.$inferSelect, deduplicated: boolean): ParsedDocumentResult {
  return {
    id: row.id,
    artifact: row.artifact as unknown as CanonicalDocumentArtifact,
    markdown: row.markdown,
    deduplicated,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class DocumentUnderstandingService {
  private readonly parseInFlight = new Map<string, Promise<ParsedDocumentResult | null>>();

  constructor(
    private readonly db: GatewayDatabase,
    private readonly files: FilesService,
    private visual: DocumentOcrClient | null = null,
    private readonly dataDir: string | null = null,
  ) {}

  replaceVisualProvider(visual: DocumentOcrClient | null): void {
    this.visual = visual;
  }

  supports(filename: string): boolean {
    return SUPPORTED_EXTENSIONS.has(extensionOf(filename));
  }

  get(fileVersionId: string): ParsedDocumentResult | null {
    const row = this.db.select().from(parsedDocuments)
      .where(and(
        eq(parsedDocuments.fileVersionId, fileVersionId),
        eq(parsedDocuments.parserRevision, DOCUMENT_PARSER_REVISION),
      )).get();
    return row ? dtoOf(row, true) : null;
  }

  markdownForFile(fileEntryId: string): string | null {
    const row = this.db.select({ markdown: parsedDocuments.markdown })
      .from(fileEntries)
      .innerJoin(parsedDocuments, and(
        eq(parsedDocuments.fileVersionId, fileEntries.currentVersionId),
        eq(parsedDocuments.parserRevision, DOCUMENT_PARSER_REVISION),
      ))
      .where(eq(fileEntries.id, fileEntryId))
      .get();
    return row?.markdown ?? null;
  }

  async parseVersion(fileEntryId: string, fileVersionId: string): Promise<ParsedDocumentResult | null> {
    const context = this.files.getVersionContext(fileEntryId, fileVersionId);
    if (!context) throw new Error("document_file_version_not_found");
    if (!this.supports(context.entry.originalName)) return null;
    const existing = this.get(fileVersionId);
    if (existing) return existing;

    const active = this.parseInFlight.get(fileVersionId);
    if (active) return active;
    const parsing = this.parseVersionOnce(fileEntryId, fileVersionId, context);
    this.parseInFlight.set(fileVersionId, parsing);
    try {
      return await parsing;
    } finally {
      if (this.parseInFlight.get(fileVersionId) === parsing) {
        this.parseInFlight.delete(fileVersionId);
      }
    }
  }

  private async parseVersionOnce(
    fileEntryId: string,
    fileVersionId: string,
    context: NonNullable<ReturnType<FilesService["getVersionContext"]>>,
  ): Promise<ParsedDocumentResult> {
    const extension = extensionOf(context.entry.originalName);
    const buffer = await readFile(context.storagePath);
    const format = formatOf(extension);
    let markdown: string;
    let pages: CanonicalDocumentPage[];
    let blocks: CanonicalDocumentBlock[];
    let assets = [] as CanonicalDocumentArtifact["assets"];
    let assetExtractionStatus: "completed" | "failed" | "not-run" = "not-run";
    if (format === "pdf") {
      const nativePdf = await parsePdfNative(buffer);
      markdown = nativePdf.markdown;
      pages = nativePdf.pages;
      blocks = nativePdf.blocks;
      if (this.dataDir) {
        try {
          assets = await extractPdfAssets(buffer, this.dataDir);
          assetExtractionStatus = "completed";
        } catch {
          assetExtractionStatus = "failed";
        }
      }
    } else {
      const converter = converterOfExtension(extension);
      if (!converter) throw new Error("document_format_not_supported");
      markdown = await converter(buffer, context.entry.originalName);
      pages = logicalPages(format, markdown, extension);
      blocks = blocksOf(markdown, format, extension);
      if (this.dataDir && ["docx", "xlsx", "pptx"].includes(format)) {
        try {
          assets = await extractOoxmlAssets(buffer, format as "docx" | "xlsx" | "pptx", this.dataDir);
          assetExtractionStatus = "completed";
        } catch {
          assetExtractionStatus = "failed";
        }
      }
    }
    const tables = tablesOf(blocks, format);
    const warnings = [
      "page-rendering-not-run",
      format === "pdf" ? "advanced-layout-analysis-not-run" : "layout-coordinates-not-available",
      ...(assetExtractionStatus === "failed" ? ["embedded-assets-extraction-failed"] : []),
      ...(assetExtractionStatus === "not-run" ? ["embedded-assets-not-extracted"] : []),
      "visual-analysis-not-run",
      ...(format === "pdf" ? ["ocr-not-run"] : []),
    ];
    const artifact: CanonicalDocumentArtifact = {
      schemaVersion: DOCUMENT_ARTIFACT_SCHEMA_VERSION,
      document: {
        fileEntryId,
        fileVersionId,
        contentHash: context.version.contentHash,
        filename: context.entry.originalName,
        format,
        parserRevision: DOCUMENT_PARSER_REVISION,
        visualRevision: null,
        visualModel: null,
      },
      pages,
      blocks,
      tables,
      assets,
      warnings,
      quality: {
        status: "partial",
        nativeTextCoverage: pages.length > 0
          ? pages.filter((page) => page.textLayerStatus === "present").length / pages.length
          : blocks.length > 0 ? 1 : 0,
        ocrCoverage: 0,
        visualCoverage: 0,
        requiresReview: true,
      },
    };
    const now = new Date();
    const id = `pdoc-${randomUUID()}`;
    this.db.insert(parsedDocuments).values({
      id,
      fileVersionId,
      parserRevision: DOCUMENT_PARSER_REVISION,
      format,
      artifact: artifact as unknown as Record<string, unknown>,
      markdown,
      quality: artifact.quality as unknown as Record<string, unknown>,
      createdAt: now,
      updatedAt: now,
    }).onConflictDoNothing().run();
    const stored = this.get(fileVersionId);
    if (!stored) throw new Error("document_artifact_persist_failed");
    return { ...stored, deduplicated: stored.id !== id };
  }

  async analyzePdfVisuals(
    fileEntryId: string,
    fileVersionId: string,
    privacyPolicy: "local_only" | "external_vlm_allowed",
  ): Promise<ParsedDocumentResult> {
    if (privacyPolicy !== "external_vlm_allowed") throw new Error("document_external_vlm_not_allowed");
    if (!this.visual) throw new Error("vlm_not_configured");
    if (!this.dataDir) throw new Error("document_asset_store_not_configured");
    const parsed = await this.parseVersion(fileEntryId, fileVersionId);
    if (!parsed) throw new Error("document_format_not_supported");
    if (parsed.artifact.document.format !== "pdf") throw new Error("document_visual_ocr_pdf_only");
    const context = this.files.getVersionContext(fileEntryId, fileVersionId);
    if (!context) throw new Error("document_file_version_not_found");

    const buffer = await readFile(context.storagePath);
    const artifact = structuredClone(parsed.artifact);
    const visualRevision = "document-vlm-ocr@2";
    const sameVisualRevision = artifact.document.visualRevision === visualRevision
      && artifact.document.visualModel === this.visual.model;
    const candidates = artifact.pages.filter((page) =>
      !sameVisualRevision || page.ocrStatus !== "completed");
    if (sameVisualRevision && candidates.length === 0) {
      return { ...parsed, deduplicated: true };
    }
    const analyzedPages = new Set<number>(sameVisualRevision
      ? artifact.pages.filter((page) => page.ocrStatus === "completed").map((page) => page.pageNo)
      : []);
    const failedPages = new Set<number>();
    let readingOrder = artifact.blocks.reduce((maximum, block) => Math.max(maximum, block.readingOrder), 0);

    for (const page of candidates) {
      try {
        const image = await renderPdfPage(buffer, page.pageNo);
        const asset = await storePageAsset(this.dataDir, image, page.pageNo);
        artifact.assets = artifact.assets.filter((item) => item.pageNo !== page.pageNo || item.kind !== "page-image");
        artifact.assets.push(asset);
        page.imageAssetId = asset.id;
        page.renderStatus = "completed";
        const ocr = await this.visual.ocrDocumentPage({ buffer: image, mime: "image/png" });
        artifact.blocks = artifact.blocks.filter((block) =>
          block.pageNo !== page.pageNo || block.source.method !== "vlm");
        const ocrBlocks = ocr.blocks.length > 0 || !ocr.text
          ? ocr.blocks
          : [{
              type: "paragraph" as const,
              text: ocr.text,
              bbox: [0, 0, 1, 1] as [number, number, number, number],
              confidence: 0.5,
            }];
        for (const block of ocrBlocks) {
          readingOrder += 1;
          artifact.blocks.push({
            id: `block-${readingOrder}`,
            type: block.type,
            pageNo: page.pageNo,
            bbox: page.width !== null && page.height !== null
              ? [
                  block.bbox[0] * page.width,
                  block.bbox[1] * page.height,
                  block.bbox[2] * page.width,
                  block.bbox[3] * page.height,
                ]
              : null,
            readingOrder,
            content: block.text,
            confidence: block.confidence,
            source: {
              method: "vlm",
              assetId: asset.id,
              nativeRef: `vlm-ocr:${this.visual.model}:page:${page.pageNo}`,
            },
          });
        }
        page.ocrStatus = "completed";
        analyzedPages.add(page.pageNo);
      } catch {
        page.renderStatus = page.imageAssetId ? "completed" : "failed";
        page.ocrStatus = "failed";
        failedPages.add(page.pageNo);
      }
    }

    artifact.blocks.sort((left, right) =>
      (left.pageNo ?? Number.MAX_SAFE_INTEGER) - (right.pageNo ?? Number.MAX_SAFE_INTEGER)
      || left.readingOrder - right.readingOrder);
    artifact.blocks.forEach((block, index) => {
      block.readingOrder = index + 1;
      block.id = `block-${index + 1}`;
    });
    artifact.document.visualRevision = visualRevision;
    artifact.document.visualModel = this.visual.model;
    artifact.warnings = artifact.warnings.filter((warning) => ![
        "page-rendering-not-run",
        "visual-analysis-not-run",
        "ocr-not-run",
        "layout-coordinates-not-available",
        "advanced-layout-analysis-not-run",
        "visual-ocr-not-needed",
        "page-rendering-partial",
      "visual-ocr-partial-failure",
      ].includes(warning)
      && !warning.startsWith("visual-ocr-failed-pages:"));
    if (analyzedPages.size < artifact.pages.length) artifact.warnings.push("page-rendering-partial");
    if (failedPages.size > 0) {
      artifact.warnings.push("visual-ocr-partial-failure");
      artifact.warnings.push(`visual-ocr-failed-pages:${[...failedPages].sort((a, b) => a - b).join(",")}`);
    }
    artifact.warnings.push("advanced-layout-analysis-not-run");
    artifact.quality = {
      status: "partial",
      nativeTextCoverage: artifact.pages.length > 0
        ? artifact.pages.filter((page) => page.textLayerStatus === "present").length / artifact.pages.length
        : 0,
      ocrCoverage: artifact.pages.length > 0 ? analyzedPages.size / artifact.pages.length : 0,
      visualCoverage: artifact.pages.length > 0 ? analyzedPages.size / artifact.pages.length : 0,
      requiresReview: artifact.warnings.length > 0 || failedPages.size > 0,
    };
    const markdown = artifact.pages.map((page) => {
      const pageBlocks = artifact.blocks.filter((block) => block.pageNo === page.pageNo);
      const nativeBlocks = pageBlocks.filter((block) => block.source.method !== "vlm");
      const projectionBlocks = nativeBlocks.length > 0
        ? nativeBlocks
        : pageBlocks.filter((block) => block.source.method === "vlm");
      const content = projectionBlocks
        .map((block) => block.content)
        .join("\n\n");
      return `## 第 ${page.pageNo} 页${content ? `\n\n${content}` : ""}`;
    }).join("\n\n");
    const now = new Date();
    this.db.update(parsedDocuments).set({
      artifact: artifact as unknown as Record<string, unknown>,
      markdown,
      quality: artifact.quality as unknown as Record<string, unknown>,
      updatedAt: now,
    }).where(eq(parsedDocuments.id, parsed.id)).run();
    const stored = this.get(fileVersionId);
    if (!stored) throw new Error("document_artifact_persist_failed");
    return { ...stored, deduplicated: false };
  }
}
