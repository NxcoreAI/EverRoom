import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Ajv } from "ajv";
import { createDatabase, type DatabaseClient } from "../src/infrastructure/database/client.js";
import { documents, roomDocumentLinks, documentVersions } from "../src/infrastructure/database/schema.js";
import { WritingStyleService } from "../src/modules/writing-style/service.js";
import { composeWritingStyleBlock } from "../src/modules/writing-style/compose.js";
import { DocWriterAgentDispatcher } from "../src/modules/subagents/doc-writer-dispatcher.js";
import type { SubagentOrchestrator } from "../src/modules/subagents/orchestrator.js";

const temporaryDirectories: string[] = [];
const databases: DatabaseClient[] = [];

async function setup(): Promise<{ database: DatabaseClient; service: WritingStyleService }> {
  const dir = await mkdtemp(join(tmpdir(), "nxcore-writing-style-injection-test-"));
  temporaryDirectories.push(dir);
  const database = createDatabase(join(dir, "gateway.sqlite"), resolve("drizzle"));
  databases.push(database);
  return { database, service: new WritingStyleService(database.db) };
}

afterEach(async () => {
  for (const database of databases.splice(0)) {
    try {
      database.sqlite.close();
    } catch {
      // already closed
    }
  }
  await Promise.all(temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }).catch(() => undefined)));
});

describe("composeWritingStyleBlock（§7.4 修订：单一画像文本）", () => {
  it("画像文本直接成为注入块", () => {
    const block = composeWritingStyleBlock({
      mode: "generation",
      profileText: "简洁的技术笔记体，短句收尾，少用感叹号。",
    });
    expect(block).toContain("<writing_style>");
    expect(block).toContain("简洁的技术笔记体");
  });

  it("空文本返回 null", () => {
    expect(composeWritingStyleBlock({ mode: "generation", profileText: null })).toBeNull();
    expect(composeWritingStyleBlock({ mode: "generation", profileText: "   " })).toBeNull();
  });

  it("补全档预算 350，超长按句末边界截断（不切半句）", () => {
    const sentences = "这是第一句完整表达的意思。".repeat(40); // 14 字/句，560 字
    const block = composeWritingStyleBlock({ mode: "completion", profileText: sentences });
    const body = block!.replace(/^<writing_style>\n/, "").replace(/\n<\/writing_style>$/, "");
    expect(body).toContain("这是第一句完整表达的意思");
    expect(body).not.toContain("…");
    expect(body.length).toBeLessThanOrEqual(350);
    expect(body.endsWith("。")).toBe(true);
  });

  it("无句读的长文本硬切加省略号", () => {
    const block = composeWritingStyleBlock({ mode: "completion", profileText: "风".repeat(500) });
    const body = block!.replace(/^<writing_style>\n/, "").replace(/\n<\/writing_style>$/, "");
    expect(body.endsWith("…")).toBe(true);
    expect(body.length).toBeLessThanOrEqual(350);
  });
});

describe("WritingStyleService 生成注入段", () => {
  it("开关关闭时返回 null（关闭 = 不注入）", async () => {
    const { service } = await setup();
    service.replaceUserContent("简洁技术笔记体。");
    expect(service.getGenerationPromptSection()).toBeNull();
  });

  it("开关开启时注入当前画像文本（系统生成或用户编辑的版本）", async () => {
    const { database, service } = await setup();
    seedDocument(database, "doc-1", "room-1", "风控");
    service.extractDocument("doc-1", "room-1", 1);
    await service.refreshProfile();
    // 未接管：refresh 自动维护的画像文本进入注入。
    const auto = service.getProfileText();
    expect(auto.userEdited).toBe(false);
    expect(auto.content.length).toBeGreaterThan(0);
    service.updateSettings({ generationEnabled: true });
    const autoSection = service.getGenerationPromptSection();
    expect(autoSection).toContain("<writing_style>");

    // 用户编辑接管后：注入用户版本；系统再沉淀不覆盖。
    service.replaceUserContent("我要的风格：冷静克制，多用短句。");
    const edited = service.getProfileText();
    expect(edited.userEdited).toBe(true);
    expect(edited.systemUpdateAvailable).toBe(false);
    seedDocument(database, "doc-2", "room-1", "风控");
    service.extractDocument("doc-2", "room-1", 1);
    await service.refreshProfile();
    expect(service.getProfileText().content).toBe("我要的风格：冷静克制，多用短句。");
    expect(service.getProfileText().systemUpdateAvailable).toBe(true);
    expect(service.getGenerationPromptSection()).toContain("我要的风格");
  });

  it("regenerate 解除接管并恢复系统自动维护", async () => {
    const { database, service } = await setup();
    seedDocument(database, "doc-1", "room-1", "风控");
    service.extractDocument("doc-1", "room-1", 1);
    await service.refreshProfile();
    service.replaceUserContent("我的手动版本。");
    const regenerated = service.regenerateProfileText();
    expect(regenerated.userEdited).toBe(false);
    expect(regenerated.content).not.toBe("我的手动版本。");
    expect(service.getProfileText().systemUpdateAvailable).toBe(false);
  });
});

describe("DocWriterAgentDispatcher 划词改写注入（M2 迁移：rewrite 归 doc-writer）", () => {
  function stubOrchestrator(): { orchestrator: SubagentOrchestrator; inputs: Array<Record<string, unknown>> } {
    const inputs: Array<Record<string, unknown>> = [];
    const orchestrator = {
      dispatch: async (input: Record<string, unknown>) => {
        inputs.push(input);
        return { id: "invocation-1", status: "completed" } as never;
      },
      startDetached: async (input: Record<string, unknown>) => {
        inputs.push(input);
        return "invocation-1";
      },
    } as unknown as SubagentOrchestrator;
    return { orchestrator, inputs };
  }

  it("rewrite dispatch 注入 writingStyle 且改派 doc-writer", async () => {
    const { orchestrator, inputs } = stubOrchestrator();
    const dispatcher = new DocWriterAgentDispatcher(orchestrator, {
      getGenerationPromptSection: () => "<writing_style>\n用户明确要求：少用感叹号\n</writing_style>",
    });
    await dispatcher.dispatchDetached({ task: "rewrite", taskInput: { selectedText: "原文" } });
    const dispatched = inputs[0]!;
    expect(dispatched).toMatchObject({ agentId: "doc-writer", source: "internal_workflow" });
    expect((dispatched.input as Record<string, unknown>).writingStyle).toContain("少用感叹号");
    expect((dispatched.input as Record<string, unknown>).task).toBe("rewrite");
  });

  it("provider 返回 null 时不注入字段", async () => {
    const { orchestrator, inputs } = stubOrchestrator();
    const dispatcher = new DocWriterAgentDispatcher(orchestrator, {
      getGenerationPromptSection: () => null,
    });
    await dispatcher.dispatchDetached({ task: "rewrite", taskInput: { selectedText: "原文" } });
    expect(inputs[0]?.input).not.toHaveProperty("writingStyle");
  });

  it("注入 writingStyle 后派发载荷必须通过 doc-writer input schema 真实校验（回归：2026-09-01 线上 subagent_input_schema_invalid）", async () => {
    const schema = JSON.parse(readFileSync(
      join(process.cwd(), "..", "..", "agents", "doc-writer", "schemas", "input.schema.json"),
      "utf8",
    )) as Record<string, unknown>;
    const ajv = new Ajv({ strict: false, allErrors: true });
    const validate = ajv.compile(schema);
    const { orchestrator, inputs } = stubOrchestrator();
    const dispatcher = new DocWriterAgentDispatcher(orchestrator, {
      getGenerationPromptSection: () => "<writing_style>\n少用感叹号\n</writing_style>",
    });
    // 覆盖 REST 路由会传入的全部字段（routes.ts selection-rewrite body 的完整形态，M2 改派后）。
    await dispatcher.dispatchDetached({
      task: "rewrite",
      taskInput: {
        selectedText: "原文",
        instruction: "更正式一点",
        contextBefore: "选区之前的上下文",
        contextAfter: "选区之后的上下文",
        blockType: "paragraph",
        roomId: "room-1",
        documentName: "会议纪要",
        responseLanguage: "zh-CN",
      },
    });
    const input = inputs[0]?.input;
    expect(input).toHaveProperty("writingStyle");
    expect(validate(input)).toBe(true);
  });
});

describe("document_draft 组装注入（doc-writer-subagent-plan §7 迁移：四信号门已退役）", () => {
  it("注入 writingStyle 后 draft-edit 组装载荷必须通过 doc-writer 真实 input schema", () => {
    const schema = JSON.parse(readFileSync(
      join(process.cwd(), "..", "..", "agents", "doc-writer", "schemas", "input.schema.json"),
      "utf8",
    )) as Record<string, unknown>;
    const ajv = new Ajv({ strict: false, allErrors: true });
    const validate = ajv.compile(schema);
    // document_draft handler 对 draft-edit 会组装的完整字段形态（§4 步骤 1）。
    const payload = {
      task: "draft-edit",
      instruction: "把结论部分改得更果断",
      documentId: "doc-1",
      documentName: "周报",
      documentMarkdown: "# 周报\n\n## 本周进展\n\n完成了文档写作子 Agent 的接线。",
      blockIndex: [{ blockId: "b1", type: "heading", ordinal: 1, textPreview: "周报" }],
      outline: ["周报", "本周进展"],
      baseVersion: 3,
      writingStyle: "<writing_style>\n冷静克制，多用短句。\n</writing_style>",
      responseLanguage: "zh-CN",
    };
    expect(validate(payload)).toBe(true);
  });

  it("draft-create 与 rewrite 载荷同样通过 schema（material 与选区字段形态）", () => {
    const schema = JSON.parse(readFileSync(
      join(process.cwd(), "..", "..", "agents", "doc-writer", "schemas", "input.schema.json"),
      "utf8",
    )) as Record<string, unknown>;
    const ajv = new Ajv({ strict: false, allErrors: true });
    const validate = ajv.compile(schema);
    expect(validate({
      task: "draft-create",
      instruction: "起草一份接口设计文档",
      material: "素材摘录……",
      roomTitle: "工程实践",
      writingStyle: "<writing_style>\n短句收尾。\n</writing_style>",
    })).toBe(true);
    expect(validate({
      task: "rewrite",
      instruction: "更正式一点",
      selectedText: "原文片段",
      contextBefore: "之前的上下文",
      contextAfter: "之后的上下文",
      blockType: "paragraph",
      writingStyle: "<writing_style>\n短句收尾。\n</writing_style>",
    })).toBe(true);
  });
});

function seedDocument(
  database: DatabaseClient,
  id: string,
  roomId: string,
  seed: string,
): void {
  const parts: string[] = [];
  for (let i = 0; i < 40; i += 1) {
    parts.push(`${seed}${seed}模块的接口设计遵循渐进披露原则，先给出最小可用集合，再按需补充高级选项与回退说明。`);
  }
  const contentJson = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: parts.join("") }] }] };
  const now = new Date();
  database.db.insert(documents).values({
    id, title: id, contentJson, contentSchemaVersion: 3, version: 1, status: "active", createdAt: now, updatedAt: now,
  }).run();
  database.db.insert(roomDocumentLinks).values({ roomId, documentId: id, linkedAt: now }).run();
  database.db.insert(documentVersions).values({
    id: `${id}-v1`, documentId: id, version: 1, title: id, contentJson, contentSchemaVersion: 3,
    sourceTransactionId: null, createdAt: now,
  }).run();
}
