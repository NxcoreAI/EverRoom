/**
 * Room 归属记忆变更事件：绑定/解绑/编辑/删除/晋升成功后由发起方派发，
 * 打开中的房间据此防抖重拉归因清单（合并视图无持久条目，刷新即同步）。
 * 与 roomOverviewChange 同构：网关无推送通道，事件由发起调用的渲染层自己派发。
 */
export const ROOM_MEMORY_CHANGED_EVENT = 'nxcore:room-memory-changed'

export function dispatchRoomMemoryChanged(): void {
  window.dispatchEvent(new CustomEvent(ROOM_MEMORY_CHANGED_EVENT))
}
