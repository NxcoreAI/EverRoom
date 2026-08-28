import { useCallback, useEffect, useRef, useState } from 'react';
import type { RoomMail } from '@nxcore/agent-contract';

/**
 * Room 邮箱面板的连接器邮件清单（GET /v1/context-rooms/:roomId/mails，sentAt 倒序）。
 * 邮件与日程同链路由路由引擎自动归类；此 hook 只负责展示层拉取。
 * 刷新：roomId 变化首载 + 监听全局 DOM 事件 'everroom:knowledge-changed'
 * （连接器同步/路由决策落库时各面板 dispatch）；事件后追加一次尾随刷新，
 * 兜住"同步完成早于路由决策落库"的异步窗口。失败时静默降级为空清单。
 */
export function useRoomMails(roomId: string): {
  mails: RoomMail[];
  refresh: () => Promise<void>;
} {
  const [mails, setMails] = useState<RoomMail[]>([]);
  const roomIdRef = useRef(roomId);
  roomIdRef.current = roomId;

  const refresh = useCallback(async () => {
    // node 测试环境无 window：保持空清单，面板回退本地快照视图
    if (typeof window === 'undefined') return;
    const contextRooms = window.nxcore?.contextRooms;
    if (!contextRooms) return;
    try {
      const { items } = await contextRooms.listMails(roomIdRef.current);
      setMails(items);
    } catch {
      // 邮件为连接器可选数据：Room 无归属邮件/网关未就绪都视为空清单
    }
  }, []);

  useEffect(() => {
    setMails([]);
    void refresh();
  }, [roomId, refresh]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onKnowledgeChanged = () => {
      void refresh();
      // 尾随刷新：连接器同步与路由决策落库之间存在秒级窗口，立即刷新可能仍读到旧归属
      window.setTimeout(() => void refresh(), 1500);
    };
    window.addEventListener('everroom:knowledge-changed', onKnowledgeChanged);
    return () => window.removeEventListener('everroom:knowledge-changed', onKnowledgeChanged);
  }, [refresh]);

  return { mails, refresh };
}
