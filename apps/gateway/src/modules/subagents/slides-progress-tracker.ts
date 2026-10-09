import { slidesProgressPlanFrom } from "./slides-draft-doc.js";
import type { SlidesProgressPlan, SlidesProgressPage } from "./slides-draft-doc.js";

export type { SlidesProgressPlan, SlidesProgressPage } from "./slides-draft-doc.js";
export { slidesProgressPlanFrom };

/**
 * PPT 逐页进度上报器（2026-09 重设计：逐页审阅闸门已删——内容确认前置到草稿文档、
 * 修改后置到成品批注，生成过程一口气跑完，不再逐页停等表态）。
 *
 * 职责只剩一件事：builder 每成功落一页，向渲染层进度卡广播一条全量快照事件
 * （经 slides_draft onUpdate 链透传）。无决策、无挂起、无超时。
 */

/** 逐页清单全量快照（进度卡直接渲染这份）。 */
export interface SlidesProgressSnapshot {
  title: string;
  totalPages: number;
  pages: SlidesProgressPage[];
  /** 已落定的页数（0..totalPages）。 */
  doneCount: number;
  /** 叙事主线。 */
  narrative?: string;
  /** 方案告警（素材缺口等）。 */
  warnings?: string[];
}

/** 父工具（slides_draft）订阅的进度事件——经 onUpdate 透传给渲染层进度卡。 */
export type SlidesProgressEvent = {
  kind: "page_applied";
  slideIndex: number;
  title: string;
  snapshot: SlidesProgressSnapshot;
};

interface TrackerState {
  plan: SlidesProgressPlan;
  appliedCount: number;
  relay: ((event: SlidesProgressEvent) => void) | null;
}

export class SlidesProgressTracker {
  private readonly runs = new Map<string, TrackerState>();

  /** builder 开跑前登记；重复登记（幂等重试重入）覆盖旧状态。 */
  arm(runId: string, plan: SlidesProgressPlan): void {
    this.runs.set(runId, { plan, appliedCount: 0, relay: null });
  }

  /** 登记后挂父工具的进度转发（onUpdate 链）。 */
  setRelay(runId: string, relay: (event: SlidesProgressEvent) => void): void {
    const state = this.runs.get(runId);
    if (state) state.relay = relay;
  }

  disarm(runId: string): void {
    this.runs.delete(runId);
  }

  dispose(): void {
    this.runs.clear();
  }

  /** set_page 成功落页后调用：广播一条带全量快照的进度事件（未登记的 run 静默忽略）。 */
  notify(runId: string | undefined, slideIndex: number): void {
    const state = runId ? this.runs.get(runId) : undefined;
    if (!state) return;
    state.appliedCount = Math.max(state.appliedCount, slideIndex + 1);
    state.relay?.({
      kind: "page_applied",
      slideIndex,
      title: state.plan.pages[slideIndex]?.title ?? "",
      snapshot: {
        title: state.plan.title,
        totalPages: state.plan.pages.length,
        pages: state.plan.pages.slice(0, 24),
        doneCount: state.appliedCount,
        ...(state.plan.narrative ? { narrative: state.plan.narrative } : {}),
        ...(state.plan.warnings?.length ? { warnings: state.plan.warnings } : {}),
      },
    });
  }
}
