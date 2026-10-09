import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import type { GatewayDatabase } from "../../infrastructure/database/client.js";
import {
  clipperAssets,
  clipperCaptures,
  fileBlobs,
  fileClassifications,
  fileEntries,
  fileVersions,
  parsedDocuments,
  uploadedFiles,
  visualNodes,
  visualObservations,
} from "../../infrastructure/database/schema.js";

/** 素材检索命中项：ref 即 slides PageSpec image 元素可直接使用的引用。 */
export interface MaterialHit {
  ref: string;
  kind: "screenshot" | "photo" | "web-clip" | "document";
  desc: string;
  meta: string;
  rank: number;
}

/** 本地素材检索与取图：三类图源（截图/照片、网页剪藏图、文档内嵌图）统一按内容哈希寻址。 */
export class MaterialsService {
  constructor(
    private readonly db: GatewayDatabase,
    private readonly dataDir: string,
  ) {}

  /**
   * 关键词检索（任一命中即返回，按命中强度排序）：文本面 = VLM 摘要/标题/
   * 关键点、剪藏 alt/OCR、所在文档标题与分类摘要。
   *
   * 曾是 AND 语义（全部命中才返回）：实盘里规划代理习惯把多概念写进一次
   * 查询（如「中国 茶 文化」「茶叶 干茶 对比」），AND 让整库 6/6 查询全空、
   * PPT 全程无图——改为任一命中 + 命中数加权排序，让头部概念锚定检索、
   * 次要词提权，精度由返回的 desc 交规划代理自判。
   */
  search(query: string, limit = 8): MaterialHit[] {
    const terms = query.split(/[\s,，、;；]+/).map((term) => term.trim().toLowerCase())
      .filter((term) => term.length >= 2).slice(0, 6);
    if (terms.length === 0) return [];
    const capped = Math.min(Math.max(limit, 1), 20);
    const hits: MaterialHit[] = [
      ...this.searchPerception(terms),
      ...this.searchClipper(terms),
      ...this.searchDocumentAssets(terms),
    ];
    hits.sort((left, right) => right.rank - left.rank);
    return hits.slice(0, capped);
  }

  /** 按内容哈希取图：file_blobs（截图/照片/剪藏）优先，回退 document-artifacts（文档内嵌图）。 */
  async readByHash(hash: string): Promise<{ buffer: Buffer; mime: string } | null> {
    if (!/^[a-f0-9]{64}$/.test(hash)) return null;
    const blob = this.db.select({ storagePath: fileBlobs.storagePath, mime: fileBlobs.mime })
      .from(fileBlobs).where(eq(fileBlobs.contentHash, hash)).get();
    if (blob) {
      const path = join(this.dataDir, blob.storagePath);
      if (existsSync(path)) {
        const buffer = await readFile(path);
        const mime = sniffImageMime(buffer) ?? blob.mime;
        return mime.startsWith("image/") ? { buffer, mime } : null;
      }
    }
    const directory = join(this.dataDir, "document-artifacts", "sha256", hash.slice(0, 2));
    const names = await readdir(directory).catch(() => [] as string[]);
    const match = names.find((name) => name.startsWith(hash));
    if (!match) return null;
    const buffer = await readFile(join(directory, match));
    const mime = sniffImageMime(buffer);
    return mime ? { buffer, mime } : null;
  }

  /** 截图/照片：perception VLM 已生成标题/摘要/关键点（vlmStatus=ready）。 */
  private searchPerception(terms: string[]): MaterialHit[] {
    const rows = this.db.select({
      hash: fileBlobs.contentHash,
      kind: visualObservations.kind,
      width: visualObservations.width,
      height: visualObservations.height,
      title: visualNodes.title,
      summary: visualNodes.summary,
      keyPoints: visualNodes.keyPoints,
      filename: uploadedFiles.originalName,
    }).from(visualObservations)
      .innerJoin(visualNodes, eq(visualObservations.nodeId, visualNodes.id))
      .innerJoin(uploadedFiles, eq(visualObservations.fileId, uploadedFiles.id))
      .innerJoin(fileBlobs, eq(uploadedFiles.contentHash, fileBlobs.contentHash))
      .where(and(eq(visualNodes.vlmStatus, "ready"), isNull(visualNodes.deletedAt)))
      .all();
    const hits: MaterialHit[] = [];
    for (const row of rows) {
      const keyPoints = row.keyPoints ?? [];
      const primary = [row.title ?? "", row.summary ?? ""].join(" ");
      const secondary = [...keyPoints, row.filename ?? ""].join(" ");
      const matched = matchTerms(terms, primary, secondary);
      if (matched === 0) continue;
      const desc = row.title || row.summary || row.filename || "截图/照片素材";
      const size = row.width && row.height ? ` ${row.width}×${row.height}` : "";
      hits.push({
        ref: `everroom-material://${row.hash}`,
        kind: row.kind,
        desc,
        meta: `${row.kind === "screenshot" ? "截图" : "照片"}${size}`,
        rank: matched * 2 + (row.width && row.width >= 600 ? 1 : 0),
      });
    }
    return hits;
  }

  /** 网页剪藏图：clipper 资产级 VLM 摘要最全（画面类型/摘要/OCR/质量分）。 */
  private searchClipper(terms: string[]): MaterialHit[] {
    const rows = this.db.select({
      hash: clipperAssets.contentHash,
      visualKind: clipperAssets.visualKind,
      summary: clipperAssets.visualSummary,
      ocrText: clipperAssets.visualOcrText,
      keyPoints: clipperAssets.visualKeyPoints,
      altText: clipperAssets.altText,
      width: clipperAssets.width,
      height: clipperAssets.height,
      role: clipperAssets.visualContentRole,
      quality: clipperAssets.visualQuality,
      relevance: clipperAssets.visualRelevance,
      pageTitle: clipperCaptures.title,
    }).from(clipperAssets)
      .innerJoin(fileBlobs, eq(clipperAssets.contentHash, fileBlobs.contentHash))
      .leftJoin(clipperCaptures, eq(clipperAssets.captureId, clipperCaptures.id))
      .where(and(
        eq(clipperAssets.status, "stored"),
        eq(clipperAssets.visualStatus, "ready"),
        isNotNull(clipperAssets.contentHash),
      ))
      .all();
    const hits: MaterialHit[] = [];
    for (const row of rows) {
      // 噪声图（表情/二维码/广告/装饰）与无内容哈希的不作素材
      if (row.role === "noise") continue;
      const keyPoints = row.keyPoints ?? [];
      const primary = [row.summary ?? "", row.altText ?? ""].join(" ");
      const secondary = [...keyPoints, row.ocrText ?? "", row.pageTitle ?? ""].join(" ");
      const matched = matchTerms(terms, primary, secondary);
      if (matched === 0) continue;
      const desc = row.summary || row.altText || keyPoints[0] || "网页剪藏配图";
      const size = row.width && row.height ? ` ${row.width}×${row.height}` : "";
      const source = row.pageTitle ? `网页剪藏《${row.pageTitle}》` : "网页剪藏";
      hits.push({
        ref: `everroom-material://${row.hash}`,
        kind: "web-clip",
        desc,
        meta: `${source}${size}`,
        rank: matched * 2
          + (row.role === "primary" ? 2 : 0)
          + (row.relevance ?? 0) + (row.quality ?? 0) * 0.5
          + (row.width && row.width >= 600 ? 1 : 0),
      });
    }
    return hits;
  }

  /**
   * 文档内嵌图（docx/pptx/xlsx media）：按文档名聚合全部解析版本与重复导入——
   * 同一份文档可能存成多个条目/多个版本，分类摘要/标签落在一处、内嵌图落在
   * 另一处，按名取并集才能不漏；命中的文档展开其内嵌图（每文档 ≤4 张，
   * 同图只出一次）。PDF 整页渲染图与 chart XML 不作素材。
   */
  private searchDocumentAssets(terms: string[]): MaterialHit[] {
    const rows = this.db.select({
      artifact: parsedDocuments.artifact,
      filename: fileEntries.originalName,
      displayName: fileEntries.displayName,
      summary: fileClassifications.summary,
      tags: fileClassifications.tags,
    }).from(parsedDocuments)
      .innerJoin(fileVersions, eq(parsedDocuments.fileVersionId, fileVersions.id))
      .innerJoin(fileEntries, eq(fileVersions.fileEntryId, fileEntries.id))
      .leftJoin(fileClassifications, eq(fileVersions.id, fileClassifications.fileVersionId))
      .where(isNull(fileEntries.deletedAt))
      .all();

    interface DocumentAggregate {
      summaries: string[];
      tagSets: string[][];
      assets: { hash: string; pageNo: number | null }[];
    }
    const documents = new Map<string, DocumentAggregate>();
    for (const row of rows) {
      const name = row.displayName || row.filename || "";
      if (!name) continue;
      const doc = documents.get(name) ?? { summaries: [], tagSets: [], assets: [] };
      if (row.summary) doc.summaries.push(row.summary);
      if (row.tags?.length) doc.tagSets.push(row.tags);
      const assets = Array.isArray(row.artifact?.assets) ? row.artifact.assets : [];
      for (const asset of assets) {
        if (asset?.kind !== "embedded-image") continue;
        if (typeof asset.mime !== "string" || !asset.mime.startsWith("image/")) continue;
        if (typeof asset.contentHash !== "string" || !/^[a-f0-9]{64}$/.test(asset.contentHash)) continue;
        if (doc.assets.some((existing) => existing.hash === asset.contentHash)) continue;
        doc.assets.push({
          hash: asset.contentHash,
          pageNo: typeof asset.pageNo === "number" ? asset.pageNo : null,
        });
      }
      documents.set(name, doc);
    }

    const hits: MaterialHit[] = [];
    const seenHashes = new Set<string>();
    for (const [name, doc] of documents) {
      const tags = [...new Set(doc.tagSets.flat())];
      const primary = [name, ...doc.summaries].join(" ");
      const secondary = tags.join(" ");
      const matched = matchTerms(terms, primary, secondary);
      if (matched === 0) continue;
      const subject = tags[0] ?? doc.summaries[0]?.slice(0, 60) ?? "";
      let taken = 0;
      for (const asset of doc.assets) {
        if (taken >= 4 || hits.length >= 20) break;
        if (seenHashes.has(asset.hash)) continue;
        seenHashes.add(asset.hash);
        hits.push({
          ref: `everroom-material://${asset.hash}`,
          kind: "document",
          desc: subject ? `《${name}》配图（文档主题：${subject}）` : `《${name}》内嵌配图`,
          meta: `文档《${name}》${asset.pageNo ? ` 第 ${asset.pageNo} 页` : ""}`,
          rank: matched,
        });
        taken += 1;
      }
    }
    return hits;
  }
}

/** 任一词条命中即算匹配；主文本面每词权重 2、辅助面 1，返回加权命中分。
 *  排序交调用方（rank 越大越靠前），0 分 = 无任何词命中。 */
function matchTerms(terms: string[], primary: string, secondary: string): number {
  const haystackPrimary = primary.toLowerCase();
  const haystackSecondary = secondary.toLowerCase();
  let matched = 0;
  for (const term of terms) {
    if (haystackPrimary.includes(term)) matched += 2;
    else if (haystackSecondary.includes(term)) matched += 1;
  }
  return matched;
}

/** 图片魔数嗅探（读盘路径无可信 mime 时兜底判定）。 */
function sniffImageMime(buffer: Buffer): string | null {
  if (buffer.length < 12) return null;
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.subarray(0, 4).toString("ascii") === "GIF8") return "image/gif";
  if (buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (buffer[0] === 0x42 && buffer[1] === 0x4d) return "image/bmp";
  return null;
}
