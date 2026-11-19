import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type { GatewayDatabase } from "../../infrastructure/database/client.js";
import { sniffImageMime } from "../../infrastructure/image-mime.js";
import { contentHashOf, storageRelPath, storeFileBlob } from "../files/storage.js";
import { fileBlobs } from "../../infrastructure/database/schema.js";

/**
 * 幻灯片图片对象库（原 MaterialsService 的存/取两半，随素材检索体系退役迁入
 * slides-style）：生图产物与文档内嵌图按内容哈希寻址，服务
 * `everroom-material://<hash>` 引用与 `GET /v1/materials/:hash` 回源。
 *
 * 检索面（截图/剪藏/文档图关键词搜索）属记忆与 Context Room，已随 Phase 2 删除；
 * 这里只保留字节存取，是 Office 配色/配图链路的一部分。
 */
export class SlideImageStore {
  constructor(
    private readonly db: GatewayDatabase,
    private readonly dataDir: string,
  ) {}

  /** 存图片字节进对象库（CAS + file_blobs 行，幂等）：生图产物（风格纵览/演示页）
   *  不走 file-imports——那条通道的白名单只有文档格式，图片本来就不进文件库，
   *  图片体系按内容哈希寻址即可。返回 hash 供 everroom-material:// 引用。 */
  async saveImageBlob(buffer: Buffer, mime: string): Promise<{ contentHash: string }> {
    if (!mime.startsWith("image/") || buffer.byteLength === 0) {
      throw new Error("仅接受非空图片数据");
    }
    const contentHash = contentHashOf(buffer);
    await storeFileBlob(this.dataDir, contentHash, buffer);
    this.db.insert(fileBlobs).values({
      contentHash,
      storagePath: storageRelPath(contentHash),
      byteSize: buffer.byteLength,
      mime,
      createdAt: new Date(),
    }).onConflictDoNothing().run();
    return { contentHash };
  }

  /** 按内容哈希取图：file_blobs（生图产物/上传图）优先，回退 document-artifacts（文档内嵌图）。 */
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
}
