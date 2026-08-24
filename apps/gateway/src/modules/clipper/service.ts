import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { and, desc, eq } from "drizzle-orm";

import type { GatewayDatabase } from "../../infrastructure/database/client.js";
import {
  clipperAssets,
  clipperCaptures,
  fileBlobs,
} from "../../infrastructure/database/schema.js";
import type { FilesService } from "../files/service.js";
import { contentHashOf, storageRelPath, storeFileBlob } from "../files/storage.js";

export const CLIPPER_EXTRACTOR_VERSION = "readability-0.6.0+everroom-2";
export const CLIPPER_PARSER_VERSION = "markdown-v1";
export const MAX_CLIPPER_ASSETS = 20;
export const MAX_CLIPPER_ASSET_BYTES = 2 * 1024 * 1024;
export const MAX_CLIPPER_TOTAL_ASSET_BYTES = 15 * 1024 * 1024;

export interface ClipperAssetInput {
  id: string;
  referenceKey: string;
  originalUrl: string;
  altText?: string;
  width?: number;
  height?: number;
}

export interface CreateClipperCaptureInput {
  captureId: string;
  sourceUrl: string;
  canonicalUrl: string;
  title: string;
  author?: string;
  publishedAt?: string;
  capturedAt: string;
  extractionMode: "selection" | "article" | "full-page";
  markdown: string;
  extractorVersion?: string;
  assets: ClipperAssetInput[];
}

export type ClipperCaptureStatus = typeof clipperCaptures.$inferSelect["status"];

export interface ClipperCaptureDto {
  id: string;
  fileEntryId: string | null;
  fileVersionId: string | null;
  sourceUrl: string;
  canonicalUrl: string;
  title: string;
  author: string | null;
  publishedAt: string | null;
  capturedAt: string;
  extractionMode: "selection" | "article" | "full-page";
  status: ClipperCaptureStatus;
  assetCount: number;
  storedAssetCount: number;
  failedAssetCount: number;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  assets: ClipperAssetDto[];
}

export interface ClipperAssetDto {
  id: string;
  referenceKey: string;
  originalUrl: string;
  localUrl: string;
  mime: string | null;
  byteSize: number | null;
  altText: string | null;
  width: number | null;
  height: number | null;
  status: "pending" | "stored" | "failed";
  errorCode: string | null;
}

export interface CreateClipperCaptureResult {
  capture: ClipperCaptureDto;
  fileEntryId: string;
  fileVersionId: string;
  jobId: string;
  contentHash: string;
  blobDeduped: boolean;
  versionDeduped: boolean;
  pendingAssetIds: string[];
}

function validWebUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password;
  } catch {
    return false;
  }
}

function safeMarkdownFilename(title: string): string {
  const safe = title.trim().replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim();
  return `${(safe || "Web clip").slice(0, 160)}.md`;
}

function sniffImageMime(buffer: Buffer): string | null {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  const header = buffer.subarray(0, 12).toString("ascii");
  if (header.startsWith("GIF87a") || header.startsWith("GIF89a")) return "image/gif";
  if (header.startsWith("RIFF") && header.slice(8, 12) === "WEBP") return "image/webp";
  if (buffer.length >= 16 && buffer.subarray(4, 8).toString("ascii") === "ftyp") {
    const brand = buffer.subarray(8, 12).toString("ascii");
    if (brand === "avif" || brand === "avis") return "image/avif";
  }
  return null;
}

export class ClipperService {
  constructor(
    private readonly db: GatewayDatabase,
    private readonly files: FilesService,
    private readonly dataDir: string,
  ) {}

  async createCapture(input: CreateClipperCaptureInput): Promise<CreateClipperCaptureResult> {
    const existing = this.db.select().from(clipperCaptures).where(eq(clipperCaptures.captureKey, input.captureId)).get();
    if (existing?.fileEntryId && existing.fileVersionId) {
      return {
        capture: this.detail(existing.id)!,
        fileEntryId: existing.fileEntryId,
        fileVersionId: existing.fileVersionId,
        jobId: `clipper:${existing.fileVersionId}`,
        contentHash: existing.rawContentHash,
        blobDeduped: true,
        versionDeduped: true,
        pendingAssetIds: this.pendingAssetIds(existing.id),
      };
    }
    if (!validWebUrl(input.sourceUrl) || !validWebUrl(input.canonicalUrl)) throw new Error("clipper_url_invalid");
    if (input.assets.length > MAX_CLIPPER_ASSETS) throw new Error("clipper_too_many_assets");
    if (new Set(input.assets.map((asset) => asset.id)).size !== input.assets.length) throw new Error("clipper_asset_id_duplicate");
    for (const asset of input.assets) {
      if (!/^[a-zA-Z0-9_-]{8,200}$/.test(asset.id) || !/^[a-zA-Z0-9_-]{8,100}$/.test(asset.referenceKey) || !validWebUrl(asset.originalUrl)) throw new Error("clipper_asset_invalid");
    }
    const capturedAt = new Date(input.capturedAt);
    if (Number.isNaN(capturedAt.getTime())) throw new Error("clipper_captured_at_invalid");
    const markdown = Buffer.from(input.markdown, "utf8");
    const rawContentHash = contentHashOf(markdown);
    const now = new Date();
    this.db.insert(clipperCaptures).values({
      id: input.captureId,
      captureKey: input.captureId,
      sourceUrl: input.sourceUrl,
      canonicalUrl: input.canonicalUrl,
      title: input.title,
      author: input.author,
      publishedAt: input.publishedAt,
      capturedAt,
      extractionMode: input.extractionMode,
      rawContentHash,
      extractorVersion: input.extractorVersion ?? CLIPPER_EXTRACTOR_VERSION,
      parserVersion: CLIPPER_PARSER_VERSION,
      status: "storing",
      assetCount: input.assets.length,
      createdAt: now,
      updatedAt: now,
    }).run();
    try {
      const imported = await this.files.importFile({
        sourceKind: "web-clipper",
        sourceKey: `clipper:${input.canonicalUrl}`,
        originalName: safeMarkdownFilename(input.title),
        buffer: markdown,
        mime: "text/markdown",
        sourceUri: input.canonicalUrl,
        sourceModifiedAt: capturedAt,
        pipelines: { room: false, wiki: false, memory: false },
      });
      this.db.transaction((tx) => {
        tx.update(clipperCaptures).set({
          fileEntryId: imported.fileEntryId,
          fileVersionId: imported.fileVersionId,
          status: input.assets.length > 0 ? "assets_pending" : "ready",
          updatedAt: new Date(),
        }).where(eq(clipperCaptures.id, input.captureId)).run();
        if (input.assets.length > 0) tx.insert(clipperAssets).values(input.assets.map((asset) => ({
          id: asset.id,
          captureId: input.captureId,
          fileVersionId: imported.fileVersionId,
          referenceKey: asset.referenceKey,
          originalUrl: asset.originalUrl,
          altText: asset.altText?.slice(0, 1_000),
          width: asset.width,
          height: asset.height,
          status: "pending" as const,
        }))).run();
      });
      return {
        capture: this.detail(input.captureId)!,
        ...imported,
        pendingAssetIds: input.assets.map((asset) => asset.id),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.db.update(clipperCaptures).set({
        status: "failed", errorCode: "file_import_failed", errorMessage: message.slice(0, 500), updatedAt: new Date(),
      }).where(eq(clipperCaptures.id, input.captureId)).run();
      throw error;
    }
  }

  async storeAsset(captureId: string, assetId: string, buffer: Buffer): Promise<ClipperAssetDto> {
    const asset = this.db.select().from(clipperAssets).where(and(
      eq(clipperAssets.id, assetId), eq(clipperAssets.captureId, captureId),
    )).get();
    if (!asset) throw new Error("clipper_asset_not_found");
    if (asset.status === "stored") return this.assetDto(asset);
    if (buffer.byteLength === 0 || buffer.byteLength > MAX_CLIPPER_ASSET_BYTES) throw new Error("clipper_asset_too_large");
    const storedBytes = this.db.select({ byteSize: clipperAssets.byteSize }).from(clipperAssets)
      .where(eq(clipperAssets.captureId, captureId)).all()
      .reduce((sum, row) => sum + (row.byteSize ?? 0), 0);
    if (storedBytes + buffer.byteLength > MAX_CLIPPER_TOTAL_ASSET_BYTES) throw new Error("clipper_assets_total_too_large");
    const mime = sniffImageMime(buffer);
    if (!mime) throw new Error("clipper_asset_type_invalid");
    const contentHash = contentHashOf(buffer);
    await storeFileBlob(this.dataDir, contentHash, buffer);
    this.db.transaction((tx) => {
      tx.insert(fileBlobs).values({
        contentHash,
        storagePath: storageRelPath(contentHash),
        byteSize: buffer.byteLength,
        mime,
      }).onConflictDoNothing().run();
      tx.update(clipperAssets).set({
        contentHash, mime, byteSize: buffer.byteLength, status: "stored",
        errorCode: null, errorMessage: null, updatedAt: new Date(),
      }).where(eq(clipperAssets.id, assetId)).run();
    });
    this.refreshCaptureStatus(captureId, false);
    return this.assetDto(this.db.select().from(clipperAssets).where(eq(clipperAssets.id, assetId)).get()!);
  }

  finalizeCapture(captureId: string, failures: Array<{ assetId: string; code?: string }>): ClipperCaptureDto {
    const failureMap = new Map(failures.map((failure) => [failure.assetId, failure.code ?? "asset_unavailable"]));
    const pending = this.db.select().from(clipperAssets).where(and(
      eq(clipperAssets.captureId, captureId), eq(clipperAssets.status, "pending"),
    )).all();
    const now = new Date();
    this.db.transaction((tx) => {
      for (const asset of pending) {
        const code = failureMap.get(asset.id) ?? "asset_unavailable";
        tx.update(clipperAssets).set({ status: "failed", errorCode: code, updatedAt: now })
          .where(eq(clipperAssets.id, asset.id)).run();
      }
    });
    this.refreshCaptureStatus(captureId, true);
    const detail = this.detail(captureId);
    if (!detail) throw new Error("clipper_capture_not_found");
    return detail;
  }

  retryCapture(captureId: string): { capture: ClipperCaptureDto; pendingAssetIds: string[] } {
    const capture = this.db.select().from(clipperCaptures).where(eq(clipperCaptures.id, captureId)).get();
    if (!capture) throw new Error("clipper_capture_not_found");
    this.db.update(clipperAssets).set({
      status: "pending", errorCode: null, errorMessage: null, updatedAt: new Date(),
    }).where(and(eq(clipperAssets.captureId, captureId), eq(clipperAssets.status, "failed"))).run();
    const pendingAssetIds = this.pendingAssetIds(captureId);
    this.db.update(clipperCaptures).set({
      status: pendingAssetIds.length > 0 ? "assets_pending" : "ready",
      failedAssetCount: 0,
      updatedAt: new Date(),
    }).where(eq(clipperCaptures.id, captureId)).run();
    return { capture: this.detail(captureId)!, pendingAssetIds };
  }

  detail(captureId: string): ClipperCaptureDto | null {
    const capture = this.db.select().from(clipperCaptures).where(eq(clipperCaptures.id, captureId)).get();
    if (!capture) return null;
    const assets = this.db.select().from(clipperAssets).where(eq(clipperAssets.captureId, captureId)).all();
    return {
      id: capture.id,
      fileEntryId: capture.fileEntryId,
      fileVersionId: capture.fileVersionId,
      sourceUrl: capture.sourceUrl,
      canonicalUrl: capture.canonicalUrl,
      title: capture.title,
      author: capture.author,
      publishedAt: capture.publishedAt,
      capturedAt: capture.capturedAt.toISOString(),
      extractionMode: capture.extractionMode,
      status: capture.status,
      assetCount: capture.assetCount,
      storedAssetCount: capture.storedAssetCount,
      failedAssetCount: capture.failedAssetCount,
      errorCode: capture.errorCode,
      errorMessage: capture.errorMessage,
      createdAt: capture.createdAt.toISOString(),
      updatedAt: capture.updatedAt.toISOString(),
      assets: assets.map((asset) => this.assetDto(asset)),
    };
  }

  latestForFile(fileEntryId: string): ClipperCaptureDto | null {
    const capture = this.db.select().from(clipperCaptures)
      .where(eq(clipperCaptures.fileEntryId, fileEntryId))
      .orderBy(desc(clipperCaptures.capturedAt)).limit(1).get();
    return capture ? this.detail(capture.id) : null;
  }

  listCaptures(limit = 100, offset = 0): { items: ClipperCaptureDto[]; total: number } {
    const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 1), 200) : 100;
    const safeOffset = Number.isFinite(offset) ? Math.max(Math.trunc(offset), 0) : 0;
    const rows = this.db.select({ id: clipperCaptures.id }).from(clipperCaptures)
      .orderBy(desc(clipperCaptures.capturedAt)).limit(safeLimit).offset(safeOffset).all();
    const total = this.db.select({ id: clipperCaptures.id }).from(clipperCaptures).all().length;
    return {
      items: rows.map(({ id }) => this.detail(id)).filter((capture): capture is ClipperCaptureDto => Boolean(capture)),
      total,
    };
  }

  async assetContent(referenceKey: string): Promise<{ buffer: Buffer; mime: string } | null> {
    const row = this.db.select({ asset: clipperAssets, blob: fileBlobs }).from(clipperAssets)
      .innerJoin(fileBlobs, eq(clipperAssets.contentHash, fileBlobs.contentHash))
      .where(and(eq(clipperAssets.referenceKey, referenceKey), eq(clipperAssets.status, "stored")))
      .orderBy(desc(clipperAssets.createdAt)).limit(1).get();
    if (!row) return null;
    return { buffer: await readFile(join(this.dataDir, row.blob.storagePath)), mime: row.blob.mime };
  }

  private pendingAssetIds(captureId: string): string[] {
    return this.db.select({ id: clipperAssets.id }).from(clipperAssets).where(and(
      eq(clipperAssets.captureId, captureId), eq(clipperAssets.status, "pending"),
    )).all().map(({ id }) => id);
  }

  private refreshCaptureStatus(captureId: string, finalized: boolean): void {
    const assets = this.db.select().from(clipperAssets).where(eq(clipperAssets.captureId, captureId)).all();
    const stored = assets.filter((asset) => asset.status === "stored").length;
    const failed = assets.filter((asset) => asset.status === "failed").length;
    const pending = assets.length - stored - failed;
    const status: ClipperCaptureStatus = pending > 0 && !finalized
      ? "assets_pending"
      : failed > 0 ? "ready_with_missing_assets" : "ready";
    this.db.update(clipperCaptures).set({
      status,
      storedAssetCount: stored,
      failedAssetCount: failed + (finalized ? pending : 0),
      updatedAt: new Date(),
    }).where(eq(clipperCaptures.id, captureId)).run();
  }

  private assetDto(asset: typeof clipperAssets.$inferSelect): ClipperAssetDto {
    return {
      id: asset.id,
      referenceKey: asset.referenceKey,
      originalUrl: asset.originalUrl,
      localUrl: `nxcore-clipper-asset://local/${asset.referenceKey}`,
      mime: asset.mime,
      byteSize: asset.byteSize,
      altText: asset.altText,
      width: asset.width,
      height: asset.height,
      status: asset.status,
      errorCode: asset.errorCode,
    };
  }
}
