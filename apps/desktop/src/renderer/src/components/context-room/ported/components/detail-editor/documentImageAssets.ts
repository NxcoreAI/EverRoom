import type { TiptapJsonContent } from '@nxcore/agent-contract'
import { hasEmbeddedDocumentImages } from '@nxcore/document-model'
import type { ImageOptions } from '@tiptap/extension-image'
import i18n from '@/i18n/i18next'
import type {
  DocumentImageMimeType,
  StoreDocumentImageInput,
  StoredDocumentImage,
} from '../../../../../../../shared/sources'

const EMBEDDED_IMAGE = /^data:(image\/(?:avif|gif|jpeg|png|webp));base64,([a-z0-9+/=\s]+)$/i

export const DOCUMENT_IMAGE_MAX_BYTES = 20 * 1024 * 1024
export const DOCUMENT_IMAGE_ACCEPT = 'image/png,image/jpeg,image/gif,image/webp,image/avif'
export const DOCUMENT_IMAGE_MIME_TYPES: ReadonlySet<string> = new Set(
  DOCUMENT_IMAGE_ACCEPT.split(','),
)
export const DOCUMENT_IMAGE_RESIZE_OPTIONS: Exclude<ImageOptions['resize'], false> = {
  enabled: true,
  directions: ['top', 'right', 'bottom', 'left', 'top-left', 'top-right', 'bottom-left', 'bottom-right'],
  minWidth: 96,
  minHeight: 48,
  alwaysPreserveAspectRatio: false,
}

export type StoreDocumentImage = (
  documentId: string,
  input: StoreDocumentImageInput,
) => Promise<StoredDocumentImage>

function decodeBase64(value: string): ArrayBuffer {
  const decoded = atob(value.replace(/\s/g, ''))
  const bytes = new Uint8Array(decoded.length)
  for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index)
  return bytes.buffer
}

function embeddedImage(src: unknown): {
  mimeType: DocumentImageMimeType
  bytes: ArrayBuffer
} | null {
  if (typeof src !== 'string') return null
  const match = EMBEDDED_IMAGE.exec(src)
  if (!match) return null
  try {
    return {
      mimeType: match[1].toLowerCase() as DocumentImageMimeType,
      bytes: decodeBase64(match[2]),
    }
  } catch {
    return null
  }
}

export { hasEmbeddedDocumentImages }

export async function storeDocumentImageFile(
  file: File,
  documentId: string,
  storeImage: StoreDocumentImage,
): Promise<StoredDocumentImage> {
  if (!DOCUMENT_IMAGE_MIME_TYPES.has(file.type)) throw new Error(i18n.t('contextRoom:documentImage.selectSupportedImage'))
  if (!file.size) throw new Error(i18n.t('contextRoom:documentImage.imageIsEmpty'))
  if (file.size > DOCUMENT_IMAGE_MAX_BYTES) throw new Error(i18n.t('contextRoom:documentImage.imageTooLarge'))
  return storeImage(documentId, {
    fileName: file.name,
    mimeType: file.type as DocumentImageMimeType,
    bytes: await file.arrayBuffer(),
  })
}

export async function localizeDocumentImages(
  content: TiptapJsonContent,
  documentId: string,
  storeImage: StoreDocumentImage,
): Promise<{ content: TiptapJsonContent; localized: number; unsupported: number }> {
  let localized = 0
  let unsupported = 0

  const visit = async (node: TiptapJsonContent): Promise<TiptapJsonContent> => {
    let next = node
    if (node.type === 'image' && typeof node.attrs?.src === 'string' && node.attrs.src.startsWith('data:image/')) {
      const image = embeddedImage(node.attrs.src)
      if (!image) {
        unsupported += 1
      } else {
        const stored = await storeImage(documentId, {
          fileName: typeof node.attrs.alt === 'string' ? node.attrs.alt : 'image',
          mimeType: image.mimeType,
          bytes: image.bytes,
        })
        localized += 1
        next = { ...node, attrs: { ...node.attrs, src: stored.src } }
      }
    }
    if (!next.content?.length) return next
    return { ...next, content: await Promise.all(next.content.map(visit)) }
  }

  return { content: await visit(content), localized, unsupported }
}
