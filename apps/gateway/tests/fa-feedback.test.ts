import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createDatabase } from "../src/infrastructure/database/client.js";
import { contextRooms, roomEntityFacts, roomLocalActions } from "../src/infrastructure/database/schema.js";
import { FaFeedbackService } from "../src/modules/fa-archive/feedback.js";
import { eq } from "drizzle-orm";
import type { GatewayDatabase } from "../src/infrastructure/database/client.js";

let root: string;
let db: GatewayDatabase;
let sqlite: ReturnType<typeof createDatabase>["sqlite"];

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "fa-feedback-test-"));
  const created = createDatabase(join(root, "gateway.sqlite"), resolve("drizzle"));
  db = created.db;
  sqlite = created.sqlite;
  // roomLocalActions 外键挂 context_rooms；反馈的 roomId 用 context_rooms 行。
  const seed = (id: string, title: string) =>
    db.insert(contextRooms).values({ id, title, data: {} }).onConflictDoNothing().run();
  seed("ctx-proj", "某AI项目");
  seed("ctx-person", "张三");
  seed("ctx-inst", "某机构");
});

afterAll(async () => {
  sqlite.close();
  await rm(root, { recursive: true, force: true });
});

describe("FA 会后反馈闭环（fa-industry-iteration 工作项三）", () => {
  const svc = () => new FaFeedbackService(db);

  it("pass/watch 必须带标准原因；非法原因码被过滤", () => {
    expect(() => svc().createDraft({ roomId: "ctx-proj", disposition: "pass" }))
      .toThrow(/pass_reason_required/);
    const draft = svc().createDraft({
      roomId: "ctx-proj",
      disposition: "watch",
      passReasons: ["traction_weak", "made_up_reason"],
      reopenConditions: "客户续费数据出来再聊",
      projectUpdates: "对方要求补充客户结构材料",
    });
    expect(draft.passReasons).toEqual(["traction_weak"]); // 非法码被滤掉
    expect(draft.status).toBe("draft");
  });

  it("确认回写：项目侧事实 + 人物/机构信号各挂各的 Room + 跟进任务", () => {
    const draft = svc().createDraft({
      roomId: "ctx-proj",
      institutionRoomId: "ctx-inst",
      personRoomId: "ctx-person",
      meetingAt: "2026-11-18",
      disposition: "interest",
      projectUpdates: "等客户续约数据；先补客户结构",
      personSignals: "偏好简短数据表、关注留存口径",
      institutionSignals: "本期基金优先看企业服务",
      reopenConditions: "客户续费数据出来再聊",
    });
    const confirmed = svc().confirm(draft.id, "李展萍");
    expect(confirmed.status).toBe("confirmed");
    const result = confirmed.applyResult as { writtenFacts: string[]; taskId: string | null; scopes: string[] };
    expect(result.scopes).toEqual(["project", "person", "institution"]);
    expect(result.taskId).toBeTruthy();

    // 事实落库检查：项目房 2 条（反馈结论 + 重启条件）、人物房 1 条、机构房 1 条
    const projFacts = db.select().from(roomEntityFacts).where(eq(roomEntityFacts.roomId, "ctx-proj")).all();
    expect(projFacts.filter((f) => f.sourceId === draft.id)).toHaveLength(2);
    const personFacts = db.select().from(roomEntityFacts).where(eq(roomEntityFacts.roomId, "ctx-person")).all();
    expect(personFacts.filter((f) => f.sourceId === draft.id)).toHaveLength(1);
    const instFacts = db.select().from(roomEntityFacts).where(eq(roomEntityFacts.roomId, "ctx-inst")).all();
    expect(instFacts.filter((f) => f.sourceId === draft.id)).toHaveLength(1);
    // 确认后的反馈 = fact 级
    expect(projFacts.find((f) => f.sourceId === draft.id)?.grade).toBe("fact");

    // 跟进任务：interest 默认 48h 内
    const task = db.select().from(roomLocalActions).where(eq(roomLocalActions.id, result.taskId!)).get();
    expect(task?.kind).toBe("task");
    expect(task?.status).toBe("needsAction");
    expect(task?.title).toContain("会后跟进（interest）");

    // 幂等：重复确认抛错
    expect(() => svc().confirm(draft.id, "x")).toThrow(/feedback_not_draft/);
  });

  it("部分确认：只回写指定路；可修订信号口径", () => {
    const draft = svc().createDraft({
      roomId: "ctx-proj",
      institutionRoomId: "ctx-inst",
      personRoomId: "ctx-person",
      disposition: "strong_interest",
      projectUpdates: "AI 建议口径",
    });
    const confirmed = svc().confirm(draft.id, "负责人", {
      edits: { projectUpdates: "负责人修订后的口径" },
      applyScopes: ["project"],
    });
    const result = confirmed.applyResult as { scopes: string[] };
    expect(result.scopes).toEqual(["project"]);
    // 人物/机构未回写
    const personFacts = db.select().from(roomEntityFacts).where(eq(roomEntityFacts.roomId, "ctx-person")).all();
    expect(personFacts.filter((f) => f.sourceId === draft.id)).toHaveLength(0);

    // strong_interest 任务默认 24h + high 优先级
    const task = db.select().from(roomLocalActions)
      .where(eq(roomLocalActions.notes, `来源：会后反馈 ${draft.id}`)).get();
    expect(task?.priority).toBe("high");
  });

  it("dismiss 只允许 draft 态", () => {
    const draft = svc().createDraft({ roomId: "ctx-proj", disposition: "unknown" });
    expect(svc().dismiss(draft.id).status).toBe("dismissed");
    const confirmed = svc().createDraft({ roomId: "ctx-proj", disposition: "interest" });
    svc().confirm(confirmed.id, "x");
    expect(() => svc().dismiss(confirmed.id)).toThrow(/feedback_already_confirmed/);
  });
});

// drizzle eq 别名（避免与外层 import 冲突的小工具）
function eq_<T extends { name: string }>(col: T, value: unknown) {
  // biome-ignore lint/suspicious/noExplicitAny: 测试辅助
  const { eq } = require("drizzle-orm") as any;
  return eq(col, value);
}
