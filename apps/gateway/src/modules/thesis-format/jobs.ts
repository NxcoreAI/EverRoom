/**
 * 排版作业注册表（第三期）。
 *
 * 为什么需要：一次排版是 5–10 分钟的长任务，如果让客户端一直挂着那个 HTTP 请求，
 * 客户端（或中间层）会在 5 分钟时先放弃，而服务端其实还在跑——用户看到「AI 模型
 * 不可用/超时」，实际产物几秒后就落库了。改成「提交即返回 jobId + 轮询状态」后，
 * 客户端只发短请求，长任务完全在网关侧推进。
 *
 * 作业只存内存：进程重启即失效（此时前端会收到 404，重开一次即可），
 * 不引入数据库表——排版作业不需要跨重启存活。
 */

export type ThesisJobPhase = "parsing" | "mapping" | "rendering";

export interface ThesisJobSnapshot {
  id: string;
  /** 作业所属工作区（模版卡与产物归属）。 */
  workspaceId: string;
  status: "running" | "completed" | "failed";
  phase: ThesisJobPhase | "done";
  /** 0–100 的粗粒度进度（阶段映射，不是精确百分比）。 */
  progress: number;
  startedAt: string;
  finishedAt?: string;
  result?: unknown;
  error?: string;
}

const PHASE_PROGRESS: Record<ThesisJobPhase | "done", number> = {
  parsing: 15,
  mapping: 45,
  rendering: 75,
  done: 100,
};

/** 作业保留时长：完成后 30 分钟内可查（够前端轮询收尾）。 */
const RETENTION_MS = 30 * 60 * 1000;

export class ThesisJobRegistry {
  private readonly jobs = new Map<string, ThesisJobSnapshot>();

  create(workspaceId: string): ThesisJobSnapshot {
    this.sweep();
    const id = `thesis-job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const snapshot: ThesisJobSnapshot = {
      id,
      workspaceId,
      status: "running",
      phase: "parsing",
      progress: PHASE_PROGRESS.parsing,
      startedAt: new Date().toISOString(),
    };
    this.jobs.set(id, snapshot);
    return snapshot;
  }

  get(id: string): ThesisJobSnapshot | undefined {
    return this.jobs.get(id);
  }

  phase(id: string, phase: ThesisJobPhase): void {
    const job = this.jobs.get(id);
    if (!job || job.status !== "running") return;
    job.phase = phase;
    job.progress = PHASE_PROGRESS[phase];
  }

  complete(id: string, result: unknown): void {
    const job = this.jobs.get(id);
    if (!job) return;
    job.status = "completed";
    job.phase = "done";
    job.progress = PHASE_PROGRESS.done;
    job.finishedAt = new Date().toISOString();
    job.result = result;
  }

  fail(id: string, error: unknown): void {
    const job = this.jobs.get(id);
    if (!job) return;
    job.status = "failed";
    job.finishedAt = new Date().toISOString();
    job.error = error instanceof Error ? error.message : String(error);
  }

  /** 清理过期作业，避免长时间运行后内存堆积。 */
  private sweep(): void {
    const cutoff = Date.now() - RETENTION_MS;
    for (const [id, job] of this.jobs) {
      const finished = job.finishedAt ? Date.parse(job.finishedAt) : Date.parse(job.startedAt);
      if (Number.isFinite(finished) && finished < cutoff) this.jobs.delete(id);
    }
  }
}
