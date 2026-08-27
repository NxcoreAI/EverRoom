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
})
