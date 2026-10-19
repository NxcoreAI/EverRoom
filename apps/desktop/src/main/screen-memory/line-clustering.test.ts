import { describe, expect, it } from 'vitest'

import { blocksWithNewLines, clusterOcrLines } from './line-clustering'
import type { VisionOcrLine } from '../vision-ocr/vision-ocr-client'

const SIZE = { width: 1000, height: 1000 }

// box 为归一化坐标（原点左下）：[x, y, w, h]。
function line(text: string, x: number, y: number, w: number, h: number): VisionOcrLine {
  return { text, confidence: 0.9, box: [x, y, w, h] }
}

// 常用行尺寸：高 20px（h=0.02）。
function row(text: string, left: number, top: number, width: number): VisionOcrLine {
  return line(text, left, 1 - top - 0.02, width, 0.02)
}

describe('clusterOcrLines', () => {
  it('空输入返回空', () => {
    const frame = clusterOcrLines([], SIZE)
    expect(frame.orderedLines).toEqual([])
    expect(frame.blocks).toEqual([])
  })

  it('同一水平带且间距小的观察合并为一行：中文不加空格、中英之间加空格', () => {
    const frame = clusterOcrLines([
      row('文件', 0.01, 0.01, 0.03),
      row('Edit', 0.06, 0.01, 0.04),
      row('View', 0.12, 0.01, 0.04),
    ], SIZE)
    expect(frame.orderedLines).toEqual(['文件Edit View'])
    expect(frame.blocks).toHaveLength(1)
  })

  it('水平间距大的左右两栏不合并为一行', () => {
    const frame = clusterOcrLines([
      row('左栏标题', 0.02, 0.10, 0.10),
      row('右栏正文', 0.60, 0.10, 0.30),
    ], SIZE)
    expect(frame.orderedLines).toEqual(['左栏标题', '右栏正文'])
    expect(frame.blocks).toHaveLength(2)
  })

  it('垂直相邻、水平有重叠的行聚成一块，块内自上而下', () => {
    const frame = clusterOcrLines([
      row('第二行', 0.10, 0.121, 0.30),
      row('第一行', 0.10, 0.100, 0.30),
      row('第三行', 0.11, 0.142, 0.28),
    ], SIZE)
    expect(frame.blocks).toHaveLength(1)
    expect(frame.orderedLines).toEqual(['第一行', '第二行', '第三行'])
  })

  it('垂直间距过大断块：标题段与远处段落分开', () => {
    const frame = clusterOcrLines([
      row('段落一', 0.10, 0.10, 0.30),
      row('段落二', 0.10, 0.60, 0.30),
    ], SIZE)
    expect(frame.blocks).toHaveLength(2)
  })

  it('水平无重叠的相邻行分开（侧栏与正文各成块）', () => {
    const frame = clusterOcrLines([
      row('侧栏项', 0.00, 0.10, 0.15),
      row('正文行', 0.20, 0.105, 0.60),
    ], SIZE)
    expect(frame.blocks).toHaveLength(2)
  })

  it('并排块阅读顺序：垂直交叠大时先左后右', () => {
    const frame = clusterOcrLines([
      row('右栏A', 0.60, 0.100, 0.30),
      row('右栏B', 0.60, 0.121, 0.30),
      row('左栏1', 0.05, 0.095, 0.20),
      row('左栏2', 0.05, 0.126, 0.20),
    ], SIZE)
    expect(frame.orderedLines).toEqual(['左栏1', '左栏2', '右栏A', '右栏B'])
  })

  it('上下块阅读顺序：先上后下', () => {
    const frame = clusterOcrLines([
      row('底部块', 0.10, 0.80, 0.30),
      row('顶部块', 0.10, 0.10, 0.30),
    ], SIZE)
    expect(frame.orderedLines).toEqual(['顶部块', '底部块'])
  })

  it('行高悬殊的相邻行不并块（大标题独立成块）', () => {
    const frame = clusterOcrLines([
      line('大标题', 0.10, 1 - 0.10 - 0.06, 0.40, 0.06),
      row('正文行', 0.10, 0.175, 0.40),
    ], SIZE)
    expect(frame.blocks).toHaveLength(2)
    expect(frame.orderedLines).toEqual(['大标题', '正文行'])
  })
})

describe('blocksWithNewLines', () => {
  it('只挑包含新行的块', () => {
    const frame = clusterOcrLines([
      row('旧块一', 0.10, 0.10, 0.30),
      row('新块行', 0.10, 0.60, 0.30),
    ], SIZE)
    expect(blocksWithNewLines(frame.blocks, ['新块行'])).toEqual(['新块行'])
  })

  it('无新行返回空数组', () => {
    const frame = clusterOcrLines([row('行', 0.1, 0.1, 0.3)], SIZE)
    expect(blocksWithNewLines(frame.blocks, [])).toEqual([])
  })
})
