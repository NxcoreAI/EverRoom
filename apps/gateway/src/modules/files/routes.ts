import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import multipart from "@fastify/multipart";
import { Type } from "@sinclair/typebox";
import { isSupportedUploadFilename, type FileDeletionHooks, type FilesService, type UploadedFileRow } from "./service.js";
import { MAX_FORMAT_FILE_BYTES } from "./format-registry.js";
import type { FileClusteringService } from "./clustering-service.js";

/** 上传原件体积上限（与 knowledge file-convert 同源，唯一字节入口统一把关）。 */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

export type FileStoreErrorCode = "empty_file" | "too_large" | "unsupported_file_type";

export class FileStoreError extends Error {
  constructor(
    message: string,
    readonly code: FileStoreErrorCode,
  ) {
    super(message);
    this.name = "FileStoreError";
  }
}

const FileIdParams = Type.Object({ id: Type.String({ minLength: 1, maxLength: 100 }) });

const CatalogFileDto = Type.Object({
  id: Type.String(),
  originalName: Type.String(),
  displayName: Type.Union([Type.String(), Type.Null()]),
  sharedTitle: Type.String(),
  sourceKind: Type.Union([
    Type.Literal("manual-upload"), Type.Literal("local-folder"),
    Type.Literal("connector"), Type.Literal("migration"), Type.Literal("web-clipper"), Type.Literal("legacy-upload"),
  ]),
  sourceLabel: Type.String(),
  relativePath: Type.Union([Type.String(), Type.Null()]),
  provider: Type.Union([Type.String(), Type.Null()]),
  bytes: Type.Integer(),
  dataType: Type.Union([Type.String(), Type.Null()]),
  agentCategory: Type.Union([Type.String(), Type.Null()]),
  summary: Type.Union([Type.String(), Type.Null()]),
  tags: Type.Array(Type.String()),
  processingState: Type.Union([
    Type.Literal("processing"), Type.Literal("ready"), Type.Literal("failed"), Type.Literal("missing"),
  ]),
  clusterId: Type.Union([Type.String(), Type.Null()]),
  contentHash: Type.String(),
  parsed: Type.Boolean(),
  updatedAt: Type.String(),
});

const FileDto = Type.Object({
  id: Type.String(),
  originalName: Type.String(),
  bytes: Type.Integer(),
  mime: Type.String(),
  assetKind: Type.Union([
    Type.Literal("document"), Type.Literal("screenshot"), Type.Literal("photo"),
    Type.Literal("audio"), Type.Literal("other"),
  ]),
  originChannel: Type.String(),
  visibility: Type.Union([Type.Literal("private"), Type.Literal("shared")]),
  capturedAt: Type.Union([Type.String(), Type.Null()]),
  contentHash: Type.String(),
  /** 是否已有归一化解析产物（未进过链路的裸上传为 false）。 */
  parsed: Type.Boolean(),
  createdAt: Type.String(),
  updatedAt: Type.String(),
});

const FileDetailDto = Type.Intersect([
  FileDto,
  Type.Object({
    /** 本体绝对路径（主进程 reveal 用）。 */
    storagePath: Type.String(),
    currentParsedId: Type.Union([Type.String(), Type.Null()]),
  }),
]);

function iso(value: Date): string {
  return value.toISOString();
}

function toDto(row: UploadedFileRow) {
  return {
    id: row.id,
    originalName: row.originalName,
    bytes: row.bytes,
    mime: row.mime,
    assetKind: row.assetKind,
    originChannel: row.originChannel,
    visibility: row.visibility,
    capturedAt: row.capturedAt?.toISOString() ?? null,
    contentHash: row.contentHash,
    parsed: Boolean(row.currentParsedId),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

function errorOf(code: string): { error: string } {
  return { error: code };
}

/**
 * 文件管理中心 REST（unified-ingest-plan §8.2）：
 * POST /v1/files 是全系统接收文件字节的唯一通道（multipart 或 JSON base64），
 * 幂等（闸1 同名同内容 deduped）；列表/详情/预览/本体路径/改名/删除级联。
 */
export function filesRoutes(
  service: FilesService,
  deletionHooks?: FileDeletionHooks,
  clustering?: FileClusteringService,
): FastifyPluginAsyncTypebox {
  return async (app) => {
    await app.register(multipart, {
      // busboy 触达 fileSize 上限时是"静默截断"而非报错：上限必须高于任何
      // 格式的 maxBytes，让 storeFileBlobStream / 字节检查拿到完整流后超限报
      // 413。否则超限文件会以恰好截断的损坏前缀入库（zip 尾部丢失 → 内嵌
      // 编辑器打开"损坏的 zip"→ 空白文档）。
      limits: { fileSize: MAX_FORMAT_FILE_BYTES + 1024 * 1024, files: 1 },
    });

    app.get(
      "/v1/files/capabilities",
      {
        schema: {
          tags: ["files"],
          response: { 200: Type.Object({ items: Type.Array(Type.Object({
            extension: Type.String(),
            dataType: Type.String(),
            parserId: Type.String(),
            parserVersion: Type.Integer(),
            manualImport: Type.Boolean(),
            autoScan: Type.Boolean(),
            connectorImport: Type.Boolean(),
            maxBytes: Type.Integer(),
          })) }) },
        },
      },
      async () => ({ items: [...service.capabilities()] }),
    );

    app.patch(
      "/v1/file-clusters/:id",
      {
        schema: {
          tags: ["files"],
          params: FileIdParams,
          body: Type.Object({ sharedTitle: Type.String({ minLength: 1, maxLength: 200 }) }),
          response: {
            200: Type.Object({ id: Type.String(), canonicalTitle: Type.String(), titlePinned: Type.Boolean() }),
            404: Type.Object({ error: Type.String() }),
          },
        },
      },
      async (request, reply) => {
        const cluster = clustering?.pinTitle(request.params.id, request.body.sharedTitle) ?? null;
        if (!cluster) return reply.code(404).send(errorOf("cluster_not_found"));
        return { id: cluster.id, canonicalTitle: cluster.canonicalTitle, titlePinned: cluster.titlePinned };
      },
    );

    app.patch(
      "/v1/file-entries/:id",
      {
        schema: {
          tags: ["files"],
          params: FileIdParams,
          body: Type.Object({ displayName: Type.String({ minLength: 1, maxLength: 300 }) }),
          response: { 200: CatalogFileDto, 404: Type.Object({ error: Type.String() }) },
        },
      },
      async (request, reply) => {
        const entry = service.renameCatalogEntry(request.params.id, request.body.displayName);
        return entry ?? reply.code(404).send(errorOf("file_not_found"));
      },
    );

    app.get(
      "/v1/files/catalog",
      {
        schema: {
          tags: ["files"],
          querystring: Type.Object({
            limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, default: 100 })),
            offset: Type.Optional(Type.Integer({ minimum: 0, default: 0 })),
          }),
          response: { 200: Type.Object({ items: Type.Array(CatalogFileDto), total: Type.Integer() }) },
        },
      },
      async (request) => service.listCatalog(request.query.limit, request.query.offset),
    );

    app.post(
      "/v1/local-file-references",
      {
        schema: {
          tags: ["files"],
          body: Type.Object({
            sourceKey: Type.String({ minLength: 1 }),
            originalName: Type.String({ minLength: 1 }),
            sourcePath: Type.String({ minLength: 1 }),
            contentHash: Type.String({ pattern: "^[a-f0-9]{64}$" }),
            byteSize: Type.Integer({ minimum: 1 }),
            localSourceId: Type.String({ minLength: 1 }),
            localItemId: Type.String({ minLength: 1 }),
            relativePath: Type.String({ minLength: 1 }),
            sourceModifiedAt: Type.String(),
          }),
          response: {
            202: Type.Object({
              fileEntryId: Type.String(), fileVersionId: Type.String(), jobId: Type.String(),
              contentHash: Type.String(), blobDeduped: Type.Boolean(), versionDeduped: Type.Boolean(),
            }),
            400: Type.Object({ error: Type.String() }),
          },
        },
      },
      async (request, reply) => {
        try {
          const result = await service.importLocalFileReference({
            sourceKind: "local-folder",
            sourceKey: request.body.sourceKey,
            originalName: request.body.originalName,
            sourcePath: request.body.sourcePath,
            contentHash: request.body.contentHash,
            byteSize: request.body.byteSize,
            localSourceId: request.body.localSourceId,
            localItemId: request.body.localItemId,
            relativePath: request.body.relativePath,
            sourceModifiedAt: new Date(request.body.sourceModifiedAt),
          });
          return reply.code(202).send(result);
        } catch (error) {
          return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
        }
      },
    );

    app.patch(
      "/v1/local-file-references/status",
      {
        schema: {
          tags: ["files"],
          body: Type.Object({
            localSourceId: Type.String({ minLength: 1 }),
            localItemId: Type.String({ minLength: 1 }),
            status: Type.Literal("missing"),
          }),
          response: { 200: Type.Object({ updated: Type.Boolean() }) },
        },
      },
      async (request) => ({
        updated: await service.markLocalFileMissing(request.body.localSourceId, request.body.localItemId),
      }),
    );

    app.post(
      "/v1/file-imports",
      {
        bodyLimit: MAX_FORMAT_FILE_BYTES + 32 * 1024 * 1024,
        schema: {
          tags: ["files"],
          response: {
            202: Type.Object({
              fileEntryId: Type.String(), fileVersionId: Type.String(), jobId: Type.String(),
              contentHash: Type.String(), blobDeduped: Type.Boolean(), versionDeduped: Type.Boolean(),
            }),
            400: Type.Object({ error: Type.String() }),
            413: Type.Object({ error: Type.String() }),
          },
        },
      },
      async (request, reply) => {
        const file = await request.file();
        if (!file) return reply.code(400).send(errorOf("file_part_required"));
        const metadataField = file.fields.metadata;
        const metadataText = metadataField && !Array.isArray(metadataField) && metadataField.type === "field"
          ? String(metadataField.value)
          : "";
        let metadata: {
          sourceKind?: unknown; sourceKey?: unknown; originalName?: unknown;
          provider?: unknown; connectionId?: unknown; localSourceId?: unknown; localItemId?: unknown;
          relativePath?: unknown; sourceUri?: unknown; sourceModifiedAt?: unknown;
          pipelines?: unknown; roomId?: unknown; clipCaptureId?: unknown;
        };
        try {
          metadata = JSON.parse(metadataText) as typeof metadata;
        } catch {
          return reply.code(400).send(errorOf("metadata_invalid"));
        }
        if (metadata.sourceKind !== "manual-upload" && metadata.sourceKind !== "connector" && metadata.sourceKind !== "migration" && metadata.sourceKind !== "web-clipper") {
          return reply.code(400).send(errorOf("source_kind_invalid"));
        }
        if (typeof metadata.sourceKey !== "string" || !metadata.sourceKey.trim()) {
          return reply.code(400).send(errorOf("source_key_required"));
        }
        const text = (value: unknown) => typeof value === "string" && value.trim() ? value : undefined;
        const sourceModifiedAt = text(metadata.sourceModifiedAt);
        const parsedModifiedAt = sourceModifiedAt ? new Date(sourceModifiedAt) : undefined;
        const pipelines = metadata.pipelines && typeof metadata.pipelines === "object"
          ? metadata.pipelines as { room: boolean; wiki: boolean; memory: boolean }
          : undefined;
        try {
          const result = await service.importFileStream({
            sourceKind: metadata.sourceKind,
            sourceKey: metadata.sourceKey,
            originalName: text(metadata.originalName) ?? file.filename,
            stream: file.file,
            mime: file.mimetype,
            ...(text(metadata.provider) ? { provider: text(metadata.provider) } : {}),
            ...(text(metadata.connectionId) ? { connectionId: text(metadata.connectionId) } : {}),
            ...(text(metadata.localSourceId) ? { localSourceId: text(metadata.localSourceId) } : {}),
            ...(text(metadata.localItemId) ? { localItemId: text(metadata.localItemId) } : {}),
            ...(text(metadata.relativePath) ? { relativePath: text(metadata.relativePath) } : {}),
            ...(text(metadata.sourceUri) ? { sourceUri: text(metadata.sourceUri) } : {}),
            ...(parsedModifiedAt && !Number.isNaN(parsedModifiedAt.getTime()) ? { sourceModifiedAt: parsedModifiedAt } : {}),
            ...(pipelines ? { pipelines } : {}),
            ...(text(metadata.roomId) ? { roomId: text(metadata.roomId) } : {}),
          });
          return reply.code(202).send(result);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return reply.code(message.includes("MB 上限") ? 413 : 400).send({ error: message });
        }
      },
    );

    app.post(
      "/v1/files",
      {
        bodyLimit: 32 * 1024 * 1024,
        schema: {
          tags: ["files"],
          response: {
            201: Type.Object({
              id: Type.String(),
              contentHash: Type.String(),
              deduped: Type.Boolean(),
              bytes: Type.Integer(),
              originalName: Type.String(),
            }),
            400: Type.Object({ error: Type.String() }),
            413: Type.Object({ error: Type.String() }),
          },
        },
      },
      async (request, reply) => {
        const contentType = request.headers["content-type"] ?? "";
        let filename: string;
        let buffer: Buffer;
        let mime: string | undefined;
        let assetKind: "document" | "screenshot" | "photo" | "audio" | "other" | undefined;
        let originChannel: string | undefined;
        let visibility: "private" | "shared" | undefined;
        let capturedAt: Date | undefined;
        if (contentType.startsWith("multipart/form-data")) {
          const file = await request.file();
          if (!file) return reply.code(400).send(errorOf("file_part_required"));
          filename = file.filename;
          mime = file.mimetype;
          try {
            buffer = await file.toBuffer();
          } catch {
            return reply.code(413).send(errorOf("too_large"));
          }
          if (file.file.truncated) return reply.code(413).send(errorOf("too_large"));
        } else {
          const body = request.body as
            | {
                filename?: unknown;
                contentBase64?: unknown;
                mime?: unknown;
                assetKind?: unknown;
                originChannel?: unknown;
                visibility?: unknown;
                capturedAt?: unknown;
              }
            | undefined;
          if (typeof body?.filename !== "string" || !body.filename.trim()) {
            return reply.code(400).send(errorOf("filename_required"));
          }
          if (typeof body.contentBase64 !== "string" || !body.contentBase64) {
            return reply.code(400).send(errorOf("content_base64_required"));
          }
          filename = body.filename;
          mime = typeof body.mime === "string" ? body.mime : undefined;
          if (["document", "screenshot", "photo", "audio", "other"].includes(String(body.assetKind))) {
            assetKind = body.assetKind as typeof assetKind;
          }
          originChannel = typeof body.originChannel === "string" ? body.originChannel : undefined;
          if (body.visibility === "private" || body.visibility === "shared") visibility = body.visibility;
          if (typeof body.capturedAt === "string") {
            const parsed = new Date(body.capturedAt);
            if (!Number.isNaN(parsed.getTime())) capturedAt = parsed;
          }
          buffer = Buffer.from(body.contentBase64, "base64");
        }
        if (buffer.byteLength === 0) return reply.code(400).send(errorOf("empty_file"));
        if (buffer.byteLength > MAX_UPLOAD_BYTES) return reply.code(413).send(errorOf("too_large"));
        if (!isSupportedUploadFilename(filename)) {
          return reply.code(400).send(errorOf("unsupported_file_type"));
        }

        const uploaded = await service.upload({
          filename, buffer, mime, assetKind, originChannel, visibility, capturedAt,
        });
        return reply.code(201).send({
          id: uploaded.fileId,
          contentHash: uploaded.contentHash,
          deduped: uploaded.deduped,
          bytes: uploaded.bytes,
          originalName: uploaded.originalName,
        });
      },
    );

    app.get(
      "/v1/files",
      {
        schema: {
          tags: ["files"],
          querystring: Type.Object({
            limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, default: 50 })),
            offset: Type.Optional(Type.Integer({ minimum: 0, default: 0 })),
          }),
          response: {
            200: Type.Object({ items: Type.Array(FileDto), total: Type.Integer() }),
          },
        },
      },
      async (request) => {
        const limit = request.query.limit ?? 50;
        const offset = request.query.offset ?? 0;
        const page = service.list(limit, offset);
        return { items: page.items.map(toDto), total: page.total };
      },
    );

    app.get(
      "/v1/files/:id",
      {
        schema: {
          tags: ["files"],
          params: FileIdParams,
          response: {
            200: FileDetailDto,
            404: Type.Object({ error: Type.String() }),
          },
        },
      },
      async (request, reply) => {
        const row = service.get(request.params.id);
        if (!row) return reply.code(404).send(errorOf("file_not_found"));
        return {
          ...toDto(row),
          storagePath: service.storagePathOf(request.params.id) ?? "",
          currentParsedId: row.currentParsedId ?? null,
        };
      },
    );

    app.get(
      "/v1/files/:id/content",
      {
        schema: {
          tags: ["files"],
          params: FileIdParams,
        },
      },
      async (request, reply) => {
        const content = service.isCatalogEntry(request.params.id)
          ? await service.catalogContentOf(request.params.id)
          : await service.contentOf(request.params.id);
        if (!content) return reply.code(404).send(errorOf("file_not_found"));
        reply.header("content-type", content.mime);
        reply.header("content-length", String(content.buffer.byteLength));
        reply.header("content-disposition", `inline; filename*=UTF-8''${encodeURIComponent(content.filename)}`);
        return reply.send(content.buffer);
      },
    );

    app.get(
      "/v1/files/:id/markdown",
      {
        schema: {
          tags: ["files"],
          params: FileIdParams,
          response: {
            200: Type.Object({ markdown: Type.String() }),
            404: Type.Object({ error: Type.String() }),
          },
        },
      },
      async (request, reply) => {
        const markdown = service.isCatalogEntry(request.params.id)
          ? service.catalogMarkdownOf(request.params.id)
          : service.markdownOf(request.params.id);
        if (markdown === null) return reply.code(404).send(errorOf("file_not_parsed"));
        return { markdown };
      },
    );

    app.get(
      "/v1/files/:id/storage",
      {
        schema: {
          tags: ["files"],
          params: FileIdParams,
          response: {
            200: Type.Object({ storagePath: Type.String() }),
            404: Type.Object({ error: Type.String() }),
          },
        },
      },
      async (request, reply) => {
        const storagePath = service.isCatalogEntry(request.params.id)
          ? service.catalogStoragePathOf(request.params.id)
          : service.storagePathOf(request.params.id);
        if (storagePath === null) return reply.code(404).send(errorOf("file_not_found"));
        return { storagePath };
      },
    );

    app.patch(
      "/v1/files/:id/meta",
      {
        schema: {
          tags: ["files"],
          params: FileIdParams,
          body: Type.Object({
            displayName: Type.String({ minLength: 1, maxLength: 300 }),
          }),
          response: {
            200: FileDto,
            404: Type.Object({ error: Type.String() }),
          },
        },
      },
      async (request, reply) => {
        const row = service.rename(request.params.id, request.body.displayName);
        if (!row) return reply.code(404).send(errorOf("file_not_found"));
        return toDto(row);
      },
    );

    app.delete(
      "/v1/files/:id",
      {
        schema: {
          tags: ["files"],
          params: FileIdParams,
          response: {
            200: Type.Object({
              deleted: Type.Boolean(),
              knowledgeCleanup: Type.Boolean(),
              deletedMemoryDocuments: Type.Array(Type.String()),
              blobCollected: Type.Boolean(),
            }),
            404: Type.Object({ error: Type.String() }),
          },
        },
      },
      async (request, reply) => {
        const result = service.isCatalogEntry(request.params.id)
          ? await service.deleteCatalogEntry(request.params.id, deletionHooks)
          : await service.deleteFile(request.params.id, deletionHooks);
        if (!result) return reply.code(404).send(errorOf("file_not_found"));
        return {
          deleted: true,
          knowledgeCleanup: result.knowledgeCleanup,
          deletedMemoryDocuments: result.deletedMemoryDocuments,
          blobCollected: result.blobCollected,
        };
      },
    );

    app.post(
      "/v1/files/gc",
      {
        schema: {
          tags: ["files"],
          response: {
            200: Type.Object({
              removedParsed: Type.Integer(),
              removedBlobs: Type.Integer(),
              errors: Type.Integer(),
            }),
          },
        },
      },
      async () => service.collectGarbage(),
    );
  };
}
