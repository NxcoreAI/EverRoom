import { beforeEach, describe, expect, it, vi } from 'vitest'

const encode = { png: Buffer.alloc(1000), jpeg: Buffer.alloc(1000) }
const decoded = {
  getSize: () => ({ width: 4000, height: 3000 }),
  resize: vi.fn(() => ({
    toPNG: () => encode.png,
    toJPEG: () => encode.jpeg,
  })),
}
vi.mock('electron', () => ({
  nativeImage: {
    createFromBuffer: vi.fn(() => decoded),
  },
}))

import { compressForEmbed } from '../src/main/office/office-material-resolver'

const limits = { maxEdge: 2560, thresholdBytes: 300 * 1024 }

describe('compressForEmbed：嵌入前压缩口径', () => {
  beforeEach(() => decoded.resize.mockClear())

  it('小于阈值与 gif 原样返回（不解码）', () => {
    const small = new Uint8Array(1024)
    expect(compressForEmbed(small, 'jpg', limits).bytes).toBe(small)
    const gif = new Uint8Array(500 * 1024)
    expect(compressForEmbed(gif, 'gif', limits).bytes).toBe(gif)
  })

  it('大图超边降采样并重编码：按长边比例缩到上限，JPEG 体积小于原图才采用', () => {
    const big = new Uint8Array(3 * 1024 * 1024)
    const out = compressForEmbed(big, 'jpg', limits)
    expect(decoded.resize).toHaveBeenCalledWith({ width: Math.round((4000 * 2560) / 4000) })
    expect(out.bytes.byteLength).toBe(1000)
    expect(out.ext).toBe('jpg')
  })

  it('PNG 保 PNG（logo 透明不丢）', () => {
    const big = new Uint8Array(3 * 1024 * 1024)
    expect(compressForEmbed(big, 'png', limits).ext).toBe('png')
  })
})
