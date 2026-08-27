import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { and, asc, desc, eq } from "drizzle-orm";

import type { GatewayDatabase } from "../../infrastructure/database/client.js";
import {
  clipperArtifacts,
  clipperAssets,
  clipperCaptures,
  entities,
  entityDocLinks,
  fileBlobs,
  fileVersions,
  ingestEvents,
  jobs,
} from "../../infrastructure/database/schema.js";
import type { FilesService } from "../files/service.js";
import { contentHashOf, storageRelPath, storeFileBlob } from "../files/storage.js";
import {
  CLIP_IMAGE_PROMPT_VERSION,
  type ClipImageAnalysisClient,
} from "../perception/vlm-client.js";

export const CLIPPER_EXTRACTOR_VERSION = "readability-0.6.0+everroom-8";
export const CLIPPER_PARSER_VERSION = "markdown-multimodal-v2";
export const MAX_CLIPPER_ASSETS = 100;
/** These are corruption/OOM guards. The extension asks before crossing its lower soft threshold. */
export const MAX_CLIPPER_ASSET_BYTES = 20 * 1024 * 1024;
export const MAX_CLIPPER_TOTAL_ASSET_BYTES = 100 * 1024 * 1024;
const MAX_CLIPPER_RASTER_DIMENSION = 4_096;
const MAX_CLIPPER_RASTER_PIXELS = 16_000_000;

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
type PipelineState = "pending" | "processing" | "ready" | "partial" | "skipped" | "failed" | "unavailable";

export interface ClipperEntityDto {
  id: string;
  name: string;
  kind: string;
  status: string;
  role: "primary" | "mention" | "manual";
  salience: number;
  evidence: string | null;
}

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
  favoritedAt: string | null;
  artifact: null | {
    schemaVersion: number;
    excerpt: string;
    coverAssetId: string | null;
    coverUrl: string | null;
    displayMarkdown?: string;
  };
  understanding: {
    parse: PipelineState;
    visual: PipelineState;
    memory: PipelineState;
    entities: PipelineState;
  };
  entities: ClipperEntityDto[];
  assets: ClipperAssetDto[];
}

export type ClipperCaptureFilter = "all" | "favorite" | "processing";
export type ClipperCaptureSort = "newest" | "oldest";

export interface ClipperCaptureListInput {
  query?: string;
  filter?: ClipperCaptureFilter;
  sort?: ClipperCaptureSort;
  limit?: number;
  offset?: number;
}

export interface ClipperCaptureListResult {
  items: ClipperCaptureDto[];
  total: number;
  counts: { all: number; favorite: number; processing: number };
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
  visualStatus: "pending" | "processing" | "ready" | "skipped" | "failed";
  visualKind: string | null;
  visualSummary: string | null;
  visualOcrText: string | null;
  visualKeyPoints: string[];
  visualEntities: Array<{ name: string; kind: string; evidence: string }>;
  visualRelevance: number | null;
  visualQuality: number | null;
  visualContentRole: "primary" | "supporting" | "noise" | null;
  visualNoiseReason: string | null;
  coverScore: number | null;
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
  const prefix = buffer.subarray(0, Math.min(buffer.length, 16_384)).toString("utf8")
    .replace(/^\uFEFF/, "")
    .replace(/^\s*<\?xml[^>]*>\s*/i, "")
    .replace(/^\s*<!--(?:[\s\S]*?)-->\s*/i, "")
    .trimStart();
  if (/^<svg(?:\s|>)/i.test(prefix)) return "image/svg+xml";
  return null;
}

function assertSafeSvg(buffer: Buffer): void {
  const svg = buffer.toString("utf8");
  const forbiddenMarkup = /<!DOCTYPE|<!ENTITY|<\?xml-stylesheet|<\s*(?:script|style|foreignObject|iframe|object|embed|audio|video)\b|\son[a-z]+\s*=|@import\b/i;
  if (forbiddenMarkup.test(svg)) throw new Error("clipper_svg_unsafe");

  const isSafeReference = (value: string, allowEmbeddedRaster: boolean): boolean => {
    const reference = value.trim();
    if (reference.startsWith("#")) return true;
    return allowEmbeddedRaster && /^data:image\/(?:png|jpe?g|gif|webp);base64,/i.test(reference);
  };
  for (const match of svg.matchAll(/\b(?:href|xlink:href)\s*=\s*(["'])([\s\S]*?)\1/gi)) {
    if (!isSafeReference(match[2] ?? "", true)) throw new Error("clipper_svg_unsafe");
  }
  for (const match of svg.matchAll(/\burl\(\s*(["']?)([\s\S]*?)\1\s*\)/gi)) {
    if (!isSafeReference(match[2] ?? "", false)) throw new Error("clipper_svg_unsafe");
  }
}

async function normalizeImage(
  buffer: Buffer,
  mime: string,
  dimensions: { width: number | null; height: number | null },
): Promise<{ buffer: Buffer; mime: string; width?: number; height?: number }> {
  if (mime !== "image/svg+xml") return { buffer, mime };
  assertSafeSvg(buffer);
  let image: Awaited<ReturnType<typeof loadImage>>;
  try {
    image = await loadImage(buffer);
  } catch {
    throw new Error("clipper_svg_invalid");
  }
  const sourceWidth = image.width || dimensions.width || 0;
  const sourceHeight = image.height || dimensions.height || 0;
  if (!sourceWidth || !sourceHeight) throw new Error("clipper_svg_dimensions_invalid");
  const scale = Math.min(
    1,
    MAX_CLIPPER_RASTER_DIMENSION / sourceWidth,
    MAX_CLIPPER_RASTER_DIMENSION / sourceHeight,
    Math.sqrt(MAX_CLIPPER_RASTER_PIXELS / (sourceWidth * sourceHeight)),
  );
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));
  const canvas = createCanvas(width, height);
  canvas.getContext("2d").drawImage(image, 0, 0, width, height);
  return { buffer: canvas.toBuffer("image/png"), mime: "image/png", width, height };
}

function markdownExcerpt(markdown: string): string {
  return markdown
    .replace(/^---[\s\S]*?---\s*/u, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[`*_>#~|\-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 320);
}

function quoteLine(value: string): string {
  return value.replace(/\s+/g, " ").trim().replace(/^/gm, "> ");
}

function markdownAssetContext(markdown: string, localUrl: string): string {
  const position = markdown.indexOf(localUrl);
  if (position < 0) return "";
  return markdown
    .slice(Math.max(0, position - 1_000), Math.min(markdown.length, position + localUrl.length + 1_000))
    .replace(/^---[\s\S]*?---\s*/u, "")
    .replace(/<!--[^>]*-->/g, " ")
    .replace(/!\[(?:\\.|[^\]])*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[`*_>#~|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 2_000);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function removeMarkdownAsset(markdown: string, localUrl: string): string {
  const target = escapeRegExp(localUrl);
  const image = `!\\[(?:\\\\.|[^\\]])*\\]\\(${target}\\)`;
  return markdown
    .replace(new RegExp(`\\[${image}\\]\\([^\\n)]+\\)`, "g"), "")
    .replace(new RegExp(image, "g"), "");
}

function cleanImageGridBlocks(markdown: string): string {
  return markdown.replace(
    /<!--\s*everroom:image-grid:start\s+columns=(\d+)\s*-->([\s\S]*?)<!--\s*everroom:image-grid:end\s*-->/giu,
    (_block, columns: string, content: string) => {
      const images = content.match(/!\[(?:\\.|[^\]])*\]\(nxcore-clipper-asset:\/\/local\/[^)\s]+\)/gu) ?? [];
      if (images.length === 0) return "";
      if (images.length === 1) return content.trim();
      return `<!-- everroom:image-grid:start columns=${Math.min(Number(columns) || images.length, images.length)} -->\n${content.trim()}\n<!-- everroom:image-grid:end -->`;
    },
  ).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function isNoiseAsset(asset: typeof clipperAssets.$inferSelect): boolean {
  if (asset.visualContentRole) return asset.visualContentRole === "noise";
  return asset.visualKind === "logo" || asset.visualKind === "decoration";
}

export class ClipperService {
  private visualProvider: ClipImageAnalysisClient | null;
  private visualWorker: Promise<void> | null = null;
  private disposed = false;

  constructor(
    private readonly db: GatewayDatabase,
    private readonly files: FilesService,
    private readonly dataDir: string,
    visualProvider: ClipImageAnalysisClient | null = null,
  ) {
    this.visualProvider = visualProvider;
    this.db.update(jobs).set({ status: "pending", updatedAt: new Date() })
      .where(and(eq(jobs.type, "clipper.visual"), eq(jobs.status, "running"))).run();
    this.kickVisualJobs();
  }

  async initialize(): Promise<void> {
    const captures = this.db.select().from(clipperCaptures).all();
    for (const capture of captures) {
      if (this.db.select({ captureId: clipperArtifacts.captureId }).from(clipperArtifacts)
        .where(eq(clipperArtifacts.captureId, capture.id)).get()) continue;
      if (!capture.fileEntryId || !capture.fileVersionId) continue;
      const context = this.files.getVersionContext(capture.fileEntryId, capture.fileVersionId);
      if (!context) continue;
      try {
        const displayMarkdown = (await readFile(context.storagePath)).toString("utf8");
        const assetCount = this.db.select({ id: clipperAssets.id }).from(clipperAssets)
          .where(eq(clipperAssets.captureId, capture.id)).all().length;
        this.db.transaction((tx) => {
          tx.insert(clipperArtifacts).values({
            captureId: capture.id,
            displayMarkdown,
            semanticMarkdown: displayMarkdown,
            excerpt: markdownExcerpt(displayMarkdown),
            visualStatus: assetCount > 0 ? "processing" : "skipped",
            parseStatus: "pending",
          }).run();
          tx.insert(jobs).values({
            id: `clipper.visual:${capture.id}:${randomUUID()}`,
            type: "clipper.visual",
            status: "pending",
            payload: { captureId: capture.id, attempts: 0, legacyBackfill: true },
          }).run();
        });
      } catch {
        // Preserve the registry row; the UI will expose its missing-content state.
      }
    }
    const interrupted = this.db.select({ id: clipperCaptures.id }).from(clipperCaptures)
      .where(eq(clipperCaptures.status, "assets_pending")).all();
    for (const { id } of interrupted) {
      await this.finalizeCapture(id, this.pendingAssetIds(id).map((assetId) => ({
        assetId,
        code: "asset_upload_interrupted",
      })));
    }
    this.kickVisualJobs();
  }

  replaceVisualProvider(provider: ClipImageAnalysisClient | null): void {
    this.visualProvider = provider;
    if (provider) {
      const retryCaptureIds = [...new Set(this.db.select({ captureId: clipperAssets.captureId }).from(clipperAssets)
        .where(and(eq(clipperAssets.status, "stored"), eq(clipperAssets.visualStatus, "failed"))).all()
        .map(({ captureId }) => captureId))];
      const now = new Date();
      this.db.transaction((tx) => {
        for (const captureId of retryCaptureIds) {
          tx.update(clipperAssets).set({
            visualStatus: "pending", errorCode: null, errorMessage: null, updatedAt: now,
          }).where(and(eq(clipperAssets.captureId, captureId), eq(clipperAssets.visualStatus, "failed"))).run();
          tx.update(clipperArtifacts).set({ visualStatus: "processing", updatedAt: now })
            .where(eq(clipperArtifacts.captureId, captureId)).run();
          tx.insert(jobs).values({
            id: `clipper.visual:${captureId}:${randomUUID()}`,
            type: "clipper.visual",
            status: "pending",
            payload: { captureId, attempts: 0 },
          }).run();
        }
      });
    }
    this.kickVisualJobs();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.visualWorker;
  }

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
        deferIngest: true,
      });
      this.db.transaction((tx) => {
        tx.update(clipperCaptures).set({
          fileEntryId: imported.fileEntryId,
          fileVersionId: imported.fileVersionId,
          status: input.assets.length > 0 ? "assets_pending" : "ready",
          updatedAt: new Date(),
        }).where(eq(clipperCaptures.id, input.captureId)).run();
        tx.insert(clipperArtifacts).values({
          captureId: input.captureId,
          displayMarkdown: input.markdown,
          semanticMarkdown: input.markdown,
          excerpt: markdownExcerpt(input.markdown),
          parseStatus: "pending",
          visualStatus: input.assets.length > 0 ? "pending" : "skipped",
        }).run();
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
          visualStatus: "pending" as const,
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
    if (buffer.byteLength === 0 || buffer.byteLength > MAX_CLIPPER_ASSET_BYTES) throw new Error("clipper_asset_emergency_limit");
    const mime = sniffImageMime(buffer);
    if (!mime) throw new Error("clipper_asset_type_invalid");
    const normalized = await normalizeImage(buffer, mime, { width: asset.width, height: asset.height });
    if (normalized.buffer.byteLength > MAX_CLIPPER_ASSET_BYTES) throw new Error("clipper_asset_emergency_limit");
    const storedBytes = this.db.select({ byteSize: clipperAssets.byteSize }).from(clipperAssets)
      .where(eq(clipperAssets.captureId, captureId)).all()
      .reduce((sum, row) => sum + (row.byteSize ?? 0), 0);
    if (storedBytes + normalized.buffer.byteLength > MAX_CLIPPER_TOTAL_ASSET_BYTES) throw new Error("clipper_assets_emergency_limit");
    const contentHash = contentHashOf(normalized.buffer);
    await storeFileBlob(this.dataDir, contentHash, normalized.buffer);
    this.db.transaction((tx) => {
      tx.insert(fileBlobs).values({
        contentHash,
        storagePath: storageRelPath(contentHash),
        byteSize: normalized.buffer.byteLength,
        mime: normalized.mime,
      }).onConflictDoNothing().run();
      tx.update(clipperAssets).set({
        contentHash,
        mime: normalized.mime,
        byteSize: normalized.buffer.byteLength,
        width: normalized.width ?? asset.width,
        height: normalized.height ?? asset.height,
        status: "stored",
        visualStatus: "pending",
        errorCode: null, errorMessage: null, updatedAt: new Date(),
      }).where(eq(clipperAssets.id, assetId)).run();
    });
    this.refreshCaptureStatus(captureId, false);
    return this.assetDto(this.db.select().from(clipperAssets).where(eq(clipperAssets.id, assetId)).get()!);
  }

  async finalizeCapture(captureId: string, failures: Array<{ assetId: string; code?: string }>): Promise<ClipperCaptureDto> {
    const capture = this.db.select().from(clipperCaptures).where(eq(clipperCaptures.id, captureId)).get();
    if (!capture) throw new Error("clipper_capture_not_found");
    const failureMap = new Map(failures.map((failure) => [failure.assetId, failure.code ?? "asset_unavailable"]));
    const pending = this.db.select().from(clipperAssets).where(and(
      eq(clipperAssets.captureId, captureId), eq(clipperAssets.status, "pending"),
    )).all();
    const now = new Date();
    this.db.transaction((tx) => {
      for (const asset of pending) {
        tx.update(clipperAssets).set({
          status: "failed",
          visualStatus: "skipped",
          errorCode: failureMap.get(asset.id) ?? "asset_unavailable",
          updatedAt: now,
        }).where(eq(clipperAssets.id, asset.id)).run();
      }
      tx.update(clipperArtifacts).set({
        visualStatus: capture.assetCount > 0 ? "processing" : "skipped",
        parseStatus: "pending",
        errorCode: null,
        errorMessage: null,
        updatedAt: now,
      }).where(eq(clipperArtifacts.captureId, captureId)).run();
      tx.insert(jobs).values({
        id: `clipper.visual:${captureId}:${randomUUID()}`,
        type: "clipper.visual",
        status: "pending",
        payload: { captureId, attempts: 0 },
      }).run();
    });
    this.refreshCaptureStatus(captureId, true);
    this.kickVisualJobs();
    return this.detail(captureId)!;
  }

  retryCapture(captureId: string): { capture: ClipperCaptureDto; pendingAssetIds: string[] } {
    const capture = this.db.select().from(clipperCaptures).where(eq(clipperCaptures.id, captureId)).get();
    if (!capture) throw new Error("clipper_capture_not_found");
    this.db.update(clipperAssets).set({
      status: "pending", visualStatus: "pending", errorCode: null, errorMessage: null, updatedAt: new Date(),
    }).where(and(eq(clipperAssets.captureId, captureId), eq(clipperAssets.status, "failed"))).run();
    const pendingAssetIds = this.pendingAssetIds(captureId);
    this.db.update(clipperCaptures).set({
      status: pendingAssetIds.length > 0 ? "assets_pending" : capture.status,
      failedAssetCount: 0,
      updatedAt: new Date(),
    }).where(eq(clipperCaptures.id, captureId)).run();
    return { capture: this.detail(captureId)!, pendingAssetIds };
  }

  detail(captureId: string, includeMarkdown = true): ClipperCaptureDto | null {
    const capture = this.db.select().from(clipperCaptures).where(eq(clipperCaptures.id, captureId)).get();
    if (!capture) return null;
    const artifact = this.db.select().from(clipperArtifacts).where(eq(clipperArtifacts.captureId, captureId)).get();
    const assets = this.db.select().from(clipperAssets).where(eq(clipperAssets.captureId, captureId)).all();
    const version = capture.fileVersionId
      ? this.db.select().from(fileVersions).where(eq(fileVersions.id, capture.fileVersionId)).get()
      : null;
    const ingest = version?.ingestEventId
      ? this.db.select().from(ingestEvents).where(eq(ingestEvents.id, version.ingestEventId)).get()
      : null;
    const routeJob = ingest?.routeJobId
      ? this.db.select().from(jobs).where(eq(jobs.id, ingest.routeJobId)).get()
      : null;
    const linkedEntities = capture.fileEntryId
      ? this.db.select({ link: entityDocLinks, entity: entities }).from(entityDocLinks)
          .innerJoin(entities, eq(entities.id, entityDocLinks.entityId))
          .where(and(eq(entityDocLinks.sourceKind, "file"), eq(entityDocLinks.sourceId, capture.fileEntryId))).all()
      : [];
    const cover = artifact?.coverAssetId ? assets.find((asset) => asset.id === artifact.coverAssetId) : null;
    const parse = this.parseState(version?.status, artifact?.parseStatus);
    const memory: PipelineState = !ingest
      ? parse === "failed" ? "failed" : "pending"
      : ingest.memoryResult
        ? "error" in ingest.memoryResult ? "failed" : "ready"
        : parse === "ready" ? "unavailable" : "processing";
    const entityState: PipelineState = linkedEntities.length > 0
      ? "ready"
      : routeJob?.status === "failed" ? "failed"
        : routeJob?.status === "completed" ? "ready"
          : ingest ? parse === "ready" && !ingest.routeJobId ? "unavailable" : "processing" : "pending";
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
      favoritedAt: capture.favoritedAt?.toISOString() ?? null,
      artifact: artifact ? {
        schemaVersion: artifact.schemaVersion,
        excerpt: artifact.excerpt,
        coverAssetId: artifact.coverAssetId,
        coverUrl: cover ? this.assetDto(cover).localUrl : null,
        ...(includeMarkdown ? { displayMarkdown: artifact.displayMarkdown } : {}),
      } : null,
      understanding: {
        parse,
        visual: (artifact?.visualStatus ?? "pending") as PipelineState,
        memory,
        entities: entityState,
      },
      entities: linkedEntities.map(({ link, entity }) => ({
        id: entity.id,
        name: entity.name,
        kind: entity.kind,
        status: entity.status,
        role: link.role,
        salience: link.salience,
        evidence: link.evidence,
      })),
      assets: assets.map((asset) => this.assetDto(asset)),
    };
  }

  latestForFile(fileEntryId: string): ClipperCaptureDto | null {
    const capture = this.db.select().from(clipperCaptures)
      .where(eq(clipperCaptures.fileEntryId, fileEntryId))
      .orderBy(desc(clipperCaptures.capturedAt)).limit(1).get();
    return capture ? this.detail(capture.id) : null;
  }

  listCaptures(inputOrLimit: ClipperCaptureListInput | number = {}, legacyOffset = 0): ClipperCaptureListResult {
    const input: ClipperCaptureListInput = typeof inputOrLimit === "number"
      ? { limit: inputOrLimit, offset: legacyOffset }
      : inputOrLimit;
    const safeLimit = Number.isFinite(input.limit) ? Math.min(Math.max(Math.trunc(input.limit!), 1), 200) : 100;
    const safeOffset = Number.isFinite(input.offset) ? Math.max(Math.trunc(input.offset!), 0) : 0;
    const query = input.query?.trim().toLocaleLowerCase() ?? "";
    const filter = input.filter ?? "all";
    const order = input.sort === "oldest" ? asc(clipperCaptures.capturedAt) : desc(clipperCaptures.capturedAt);
    const all = this.db.select({ id: clipperCaptures.id }).from(clipperCaptures).orderBy(order).all()
      .map(({ id }) => this.detail(id, false)).filter((item): item is ClipperCaptureDto => Boolean(item));
    const isProcessing = (item: ClipperCaptureDto) => Object.values(item.understanding)
      .some((state) => state === "pending" || state === "processing");
    const matchesQuery = (item: ClipperCaptureDto) => !query || [
      item.title, item.author, item.artifact?.excerpt, ...item.entities.map((entity) => entity.name),
    ].filter(Boolean).join(" ").toLocaleLowerCase().includes(query);
    const searched = all.filter(matchesQuery);
    const counts = {
      all: searched.length,
      favorite: searched.filter((item) => item.favoritedAt !== null).length,
      processing: searched.filter(isProcessing).length,
    };
    const filtered = searched.filter((item) => filter === "favorite"
      ? item.favoritedAt !== null
      : filter === "processing" ? isProcessing(item) : true);
    return { items: filtered.slice(safeOffset, safeOffset + safeLimit), total: filtered.length, counts };
  }

  setFavorite(captureId: string, favorite: boolean): ClipperCaptureDto | null {
    const capture = this.db.select({ id: clipperCaptures.id }).from(clipperCaptures)
      .where(eq(clipperCaptures.id, captureId)).get();
    if (!capture) return null;
    this.db.update(clipperCaptures).set({ favoritedAt: favorite ? new Date() : null, updatedAt: new Date() })
      .where(eq(clipperCaptures.id, captureId)).run();
    return this.detail(captureId, false);
  }

  async assetContent(referenceKey: string): Promise<{ buffer: Buffer; mime: string } | null> {
    const row = this.db.select({ asset: clipperAssets, blob: fileBlobs }).from(clipperAssets)
      .innerJoin(fileBlobs, eq(clipperAssets.contentHash, fileBlobs.contentHash))
      .where(and(eq(clipperAssets.referenceKey, referenceKey), eq(clipperAssets.status, "stored")))
      .orderBy(desc(clipperAssets.createdAt)).limit(1).get();
    if (!row) return null;
    return { buffer: await readFile(join(this.dataDir, row.blob.storagePath)), mime: row.blob.mime };
  }

  private parseState(
    versionStatus: typeof fileVersions.$inferSelect["status"] | undefined,
    artifactStatus: typeof clipperArtifacts.$inferSelect["parseStatus"] | undefined,
  ): PipelineState {
    if (versionStatus === "parsed") return "ready";
    if (versionStatus === "failed" || artifactStatus === "failed") return "failed";
    if (versionStatus === "parsing") return "processing";
    return artifactStatus === "processing" ? "processing" : "pending";
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

  private kickVisualJobs(): void {
    if (this.disposed || this.visualWorker) return;
    this.visualWorker = this.processVisualJobs().finally(() => {
      this.visualWorker = null;
      if (!this.disposed) {
        const pending = this.db.select({ id: jobs.id }).from(jobs).where(and(
          eq(jobs.type, "clipper.visual"), eq(jobs.status, "pending"),
        )).limit(1).get();
        if (pending) this.kickVisualJobs();
      }
    });
  }

  private async processVisualJobs(): Promise<void> {
    while (!this.disposed) {
      const job = this.db.select().from(jobs).where(and(
        eq(jobs.type, "clipper.visual"), eq(jobs.status, "pending"),
      )).orderBy(jobs.createdAt).limit(1).get();
      if (!job) return;
      const payload = job.payload as { captureId?: string; attempts?: number };
      if (!payload.captureId) {
        this.db.update(jobs).set({ status: "failed", error: { message: "captureId missing" }, updatedAt: new Date() })
          .where(eq(jobs.id, job.id)).run();
        continue;
      }
      this.db.update(jobs).set({ status: "running", updatedAt: new Date() }).where(eq(jobs.id, job.id)).run();
      try {
        await this.understandCapture(payload.captureId);
        this.db.update(jobs).set({ status: "completed", result: { captureId: payload.captureId }, error: null, updatedAt: new Date() })
          .where(eq(jobs.id, job.id)).run();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const attempts = payload.attempts ?? 0;
        if (attempts < 2) {
          this.db.update(jobs).set({
            status: "pending", payload: { ...payload, attempts: attempts + 1 }, error: { message }, updatedAt: new Date(),
          }).where(eq(jobs.id, job.id)).run();
        } else {
          this.db.update(jobs).set({ status: "failed", error: { message }, updatedAt: new Date() })
            .where(eq(jobs.id, job.id)).run();
          this.db.update(clipperArtifacts).set({
            parseStatus: "failed", errorCode: "clipper_understanding_failed", errorMessage: message.slice(0, 500), updatedAt: new Date(),
          }).where(eq(clipperArtifacts.captureId, payload.captureId)).run();
        }
      }
    }
  }

  private async understandCapture(captureId: string): Promise<void> {
    const capture = this.db.select().from(clipperCaptures).where(eq(clipperCaptures.id, captureId)).get();
    const artifact = this.db.select().from(clipperArtifacts).where(eq(clipperArtifacts.captureId, captureId)).get();
    if (!capture || !artifact) throw new Error("clipper_capture_not_found");
    const stored = this.db.select().from(clipperAssets).where(and(
      eq(clipperAssets.captureId, captureId), eq(clipperAssets.status, "stored"),
    )).all();
    let visualFailures = 0;
    for (const asset of stored) {
      if (asset.visualStatus === "ready") continue;
      if (!this.visualProvider) {
        visualFailures += 1;
        this.db.update(clipperAssets).set({
          visualStatus: "failed", errorCode: "vlm_unavailable", errorMessage: "图片理解模型未配置", updatedAt: new Date(),
        }).where(eq(clipperAssets.id, asset.id)).run();
        continue;
      }
      this.db.update(clipperAssets).set({ visualStatus: "processing", updatedAt: new Date() })
        .where(eq(clipperAssets.id, asset.id)).run();
      try {
        const blob = this.db.select().from(fileBlobs).where(eq(fileBlobs.contentHash, asset.contentHash!)).get();
        if (!blob) throw new Error("clipper_asset_blob_missing");
        const result = await this.visualProvider.analyzeClipImage(
          { buffer: await readFile(join(this.dataDir, blob.storagePath)), mime: asset.mime! },
          {
            pageTitle: capture.title,
            altText: asset.altText ?? "",
            nearbyText: markdownAssetContext(artifact.displayMarkdown, `nxcore-clipper-asset://local/${asset.referenceKey}`),
          },
        );
        this.db.update(clipperAssets).set({
          visualStatus: "ready",
          visualKind: result.kind,
          visualSummary: result.summary,
          visualOcrText: result.ocrText,
          visualKeyPoints: result.keyPoints,
          visualEntities: result.entities,
          visualRelevance: result.relevance,
          visualQuality: result.quality,
          visualContentRole: result.contentRole,
          visualNoiseReason: result.noiseReason,
          visualModel: this.visualProvider.model,
          visualPromptVersion: CLIP_IMAGE_PROMPT_VERSION,
          errorCode: null,
          errorMessage: null,
          updatedAt: new Date(),
        }).where(eq(clipperAssets.id, asset.id)).run();
      } catch (error) {
        visualFailures += 1;
        const message = error instanceof Error ? error.message : String(error);
        this.db.update(clipperAssets).set({
          visualStatus: "failed", errorCode: "vlm_failed", errorMessage: message.slice(0, 500), updatedAt: new Date(),
        }).where(eq(clipperAssets.id, asset.id)).run();
      }
    }

    const analyzed = this.db.select().from(clipperAssets).where(eq(clipperAssets.captureId, captureId)).all();
    const displayMarkdown = this.displayMarkdown(artifact.displayMarkdown, analyzed);
    const semanticMarkdown = this.semanticMarkdown(displayMarkdown, analyzed);
    const coverAssetId = this.selectCover(analyzed);
    const successfulVisuals = analyzed.filter((asset) => asset.visualStatus === "ready").length;
    const visualStatus = stored.length === 0
      ? "skipped" as const
      : visualFailures === 0 ? "ready" as const
        : successfulVisuals > 0 ? "partial" as const : "failed" as const;
    this.db.update(clipperArtifacts).set({
      displayMarkdown,
      semanticMarkdown,
      excerpt: markdownExcerpt(displayMarkdown),
      coverAssetId,
      visualStatus,
      parseStatus: "processing",
      errorCode: visualStatus === "failed" ? "clipper_visual_failed" : null,
      errorMessage: visualStatus === "failed" ? "图片未能完成视觉理解，可稍后重试" : null,
      updatedAt: new Date(),
    }).where(eq(clipperArtifacts.captureId, captureId)).run();

    const imported = await this.files.importFile({
      sourceKind: "web-clipper",
      sourceKey: `clipper:${capture.canonicalUrl}`,
      originalName: safeMarkdownFilename(capture.title),
      buffer: Buffer.from(semanticMarkdown, "utf8"),
      mime: "text/markdown",
      sourceUri: capture.canonicalUrl,
      sourceModifiedAt: capture.capturedAt,
      pipelines: { room: true, wiki: true, memory: true },
    });
    this.db.update(clipperCaptures).set({ fileVersionId: imported.fileVersionId, updatedAt: new Date() })
      .where(eq(clipperCaptures.id, captureId)).run();
  }

  private semanticMarkdown(markdown: string, assets: Array<typeof clipperAssets.$inferSelect>): string {
    let result = markdown;
    for (const asset of assets) {
      if (asset.visualStatus !== "ready" || !asset.visualSummary || isNoiseAsset(asset)) continue;
      const localUrl = `nxcore-clipper-asset://local/${asset.referenceKey}`;
      const details = [
        `图片理解：${asset.visualSummary}`,
        asset.visualOcrText ? `可见文字：${asset.visualOcrText}` : "",
        ...(asset.visualKeyPoints ?? []).map((item) => `要点：${item}`),
        ...(asset.visualEntities ?? []).map((item) => `可见实体：${item.name}（${item.kind}）— ${item.evidence}`),
      ].filter(Boolean).map(quoteLine).join("\n");
      const marker = `](${localUrl})`;
      result = result.replace(marker, `${marker}\n\n${details}`);
    }
    return result;
  }

  private displayMarkdown(markdown: string, assets: Array<typeof clipperAssets.$inferSelect>): string {
    let result = markdown;
    for (const asset of assets) {
      if (!isNoiseAsset(asset)) continue;
      result = removeMarkdownAsset(result, `nxcore-clipper-asset://local/${asset.referenceKey}`);
    }
    return cleanImageGridBlocks(result);
  }

  private selectCover(assets: Array<typeof clipperAssets.$inferSelect>): string | null {
    const nonCoverPattern = /(?:^|[\W_])(logo|wordmark|favicon|icon|avatar|sprite|badge)(?:[\W_]|$)/i;
    const eligible = assets.filter((asset) => {
      if (asset.status !== "stored" || isNoiseAsset(asset)) return false;
      if (asset.width && asset.height && (asset.width < 160 || asset.height < 90)) return false;
      if (asset.visualStatus === "ready") return true;
      return !nonCoverPattern.test(`${asset.altText ?? ""} ${asset.originalUrl}`);
    });
    let best: { id: string; score: number } | null = null;
    for (const [index, asset] of eligible.entries()) {
      const pixels = Math.max(1, (asset.width ?? 640) * (asset.height ?? 480));
      const dimensionScore = Math.min(1, Math.log10(pixels) / 6);
      const visualReady = asset.visualStatus === "ready";
      const fallbackKind = /\.svg(?:$|[?#])/i.test(asset.originalUrl) ? "illustration" : "other";
      const kindScore = ({ photo: 1, illustration: 0.9, diagram: 0.8, chart: 0.75, screenshot: 0.55, other: 0.5 } as Record<string, number>)[asset.visualKind ?? fallbackKind] ?? 0;
      const score = (visualReady ? asset.visualRelevance ?? 0 : 0.45) * 0.45
        + (visualReady ? asset.visualQuality ?? 0 : 0.5) * 0.25
        + kindScore * 0.2
        + dimensionScore * 0.1
        - index * 0.015;
      this.db.update(clipperAssets).set({ coverScore: score, updatedAt: new Date() })
        .where(eq(clipperAssets.id, asset.id)).run();
      if (!best || score > best.score) best = { id: asset.id, score };
    }
    return best?.id ?? null;
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
      visualStatus: asset.visualStatus,
      visualKind: asset.visualKind,
      visualSummary: asset.visualSummary,
      visualOcrText: asset.visualOcrText,
      visualKeyPoints: asset.visualKeyPoints ?? [],
      visualEntities: asset.visualEntities ?? [],
      visualRelevance: asset.visualRelevance,
      visualQuality: asset.visualQuality,
      visualContentRole: asset.visualContentRole,
      visualNoiseReason: asset.visualNoiseReason,
      coverScore: asset.coverScore,
    };
  }
}
