import { useCallback, useEffect, useRef, useState } from 'react';
import type { KnowledgeFileDto } from '../../../../../../shared/knowledge';

/**
 * Room 的 knowledge 上传文件清单（uploaded_files ⨝ 最新归属决策）。
 * knowledge 服务可选：不可用/失败时静默降级为空清单。
 * 刷新：roomId 变化首载 + 监听全局 DOM 事件 'everroom:knowledge-changed'
 * （上传/晋升/挂载完成时各面板 dispatch）；事件后追加一次尾随刷新，
 * 兜住"上传 202 返回早于路由决策落库"的异步窗口。
 */
export function useRoomKnowledgeFiles(roomId: string): {
  files: KnowledgeFileDto[];
  refresh: () => Promise<void>;
} {
  const [files, setFiles] = useState<KnowledgeFileDto[]>([]);
  const roomIdRef = useRef(roomId);
  roomIdRef.current = roomId;

  const refresh = useCallback(async () => {
    const knowledge = window.nxcore?.knowledge;
    if (!knowledge) return;
    try {
      const { items } = await knowledge.listRoomFiles(roomIdRef.current);
      setFiles(items);
    } catch {
      // knowledge 可选：Room 无归属文件/服务未就绪都视为空清单
    }
  }, []);

  useEffect(() => {
    setFiles([]);
    void refresh();
  }, [roomId, refresh]);

  useEffect(() => {
    const onKnowledgeChanged = () => {
      void refresh();
      // 尾随刷新：路由决策异步落库（wake→drain 毫秒级窗口），立即刷新可能仍读到旧归属
      window.setTimeout(() => void refresh(), 800);
    };
    window.addEventListener('everroom:knowledge-changed', onKnowledgeChanged);
    return () => window.removeEventListener('everroom:knowledge-changed', onKnowledgeChanged);
  }, [refresh]);

  return { files, refresh };
}
