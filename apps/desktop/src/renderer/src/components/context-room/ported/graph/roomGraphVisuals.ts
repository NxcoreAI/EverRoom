import type { KnowledgeRoomRelationDto } from '../../../../../../shared/knowledge'
import type { ForceGraphOptions } from './forceGraphProtocol'

type RoomRelationType = KnowledgeRoomRelationDto['type']

export const ROOM_RELATION_TYPE_COLORS: Record<RoomRelationType, number> = {
  shared_evidence: 0x4678bd,
  shared_entity: 0x278679,
  mixed: 0x755daf,
  related: 0x63758b,
  depends_on: 0xac7629,
  part_of: 0x347f9f,
  supports: 0x3d8557,
  blocks: 0xb65353,
  owns: 0x985a82,
  custom: 0x9a673d,
}

export function roomRelationTypeColor(type: RoomRelationType): number {
  return ROOM_RELATION_TYPE_COLORS[type]
}

export function roomGraphLayoutOptions({
  compact,
  nodeCount,
  relationCount,
}: {
  compact: boolean
  nodeCount: number
  relationCount: number
}): Partial<ForceGraphOptions> {
  const averageDegree = nodeCount > 0 ? (relationCount * 2) / nodeCount : 0
  const density = Math.min(1, Math.max(0, averageDegree / 6))
  const scale = Math.min(1, Math.max(0, (nodeCount - 6) / 36))

  return compact
    ? {
        centerStrength: 0.024,
        collisionPadding: Math.round(18 + scale * 10),
        collisionStrength: 0.82,
        degreeBias: 1,
        linkDistance: Math.round(148 + scale * 28 + density * 20),
        linkStrength: 0.16,
        manyBodyStrength: -Math.round(165 + scale * 80 + density * 55),
        velocityDecay: 0.59,
      }
    : {
        centerStrength: 0.018,
        collisionPadding: Math.round(26 + scale * 12),
        collisionStrength: 0.88,
        degreeBias: 1,
        linkDistance: Math.round(182 + scale * 42 + density * 28),
        linkStrength: 0.15,
        manyBodyStrength: -Math.round(230 + scale * 120 + density * 80),
        velocityDecay: 0.59,
      }
}

export function roomGraphLayoutDimensions({
  compact,
  nodeCount,
  relationCount,
  screenHeight,
  screenWidth,
}: {
  compact: boolean
  nodeCount: number
  relationCount: number
  screenHeight: number
  screenWidth: number
}): { height: number; width: number } {
  const safeWidth = Math.max(1, screenWidth)
  const safeHeight = Math.max(1, screenHeight)
  const aspectRatio = Math.min(2, Math.max(1, safeWidth / safeHeight))
  const averageDegree = nodeCount > 0 ? (relationCount * 2) / nodeCount : 0
  const edgePressure = 1 + Math.min(0.7, averageDegree * 0.075)
  const spacing = compact ? 154 : 194
  const targetArea = Math.max(1, nodeCount) * spacing * spacing * edgePressure
  const targetWidth = Math.sqrt(targetArea * aspectRatio)
  const targetHeight = targetWidth / aspectRatio

  return {
    height: Math.min(3200, Math.max(safeHeight, Math.round(targetHeight))),
    width: Math.min(3200, Math.max(safeWidth, Math.round(targetWidth))),
  }
}
