import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";
import { createDatabase, type DatabaseClient } from "../src/infrastructure/database/client.js";
import { parsedDocuments } from "../src/infrastructure/database/schema.js";
import { DocumentUnderstandingService } from "../src/modules/document-understanding/service.js";
import {
  createDocumentAnalysisResultValidator,
  createDocumentUnderstandingTools,
} from "../src/modules/document-understanding/tools.js";
import { DOCUMENT_PARSER_REVISION } from "../src/modules/document-understanding/types.js";
import { extractOoxmlAssets } from "../src/modules/document-understanding/assets.js";
import { FilesService } from "../src/modules/files/service.js";
import type { DocumentOcrClient } from "../src/modules/perception/vlm-client.js";

const directories: string[] = [];
const databases: DatabaseClient[] = [];

afterEach(async () => {
  databases.splice(0).forEach((database) => database.sqlite.close());
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

async function setup(visual: DocumentOcrClient | null = null) {
  const dataDir = await mkdtemp(join(tmpdir(), "everroom-document-understanding-"));
  directories.push(dataDir);
  const database = createDatabase(join(dataDir, "gateway.sqlite"), resolve("drizzle"));
  databases.push(database);
  const files = new FilesService(database.db, dataDir);
  files.initializeCatalog();
  return {
    database,
    files,
    dataDir,
    service: new DocumentUnderstandingService(database.db, files, visual, dataDir),
  };
}

function minimalPdf(text: string): Buffer {
  const escaped = text.replace(/([\\()])/g, "\\$1");
  const stream = `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, "ascii");
}

describe("DocumentUnderstandingService", () => {
  it("persists a page-aware PDF artifact and reuses it by parser revision", async () => {
    const test = await setup();
    const imported = await test.files.importFile({
      sourceKind: "manual-upload",
      sourceKey: "manual:pdf-1",
      originalName: "report.pdf",
      buffer: minimalPdf("Quarterly report body"),
      mime: "application/pdf",
    });

    const first = await test.service.parseVersion(imported.fileEntryId, imported.fileVersionId);
    const second = await test.service.parseVersion(imported.fileEntryId, imported.fileVersionId);

    expect(first).toMatchObject({ deduplicated: false });
    expect(first?.artifact).toMatchObject({
      schemaVersion: 2,
      document: { format: "pdf", parserRevision: DOCUMENT_PARSER_REVISION },
      pages: [{ pageNo: 1, textLayerStatus: "present", ocrStatus: "not-needed" }],
      quality: { status: "partial", nativeTextCoverage: 1, requiresReview: true },
    });
    expect(first?.artifact.blocks[0]).toMatchObject({
      pageNo: 1,
      content: expect.stringContaining("Quarterly report body"),
      source: { method: "text-layer" },
    });
    expect(first?.artifact.blocks[0]?.bbox).not.toBeNull();
    expect(first?.artifact.pages[0]).toMatchObject({
      width: 612,
      height: 792,
      renderStatus: "not-run",
    });
    expect(first?.artifact.warnings).toContain("ocr-not-run");
    expect(second).toMatchObject({ id: first?.id, deduplicated: true });
    expect(test.database.db.select().from(parsedDocuments).all()).toHaveLength(1);
    expect(test.service.markdownForFile(imported.fileEntryId)).toContain("Quarterly report body");
    expect(test.service.markdownForFile("file-missing")).toBeNull();

    const validateResult = createDocumentAnalysisResultValidator(test.service);
    const formalResult = {
      status: "partial",
      summary: "This is a quarterly report.",
      facts: [{ key: "topic", value: "Quarterly report body", evidenceRefs: [first!.artifact.blocks[0]!.id] }],
      missingFields: [],
      artifactId: first!.id,
      fileVersionId: imported.fileVersionId,
      format: "pdf",
      pageCount: first!.artifact.pages.length,
      blockCount: first!.artifact.blocks.length,
      tableCount: first!.artifact.tables.length,
      valid: true,
      issues: [],
      warnings: first!.artifact.warnings,
      requiresReview: true,
    };
    expect(() => validateResult({ fileVersionId: imported.fileVersionId }, formalResult)).not.toThrow();
    expect(() => validateResult({ fileVersionId: imported.fileVersionId }, {
      ...formalResult,
      facts: [{ key: "topic", value: "Quarterly report body", evidenceRefs: ["block-missing"] }],
    })).toThrow("subagent_result_evidence_not_found:block-missing");
    expect(() => validateResult({ fileVersionId: "another-version" }, formalResult))
      .toThrow("subagent_result_file_version_mismatch");

    const tools = createDocumentUnderstandingTools(test.service);
    const run = {
      runId: "document-tool-run",
      sessionId: "document-tool-session",
      runtimeSessionRef: null,
      prompt: "validate",
      originalPrompt: "validate",
      pageLabel: "Document parser",
      roomId: null,
      captureMemory: false,
      recallMemory: false,
      toolsEnabled: true,
    };
    const validation = await tools.find((tool) => tool.name === "document_validate_artifact")!
      .execute(run, { fileVersionId: imported.fileVersionId });
    expect(JSON.parse(validation.content)).toMatchObject({ valid: true, issues: [] });
    const content = await tools.find((tool) => tool.name === "document_read_content")!
      .execute(run, { fileVersionId: imported.fileVersionId, limit: 100_000 });
    expect(JSON.parse(content.content)).toMatchObject({
      fileVersionId: imported.fileVersionId,
      content: expect.stringContaining("Quarterly report body"),
      contentPage: { truncated: false },
    });
    await test.files.dispose();
  });

  it("coalesces concurrent parse requests for the same immutable file version", async () => {
    const test = await setup();
    const imported = await test.files.importFile({
      sourceKind: "manual-upload",
      sourceKey: "manual:concurrent-pdf",
      originalName: "concurrent.pdf",
      buffer: minimalPdf("One parse for two callers"),
      mime: "application/pdf",
    });

    const [first, second] = await Promise.all([
      test.service.parseVersion(imported.fileEntryId, imported.fileVersionId),
      test.service.parseVersion(imported.fileEntryId, imported.fileVersionId),
    ]);

    expect(first?.id).toBe(second?.id);
    expect(first?.deduplicated).toBe(false);
    expect(second?.deduplicated).toBe(false);
    expect(test.database.db.select().from(parsedDocuments).all()).toHaveLength(1);
    await test.files.dispose();
  });

  it("projects an XLSX sheet into structured table cells without losing escaped pipes", async () => {
    const test = await setup();
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Metrics");
    sheet.addRow(["Name", "Value"]);
    sheet.addRow(["A|B", 42]);
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer() as ArrayBuffer);
    const imported = await test.files.importFile({
      sourceKind: "manual-upload",
      sourceKey: "manual:xlsx-1",
      originalName: "metrics.xlsx",
      buffer,
      mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });

    const result = await test.service.parseVersion(imported.fileEntryId, imported.fileVersionId);

    expect(result?.artifact.document.format).toBe("xlsx");
    expect(result?.artifact.tables).toHaveLength(1);
    expect(result?.artifact.tables[0]?.sheetName).toBe("Metrics");
    expect(result?.artifact.tables[0]?.cells).toEqual(expect.arrayContaining([
      expect.objectContaining({ row: 0, column: 0, content: "Name" }),
      expect.objectContaining({ row: 1, column: 0, content: "A|B" }),
      expect.objectContaining({ row: 1, column: 1, content: "42" }),
    ]));
    expect(result?.artifact.pages).toEqual([]);
    await test.files.dispose();
  });

  it("extracts OOXML embedded images and charts as content-addressed assets", async () => {
    const test = await setup();
    const zip = new JSZip();
    zip.file("ppt/media/image1.png", Buffer.from("fake-png"));
    zip.file("ppt/charts/chart1.xml", "<chart><title>Revenue</title></chart>");
    zip.file("ppt/slides/slide2.xml", "<slide />");
    zip.file("ppt/slides/_rels/slide2.xml.rels", [
      "<Relationships>",
      '<Relationship Id="rId1" Target="../media/image1.png"/>',
      '<Relationship Id="rId2" Target="../charts/chart1.xml"/>',
      "</Relationships>",
    ].join(""));

    const assets = await extractOoxmlAssets(
      Buffer.from(await zip.generateAsync({ type: "uint8array" })),
      "pptx",
      test.dataDir,
    );

    expect(assets).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "embedded-image",
        pageNo: 2,
        mime: "image/png",
        sourceRef: "ppt/media/image1.png",
        storageRef: expect.stringMatching(/^document-artifacts\/sha256\//),
      }),
      expect.objectContaining({
        kind: "chart",
        pageNo: 2,
        mime: "application/xml",
        sourceRef: "ppt/charts/chart1.xml",
      }),
    ]));
    await test.files.dispose();
  });

  it("runs VLM OCR for every PDF page only with explicit external-VLM permission", async () => {
    let calls = 0;
    const visual: DocumentOcrClient = {
      model: "fake-document-vlm",
      ocrDocumentPage: async () => {
        calls += 1;
        return {
          text: "Scanned invoice 42",
          blocks: [{
            type: "paragraph",
            text: "Scanned invoice 42",
            bbox: [0.1, 0.2, 0.8, 0.3],
            confidence: 0.93,
          }],
        };
      },
    };
    const test = await setup(visual);
    const imported = await test.files.importFile({
      sourceKind: "manual-upload",
      sourceKey: "manual:scanned-pdf-1",
      originalName: "scan.pdf",
      buffer: minimalPdf(""),
      mime: "application/pdf",
    });
    const native = await test.service.parseVersion(imported.fileEntryId, imported.fileVersionId);
    expect(native?.artifact.pages[0]).toMatchObject({
      textLayerStatus: "absent",
      ocrStatus: "not-run",
    });

    await expect(test.service.analyzePdfVisuals(
      imported.fileEntryId,
      imported.fileVersionId,
      "local_only",
    )).rejects.toThrow("document_external_vlm_not_allowed");
    expect(calls).toBe(0);

    const analyzed = await test.service.analyzePdfVisuals(
      imported.fileEntryId,
      imported.fileVersionId,
      "external_vlm_allowed",
    );
    expect(calls).toBe(1);
    expect(analyzed.artifact.document).toMatchObject({
      visualRevision: "document-vlm-ocr@2",
      visualModel: "fake-document-vlm",
    });
    expect(analyzed.artifact.pages[0]).toMatchObject({
      renderStatus: "completed",
      ocrStatus: "completed",
      imageAssetId: expect.any(String),
    });
    expect(analyzed.artifact.blocks[0]).toMatchObject({
      content: "Scanned invoice 42",
      bbox: [61.2, 158.4, 489.6, 237.6],
      confidence: 0.93,
      source: { method: "vlm", assetId: expect.any(String) },
    });
    expect(analyzed.artifact.quality).toMatchObject({
      nativeTextCoverage: 0,
      ocrCoverage: 1,
      visualCoverage: 1,
    });
    expect(analyzed.markdown).toContain("Scanned invoice 42");
    const repeated = await test.service.analyzePdfVisuals(
      imported.fileEntryId,
      imported.fileVersionId,
      "external_vlm_allowed",
    );
    expect(repeated.deduplicated).toBe(true);
    expect(calls).toBe(1);
    await test.files.dispose();
  });

  it("does not skip a PDF page that already has a native text layer", async () => {
    let calls = 0;
    const visual: DocumentOcrClient = {
      model: "fake-document-vlm",
      ocrDocumentPage: async () => {
        calls += 1;
        return {
          text: "Visual copy",
          blocks: [{ type: "paragraph", text: "Visual copy", bbox: [0.1, 0.2, 0.8, 0.3], confidence: 0.8 }],
        };
      },
    };
    const test = await setup(visual);
    const imported = await test.files.importFile({
      sourceKind: "manual-upload",
      sourceKey: "manual:text-pdf-ocr-1",
      originalName: "text.pdf",
      buffer: minimalPdf("Native copy"),
      mime: "application/pdf",
    });
    const analyzed = await test.service.analyzePdfVisuals(
      imported.fileEntryId,
      imported.fileVersionId,
      "external_vlm_allowed",
    );
    expect(calls).toBe(1);
    expect(analyzed.artifact.pages[0]?.ocrStatus).toBe("completed");
    expect(analyzed.artifact.blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({ content: expect.stringContaining("Native copy") }),
      expect.objectContaining({ content: "Visual copy" }),
    ]));
    expect(analyzed.artifact.blocks.some((block) => block.source.method === "text-layer")).toBe(true);
    expect(analyzed.artifact.blocks.some((block) => block.source.method === "vlm")).toBe(true);
    expect(analyzed.markdown).toContain("Native copy");
    expect(analyzed.markdown).not.toContain("Visual copy");
    await test.files.dispose();
  });
});
