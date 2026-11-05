import type { FileCatalogDto } from '@/shared/ingest'

/**
 * 「产物」口径的唯一判据（产物页与概览动态共用）。
 *
 * 产物页把这两类 sourceKind 算产物；概览动态里它们只能是 `output`，其余算 `material`。
 * 两处若各写一遍，很快会出现「产物页里有、动态里算材料」的口径漂移，所以抽成最小模块：
 * 纯常量 + 纯函数，不引 React，谁都能安全地 import（`fileBrowser.tsx` 依赖它，别反向引）。
 */
export const ARTIFACT_SOURCE_KINDS: ReadonlyArray<FileCatalogDto['sourceKind']> = [
  'agent-generated',
  'artifact-imported',
]

export function isArtifactSourceKind(kind: FileCatalogDto['sourceKind']): boolean {
  return ARTIFACT_SOURCE_KINDS.includes(kind)
}
