import { describe, expect, it } from 'vitest'

import {
  ROOM_RELATION_TYPE_COLORS,
  roomGraphLayoutDimensions,
  roomGraphLayoutOptions,
} from '../src/renderer/src/components/context-room/ported/components/roomGraphVisuals'

describe('Room graph visuals', () => {
  it('assigns a distinct stable color to every relationship type', () => {
    const colors = Object.values(ROOM_RELATION_TYPE_COLORS)

    expect(colors).toHaveLength(10)
    expect(new Set(colors).size).toBe(colors.length)
    expect(ROOM_RELATION_TYPE_COLORS.blocks).toBe(0xb65353)
    expect(ROOM_RELATION_TYPE_COLORS.supports).toBe(0x3d8557)
  })

  it('expands dense graphs and increases their node spacing', () => {
    const smallDimensions = roomGraphLayoutDimensions({
      compact: false,
      nodeCount: 4,
      relationCount: 3,
      screenHeight: 420,
      screenWidth: 640,
    })
    const denseDimensions = roomGraphLayoutDimensions({
      compact: false,
      nodeCount: 40,
      relationCount: 100,
      screenHeight: 420,
      screenWidth: 640,
    })
    const smallOptions = roomGraphLayoutOptions({ compact: false, nodeCount: 4, relationCount: 3 })
    const denseOptions = roomGraphLayoutOptions({ compact: false, nodeCount: 40, relationCount: 100 })

    expect(denseDimensions.width * denseDimensions.height)
      .toBeGreaterThan(smallDimensions.width * smallDimensions.height * 2)
    expect(denseOptions.collisionPadding).toBeGreaterThan(smallOptions.collisionPadding!)
    expect(denseOptions.linkDistance).toBeGreaterThan(smallOptions.linkDistance!)
    expect(denseOptions.manyBodyStrength).toBeLessThan(smallOptions.manyBodyStrength!)
  })

  it('keeps the compact detail-pane graph denser than the full-size home graph', () => {
    const compactDimensions = roomGraphLayoutDimensions({
      compact: true,
      nodeCount: 10,
      relationCount: 18,
      screenHeight: 420,
      screenWidth: 480,
    })
    const fullDimensions = roomGraphLayoutDimensions({
      compact: false,
      nodeCount: 10,
      relationCount: 18,
      screenHeight: 420,
      screenWidth: 640,
    })
    const compactOptions = roomGraphLayoutOptions({ compact: true, nodeCount: 10, relationCount: 18 })
    const fullOptions = roomGraphLayoutOptions({ compact: false, nodeCount: 10, relationCount: 18 })

    // 详情面板空间小：同规模图的世界面积与节点间距都比首页全图小。
    expect(compactDimensions.width * compactDimensions.height)
      .toBeLessThan(fullDimensions.width * fullDimensions.height)
    expect(compactOptions.collisionPadding!).toBeLessThan(fullOptions.collisionPadding!)
    expect(compactOptions.linkDistance!).toBeLessThan(fullOptions.linkDistance!)
    expect(compactOptions.manyBodyStrength!)
      .toBeGreaterThan(fullOptions.manyBodyStrength!)
  })
})
