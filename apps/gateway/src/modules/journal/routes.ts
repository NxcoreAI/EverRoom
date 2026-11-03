import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";

import type { JournalScheduler } from "./scheduler.js";
import type { JournalService } from "./service.js";

/**
 * 每日洞察端点（主页「今日洞察」卡）。
 *
 * 只有两个：读当天、手动重写。**没有列表端点**——一期只做今日卡片，
 * 历史版本只在库里留痕（见 docs/daily-journal-plan.zh-CN.md §10 分期）。
 */

const BulletDto = Type.Object({
  text: Type.String(),
  sourceIds: Type.Array(Type.String()),
});

const ActionDto = Type.Object({
  label: Type.String(),
  kind: Type.Union([Type.Literal("open-file"), Type.Literal("ask-agent")]),
  targetId: Type.String(),
});

const EntryDto = Type.Object({
  id: Type.String(),
  date: Type.String(),
  version: Type.Integer(),
  headline: Type.String(),
  summary: Type.String(),
  bullets: Type.Array(BulletDto),
  actions: Type.Array(ActionDto),
  /** null = 模板兜底（模型未就绪/失败）。 */
  model: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.String(),
});

const TodayDto = Type.Object({
  date: Type.String(),
  entry: Type.Union([EntryDto, Type.Null()]),
  status: Type.Union([
    Type.Literal("pending"),
    Type.Literal("generating"),
    Type.Literal("ready"),
    Type.Literal("failed"),
  ]),
  signalCount: Type.Integer(),
  lastError: Type.Union([Type.String(), Type.Null()]),
});

export function journalRoutes(
  service: JournalService,
  scheduler: JournalScheduler,
): FastifyPluginAsyncTypebox {
  return async (app) => {
    /**
     * 当天日记的当前版本。
     *
     * 读不到条目**不是错误**：还没信号、正在生成、生成失败都可能让 `entry` 为 null，
     * 由 `status` 说明原因，渲染端据此显示加载/空态/失败态。
     */
    app.get(
      "/v1/journal/today",
      {
        schema: { tags: ["journal"], response: { 200: TodayDto } },
      },
      async () => service.today(),
    );

    /**
     * 手动重写当天（卡片上的「刷新」）。
     *
     * `force` 只绕过「最小间隔」与「指纹未变」，单飞行仍在调度器里：
     * 连点两次也只真实生成一次，第二次拿到的是同一版。
     */
    app.post(
      "/v1/journal/refresh",
      {
        schema: { tags: ["journal"], response: { 200: TodayDto } },
      },
      async () => {
        const result = await scheduler.requestRun("manual", { force: true });
        return result.view;
      },
    );
  };
}
