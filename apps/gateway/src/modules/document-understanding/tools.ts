import { Type } from "@sinclair/typebox";
import type { PiAgentRuntimeTool } from "@nxcore/agent-runtime-pi";
import type { DocumentUnderstandingService } from "./service.js";

function toolResult(value: unknown, details: Record<string, unknown> = {}) {
  return { content: JSON.stringify(value), details };
}

export function createDocumentUnderstandingTools(
  service: DocumentUnderstandingService,
): PiAgentRuntimeTool[] {
  const parseNative: PiAgentRuntimeTool = {
    name: "document_parse_native",
    label: "Parse document natively",
    description: "对已授权的文件版本运行确定性 Office/PDF 原生解析并持久化 Canonical Artifact。",
    parameters: Type.Object({
      fileEntryId: Type.String({ minLength: 1, maxLength: 200 }),
      fileVersionId: Type.String({ minLength: 1, maxLength: 200 }),
    }, { additionalProperties: false }),
    execute: async (_toolCallId, params) => {
      const result = await service.parseVersion(String(params.fileEntryId), String(params.fileVersionId));
      if (!result) throw new Error("document_format_not_supported");
      return toolResult({
        artifactId: result.id,
        fileVersionId: result.artifact.document.fileVersionId,
        format: result.artifact.document.format,
        pageCount: result.artifact.pages.length,
        blockCount: result.artifact.blocks.length,
        tableCount: result.artifact.tables.length,
        warnings: result.artifact.warnings,
        quality: result.artifact.quality,
        deduplicated: result.deduplicated,
      }, { artifactId: result.id });
    },
  };

  const readArtifact: PiAgentRuntimeTool = {
    name: "document_read_artifact",
    label: "Read document artifact",
    description: "分页读取已解析文档的 block、table、质量和证据信息，不暴露本地文件路径。",
    parameters: Type.Object({
      fileVersionId: Type.String({ minLength: 1, maxLength: 200 }),
      blockOffset: Type.Optional(Type.Integer({ minimum: 0 })),
      blockLimit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    }, { additionalProperties: false }),
    execute: async (_toolCallId, params) => {
      const result = service.get(String(params.fileVersionId));
      if (!result) throw new Error("document_artifact_not_found");
      const offset = Number(params.blockOffset ?? 0);
      const limit = Number(params.blockLimit ?? 50);
      return toolResult({
        artifactId: result.id,
        document: result.artifact.document,
        pages: result.artifact.pages,
        blocks: result.artifact.blocks.slice(offset, offset + limit),
        blockPage: { offset, limit, total: result.artifact.blocks.length },
        tables: result.artifact.tables,
        assets: result.artifact.assets,
        warnings: result.artifact.warnings,
        quality: result.artifact.quality,
      }, { artifactId: result.id, blockOffset: offset, blockLimit: limit });
    },
  };

  const readContent: PiAgentRuntimeTool = {
    name: "document_read_content",
    label: "Read document content",
    description: "读取已解析文档的 Markdown 正文，用于回答调用方问题；返回内容会按字符上限截断，不暴露本地文件路径。",
    parameters: Type.Object({
      fileVersionId: Type.String({ minLength: 1, maxLength: 200 }),
      offset: Type.Optional(Type.Integer({ minimum: 0 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100_000 })),
    }, { additionalProperties: false }),
    execute: async (_toolCallId, params) => {
      const result = service.get(String(params.fileVersionId));
      if (!result) throw new Error("document_artifact_not_found");
      const offset = Number(params.offset ?? 0);
      const limit = Number(params.limit ?? 100_000);
      const content = result.markdown.slice(offset, offset + limit);
      return toolResult({
        artifactId: result.id,
        fileVersionId: result.artifact.document.fileVersionId,
        filename: result.artifact.document.filename,
        content,
        contentPage: {
          offset,
          limit,
          total: result.markdown.length,
          truncated: offset + content.length < result.markdown.length,
        },
      }, { artifactId: result.id, offset, limit, total: result.markdown.length });
    },
  };

  const analyzeVisuals: PiAgentRuntimeTool = {
    name: "document_analyze_visuals",
    label: "Analyze document pages visually",
    description: "在调用方明确允许外部 VLM 时渲染 PDF 全部页面，并使用已配置 VLM 逐页执行 OCR 与基础版面识别。",
    parameters: Type.Object({
      fileEntryId: Type.String({ minLength: 1, maxLength: 200 }),
      fileVersionId: Type.String({ minLength: 1, maxLength: 200 }),
      privacyPolicy: Type.Union([
        Type.Literal("local_only"),
        Type.Literal("external_vlm_allowed"),
      ]),
    }, { additionalProperties: false }),
    execute: async (_toolCallId, params) => {
      const result = await service.analyzePdfVisuals(
        String(params.fileEntryId),
        String(params.fileVersionId),
        params.privacyPolicy as "local_only" | "external_vlm_allowed",
      );
      return toolResult({
        artifactId: result.id,
        fileVersionId: result.artifact.document.fileVersionId,
        visualRevision: result.artifact.document.visualRevision,
        visualModel: result.artifact.document.visualModel,
        renderedPages: result.artifact.pages
          .filter((page) => page.renderStatus === "completed")
          .map((page) => page.pageNo),
        ocrPages: result.artifact.pages
          .filter((page) => page.ocrStatus === "completed")
          .map((page) => page.pageNo),
        warnings: result.artifact.warnings,
        quality: result.artifact.quality,
      }, { artifactId: result.id });
    },
  };

  const validateArtifact: PiAgentRuntimeTool = {
    name: "document_validate_artifact",
    label: "Validate document artifact",
    description: "检查 Canonical Artifact 的页码、reading order、证据绑定和质量告警。",
    parameters: Type.Object({
      fileVersionId: Type.String({ minLength: 1, maxLength: 200 }),
    }, { additionalProperties: false }),
    execute: async (_toolCallId, params) => {
      const result = service.get(String(params.fileVersionId));
      if (!result) throw new Error("document_artifact_not_found");
      const issues: string[] = [];
      const pageNumbers = result.artifact.pages.map((page) => page.pageNo);
      if (new Set(pageNumbers).size !== pageNumbers.length) issues.push("duplicate-page-number");
      const orders = result.artifact.blocks.map((block) => block.readingOrder);
      if (orders.some((order, index) => index > 0 && order <= orders[index - 1]!)) {
        issues.push("invalid-reading-order");
      }
      if (result.artifact.blocks.some((block) => !block.source.method)) issues.push("block-without-evidence");
      if (result.artifact.blocks.length === 0) issues.push("no-content-blocks");
      return toolResult({
        valid: issues.length === 0,
        issues,
        warnings: result.artifact.warnings,
        quality: result.artifact.quality,
      }, { artifactId: result.id, issueCount: issues.length });
    },
  };

  return [parseNative, analyzeVisuals, readContent, readArtifact, validateArtifact];
}
