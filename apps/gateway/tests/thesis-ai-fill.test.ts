import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createDatabase } from "../src/infrastructure/database/client.js";
import { ThesisFormatService } from "../src/modules/thesis-format/service.js";
import type { SubagentOrchestrator } from "../src/modules/subagents/orchestrator.js";

/**
 * 「AI 补写空白小节」开关必须**在映射阶段**就落到卡片上：
 * 补写判断发生在 mapWithProfile 里，如果只在渲染卡片时才加 aiFill，
 * 代理永远不会被调用——用户勾了勾选框却什么都没发生。
 */

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true, maxRetries: 5 })));
});

const CARD = {
  cardMeta: { parsedAt: new Date().toISOString(), sourceName: "模板.docx" },
  page: { widthMm: 210, heightMm: 297, marginTopMm: 25, marginBottomMm: 25, marginLeftMm: 30, marginRightMm: 25, gutterMm: 0, orientation: "portrait" },
  base: { font: { eastAsia: "宋体", ascii: "Times New Roman", size: 12 }, lineSpacing: { mode: "multiple", value: 1.5 } },
  header: { enabled: false },
  footer: { enabled: false, pageNumber: { enabled: false } },
  headings: [],
  abstract: {},
  toc: { enabled: true },
  references: {},
  cover: {},
  fixedTexts: {},
  profile: {
    version: 3,
    mode: "template-first",
    sourceName: "模板.docx",
    slots: [
      { id: "slot-1", kind: "body", title: "一、项目任务", matchKey: { normalized: "一项目任务", tokens: ["项目", "任务"] }, level: 1, styleKey: "heading1", emitTemplateTitle: false, capacity: "many", order: 0 },
      { id: "slot-2", kind: "body", title: "七、项目总结与展望", matchKey: { normalized: "七项目总结与展望", tokens: ["项目", "总结"] }, level: 1, styleKey: "heading1", emitTemplateTitle: false, capacity: "many", order: 1 },
    ],
    fixed: { numbering: { scheme: "none", levels: [] }, fixedBlocks: [] },
    gaps: [],
  },
};

describe("AI 补写开关", () => {
  it("勾选后开关在映射阶段生效，补写内容进入装订规格", async () => {
    const dir = await mkdtemp(join(tmpdir(), "everroom-ai-fill-"));
    dirs.push(dir);
    const database = createDatabase(join(dir, "gateway.sqlite"), resolve("drizzle"));
    const captured: { formatCard?: { profile?: { aiFill?: boolean } }; bindingSpec?: { generatedSections?: Array<{ title: string; text: string }> } } = {};

    const orchestrator = {
      listDefinitions: () => [{ id: "thesis-formatter" }],
      dispatch: async (request: { input: { task?: string } }) => {
        const task = request.input?.task;
        if (task === "fill_sections") {
          return {
            status: "completed",
            result: {
              structuredOutput: {
                generatedSections: [
                  { title: "项目总结与展望", text: "本项目完成了任务说明所述的工作，并形成了可交付成果与测试报告。" },
                ],
              },
            },
          };
        }
        return { status: "completed", result: { structuredOutput: { decisions: [] } } };
      },
    } as unknown as SubagentOrchestrator;

    const bridge = {
      describeThesisDocx: async () => ({
        outline: [
          { index: 0, kind: "heading", level: 1, text: "一、项目任务" },
          { index: 1, kind: "paragraph", text: "源正文：任务说明。" },
        ],
        blockCount: 2,
      }),
      reformatThesisDocx: async (request: unknown) => {
        Object.assign(captured, request);
        return { docxBase64: "QQ==", warnings: [], diagnostics: null };
      },
    };

    const files = {
      dataDirectory: () => dir,
      catalogEntry: () => ({ id: "f1", originalName: "源论文.docx" }),
      catalogStoragePathOf: () => join(dir, "source.docx"),
      catalogEntriesByName: () => [],
    } as never;

    await writeFile(join(dir, "source.docx"), Buffer.from("PK\u0003\u0004"));
    const service = new ThesisFormatService({
      db: database.db,
      files,
      orchestrator,
      officeBridge: bridge as never,
    });
    const row = service.cardStore().upsert({
      workspaceId: "ws-1",
      card: CARD as never,
      sourceFileEntryId: "f1",
      sourceName: "模板.docx",
    });
    await (service as unknown as { writeTemplateCache: (id: string, bytes: Buffer) => Promise<void> })
      .writeTemplateCache(row.id, Buffer.from("PK\u0003\u0004"));

    await service.reformat("ws-1", "f1", row.id, { aiFill: true });

    expect(captured.formatCard?.profile?.aiFill).toBe(true);
    expect(captured.bindingSpec?.generatedSections?.[0]?.title).toBe("七、项目总结与展望");
  });
});

describe('AI 补写候选项：模版正文小节（不在剖面里）', () => {
  it('自动编号小节（实验目的/实验步骤）也会进补写列表', async () => {
    const { pickFillSectionTitles } = await import("../src/modules/thesis-format/service.js");
    const picked = pickFillSectionTitles([
      { kind: "heading", level: 1, text: "实验一 闪烁灯" },
      { kind: "list", text: "实验目的" },
      { kind: "list", text: "实验仪器与工具" },
      { kind: "list", text: "实验步骤" },
      { kind: "heading", level: 3, text: "1.1.1 任务概述" },
      { kind: "list", text: "五、在实验室内不准喧哗、打闹、吸烟和吃食物，不准乱吐乱丢杂物。" },
      { kind: "heading", level: 1, text: "目    录" },
      { kind: "heading", level: 1, text: "参考文献" },
      { kind: "paragraph", text: "2024   — 2025   学年第一学期" },
    ]).map((entry) => entry.title);
    expect(picked).toContain("实验目的");
    expect(picked).toContain("实验仪器与工具");
    expect(picked).toContain("实验步骤");
    expect(picked).toContain("1.1.1 任务概述");
    expect(picked).not.toContain("目    录");
    expect(picked).not.toContain("参考文献");
    // 守则整句、学年行都不是章节
    expect(picked.some((title) => title.includes("不准喧哗"))).toBe(false);
    expect(picked.some((title) => title.includes("学年第一学期"))).toBe(false);
  });
});
