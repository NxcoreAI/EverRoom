import type { PlanChangePayload } from "@nxcore/agent-contract";

/** 看板实时事件：只带变更后的条目与事件，渲染层按 id upsert。 */
export type PlanStreamPayload = PlanChangePayload;

type Listener = (payload: PlanStreamPayload) => void;

/**
 * 计划变更的进程内广播（按空间分房间）。
 *
 * 只服务一个用途：`GET /v1/plan/stream` 的 SSE 订阅。刻意不复用 `AgentEventBroker`
 * （那是按 sessionId 的房间，看板吃的是"这个空间所有任务"），也不做持久化——
 * 丢一条事件不影响一致性：渲染层 30s 兜底轮询会补齐。
 */
export class PlanStreamHub {
  private readonly rooms = new Map<string, Set<Listener>>();

  subscribe(workspaceId: string, listener: Listener): () => void {
    const room = this.rooms.get(workspaceId) ?? new Set<Listener>();
    room.add(listener);
    this.rooms.set(workspaceId, room);
    return () => {
      room.delete(listener);
      if (room.size === 0) this.rooms.delete(workspaceId);
    };
  }

  publish(payload: PlanStreamPayload): void {
    const room = this.rooms.get(payload.workspaceId);
    if (!room) return;
    for (const listener of room) {
      try {
        listener(payload);
      } catch {
        // 单个订阅者写失败（客户端已断开）不影响其它订阅者。
      }
    }
  }

  /** 当前订阅数（调试 / 健康检查用）。 */
  listenerCount(workspaceId?: string): number {
    if (workspaceId) return this.rooms.get(workspaceId)?.size ?? 0;
    let total = 0;
    for (const room of this.rooms.values()) total += room.size;
    return total;
  }
}
