import { describe, expect, it, vi } from 'vitest'

import {
  DOCUMENT_IMAGE_RESIZE_OPTIONS,
  hasEmbeddedDocumentImages,
  localizeDocumentImages,
  storeDocumentImageFile,
} from '../src/renderer/src/components/context-room/ported/components/detail-editor/documentImageAssets'

describe('document image localization', () => {
  it('uses the official resizable image node view with corner handles and locked proportions', () => {
    expect(DOCUMENT_IMAGE_RESIZE_OPTIONS).toEqual({
      enabled: true,
      directions: ['top-left', 'top-right', 'bottom-left', 'bottom-right'],
      minWidth: 96,
      minHeight: 48,
      alwaysPreserveAspectRatio: true,
    })
  })

  it('validates and stores an inserted image as a local document asset', async () => {
    const file = new File([new Uint8Array([1, 2, 3])], 'diagram.png', { type: 'image/png' })
    const storeImage = vi.fn(async () => ({
      assetId: 'asset-1',
      src: 'nxcore-document-asset://doc/diagram.png',
      mimeType: 'image/png' as const,
      bytes: 3,
    }))

    await expect(storeDocumentImageFile(file, 'doc-1', storeImage)).resolves.toMatchObject({
      src: 'nxcore-document-asset://doc/diagram.png',
    })
    expect(storeImage).toHaveBeenCalledWith('doc-1', expect.objectContaining({
      fileName: 'diagram.png',
      mimeType: 'image/png',
    }))
  })

  it('replaces embedded image bytes with a local asset URL without changing other nodes', async () => {
    const storeImage = vi.fn(async () => ({
      assetId: 'asset-1',
      src: 'nxcore-document-asset://local/key/asset.png',
      mimeType: 'image/png' as const,
      bytes: 8,
    }))
    const source = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: '正文' }] },
        {
          type: 'image',
          attrs: {
            src: 'data:image/png;base64,iVBORw0KGgo=',
            alt: '示意图',
            title: null,
          },
        },
      ],
    }

    expect(hasEmbeddedDocumentImages(source)).toBe(true)
    const result = await localizeDocumentImages(source, 'doc-1', storeImage)

    expect(result).toMatchObject({ localized: 1, unsupported: 0 })
    expect(storeImage).toHaveBeenCalledWith('doc-1', expect.objectContaining({
      fileName: '示意图',
      mimeType: 'image/png',
    }))
    expect(result.content.content?.[0]).toEqual(source.content[0])
    expect(result.content.content?.[1].attrs?.src).toBe('nxcore-document-asset://local/key/asset.png')
    expect(source.content[1].attrs.src).toMatch(/^data:image\/png/)
    expect(hasEmbeddedDocumentImages(result.content)).toBe(false)
  })

  it('reports unsupported embedded images without deleting them', async () => {
    const source = {
      type: 'doc',
      content: [{ type: 'image', attrs: { src: 'data:image/svg+xml;base64,PHN2Zz4=' } }],
    }
    const result = await localizeDocumentImages(source, 'doc-1', vi.fn())
    expect(result).toEqual({ content: source, localized: 0, unsupported: 1 })
  })
})
