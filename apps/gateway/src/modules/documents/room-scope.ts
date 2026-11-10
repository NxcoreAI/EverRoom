import { WORKSPACE_DOCUMENT_CHANNEL } from "@nxcore/agent-contract";

/**
 * 把「可空 Room 归属」归一为旧接口需要的非空 scope id（P0-2）。
 *
 * 索引、摄取、事件总线、块引用等既有管线以「一个非空 scope 字符串」为分区键：
 * 工作区级文稿（roomId 为 null）统一落到 WORKSPACE_DOCUMENT_CHANNEL，
 * 从而不必改写这些管线，也不会为无房文稿伪造 Room 记录。
 */
export function roomScopeId(roomId: string | null): string {
  return roomId ?? WORKSPACE_DOCUMENT_CHANNEL;
}
