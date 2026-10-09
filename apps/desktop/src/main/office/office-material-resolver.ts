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
        return { bytes: new Uint8Array(content.buffer), ext: extOfImageMime(content.mime) }
      } catch {
        return null
      }
    },
  }
}
