import { useCallback, useRef, useState } from 'react';

import type {
  EmergenceFocusInput,
  EmergenceProjectionResultDto,
} from '../../../../../../shared/knowledge';
import { mergeWanderResult } from '../components/emergence-graph/walkModel';

export interface UseEmergenceOptions {
  roomId: string;
  /** 漫步起点兜底用（网关取 focus.documentId）；聚焦世界已迁 useFocusMindmap。 */
  focus: EmergenceFocusInput;
}

/**
 * 漫步投影取数（思路板块漫步模式）：用户动作触发（入口/再走一次/沿此漫步），
 * 不随焦点变化自动请求；requestVersion 递增丢弃迟到旧响应；每次触发换新 seed。
 * 续走（extendWalk）不换旅程：新投影按确定性 id 合并进当前切片，
 * journeyKey 只在整段旅程重开（wanderFrom）时递增，供渲染层区分
 * 「重置路径」与「原地扩充」。
 */
export function useEmergence({ roomId, focus }: UseEmergenceOptions) {
  const [wanderResult, setWanderResult] = useState<EmergenceProjectionResultDto | null>(null);
  const [wanderLoading, setWanderLoading] = useState(false);
  const [extending, setExtending] = useState(false);
  const [journeyKey, setJourneyKey] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const versionRef = useRef(0);
  const inflightRef = useRef(0);
  const extendingRef = useRef(false);
  const extendedFromRef = useRef(new Set<string>());

  const requestWander = useCallback(async (startNodeRef: string | null): Promise<EmergenceProjectionResultDto | null> => {
    const knowledge = window.nxcore?.knowledge;
    if (!knowledge) return null;
    const seed = Math.floor(Math.random() * 2 ** 31);
    const requestVersion = ++versionRef.current;
    const data = await knowledge.emergence(roomId, {
      mode: 'wander',
      focus,
      wander: { startNodeRef, seed },
      limit: 15,
      requestVersion,
    });
    if (data.requestVersion !== versionRef.current) return null;
    return data;
  }, [roomId, focus]);

  const wanderFrom = useCallback(async (startNodeRef?: string | null) => {
    setWanderLoading(true);
    setError(null);
    extendedFromRef.current.clear();
    inflightRef.current += 1;
    try {
      const data = await requestWander(startNodeRef ?? null);
      if (data) {
        setWanderResult(data);
        setJourneyKey((key) => key + 1);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      inflightRef.current -= 1;
      if (inflightRef.current === 0) setWanderLoading(false);
    }
  }, [requestWander]);

  /**
   * 续走：以当前驻足为起点再投影一次并合并进切片（不重置旅程）。
   * 同一站只自动续走一次（防边合并边触发的循环），失败静默——保留当前
   * 视图，尽头卡兜底，不打断漫步。
   */
  const extendWalk = useCallback(async (startNodeRef: string) => {
    if (extendingRef.current || extendedFromRef.current.has(startNodeRef)) return;
    extendingRef.current = true;
    extendedFromRef.current.add(startNodeRef);
    setExtending(true);
    try {
      const data = await requestWander(startNodeRef);
      if (data) setWanderResult((prev) => (prev ? mergeWanderResult(prev, data) : data));
    } catch {
      // 续走失败保持当前视图
    } finally {
      extendingRef.current = false;
      setExtending(false);
    }
  }, [requestWander]);

  const hasExtended = useCallback(
    (startNodeRef: string): boolean => extendedFromRef.current.has(startNodeRef),
    [],
  );

  return {
    wanderResult,
    wanderLoading,
    extending,
    journeyKey,
    error,
    wanderFrom,
    extendWalk,
    hasExtended,
  };
}
