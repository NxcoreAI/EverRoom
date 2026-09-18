import { useCallback, useEffect, useRef } from 'react';
import gsap from 'gsap';

import { prefersReducedMotion } from './useGraphCamera';

/** 切换动画时长（ms）：退场渐隐 → 钉屏换树 → 位置变形 → 入场错峰 → 相机补间。 */
export const TIMING = {
  fadeOut: 130,
  fadeOutBackstop: 210,
  morph: 300,
  born: 200,
  stagger: 45,
  staggerCap: 180,
  camera: 380,
  walkCamera: 260,
  recenter: 360,
  watchdog: 650,
} as const;

/**
 * 切换动画编排：代数计数器防快速连点叠动画，tween/定时器注册集中清理。
 * 每个回调先验 gen（alive），过期补间被整体 kill，不会两层动画打架。
 */
export function useGraphTransition() {
  const genRef = useRef(0);
  const tweensRef = useRef<gsap.core.Tween[]>([]);
  const timersRef = useRef<number[]>([]);

  const kill = useCallback(() => {
    for (const tween of tweensRef.current) tween.kill();
    tweensRef.current = [];
    for (const timer of timersRef.current) clearTimeout(timer);
    timersRef.current = [];
  }, []);

  const alive = useCallback((gen: number) => gen === genRef.current, []);

  /** 开启新一代：杀掉上一代全部补间/定时器，返回新代数。 */
  const next = useCallback(() => {
    kill();
    genRef.current += 1;
    return genRef.current;
  }, [kill]);

  const track = useCallback((tween: gsap.core.Tween) => {
    tweensRef.current.push(tween);
    if (tweensRef.current.length > 120) tweensRef.current.splice(0, tweensRef.current.length - 120);
    return tween;
  }, []);

  /** gen 守卫的延迟回调（rAF 冻结兜底走同一队列）。 */
  const later = useCallback((gen: number, fn: () => void, ms: number) => {
    const timer = window.setTimeout(() => {
      if (alive(gen)) fn();
    }, ms);
    timersRef.current.push(timer);
    return timer;
  }, [alive]);

  /** 元素相对位移入场/变形（reduced-motion 直接终态）。 */
  const morphFrom = useCallback((el: Element, from: { x: number; y: number }, durationMs: number, ease: string, delayMs = 0) => {
    if (prefersReducedMotion()) return;
    track(gsap.from(el, { x: from.x, y: from.y, duration: durationMs / 1000, ease, delay: delayMs / 1000, overwrite: 'auto' }));
  }, [track]);

  const bornFrom = useCallback((el: Element, from: { x: number; y: number }, delayMs = 0) => {
    if (prefersReducedMotion()) return;
    track(gsap.from(el, {
      x: from.x, y: from.y, opacity: 0, scale: 0.92,
      duration: TIMING.born / 1000, ease: 'power2.out', delay: delayMs / 1000, overwrite: 'auto',
    }));
  }, [track]);

  const fadeOutEl = useCallback((el: Element, onComplete?: () => void) => {
    if (prefersReducedMotion()) {
      onComplete?.();
      return;
    }
    track(gsap.to(el, { opacity: 0, duration: TIMING.fadeOut / 1000, ease: 'power1.out', onComplete }));
  }, [track]);

  useEffect(() => kill, [kill]);

  return { genRef, alive, next, later, track, kill, morphFrom, bornFrom, fadeOutEl };
}

export type GraphTransition = ReturnType<typeof useGraphTransition>;
