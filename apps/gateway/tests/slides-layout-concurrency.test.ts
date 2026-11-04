import { describe, expect, it } from "vitest";
import { runIndexWorkers } from "../src/modules/subagents/slides-layout-tail.js";

/**
 * 页级并发扇出的回归钉子。
 *
 * 背景（2026-10-21 实测）：改造前是 `Math.min(8, pages.length)` 硬编码窗口，
 * 一册 15 页的 deck 有 7 页要等第一波落定才开工，白多出一整轮单页耗时
 * （单页 P50 141s → 实际均值 165s）。抽成 runIndexWorkers 之后，
 * 窗口由 NXCORE_SLIDES_DECK_CONCURRENCY 决定，默认 16。
 */
describe("runIndexWorkers", () => {
  /** 记录任意时刻的最大在飞数，并校验每个索引恰好跑一次。 */
  async function measure(count: number, limit: number) {
    let inFlight = 0;
    let peak = 0;
    const seen: number[] = [];
    await runIndexWorkers(count, limit, async (index) => {
      seen.push(index);
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      // 让出一次事件循环，保证并发是真的并发而不是同步串完。
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
    });
    return { peak, seen };
  }

  it("窗口小于页数时，在飞数永远不超过窗口", async () => {
    const { peak, seen } = await measure(15, 4);
    expect(peak).toBe(4);
    expect(seen.sort((a, b) => a - b)).toEqual([...Array(15).keys()]);
  });

  it("窗口 ≥ 页数时，15 页一次全飞（这正是 6 分钟目标的前提）", async () => {
    const { peak } = await measure(15, 16);
    expect(peak).toBe(15);
  });

  it("窗口为 1 时严格串行", async () => {
    const { peak, seen } = await measure(6, 1);
    expect(peak).toBe(1);
    expect(seen).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("0 页立即返回，不空转", async () => {
    let calls = 0;
    await runIndexWorkers(0, 8, async () => { calls += 1; });
    expect(calls).toBe(0);
  });

  it("非法窗口（0 / 负数 / 小数）夹到至少 1，不会死锁", async () => {
    for (const limit of [0, -3, 0.4]) {
      const { peak, seen } = await measure(3, limit);
      expect(peak).toBe(1);
      expect(seen).toHaveLength(3);
    }
  });

  it("worker 抛错直接冒泡：是否消化由调用方决定", async () => {
    await expect(runIndexWorkers(3, 2, async (index) => {
      if (index === 1) throw new Error("page_failed");
    })).rejects.toThrow("page_failed");
  });
});
