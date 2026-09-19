import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  EmergenceFocusInput,
  EmergenceProjectionResultDto,
  EmergenceWanderInput,
} from '../../../../../../shared/knowledge';

export interface UseEmergenceOptions {
  roomId: string;
  focus: EmergenceFocusInput;
  /** 焦点变化后的静默期：连续编辑不打点。 */
  debounceMs?: number;
  /** 锁定=焦点变化不重新投影（漫步仍可手动触发）。 */
  locked?: boolean;
}

/**
 * 知识涌现投影的取数与状态守卫：
 * - 聚焦/漫步各自持有结果，回到聚焦不重新请求、卡片不重排；
 * - requestVersion 客户端递增，旧响应不覆盖新状态（含漫步期间迟到的聚焦响应）；
 * - 聚焦随焦点 debounce 增量更新；漫步是用户动作（入口/再走一次/沿此漫步），立即触发。
 */
export function useEmergence({ roomId, focus, debounceMs = 1500, locked = false }: UseEmergenceOptions) {
  const [focusResult, setFocusResult] = useState<EmergenceProjectionResultDto | null>(null);
  const [wanderResult, setWanderResult] = useState<EmergenceProjectionResultDto | null>(null);
  const [focusLoading, setFocusLoading] = useState(false);
  const [wanderLoading, setWanderLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const versionRef = useRef(0);
  const inflightRef = useRef(0);

  const request = useCallback(async (
    mode: 'focus' | 'wander',
    wander?: EmergenceWanderInput | null,
  ) => {
    const knowledge = window.nxcore?.knowledge;
    if (!knowledge) return;
    const requestVersion = ++versionRef.current;
    if (mode === 'focus') setFocusLoading(true);
    else setWanderLoading(true);
    setError(null);
    inflightRef.current += 1;
    try {
      const data = await knowledge.emergence(roomId, {
        mode,
        focus,
        wander: mode === 'wander' ? (wander ?? {}) : null,
        limit: mode === 'focus' ? 5 : 15,
        requestVersion,
      });
      if (data.requestVersion !== versionRef.current) return;
      if (mode === 'focus') setFocusResult(data);
      else setWanderResult(data);
    } catch (cause) {
      if (requestVersion === versionRef.current) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      inflightRef.current -= 1;
      if (mode === 'focus' && inflightRef.current === 0) setFocusLoading(false);
      if (mode === 'wander' && inflightRef.current === 0) setWanderLoading(false);
    }
  }, [roomId, focus]);

  // 锁定时冻结投影：焦点行仍跟随显示，卡片不随外部焦点变化重排。
  // 首次投影立即发出（面板打开即取数）；后续焦点变化走防抖，连续编辑不打点。
  // 章节正文进 key：正文随输入增长，防抖后一次成型，符合「输入停顿才更新焦点」。
  const focusKey = `${focus.documentId ?? ''} ${focus.selectionText ?? ''} ${focus.blockId ?? ''} ${focus.chapter?.heading ?? ''} ${focus.chapter?.bodyText ?? ''}`;
  const initialRef = useRef<string | null>(null);
  useEffect(() => {
    if (locked) return;
    if (initialRef.current !== roomId) {
      initialRef.current = roomId;
      void request('focus');
      return;
    }
    const timer = window.setTimeout(() => { void request('focus'); }, debounceMs);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, focusKey, locked, debounceMs]);

  const wanderFrom = useCallback((startNodeRef?: string | null) => {
    const seed = Math.floor(Math.random() * 2 ** 31);
    void request('wander', { startNodeRef: startNodeRef ?? null, seed });
  }, [request]);

  return {
    focusResult,
    wanderResult,
    focusLoading,
    wanderLoading,
    error,
    request,
    wanderFrom,
  };
}
