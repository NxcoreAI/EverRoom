import { nativeImage } from 'electron'
import type { FilesGatewayBridge } from '../gateway/files-gateway-bridge'
import type { GenOfficeMaterialResolver } from './office-runtime'

const MATERIAL_REF = /^everroom-material:\/\/([a-f0-9]{64})$/

/** mime → 媒体扩展名（与 genoffice fetchImage 的 ext 词表一致）。 */
function extOfImageMime(mime: string): string {
  if (/png/.test(mime)) return 'png'
  if (/gif/.test(mime)) return 'gif'
  if (/webp/.test(mime)) return 'webp'
  if (/bmp/.test(mime)) return 'bmp'
  return 'jpg'
}

/** 画布 1280 宽：嵌入图最长边超过 2×（Retina 余量）已无显示收益，只贡献体积。 */
const MAX_EMBED_EDGE = 2560
/** 小于阈值的图（图标、小 logo）不值得重编码，原样嵌入。 */
const COMPRESS_THRESHOLD_BYTES = 300 * 1024

/**
 * 嵌入前压缩：素材库原图（相机原图 3~8MB）直嵌曾把 deck 撑到 39MB+、打开要 30s+。
 * 超过阈值的大图降采样到 2560 边并重编码（照片类 JPEG q82；PNG 保 PNG——logo 可能
 * 带透明，转 JPEG 会丢 alpha）。压完反而更大（少见）或解码失败时保留原图。
 */
export function compressForEmbed(
  bytes: Uint8Array,
  ext: string,
  limits: { maxEdge: number; thresholdBytes: number } = { maxEdge: MAX_EMBED_EDGE, thresholdBytes: COMPRESS_THRESHOLD_BYTES },
): { bytes: Uint8Array; ext: string } {
  if (bytes.byteLength <= limits.thresholdBytes) return { bytes, ext }
  if (ext === 'gif') return { bytes, ext }
  try {
    let image = nativeImage.createFromBuffer(Buffer.from(bytes))
    const size = image.getSize()
    if (size.width <= 0 || size.height <= 0) return { bytes, ext }
    const longest = Math.max(size.width, size.height)
    if (longest > limits.maxEdge) {
      image = image.resize({ width: Math.max(1, Math.round((size.width * limits.maxEdge) / longest)) })
    }
    const encoded = ext === 'png' ? image.toPNG() : image.toJPEG(82)
    if (encoded.byteLength >= bytes.byteLength) return { bytes, ext }
    return { bytes: new Uint8Array(encoded), ext: ext === 'png' ? 'png' : 'jpg' }
  } catch {
    return { bytes, ext }
  }
}

/**
 * everroom-material:// 素材回源器：hash 命中本地网关 /v1/materials/:hash。
 * 任何失败（无桥/网络/404/非图片）都返回 null → 引擎按图片下载失败跳过该图。
 */
export function createEverroomMaterialResolver(
  filesBridge: () => FilesGatewayBridge | null,
): GenOfficeMaterialResolver {
  return {
    resolveMaterial: async (url) => {
      const match = MATERIAL_REF.exec(url)
      if (!match) return null
      const files = filesBridge()
      if (!files) return null
      try {
        const content = await files.readMaterial(match[1]!)
        if (!content) return null
        return compressForEmbed(new Uint8Array(content.buffer), extOfImageMime(content.mime))
      } catch {
        return null
      }
    },
  }
}
