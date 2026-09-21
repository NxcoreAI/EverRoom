import { useCallback, useEffect, useRef } from 'react';
import gsap from 'gsap';

import { type CamTransform, type ViewportSize, clampScale, fitTransform, pinTransform, screenOf } from './cameraMath';
import type { BBox, Point } from './treeLayout';

export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export interface TweenOptions {
  durationMs?: number;
  /** 相机聚焦点在视口宽度的比例位置（默认 0.5）。 */
  cx?: number;
  /** 视口底部预留高度（详情条），视觉中心上移。 */
  bottomReserve?: number;
  onComplete?: () => void;
}

/**
 * 平移/缩放相机：transform 写在 camera 层（origin 0 0），内容坐标即布局坐标。
 * 相机补间 = 缩放插值 + 锚点从起始屏幕位滑向视口中心；完成即精确落位，
 * 正确性不依赖补间（rAF 冻结时 gsap 恢复后吸附终态）。
 */
export function useGraphCamera(
  viewportRef: React.RefObject<HTMLElement | null>,
  cameraRef: React.RefObject<HTMLElement | null>,
) {
  const camRef = useRef<CamTransform>({ x: 0, y: 0, scale: 1 });
  const tweenAnchor = useRef<Point | null>(null);
  const tween = useRef<gsap.core.Tween | null>(null);
  // 盲铺开自愈：fit 时视口还没尺寸（隐藏容器/后台标签），落位是错的；视口有真实尺寸后重铺
  const lastFit = useRef<{ bbox: BBox; padding: number; maxScale: number; vw: number; vh: number } | null>(null);

  const apply = useCallback(() => {
    const el = cameraRef.current;
    if (!el) return;
    const cam = camRef.current;
    if (!Number.isFinite(cam.x) || !Number.isFinite(cam.y) || !Number.isFinite(cam.scale) || cam.scale <= 0) {
      camRef.current = { x: 0, y: 0, scale: 1 };
    }
    const { x, y, scale } = camRef.current;
    el.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
  }, [cameraRef]);

  const setCam = useCallback((next: CamTransform) => {
    camRef.current = next;
    apply();
  }, [apply]);

  const viewportSize = useCallback((): ViewportSize => {
    const el = viewportRef.current;
    return { width: el?.clientWidth ?? 0, height: el?.clientHeight ?? 0 };
  }, [viewportRef]);

  const visualCenter = useCallback((bottomReserve = 0): Point => {
    const { width, height } = viewportSize();
    return { x: width / 2, y: Math.max(40, (height - bottomReserve) / 2) };
  }, [viewportSize]);

  const fit = useCallback((bbox: BBox, padding = 28, maxScale = 1.15) => {
    const vp = viewportSize();
    lastFit.current = { bbox, padding, maxScale, vw: vp.width, vh: vp.height };
    setCam(fitTransform(bbox, vp, padding, maxScale));
  }, [setCam, viewportSize]);

  const cancelTween = useCallback(() => {
    if (tween.current) {
      tween.current.kill();
      tween.current = null;
    }
    tweenAnchor.current = null;
  }, []);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      const vp = viewportSize();
      if (vp.width < 80 || vp.height < 80) return;
      const fitRec = lastFit.current;
      if (!fitRec || fitRec.vw >= 80 || fitRec.vh >= 80) return;
      lastFit.current = { ...fitRec, vw: vp.width, vh: vp.height };
      cancelTween();
      setCam(fitTransform(fitRec.bbox, vp, fitRec.padding, fitRec.maxScale));
    });
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [viewportRef, viewportSize, cancelTween, setCam, visualCenter]);

  /** 锚点（内容坐标）滑向视口中心，缩放同步插值到 toScale。 */
  const tweenTo = useCallback((anchor: Point, toScale: number, options: TweenOptions = {}) => {
    cancelTween();
    const { durationMs = 380, cx = 0.5, bottomReserve = 0, onComplete } = options;
    const reduced = prefersReducedMotion();
    const viewport = viewportSize();
    const target = { x: viewport.width * cx, y: visualCenter(bottomReserve).y };
    const cam = camRef.current;
    const scale0 = Number.isFinite(cam.scale) && cam.scale > 0.01 ? cam.scale : 1;
    const goal = clampScale(toScale);
    let start = screenOf(anchor.x, anchor.y, cam);
    if (!Number.isFinite(start.x) || !Number.isFinite(start.y)) start = { ...target };
    const offscreen = start.x < 0 || start.x > viewport.width || start.y < 0 || start.y > viewport.height;
    if (offscreen) start = { ...target };
    if (reduced || durationMs <= 0) {
      setCam(pinTransform(anchor.x, anchor.y, target.x, target.y, goal));
      onComplete?.();
      return;
    }
    tweenAnchor.current = anchor;
    const proxy = { t: 0 };
    tween.current = gsap.to(proxy, {
      t: 1,
      duration: durationMs / 1000,
      ease: 'power3.out',
      onUpdate: () => {
        const k = proxy.t;
        const sp = { x: start.x + (target.x - start.x) * k, y: start.y + (target.y - start.y) * k };
        const scale = scale0 + (goal - scale0) * k;
        setCam(pinTransform(anchor.x, anchor.y, sp.x, sp.y, scale));
      },
      onComplete: () => {
        tween.current = null;
        setCam(pinTransform(anchor.x, anchor.y, target.x, target.y, goal));
        onComplete?.();
      },
    });
  }, [cancelTween, setCam, viewportSize, visualCenter]);

  /** 看门狗：补间结束后中心不在画内 / 缩放异常 → 收敛回可视状态，任何情况不白屏。 */
  const ensureVisible = useCallback((anchor: Point, bbox: BBox | null, bottomReserve = 0) => {
    const cam = camRef.current;
    const viewport = viewportSize();
    if (!Number.isFinite(cam.scale) || cam.scale <= 0) {
      setCam(bbox ? fitTransform(bbox, viewport, 28, 1.15) : { x: 0, y: 0, scale: 1 });
      return;
    }
    if (cam.scale < 0.2 || cam.scale > 3) {
      if (bbox) setCam(fitTransform(bbox, viewport, 28, 1.15));
      return;
    }
    const sp = screenOf(anchor.x, anchor.y, cam);
    const margin = 24;
    if (sp.x < margin || sp.x > viewport.width - margin || sp.y < margin || sp.y > viewport.height - margin) {
      const center = visualCenter(bottomReserve);
      setCam(pinTransform(anchor.x, anchor.y, center.x, center.y, cam.scale));
    }
  }, [setCam, viewportSize, visualCenter]);

  /** 滚轮缩放（锚定光标）+ 背景拖拽平移；节点上不触发。 */
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const onWheel = (event: WheelEvent) => {
      if (!(event.target instanceof Element) || event.target.closest('[data-eg-node]')) return;
      event.preventDefault();
      const rect = viewport.getBoundingClientRect();
      const cursor = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      const cam = camRef.current;
      const scale = Number.isFinite(cam.scale) && cam.scale > 0 ? cam.scale : 1;
      const content = { x: (cursor.x - cam.x) / scale, y: (cursor.y - cam.y) / scale };
      const next = clampScale(scale * Math.exp(-event.deltaY * 0.0015));
      setCam(pinTransform(content.x, content.y, cursor.x, cursor.y, next));
    };
    let drag: { pointerId: number; lastX: number; lastY: number } | null = null;
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || event.target.closest('[data-eg-node]')) return;
      drag = { pointerId: event.pointerId, lastX: event.clientX, lastY: event.clientY };
      viewport.setPointerCapture(event.pointerId);
    };
    const onPointerMove = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      const cam = camRef.current;
      camRef.current = { ...cam, x: cam.x + (event.clientX - drag.lastX), y: cam.y + (event.clientY - drag.lastY) };
      drag.lastX = event.clientX;
      drag.lastY = event.clientY;
      apply();
    };
    const onPointerUp = (event: PointerEvent) => {
      if (drag && event.pointerId === drag.pointerId) {
        drag = null;
        try { viewport.releasePointerCapture(event.pointerId); } catch { /* 已释放 */ }
      }
    };
    viewport.addEventListener('wheel', onWheel, { passive: false });
    viewport.addEventListener('pointerdown', onPointerDown);
    viewport.addEventListener('pointermove', onPointerMove);
    viewport.addEventListener('pointerup', onPointerUp);
    viewport.addEventListener('pointercancel', onPointerUp);
    return () => {
      viewport.removeEventListener('wheel', onWheel);
      viewport.removeEventListener('pointerdown', onPointerDown);
      viewport.removeEventListener('pointermove', onPointerMove);
      viewport.removeEventListener('pointerup', onPointerUp);
      viewport.removeEventListener('pointercancel', onPointerUp);
    };
  }, [viewportRef, setCam, apply]);

  return { camRef, setCam, apply, fit, tweenTo, cancelTween, ensureVisible, viewportSize, visualCenter };
}

export type GraphCamera = ReturnType<typeof useGraphCamera>;
