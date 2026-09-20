import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  EmergenceProjectionResultDto,
  FocusMindmapStatus,
  FocusMindmapScope,
} from '../../../../../../shared/knowledge';

export interface UseFocusMindmapOptions {
  roomId: string;
  /** 打开的文档 id；null = Room 级导图。选区/章节不参与（一期不做焦点变化重生成）。 */
  documentId: string | null;
}

const POLL_INTERVAL_MS = 4000;

/**
 * 聚焦思维导图取数（思路板块聚焦模式）：
 * - scope 仅由 roomId/documentId 决定；身份变化 → requestVersion++ 重 GET（GET 无行懒 kick）；
 * - pending/processing 期间 4s 轮询（WikiPane 模式），ready/failed 停；
 * - requestVersion 守卫丢弃迟到旧响应；projection 只在 ready 时替换，
 *   切换期间保留旧值（UI 按 status 走骨架屏，不闪空）；
 * - retry=失败重试（ensure），regenerate=ready 强制重生成（ensure force）。
 */
export function useFocusMindmap({ roomId, documentId }: UseFocusMindmapOptions) {
  const scope: FocusMindmapScope = documentId ? 'document' : 'room';
  const [status, setStatus] = useState<FocusMindmapStatus | 'idle'>('idle');
  const [projection, setProjection] = useState<EmergenceProjectionResultDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const versionRef = useRef(0);
  const identityRef = useRef<string | null>(null);

  const fetchStatus = useCallback(async (): Promise<FocusMindmapStatus | null> => {
    const knowledge = window.nxcore?.knowledge;
    if (!knowledge) return null;
    try {
      const data = await knowledge.focusMindmap(roomId, {
        scope,
        documentId,
        requestVersion: versionRef.current,
      });
      if (data.requestVersion !== versionRef.current) return null;
      setStatus(data.status);
      setError(data.error);
      if (data.status === 'ready' && data.projection) setProjection(data.projection);
      return data.status;
    } catch (cause) {
      setStatus('failed');
      setError(cause instanceof Error ? cause.message : String(cause));
      return 'failed';
    }
  }, [roomId, scope, documentId]);

  // scope 身份变化：新版本号 + 立即 GET（旧投影保留在新 ready 前不替换）。
  useEffect(() => {
    const identity = `${roomId}:${scope}:${documentId ?? ''}`;
    if (identityRef.current === identity) return;
    identityRef.current = identity;
    versionRef.current += 1;
    void fetchStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, scope, documentId]);

  // 生成中轮询：ready/failed 停；轮询响应同样过版本守卫。
  useEffect(() => {
    if (status !== 'pending' && status !== 'processing') return;
    const timer = window.setInterval(() => { void fetchStatus(); }, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [status, fetchStatus]);

  const kick = useCallback(async (force: boolean) => {
    const knowledge = window.nxcore?.knowledge;
    if (!knowledge) return;
    versionRef.current += 1;
    const requestVersion = versionRef.current;
    setStatus('processing');
    try {
      const data = await knowledge.ensureFocusMindmap(roomId, {
        scope,
        documentId,
        ...(force ? { force: true } : {}),
        requestVersion,
      });
      if (data.requestVersion !== versionRef.current) return;
      setStatus(data.status);
      setError(data.error);
      if (data.status === 'ready' && data.projection) setProjection(data.projection);
    } catch (cause) {
      if (requestVersion === versionRef.current) {
        setStatus('failed');
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    }
  }, [roomId, scope, documentId]);

  return {
    scope,
    status,
    projection,
    generating: status === 'pending' || status === 'processing' || status === 'idle',
    failed: status === 'failed',
    error,
    retry: useCallback(() => { void kick(false); }, [kick]),
    regenerate: useCallback(() => { void kick(true); }, [kick]),
  };
}
