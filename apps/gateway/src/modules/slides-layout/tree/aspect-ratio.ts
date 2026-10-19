/**
 * 图片长宽比解析：编译期尽力而为（material:// 读 blob 头；http 拉 64KB 超时跳过）。
 * 取不到只跳过该叶子的失配缺陷检测——不变形不变式由编译器显式 fit 保证，与此无关。
 */

export interface ArDeps {
  /** everroom-material:// 的 hash → 原始字节（网关侧读 file_blobs）。 */
  readMaterialBlob(hash: string): Promise<Uint8Array | null>;
  /** http(s) url → 头部字节（约 64KB；超时/失败返回 null）。 */
  fetchHead(url: string): Promise<Uint8Array | null>;
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

export function pngDimensions(bytes: Uint8Array): { w: number; h: number } | null {
  if (bytes.length < 24) return null;
  for (let i = 0; i < PNG_SIG.length; i++) {
    if (bytes[i] !== PNG_SIG[i]) return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const w = view.getUint32(16);
  const h = view.getUint32(20);
  if (w <= 0 || h <= 0) return null;
  return { w, h };
}

export function jpegDimensions(bytes: Uint8Array): { w: number; h: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1]!;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = view.getUint16(offset + 2);
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      const h = view.getUint16(offset + 5);
      const w = view.getUint16(offset + 7);
      if (w > 0 && h > 0) return { w, h };
      return null;
    }
    if (length < 2) return null;
    offset += 2 + length;
  }
  return null;
}

export function imageDimensions(bytes: Uint8Array): { w: number; h: number } | null {
  return pngDimensions(bytes) ?? jpegDimensions(bytes);
}

const MATERIAL_URL = /^everroom-material:\/\/([0-9a-f]{64})$/i;

export async function resolveImageAr(url: string, deps: ArDeps): Promise<number | null> {
  const material = MATERIAL_URL.exec(url);
  let bytes: Uint8Array | null = null;
  if (material) {
    bytes = await deps.readMaterialBlob(material[1]!.toLowerCase());
  } else if (/^https?:\/\//i.test(url)) {
    bytes = await deps.fetchHead(url);
  } else {
    return null;
  }
  if (!bytes) return null;
  const dims = imageDimensions(bytes);
  if (!dims) return null;
  return dims.w / dims.h;
}

/** 批量解析并只保留成功项（Map 里没有的 url = 长宽比未知）。 */
export async function resolveImageArs(urls: string[], deps: ArDeps): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  await Promise.all(
    urls.map(async (url) => {
      const ar = await resolveImageAr(url, deps);
      if (ar !== null) map.set(url, ar);
    }),
  );
  return map;
}
