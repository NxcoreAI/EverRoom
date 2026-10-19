/**
 * 「进入 Room 产物库后自动展开新建产物面板」的一次性意图。
 *
 * 文稿页「+新建文档」选完 Room 后登记该意图，产物库挂载时消费并自动展开
 * 「+新建产物」面板（直接停在创建类型选择界面）。导航要穿过 App → PageCanvas →
 * ContextRoomPage → PortedContextRoom → PortedDetail → WorkspaceLayout →
 * WorkspacePaneBody 多层，且产物库在导航之后才挂载，故用模块级待办承载
 * 「先登记、后挂载」的时序，不必逐层透传 prop。
 */
let pendingRoomId: string | null = null

export function requestArtifactCreateIntent(roomId: string): void {
  pendingRoomId = roomId
}

/**
 * 消费意图：仅当目标 Room 匹配时返回 true。
 * 无论是否匹配都会清空待办——意图只对紧随其后的一次导航有效，避免陈旧意图
 * （用户中途改点别的 Room）在之后误触发。
 */
export function consumeArtifactCreateIntent(roomId: string): boolean {
  const matched = pendingRoomId === roomId
  pendingRoomId = null
  return matched
}
