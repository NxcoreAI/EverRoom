import { useEffect, useRef } from 'react';

import { createSkeletonGraph, frameSkeleton, unregisterLiveGraph } from './g6FocusGraph';

/**
 * 投影/漫步加载占位：G6 骨架树（与真图同引擎同布局），出图后节点原位显形零跳变。
 * 不可交互；底部提示语走 DOM（随 locale）。
 */
export function SkeletonTreeCanvas({ hint }: { hint: string }) {
  const mountRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = mountRef.current;
    if (!el) return;
    const graph = createSkeletonGraph(el);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const apply = () => {
      if (!el.isConnected || !el.clientWidth || !el.clientHeight) return;
      try {
        graph.changeSize(el.clientWidth, el.clientHeight);
        graph.refreshLayout();
        frameSkeleton(graph, el);
      } catch { /* 已销毁 */ }
    };
    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(apply, 160);
      });
      observer.observe(el);
    }
    return () => {
      if (timer) clearTimeout(timer);
      observer?.disconnect();
      unregisterLiveGraph(graph);
      try { graph.destroy(); } catch { /* 已销毁 */ }
    };
  }, []);

  return (
    <div className="eg-viewport eg-skeleton" aria-busy="true">
      <div ref={mountRef} className="eg-g6-mount" />
      <p className="eg-skeleton-hint">{hint}</p>
    </div>
  );
}
