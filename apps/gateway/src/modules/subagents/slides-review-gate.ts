import { randomUUID } from "node:crypto";

/**
 * PPT 逐页审阅闸门（用户决策：方案只展示不停；每页落定后停下等表态再继续）。
 * 方案阶段不拦；落页阶段 office-plugin 的 set_page 在成功落页后经 awaitDecision
 * 挂起，等渲染层经 REST resolve 端点送回表态再放行 builder。
 *
 * 状态机（按 builder invocationId 键控；DocumentExecutionContext.runId 即该 id）：
 * - continue：确认本页，翻下一页
 * - revise：本页已落但用户要改——builder 按反馈对同一 slideIndex 重落一版，
 *   expectRepeatIndex 使重落页再次过闸（用户确认重落版）
 * - finish：到此为止——后续 set_page 全部直通不拦，builder 按提示收尾提交
 * QA 自检替换（slideIndex < pagesGated 且非重落页）不过闸。
 * 挂起 5 分钟无表态自动视为 continue（带 timedOut 标记），不卡死文件句柄。
 *
 * 每个事件都带全量快照（snapshot）：渲染层进度卡只需保留最新一条即可还原
 * 逐页清单状态，无需自己累积事件。
 */

export type SlidesGateAction = "continue" | "revise" | "finish";

export interface SlidesGateDecision {
  action: SlidesGateAction;
  feedback?: string;
  timedOut?: boolean;
}

export interface SlidesGatePlanPage {
  title: string;
  /** 内容角色提示（cover/data/table/flow…）。 */
  role?: string;
  /** 该页文案要点（自含完整内容，非标题碎片）。 */
  points?: string[];
  /** 该页要呈现的真实数据（数字/表行/图表系列）。 */
  data?: string;
  /** 配图直链与说明（供进度卡缩略图预览）。 */
  materials?: Array<{ url: string; desc?: string }>;
  /** 给落页代理的版式/重点方向建议。 */
  notes?: string;
}

export interface SlidesGatePlan {
  title: string;
  narrative?: string;
  pages: SlidesGatePlanPage[];
  warnings?: string[];
}

/** 方案结构化输出 → 展示载荷（纯函数）：缺标题/页清单视为无效，字段截长防爆量。 */
export function slidesGatePlanFrom(output: unknown): SlidesGatePlan | null {
  if (!output || typeof output !== "object" || Array.isArray(output)) return null;
  const plan = output as Record<string, unknown>;
  const title = typeof plan.title === "string" ? plan.title.trim().slice(0, 120) : "";
  const rawPages = Array.isArray(plan.pages) ? plan.pages : [];
  if (!title || rawPages.length === 0) return null;
  const pages = rawPages.slice(0, 24).map((raw): SlidesGatePlanPage => {
    const page = raw !== null && typeof raw === "object" && !Array.isArray(raw)
      ? raw as Record<string, unknown>
      : {};
    const title = typeof page.title === "string" ? page.title.trim().slice(0, 80) : "";
    const role = typeof page.role === "string" ? page.role.trim().slice(0, 20) : "";
    const points = Array.isArray(page.points)
      ? page.points
        .filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
        .slice(0, 6)
        .map((item) => item.trim().slice(0, 160))
      : [];
    const data = typeof page.data === "string" ? page.data.trim().slice(0, 240) : "";
    const rawMaterials = Array.isArray(page.materials) ? page.materials : [];
    const materials = rawMaterials
      .map((raw): { url: string; desc?: string } | null => {
        const material = raw !== null && typeof raw === "object" && !Array.isArray(raw)
          ? raw as Record<string, unknown>
          : {};
        if (typeof material.url !== "string" || !/^https?:\/\//.test(material.url.trim())) return null;
        const desc = typeof material.desc === "string" ? material.desc.trim().slice(0, 60) : "";
        return { url: material.url.trim().slice(0, 500), ...(desc ? { desc } : {}) };
      })
      .filter((material): material is { url: string; desc?: string } => material !== null)
      .slice(0, 3);
    const notes = typeof page.notes === "string" ? page.notes.trim().slice(0, 140) : "";
    return {
      title,
      ...(role ? { role } : {}),
      ...(points.length ? { points } : {}),
      ...(data ? { data } : {}),
      ...(materials.length ? { materials } : {}),
      ...(notes ? { notes } : {}),
    };
  });
  const narrative = typeof plan.narrative === "string" ? plan.narrative.trim().slice(0, 200) : "";
  const warnings = Array.isArray(plan.warnings)
    ? plan.warnings
      .filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
      .slice(0, 6)
      .map((item) => item.trim().slice(0, 300))
    : [];
  return {
    title,
    ...(narrative ? { narrative } : {}),
    pages,
    ...(warnings.length ? { warnings } : {}),
  };
}

/** 逐页清单全量快照（进度卡直接渲染这份）。 */
export interface SlidesGateSnapshot {
  title: string;
  totalPages: number;
  pages: SlidesGatePlanPage[];
  /** 已确认完成的页数（0..totalPages）。 */
  doneCount: number;
  /** 正在按反馈重落的页序号。 */
  revisingIndex: number | null;
  /** 等用户表态的页序号。 */
  awaitingIndex: number | null;
  /** 用户选择到此为止（提前收尾）。 */
  finishedEarly: boolean;
  /** 叙事主线（风格走向）。 */
  narrative?: string;
  /** 方案告警（素材缺口等）。 */
  warnings?: string[];
}

/** 父工具（slides_draft）订阅的进度事件——经 onUpdate 透传给渲染层进度卡。 */
export type SlidesGateEvent =
  | { kind: "page_applied"; slideIndex: number; title: string; snapshot: SlidesGateSnapshot }
  | { kind: "gate_open"; approvalId: string; slideIndex: number; title: string; snapshot: SlidesGateSnapshot }
  | {
      kind: "page_resolved";
      slideIndex: number;
      action: SlidesGateAction;
      timedOut?: boolean;
      snapshot: SlidesGateSnapshot;
    };

interface GateState {
  plan: SlidesGatePlan;
  pagesGated: number;
  /** revise 后待重落的页序号；其余“回填旧页”视为 QA 自检替换，直通。 */
  expectRepeatIndex: number | null;
  finished: boolean;
  /** 是否正有某页挂起等表态（快照 awaiting/doneCount 的分界）。 */
  awaiting: boolean;
  relay: ((event: SlidesGateEvent) => void) | null;
}

/** 事件去掉 snapshot 后的形状（分配式 Omit，保住判别联合）。 */
type SlidesGateEventBody = SlidesGateEvent extends infer Event
  ? Event extends { snapshot: SlidesGateSnapshot } ? Omit<Event, "snapshot"> : never
  : never;

interface PendingGate {
  resolve: (decision: SlidesGateDecision) => void;
  timeout: NodeJS.Timeout;
}

const GATE_TIMEOUT_MS = 5 * 60_000;

export class SlidesReviewGate {
  private readonly gates = new Map<string, GateState>();
  private readonly pending = new Map<string, PendingGate>();

  /** builder 开跑前布闸；重复 arm（幂等重试重入）覆盖旧状态。 */
  arm(runId: string, plan: SlidesGatePlan): void {
    this.gates.set(runId, {
      plan,
      pagesGated: 0,
      expectRepeatIndex: null,
      finished: false,
      awaiting: false,
      relay: null,
    });
  }

  /** 布闸后挂父工具的进度转发（onUpdate 链）。 */
  setRelay(runId: string, relay: (event: SlidesGateEvent) => void): void {
    const state = this.gates.get(runId);
    if (state) state.relay = relay;
  }

  disarm(runId: string): void {
    const state = this.gates.get(runId);
    if (!state) return;
    state.finished = true;
    this.gates.delete(runId);
  }

  /** 闸门是否对该 run 生效（office-plugin 据此决定是否挂起等表态）。 */
  isActive(runId: string | undefined): boolean {
    return typeof runId === "string" && this.gates.has(runId);
  }

  /**
   * set_page 成功落页后调用。闸门未布（edit 流 / 非受控填页）直接放行；
   * QA 自检替换直通；新页与 revise 重落页挂起等表态。
   */
  async awaitDecision(
    runId: string | undefined,
    slideIndex: number,
  ): Promise<SlidesGateDecision> {
    const state = runId ? this.gates.get(runId) : undefined;
    if (!state || state.finished) return { action: "continue" };
    const isNewPage = slideIndex >= state.pagesGated;
    const isRepeat = state.expectRepeatIndex !== null && slideIndex === state.expectRepeatIndex;
    if (!isNewPage && !isRepeat) return { action: "continue" };

    state.pagesGated = Math.max(state.pagesGated, slideIndex + 1);
    state.expectRepeatIndex = null;
    const pageTitle = state.plan.pages[slideIndex]?.title ?? "";
    const emit = (event: SlidesGateEventBody): void => {
      state.relay?.({ ...event, snapshot: this.snapshot(state) } as SlidesGateEvent);
    };
    const approvalId = randomUUID();
    state.awaiting = true;
    emit({ kind: "page_applied", slideIndex, title: pageTitle });
    emit({ kind: "gate_open", approvalId, slideIndex, title: pageTitle });
    const decision = await new Promise<SlidesGateDecision>((resolve) => {
      const timeout = setTimeout(() => {
        this.pending.delete(approvalId);
        resolve({ action: "continue", timedOut: true });
      }, GATE_TIMEOUT_MS);
      timeout.unref?.();
      this.pending.set(approvalId, { resolve, timeout });
    });
    state.awaiting = false;
    if (decision.action === "finish") {
      state.finished = true;
      emit({ kind: "page_resolved", slideIndex, action: "finish" });
    } else if (decision.action === "revise") {
      state.expectRepeatIndex = slideIndex;
      emit({ kind: "page_resolved", slideIndex, action: "revise" });
    } else {
      emit({
        kind: "page_resolved",
        slideIndex,
        action: "continue",
        ...(decision.timedOut ? { timedOut: true } : {}),
      });
    }
    return decision;
  }

  /** REST resolve 端点回填表态；未找到挂起项返回 false（路由层转 404）。 */
  resolve(approvalId: string, decision: SlidesGateDecision): boolean {
    const pending = this.pending.get(approvalId);
    if (!pending) return false;
    clearTimeout(pending.timeout);
    this.pending.delete(approvalId);
    pending.resolve(decision);
    return true;
  }

  dispose(): void {
    for (const pending of this.pending.values()) clearTimeout(pending.timeout);
    this.pending.clear();
    this.gates.clear();
  }

  /**
   * 快照：awaiting=有页挂起等表态时，该页计入 awaitingIndex 而非 doneCount；
   * revise 的页计入 revisingIndex 而非 doneCount——渲染层按
   * 「<doneCount 且非 revising → done；=revising → 调整中；=awaiting → 等确认；
   * 其余 → 未开始」推导每页状态。
   */
  private snapshot(state: GateState): SlidesGateSnapshot {
    const revisingIndex = state.expectRepeatIndex;
    const doneCount = revisingIndex !== null
      ? revisingIndex
      : state.pagesGated - (state.awaiting && !state.finished ? 1 : 0);
    return {
      title: state.plan.title,
      totalPages: state.plan.pages.length,
      pages: state.plan.pages.slice(0, 24),
      doneCount,
      revisingIndex,
      awaitingIndex: state.awaiting && !state.finished ? state.pagesGated - 1 : null,
      finishedEarly: state.finished,
      ...(state.plan.narrative ? { narrative: state.plan.narrative } : {}),
      ...(state.plan.warnings?.length ? { warnings: state.plan.warnings } : {}),
    };
  }
}
