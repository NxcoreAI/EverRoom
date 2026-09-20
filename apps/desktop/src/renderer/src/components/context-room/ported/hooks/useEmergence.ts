import { useCallback, useRef, useState } from 'react';

import type {
  EmergenceFocusInput,
  EmergenceProjectionResultDto,
} from '../../../../../../shared/knowledge';

export interface UseEmergenceOptions {
  roomId: string;
  /** 漫步起点兜底用（网关取 focus.documentId）；聚焦世界已迁 useFocusMindmap。 */
  focus: EmergenceFocusInput;
}

/**
 * 漫步投影取数（思路板块漫步模式）：用户动作触发（入口/再走一次/沿此漫步），
 * 不随焦点变化自动请求；requestVersion 递增丢弃迟到旧响应；每次触发换新 seed。
 */
export function useEmergence({ roomId, focus }: UseEmergenceOptions) {
  const [wanderResult, setWanderResult] = useState<EmergenceProjectionResultDto | null>(null);
  const [wanderLoading, setWanderLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const versionRef = useRef(0);
  const inflightRef = useRef(0);

  const wanderFrom = useCallback(async (startNodeRef?: string | null) => {
    const knowledge = window.nxcore?.knowledge;
    if (!knowledge) return;
    const seed = Math.floor(Math.random() * 2 ** 31);
    const requestVersion = ++versionRef.current;
    setWanderLoading(true);
    setError(null);
    inflightRef.current += 1;
    try {
      const data = await knowledge.emergence(roomId, {
        mode: 'wander',
        focus,
        wander: { startNodeRef: startNodeRef ?? null, seed },
        limit: 15,
        requestVersion,
      });
      if (data.requestVersion !== versionRef.current) return;
      setWanderResult(data);
    } catch (cause) {
      if (requestVersion === versionRef.current) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      inflightRef.current -= 1;
      if (inflightRef.current === 0) setWanderLoading(false);
    }
  }, [roomId, focus]);

  return {
    wanderResult,
    wanderLoading,
    error,
    wanderFrom,
  };
}
