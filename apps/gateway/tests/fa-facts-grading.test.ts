import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createDatabase } from "../src/infrastructure/database/client.js";
import { roomEntityFacts } from "../src/infrastructure/database/schema.js";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { parseExtractionResponse } from "../src/modules/knowledge/llm.js";
import type { GatewayDatabase } from "../src/infrastructure/database/client.js";

let root: string;
let db: GatewayDatabase;
let sqlite: ReturnType<typeof createDatabase>["sqlite"];

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "fa-facts-test-"));
  const created = createDatabase(join(root, "gateway.sqlite"), resolve("drizzle"));
  db = created.db;
  sqlite = created.sqlite;
});

afterAll(async () => {
  sqlite.close();
  await rm(root, { recursive: true, force: true });
});

const fingerprint = (content: string) => createHash("sha256").update(content.trim()).digest("hex").slice(0, 20);

function insertFact(input: { roomId: string; content: string; grade?: string; numeric?: unknown }) {
  db.insert(roomEntityFacts).values({
    id: randomUUID(),
    roomId: input.roomId,
    factId: fingerprint(input.content),
    content: input.content,
    type: "属性",
    grade: (input.grade ?? "opinion") as never,
    numeric: (input.numeric ?? null) as never,
    sourceKind: "everroom-doc",
    sourceId: "doc-1",
    sourceVersion: 1,
    evidenceGroupKey: "g",
  }).run();
}

describe("FA 事实分级（fa-industry-iteration 工作项二）", () => {
  it("grade/numeric 列可写可读，缺省 opinion", () => {
    insertFact({ roomId: "room-1", content: "2025H1 营收 1.2 亿元（经审计）", grade: "fact", numeric: { value: 1.2, unit: "亿元", period: "2025H1", audited: true } });
    insertFact({ roomId: "room-1", content: "预计明年收入翻番", grade: "forecast" });
    insertFact({ roomId: "room-1", content: "无分级的旧数据" });
    const rows = db.select().from(roomEntityFacts).all();
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.content.includes("营收"))?.grade).toBe("fact");
    expect(rows.find((r) => r.content.includes("营收"))?.numeric).toMatchObject({ value: 1.2, audited: true });
    expect(rows.find((r) => r.content.includes("翻番"))?.grade).toBe("forecast");
    expect(rows.find((r) => r.content.includes("旧数据"))?.grade).toBe("opinion");
  });

  it("迁移已为既有行回填 opinion 缺省", () => {
    // 上面第三条未传 grade，走列 DEFAULT 'opinion'
    const legacy = db.select().from(roomEntityFacts).all().find((r) => !r.numeric && r.grade === "opinion");
    expect(legacy).toBeTruthy();
  });
});

describe("parseExtractionResponse 分级解析", () => {
  it("接受 grade 五档并透传 numeric；非法值回落 opinion；缺省 opinion", () => {
    const result = parseExtractionResponse(JSON.stringify({
      summary: "s",
      entities: [],
      facts: [
        { content: "经审计营收 1.2 亿", type: "属性", grade: "fact", numeric: { value: 1.2, unit: "亿", period: "2025H1", audited: true }, entities: [] },
        { content: "管理层预测翻番", type: "属性", grade: "forecast", entities: [] },
        { content: "创始人认为赛道将洗牌", type: "属性", grade: "garbage", entities: [] },
        { content: "未标注分级的陈述", type: "属性", entities: [] },
        { content: "数据缺失的指标", type: "属性", grade: "unknown", numeric: { value: "不是数字", period: "2025" }, entities: [] },
      ],
    }));
    expect(result.facts).toHaveLength(5);
    const [f1, f2, f3, f4, f5] = result.facts;
    expect(f1?.grade).toBe("fact");
    expect(f1?.numeric).toMatchObject({ value: 1.2, audited: true });
    expect(f2?.grade).toBe("forecast");
    expect(f3?.grade).toBe("opinion");
    expect(f4?.grade).toBe("opinion");
    // numeric.value 非数字被剔除，period 保留
    expect(f5?.numeric).toMatchObject({ period: "2025" });
    expect(f5?.numeric?.value).toBeUndefined();
  });

  it("旧格式（无 grade/numeric 字段）兼容", () => {
    const result = parseExtractionResponse(JSON.stringify({
      summary: "s",
      entities: [],
      facts: [{ content: "历史决策重放的事实", type: "属性", entities: [] }],
    }));
    expect(result.facts[0]?.grade).toBe("opinion");
    expect(result.facts[0]?.numeric).toBeUndefined();
  });
});
