import { useCallback, useEffect, useRef, useState } from 'react';

import type { RouteMindmapStatusDto } from '../../../../../../shared/knowledge';

export interface UseRouteMindmapOptions {
  roomId: string;
  /** 打开的新文档 id；null = 面板空态（不取数）。 */
  documentId: string | null;
}

const POLL_INTERVAL_MS = 1500;

/**
 * 写作路线导图取数（聚焦改版 2026-09）：
 * - 身份（roomId+documentId）变化 → requestVersion++ 重 GET，迟到旧响应丢弃；
 * - expanding（生成中）/writing（拍板写正文）1.5s 轮询，其余状态停；
 * - 五动作走单通道：start/expand/back/skip/finalize，响应即新状态；
 * - 动作被网关拒（busy/finalized 等）时置 actionError，下一次成功动作清除；
 *   failed 状态的 retry=start（网关按图与 expandingNodeRef 决定重派哪层）。
 */
export function useRouteMindmap({ roomId, documentId }: UseRouteMindmapOptions) {
  const [view, setView] = useState<RouteMindmapStatusDto | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const versionRef = useRef(0);
  const identityRef = useRef<string | null>(null);
  const latestRef = useRef<RouteMindmapStatusDto | null>(null);

  const apply = useCallback((data: RouteMindmapStatusDto) => {
    if (data.requestVersion !== versionRef.current) return;
    latestRef.current = data;
    setView(data);
  }, []);

  const refresh = useCallback(async (): Promise<RouteMindmapStatusDto | null> => {
    const knowledge = window.nxcore?.knowledge;
    if (!knowledge || !documentId) return null;
    try {
      const data = await knowledge.getRouteMindmap(roomId, {
        documentId,
        requestVersion: versionRef.current,
      });
      apply(data);
      return data;
    } catch {
      return null;
    }
  }, [roomId, documentId, apply]);

  // 身份变化：新版本号 + 立即 GET（旧图保留到新响应到达）。
  useEffect(() => {
    const identity = `${roomId}:${documentId ?? ''}`;
    if (identityRef.current === identity) return;
    identityRef.current = identity;
    versionRef.current += 1;
    latestRef.current = null;
    setView(null);
    setActionError(null);
    if (documentId) void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, documentId]);

  // 生成/写正文轮询：其余状态停；轮询响应同样过版本守卫。
  const busy = view?.status === 'expanding' || view?.writing === true;
  useEffect(() => {
    if (!busy) return;
    const timer = window.setInterval(() => { void refresh(); }, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [busy, refresh]);

  const act = useCallback(async (input: {
    action: 'start' | 'expand' | 'back' | 'skip' | 'finalize';
    title?: string;
    description?: string | null;
    nodeRef?: string;
    toDepth?: number;
  }) => {
    const knowledge = window.nxcore?.knowledge;
    if (!knowledge || !documentId) return;
    versionRef.current += 1;
    try {
      const data = await knowledge.routeMindmapAction(roomId, {
        action: input.action,
        documentId,
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.nodeRef !== undefined ? { nodeRef: input.nodeRef } : {}),
        ...(input.toDepth !== undefined ? { toDepth: input.toDepth } : {}),
        requestVersion: versionRef.current,
      });
      apply(data);
      setActionError(null);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [roomId, documentId, apply]);

  return {
    view,
    actionError,
    start: useCallback((title?: string, description?: string | null) => {
      void act({ action: 'start', ...(title !== undefined ? { title } : {}), ...(description !== undefined ? { description } : {}) });
    }, [act]),
    expand: useCallback((nodeRef: string) => { void act({ action: 'expand', nodeRef }); }, [act]),
    back: useCallback((toDepth: number) => { void act({ action: 'back', toDepth }); }, [act]),
    skip: useCallback(() => { void act({ action: 'skip' }); }, [act]),
    finalize: useCallback(() => { void act({ action: 'finalize' }); }, [act]),
    retry: useCallback(() => { void act({ action: 'start' }); }, [act]),
  };
}
