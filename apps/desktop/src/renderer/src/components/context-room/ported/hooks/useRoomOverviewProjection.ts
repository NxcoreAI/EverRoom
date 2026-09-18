import { useEffect, useState } from 'react';
import type { RoomOverviewProjection } from '@nxcore/agent-contract';
import {
  preferRoomOverviewProjection,
  ROOM_OVERVIEW_CHANGED_EVENT,
  type RoomOverviewChangedDetail,
} from '../../roomOverviewChange';

/**
 * 概览投影（确定性日历/待办 claim 的数据源）：初次拉取 + 投影变更事件刷新。
 * 概览仪表盘、动态时间轴、日程/待办面板共用；投影不可用时保持 null，
 * 调用方回退本地快照视图。node 测试环境无 window 同样保持 null。
 */
export function useRoomOverviewProjection(roomId: string) {
  const [projection, setProjection] = useState<RoomOverviewProjection | null>(null);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    let cancelled = false;
    const load = async () => {
      const api = window.nxcore?.contextRooms;
      if (!api?.overview) return;
      try {
        const next = await api.overview(roomId);
        if (!cancelled) setProjection((current) => preferRoomOverviewProjection(current, next));
      } catch {
        // 投影不可用时维持本地快照视图（面板仍有兜底数据）
      }
    };
    void load();
    const refresh = (event: Event) => {
      const detail = (event as CustomEvent<RoomOverviewChangedDetail>).detail;
      if (detail?.roomId && detail.roomId !== roomId) return;
      const next = detail?.projection;
      if (next) {
        setProjection((current) => preferRoomOverviewProjection(current, next));
        return;
      }
      void load();
    };
    window.addEventListener(ROOM_OVERVIEW_CHANGED_EVENT, refresh as EventListener);
    return () => {
      cancelled = true;
      window.removeEventListener(ROOM_OVERVIEW_CHANGED_EVENT, refresh as EventListener);
    };
  }, [roomId]);
  return projection;
}
