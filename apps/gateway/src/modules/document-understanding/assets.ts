import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import JSZip from "jszip";
import type { CanonicalDocumentAsset } from "./types.js";

const MIME_BY_EXTENSION: Record<string, string> = {
  ".bmp": "image/bmp",
  ".emf": "image/emf",
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".webp": "image/webp",
  ".wmf": "image/wmf",
  ".xml": "application/xml",
};
const MAX_ASSETS_PER_DOCUMENT = 200;
const MAX_ASSET_BYTES = 20 * 1024 * 1024;

function safeExtension(sourceRef: string, mime: string): string {
  const extension = extname(sourceRef).toLowerCase();
  if (/^\.[a-z0-9]{1,8}$/.test(extension)) return extension;
  if (mime === "image/png") return ".png";
  if (mime === "application/xml") return ".xml";
  return ".bin";
}

export async function storeDocumentAsset(
  dataDir: string,
  buffer: Buffer,
  input: {
    kind: CanonicalDocumentAsset["kind"];
    pageNo: number | null;
    mime: string;
    sourceRef: string;
  },
): Promise<CanonicalDocumentAsset> {
  const contentHash = createHash("sha256").update(buffer).digest("hex");
  const extension = safeExtension(input.sourceRef, input.mime);
  const storageRef = `document-artifacts/sha256/${contentHash.slice(0, 2)}/${contentHash}${extension}`;
  const directory = join(dataDir, "document-artifacts", "sha256", contentHash.slice(0, 2));
  await mkdir(directory, { recursive: true });
  await writeFile(join(dataDir, storageRef), buffer, { flag: "wx" }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  return {
    id: `asset-${input.kind}-${contentHash.slice(0, 12)}`,
    kind: input.kind,
    pageNo: input.pageNo,
    mime: input.mime,
    contentHash,
    storageRef,
    sourceRef: input.sourceRef,
  };
}

function slideNumberOf(path: string): number | null {
  const value = /ppt\/slides\/slide(\d+)\.xml/.exec(path)?.[1];
  return value ? Number(value) : null;
}

async function pptAssetPages(zip: JSZip, target: string): Promise<number[]> {
  const pages: number[] = [];
  const relationFiles = Object.keys(zip.files).filter((path) => /^ppt\/slides\/_rels\/slide\d+\.xml\.rels$/.test(path));
  for (const relationPath of relationFiles) {
    const xml = await zip.file(relationPath)?.async("string");
    if (!xml) continue;
    const normalizedTarget = target.replace(/^ppt\//, "../");
    if (xml.includes(`Target="${normalizedTarget}"`) || xml.includes(`Target='${normalizedTarget}'`)) {
      const pageNo = slideNumberOf(relationPath.replace("/_rels/", "/").replace(".xml.rels", ".xml"));
      if (pageNo !== null) pages.push(pageNo);
    }
  }
  return [...new Set(pages)].sort((a, b) => a - b);
}

export async function extractOoxmlAssets(
  buffer: Buffer,
  format: "docx" | "xlsx" | "pptx",
  dataDir: string,
): Promise<CanonicalDocumentAsset[]> {
  const zip = await JSZip.loadAsync(buffer);
  const mediaPrefix = format === "docx" ? "word/media/" : format === "xlsx" ? "xl/media/" : "ppt/media/";
  const chartPrefix = format === "docx" ? "word/charts/" : format === "xlsx" ? "xl/charts/" : "ppt/charts/";
  const paths = Object.keys(zip.files).filter((path) =>
    !zip.files[path]!.dir && (path.startsWith(mediaPrefix) || /^.+\/charts\/chart\d+\.xml$/.test(path)))
    .slice(0, MAX_ASSETS_PER_DOCUMENT);
  const assets: CanonicalDocumentAsset[] = [];
  for (const path of paths) {
    const entry = zip.file(path);
    if (!entry) continue;
    const bytes = Buffer.from(await entry.async("uint8array"));
    if (bytes.byteLength > MAX_ASSET_BYTES) continue;
    const kind = path.startsWith(chartPrefix) ? "chart" as const : "embedded-image" as const;
    const mime = kind === "chart" ? "application/xml" : MIME_BY_EXTENSION[extname(path).toLowerCase()] ?? "application/octet-stream";
    const pages = format === "pptx" ? await pptAssetPages(zip, path) : [];
    const pageNumbers: Array<number | null> = pages.length > 0 ? pages : [null];
    for (const pageNo of pageNumbers) {
      const asset = await storeDocumentAsset(dataDir, bytes, { kind, pageNo, mime, sourceRef: path });
      assets.push({
        ...asset,
        id: pageNo === null ? asset.id : `${asset.id}-page-${pageNo}`,
      });
    }
  }
  return assets;
}
