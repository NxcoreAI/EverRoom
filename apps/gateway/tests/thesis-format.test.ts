import { join, resolve } from "node:path";
import Fastify from "fastify";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { describe, expect, it, vi } from "vitest";
import { createDatabase } from "../src/infrastructure/database/client.js";
import { SubagentRegistry } from "../src/modules/subagents/registry.js";
import { ThesisFormatCardStore } from "../src/modules/thesis-format/card-store.js";
import { validateThesisFormatCard } from "../src/modules/thesis-format/validate.js";
import { extractOoxmlFactsAsync } from "../src/modules/thesis-format/ooxml-facts.js";
import { ThesisFormatService, cardForAgent, factsForAgent } from "../src/modules/thesis-format/service.js";
import { mergeTemplateImages } from "../src/modules/thesis-format/template-images.js";
import { buildTemplateProfile } from "../src/modules/thesis-format/template-profile.js";
import { buildContentProfile, flattenChapters, type ContentProfile, type OutlineBlock } from "../src/modules/thesis-format/content-profile.js";
import { buildMappingPlan, sanitizeMappingDecisions } from "../src/modules/thesis-format/mapping-plan.js";
import { thesisFormatRoutes } from "../src/modules/thesis-format/routes.js";
import { planToBindingSpec } from "../src/modules/thesis-format/plan-to-spec.js";
import type { TemplateProfile } from "../src/modules/thesis-format/template-profile.js";
import JSZip from "jszip";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";

const logger = { info: () => undefined, warn: () => undefined };

/** 仓库 agents/ 目录的 thesis-formatter 包必须能被注册器完整加载（守卫 agent.yaml/schema 改坏）。 */
describe("thesis-formatter agent bundle", () => {
  it("loads from the repository agents directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "everroom-thesis-agents-"));
    try {
      const database = createDatabase(join(root, "gateway.sqlite"), resolve("drizzle"));
      const registry = new SubagentRegistry(database.db, {
        enabled: true,
        definitionsDir: resolve(join(process.cwd(), "..", "..", "agents")),
        runtimeDir: join(root, "runtime"),
        defaultTimeoutMs: 30_000,
        maxConcurrent: 4,
      }, { search: { url: "https://mcp.example.test", headers: { Authorization: "test-secret" } } }, logger);
      await registry.initialize();
      const definition = registry.get("thesis-formatter");
      expect(definition).toBeTruthy();
      expect(definition?.revision.inputSchema).toBeTruthy();
      expect(definition?.revision.outputSchema).toBeTruthy();
      expect(definition?.revision.policy.allowedCallers).toContain("internal-workflow");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("ThesisFormatService adjudication cache", () => {
  it("reuses decisions for identical outlines (no second model round-trip)", async () => {
    const root = await mkdtemp(join(tmpdir(), "everroom-thesis-adjudication-cache-"));
    try {
      const database = createDatabase(join(root, "gateway.sqlite"), resolve("drizzle"));
      const service = new ThesisFormatService({
        db: database.db,
        files: {} as never,
        orchestrator: {} as never,
        officeBridge: null,
      });
      const decisions = [{ chapterTraceId: "c1", slotId: "s1", reason: "附录归附录槽位" }];
      const dispatch = vi.fn(async () => ({ decisions }));
      (service as unknown as { dispatchAgent: unknown }).dispatchAgent = dispatch;
      const profile = { slots: [{ id: "s1", title: "第一章" }] };
      const plan = {
        pendingForSemantic: [{
          chapterTraceId: "c1",
          chapterText: "附录 B 组合导航滤波流程",
          candidates: [{ slotId: "s1", score: 0.5 }],
        }],
      };
      const adjudicate = (service as unknown as {
        adjudicateMapping: (workspace: string, p: typeof profile, input: typeof plan) => Promise<unknown>;
      }).adjudicateMapping.bind(service);

      const first = await adjudicate("ws-1", profile, plan);
      const second = await adjudicate("ws-1", profile, plan);

      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(second).toEqual(first);
      expect(first).toEqual([{ chapterTraceId: "c1", slotId: "s1", reason: "附录归附录槽位" }]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("thesis job dedupe", () => {
  it("reuses the running job for the same document/card/options", async () => {
    const root = await mkdtemp(join(tmpdir(), "everroom-thesis-job-dedupe-"));
    try {
      const database = createDatabase(join(root, "gateway.sqlite"), resolve("drizzle"));
      const service = new ThesisFormatService({
        db: database.db,
        files: {} as never,
        orchestrator: {} as never,
        officeBridge: null,
      });
      let release!: () => void;
      const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
      const reformat = vi.spyOn(service, "reformat").mockImplementation(async () => {
        await gate;
        return { fileEntryId: "out-1", originalName: "out.docx" };
      });

      // 连点两次：第二次必须复用同一个作业，不能再起一个抢模型并发槽。
      const first = service.startReformatJob("ws-1", "file-1", "card-1");
      const second = service.startReformatJob("ws-1", "file-1", "card-1");
      expect(second.id).toBe(first.id);
      expect(reformat).toHaveBeenCalledTimes(1);

      release();
      await gate;
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));

      // 作业完成后同参数重跑 = 新作业（用户主动重排一次）。
      const third = service.startReformatJob("ws-1", "file-1", "card-1");
      expect(third.id).not.toBe(first.id);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("thesis-format routes", () => {
  it("serves cards by workspace path; the retired Room path is gone", async () => {
    const app = Fastify().withTypeProvider<TypeBoxTypeProvider>();
    const list = vi.fn((workspaceId: string) => [{
      id: "card-1",
      workspaceId,
      sourceName: "模版.docx",
      sourceFileEntryId: null,
      updatedAt: new Date(),
      card: {},
    }]);
    await app.register(thesisFormatRoutes({ cardStore: () => ({ list }) } as never));

    const ok = await app.inject({ method: "GET", url: "/v1/thesis-format/workspaces/ws-1/cards" });
    expect(ok.statusCode).toBe(200);
    expect(list).toHaveBeenCalledWith("ws-1");
    expect(ok.json()).toMatchObject([{ id: "card-1", sourceName: "模版.docx" }]);

    const retired = await app.inject({ method: "GET", url: "/v1/thesis-format/rooms/room-1/cards" });
    expect(retired.statusCode).toBe(404);
    await app.close();
  });
});

describe("ThesisFormatCardStore (multi-card)", () => {
  it("upserts per (workspace, sourceName), lists, resolves by id and removes", async () => {
    const root = await mkdtemp(join(tmpdir(), "everroom-thesis-cards-"));
    try {
      const database = createDatabase(join(root, "gateway.sqlite"), resolve("drizzle"));
      const store = new ThesisFormatCardStore(database.db);
      const card = () => validateThesisFormatCard({}, "模版.zip");
      const a1 = store.upsert({ workspaceId: "w1", card: card(), sourceFileEntryId: null, sourceName: "A.docx" });
      const b1 = store.upsert({ workspaceId: "w1", card: card(), sourceFileEntryId: null, sourceName: "B.docx" });
      const a2 = store.upsert({ workspaceId: "w1", card: card(), sourceFileEntryId: "entry-1", sourceName: "A.docx" });
      expect(a2.id).toBe(a1.id);
      expect(store.list("w1")).toHaveLength(2);
      expect(store.latest("w1")?.id).toBe(a2.id);
      expect(store.byId("w1", b1.id)?.sourceName).toBe("B.docx");
      expect(store.remove("w1", b1.id)).toBe(true);
      expect(store.remove("w1", b1.id)).toBe(false);
      expect(store.list("w1")).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("isolates cards by workspace (same template name in two spaces)", async () => {
    const root = await mkdtemp(join(tmpdir(), "everroom-thesis-card-workspaces-"));
    try {
      const database = createDatabase(join(root, "gateway.sqlite"), resolve("drizzle"));
      const store = new ThesisFormatCardStore(database.db);
      const card = () => validateThesisFormatCard({}, "模版.docx");
      const a = store.upsert({ workspaceId: "ws-a", card: card(), sourceFileEntryId: null, sourceName: "模版.docx" });
      const b = store.upsert({ workspaceId: "ws-b", card: card(), sourceFileEntryId: null, sourceName: "模版.docx" });

      // 同名模版在不同工作区互不覆盖、各自可见。
      expect(b.id).not.toBe(a.id);
      expect(store.list("ws-a").map((row) => row.id)).toEqual([a.id]);
      expect(store.list("ws-b").map((row) => row.id)).toEqual([b.id]);
      // 跨工作区按 id 取 / 删都不生效（工作区隔离）。
      expect(store.byId("ws-b", a.id)).toBeNull();
      expect(store.remove("ws-b", a.id)).toBe(false);
      expect(store.list("ws-a")).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("validateThesisFormatCard", () => {
  it("fills Chinese thesis defaults for an empty card", () => {
    const card = validateThesisFormatCard({}, "模版.zip");
    expect(card.page.marginTopMm).toBe(25);
    expect(card.base.font.eastAsia).toBe("宋体");
    expect(card.base.font.size).toBe(12);
    expect(card.base.paragraph.lineSpacingMultiple).toBe(1.25);
    expect(card.footer.frontMatterFormat).toBe("roman");
    expect(card.parts.map((part) => part.type)).toEqual([
      "cover", "commitment", "abstract_zh", "abstract_en", "toc",
      "chapter", "appendix", "references", "acknowledgement", "achievements",
    ]);
  });

  it("resolves Chinese size names to pt and keeps explicit values", () => {
    const card = validateThesisFormatCard({
      headings: [{ level: 1, font: { eastAsia: "黑体", ascii: "Times New Roman", size: "小二", bold: true } }],
      page: { marginTopMm: 30 },
    }, "模版.docx");
    expect(card.headings[0]?.font.size).toBe(18);
    expect(card.page.marginTopMm).toBe(30);
  });

  it("rejects invalid size values", () => {
    expect(() => validateThesisFormatCard({ base: { font: { size: "十七号" } } }, "模版.docx"))
      .toThrow(/字号非法/);
  });
});

/** 1x1 PNG (base64), header logo extraction fixture. */
const LOGO_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

/** docx fixture with a header logo: header1.xml embeds an anchor drawing + media/rels. */
async function docxWithHeaderLogo(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/></Types>',
  );
  const headerXml = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ',
    'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ',
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ',
    'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" ',
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">',
    '<w:p><w:r><w:drawing>',
    '<wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="0" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1">',
    '<wp:simplePos x="0" y="0"/>',
    '<wp:positionH relativeFrom="margin"><wp:align>center</wp:align></wp:positionH>',
    '<wp:positionV relativeFrom="margin"><wp:align>top</wp:align></wp:positionV>',
    '<wp:extent cx="381000" cy="381000"/><wp:wrapNone/><wp:docPr id="1" name="logo"/>',
    '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">',
    '<pic:pic><pic:blipFill><a:blip r:embed="rId5"/></pic:blipFill></pic:pic>',
    '</a:graphicData></a:graphic></wp:anchor></w:drawing></w:r></w:p></w:hdr>',
  ].join('');
  zip.file("word/header1.xml", headerXml);
  zip.file(
    "word/_rels/header1.xml.rels",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/logo.png"/></Relationships>',
  );
  zip.file("word/media/logo.png", Buffer.from(LOGO_PNG_BASE64, "base64"));
  return zip.generateAsync({ type: "nodebuffer" });
}

describe("ooxml-facts header images", () => {
  it("extracts header image bytes and placement facts", async () => {
    const bytes = await docxWithHeaderLogo();
    const facts = await extractOoxmlFactsAsync(bytes);
    expect(facts.headers).toHaveLength(1);
    const headerFacts = facts.headers[0]!;
    expect(headerFacts.images).toHaveLength(1);
    const image = headerFacts.images[0]!;
    expect(image.dataUrl).toMatch(/^data:image\/png;base64,/);
    expect(image.floating).toBe(true);
    expect(image.posH).toBe("center");
    expect(image.posV).toBe("top");
    expect(image.widthPx).toBe(40);
  });
});

describe("validateThesisFormatCard header images", () => {
  it("keeps valid image facts and drops dirty entries", () => {
    const card = validateThesisFormatCard(
      {
        header: {
          enabled: true,
          images: [
            { dataUrl: "data:image/png;base64," + LOGO_PNG_BASE64, widthPx: 40, heightPx: 40, floating: true, posH: "center", posVRel: "margin" },
            { dataUrl: "javascript:alert(1)" },
            "not-an-object",
          ],
        },
      },
      "template.docx",
    );
    const images = card.header.images ?? [];
    expect(images).toHaveLength(1);
    expect(images[0]!.dataUrl).toMatch(/^data:image\/png;base64,/);
    expect(images[0]!.widthPx).toBe(40);
  });

  it("gives an empty array when images are absent (no fabrication)", () => {
    const card = validateThesisFormatCard({ header: { enabled: true } }, "template.docx");
    expect(card.header.images ?? []).toEqual([]);
  });
});

/** 封面带校徽的模版：logo 在正文首个分节之前的居中段落里（不在页眉）。 */
async function docxWithCoverLogo(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/></Types>',
  );
  zip.file(
    "word/_rels/document.xml.rels",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId10" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/></Relationships>',
  );
  const document = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ',
    'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ',
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ',
    'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" ',
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>',
    '<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:drawing><wp:inline distT="0" distB="0" distL="114300" distR="114300">',
    '<wp:extent cx="5958840" cy="850265"/><wp:docPr id="2" name="图片 1" descr="学校常用标识2"/>',
    '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">',
    '<pic:pic><pic:blipFill><a:blip r:embed="rId10"/></pic:blipFill></pic:pic>',
    '</a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>',
    '<w:p><w:r><w:t>通信工程学院</w:t></w:r></w:p>',
    '<w:p><w:pPr><w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:pPr></w:p>',
    '<w:p><w:r><w:t>正文</w:t></w:r></w:p>',
    '</w:body></w:document>',
  ].join('');
  zip.file("word/document.xml", document);
  zip.file("word/media/image1.png", Buffer.from(LOGO_PNG_BASE64, "base64"));
  return zip.generateAsync({ type: "nodebuffer" });
}

describe("封面 logo 提取与确定性写入", () => {
  it("抽出封面的校徽及其尺寸/居中事实", async () => {
    const facts = await extractOoxmlFactsAsync(await docxWithCoverLogo());
    expect(facts.coverImages).toHaveLength(1);
    const logo = facts.coverImages[0]!;
    expect(logo.dataUrl).toMatch(/^data:image\/png;base64,/);
    expect(logo.widthPx).toBe(626);
    expect(logo.heightPx).toBe(89);
    expect(logo.posH).toBe("center");
    // 正文分节之后的插图不算封面元素
    expect(facts.coverImages).toHaveLength(1);
  });

  it("封面图写进 card.cover.logo，且不覆盖代理已给的值", async () => {
    const facts = {
      ooxml: [{
        name: "模版.docx",
        styles: [],
        sections: [],
        headers: [{ file: "header1.xml", text: "", images: [] }],
        footers: [],
        coverImages: [{ dataUrl: `data:image/png;base64,${LOGO_PNG_BASE64}`, widthPx: 626, heightPx: 89, posH: "center" as const }],
      }],
      documentsText: [],
    };
    const base = validateThesisFormatCard({ cover: { schoolName: "通信工程学院" } }, "模版.docx");
    const merged = mergeTemplateImages(base, facts);
    expect(merged.cover.logo?.widthPx).toBe(626);
    expect(merged.cover.logo?.posH).toBe("center");

    const kept = mergeTemplateImages(
      { ...base, cover: { ...base.cover, logo: { dataUrl: `data:image/png;base64,${LOGO_PNG_BASE64}`, widthPx: 10 } } },
      facts,
    );
    expect(kept.cover.logo?.widthPx).toBe(10);
  });

  it("facts 里没有图片时不写字段（绝不编造 logo）", () => {
    const base = validateThesisFormatCard({ cover: { schoolName: "某学院" } }, "模版.docx");
    const merged = mergeTemplateImages(base, { ooxml: [], documentsText: [] });
    expect(merged.cover.logo).toBeUndefined();
    expect(merged.header.images ?? []).toEqual([]);
  });

  it("非法 data:URL 的封面图被丢弃", () => {
    const card = validateThesisFormatCard({ cover: { logo: { dataUrl: "javascript:alert(1)" } } }, "模版.docx");
    expect(card.cover.logo).toBeUndefined();
  });
});

describe("封面文字兜底（coverText）", () => {
  const factsWithCover = (coverText: string[]) => ({
    ooxml: [{ name: "模版.docx", styles: [], sections: [], headers: [], footers: [], coverText }],
    documentsText: [],
  });

  it("代理留空时用封面文本补齐校名/文种/学年", () => {
    const base = validateThesisFormatCard({ cover: { schoolName: "" } }, "模版.docx");
    expect(base.cover.degreeLine).toBe("本科毕业论文（设计）"); // 校验层兜底值
    const merged = mergeTemplateImages(base, factsWithCover([
      "通信工程学院", "《人工智能创新创业实践》", "课程考核报告", "2026-2027学年第一学期",
    ]));
    expect(merged.cover.schoolName).toBe("通信工程学院");
    expect(merged.cover.degreeLine).toBe("课程考核报告");
    expect(merged.cover.yearLine).toBe("2026-2027学年第一学期");
  });

  it("代理已给出的封面字段不被覆盖", () => {
    const base = validateThesisFormatCard(
      { cover: { schoolName: "嘉应学院", degreeLine: "本科毕业论文（设计）" } },
      "模版.docx",
    );
    const merged = mergeTemplateImages(base, factsWithCover(["通信工程学院", "课程考核报告"]));
    expect(merged.cover.schoolName).toBe("嘉应学院");
  });

  it("coverText 为空时保持原样（不编造）", () => {
    const base = validateThesisFormatCard({ cover: { schoolName: "" } }, "模版.docx");
    const merged = mergeTemplateImages(base, factsWithCover([]));
    expect(merged.cover.schoolName).toBe("");
    expect(merged.cover.yearLine).toBe("");
  });
});

describe("factsForAgent 剥离图片字节", () => {
  it("代理输入里没有任何 data:URL，但保留尺寸与版位元信息", () => {
    const facts = {
      ooxml: [{
        name: "模版.docx",
        styles: [],
        sections: [],
        headers: [{ file: "header1.xml", text: "", images: [{ dataUrl: `data:image/png;base64,${LOGO_PNG_BASE64}`, widthPx: 40, heightPx: 40 }] }],
        footers: [],
        coverImages: [{ dataUrl: `data:image/png;base64,${LOGO_PNG_BASE64}`, widthPx: 626, heightPx: 89, posH: "center" as const }],
        coverText: ["通信工程学院"],
      }],
      documentsText: [{ name: "模版.docx", text: "正文" }],
    };
    const forAgent = factsForAgent(facts) as { ooxml: Array<Record<string, unknown>> };
    const serialized = JSON.stringify(forAgent);
    expect(serialized).not.toContain("data:image");
    expect(serialized).not.toContain(LOGO_PNG_BASE64);
    const member = forAgent.ooxml[0]!;
    expect((member.coverImages as Array<Record<string, unknown>>)[0]).toMatchObject({ hasBytes: true, widthPx: 626, posH: "center" });
    expect(member.coverText).toEqual(["通信工程学院"]);
    expect(member.styles).toEqual([]);
  });
});

describe("cardForAgent 剥离卡片里的图片字节", () => {
  it("封面 logo 与页眉图只留元信息，别处字段原样", () => {
    const card = validateThesisFormatCard({
      cover: { schoolName: "广州城市理工学院", logo: { dataUrl: `data:image/png;base64,${LOGO_PNG_BASE64}`, widthPx: 626, heightPx: 89, posH: "center" } },
      header: { enabled: true, images: [{ dataUrl: `data:image/png;base64,${LOGO_PNG_BASE64}`, widthPx: 40, heightPx: 40 }] },
    }, "模版.docx");
    const forAgent = cardForAgent(card) as { cover: Record<string, unknown>; header: Record<string, unknown> };
    const serialized = JSON.stringify(forAgent);
    expect(serialized).not.toContain("data:image");
    expect(forAgent.cover.schoolName).toBe("广州城市理工学院");
    expect(forAgent.cover.logo).toMatchObject({ hasBytes: true, widthPx: 626, posH: "center" });
    expect((forAgent.header.images as Array<Record<string, unknown>>)[0]).toMatchObject({ widthPx: 40 });
    // 原卡不受影响（回填仍用带字节的版本）
    expect(card.cover.logo?.dataUrl).toContain("data:image/png");
  });
});

/** 带章节骨架 + 中文编号的模板：验证 outline/numbering 抽取。 */
async function docxWithOutline(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/></Types>',
  );
  zip.file(
    "word/styles.xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
    + '<w:style w:type="paragraph" w:styleId="1"><w:name w:val="heading 1"/><w:pPr><w:outlineLvl w:val="0"/><w:numPr><w:numId w:val="3"/></w:numPr></w:pPr></w:style>'
    + '<w:style w:type="paragraph" w:styleId="2"><w:name w:val="heading 2"/><w:pPr><w:outlineLvl w:val="1"/></w:pPr></w:style>'
    + '<w:style w:type="paragraph" w:styleId="a"><w:name w:val="Normal"/></w:style>'
    + '</w:styles>',
  );
  zip.file(
    "word/numbering.xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
    + '<w:abstractNum w:abstractNumId="7">'
    + '<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="chineseCounting"/><w:lvlText w:val="%1、"/><w:pPr><w:ind w:firstLine="420"/></w:pPr></w:lvl>'
    + '<w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1.%2"/></w:lvl>'
    + '</w:abstractNum>'
    + '<w:num w:numId="3"><w:abstractNumId w:val="7"/></w:num>'
    + '</w:numbering>',
  );
  const paragraph = (styleId: string, text: string) =>
    `<w:p><w:pPr><w:pStyle w:val="${styleId}"/></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`;
  zip.file(
    "word/document.xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
    + paragraph("a", "封面标题")
    + '<w:p><w:pPr><w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:pPr></w:p>'
    + paragraph("1", "一、项目任务")
    + paragraph("2", "1.1 背景")
    + paragraph("a", "正文段落")
    + paragraph("1", "二、项目需求分析")
    + paragraph("a", "参考资料")
    + paragraph("1", "参考资料")
    + '</w:body></w:document>',
  );
  return zip.generateAsync({ type: "nodebuffer" });
}

describe("模板正文大纲与编号方案（M1 模板剖面）", () => {
  it("抽出章节骨架：层级、文本、封面区标记", async () => {
    const facts = await extractOoxmlFactsAsync(await docxWithOutline());
    const outline = facts.outline;
    expect(outline.map((entry) => `${entry.level}:${entry.text}`)).toEqual([
      "1:一、项目任务",
      "2:1.1 背景",
      "1:二、项目需求分析",
      "1:参考资料",
    ]);
    expect(outline[0]!.styleId).toBe("1");
    expect(outline.every((entry) => entry.inCoverRegion === false)).toBe(true);
  });

  it("识别中文一级编号方案", async () => {
    const facts = await extractOoxmlFactsAsync(await docxWithOutline());
    expect(facts.numbering.scheme).toBe("cn-upper");
    expect(facts.numbering.headingNumId).toBe(3);
    expect(facts.numbering.levels[0]).toMatchObject({ level: 1, numFmt: "chineseCounting", lvlText: "%1、", start: 1 });
  });

  it("无 numbering.xml 时 scheme = none（不编造）", async () => {
    const zip = new JSZip();
    zip.file(
      "[Content_Types].xml",
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/></Types>',
    );
    zip.file(
      "word/styles.xml",
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="1"><w:name w:val="heading 1"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style></w:styles>',
    );
    zip.file(
      "word/document.xml",
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="1"/></w:pPr><w:r><w:t>一、项目任务</w:t></w:r></w:p></w:body></w:document>',
    );
    const facts = await extractOoxmlFactsAsync(await zip.generateAsync({ type: "nodebuffer" }));
    expect(facts.numbering.scheme).toBe("none");
    expect(facts.numbering.levels).toEqual([]);
    expect(facts.outline).toHaveLength(1);
  });
});

describe("TemplateProfile（M1：固定元素 + 槽位骨架）", () => {
  const cardOf = (overrides: Record<string, unknown> = {}) =>
    validateThesisFormatCard(overrides, "模版.docx");

  it("模板章节 → 槽位：锚点升级为固定槽位，其余为 body 且可扩展", async () => {
    const facts = await extractOoxmlFactsAsync(await docxWithOutline());
    const profile = buildTemplateProfile({ facts, card: cardOf(), sourceName: "模版.docx" });
    expect(profile.version).toBe(3);
    expect(profile.slots.map((slot) => `${slot.kind}:${slot.title}`)).toEqual([
      "body:一、项目任务",
      "body:二、项目需求分析",
      "reference:参考资料",
    ]);
    // 锚点槽位保留模板原标题；body 槽位用内容标题
    expect(profile.slots[2]!.emitTemplateTitle).toBe(true);
    expect(profile.slots[0]!.emitTemplateTitle).toBe(false);
    expect(profile.slots[0]!.capacity).toBe("many");
    // 匹配特征已归一化（剥掉「一、」）
    expect(profile.slots[0]!.matchKey.normalized).toBe("项目任务");
    expect(profile.slots[0]!.matchKey.tokens.length).toBeGreaterThan(0);
  });

  it("编号方案与页面一起进 fixed；样式锁覆盖题注/列表等语义键", async () => {
    const facts = await extractOoxmlFactsAsync(await docxWithOutline());
    const profile = buildTemplateProfile({ facts, card: cardOf(), sourceName: "模版.docx" });
    expect(profile.fixed.numbering.scheme).toBe("cn-upper");
    expect(profile.fixed.page.widthMm).toBeGreaterThan(0);
    for (const key of ["body", "h1", "h2", "caption", "tableText", "listItem", "formula"]) {
      expect(profile.fixed.styles[key]).toBeDefined();
    }
    // 模板没定义题注样式 → 回退正文但必须记 gap（不静默）
    expect(profile.fixed.styles.caption!.origin).toBe("default");
    expect(profile.gaps.some((gap) => gap.includes("caption"))).toBe(true);
  });

  it("封面 logo 进入 fixed.logos 且角色为 cover", async () => {
    const facts = await extractOoxmlFactsAsync(await docxWithCoverLogo());
    const card = validateThesisFormatCard({}, "模版.docx");
    const profile = buildTemplateProfile({
      facts,
      card: { ...card, cover: { ...card.cover, logo: facts.coverImages[0]! } },
      sourceName: "模版.docx",
    });
    expect(profile.fixed.logos.some((logo) => logo.role === "cover" && logo.widthPx === 626)).toBe(true);
  });

  it("模板没有章节骨架时降级并记 gap", async () => {
    const facts = await extractOoxmlFactsAsync(await docxWithCoverLogo());
    const profile = buildTemplateProfile({ facts, card: cardOf(), sourceName: "规范.docx" });
    expect(profile.slots).toEqual([]);
    expect(profile.gaps.some((gap) => gap.includes("章节标题"))).toBe(true);
  });
});

describe("ContentProfile（M2：内容剖面）", () => {
  /** 贴近真实：一、/1.1 混排 + 图表题注 + 参考文献锚点。 */
  const outline = (): OutlineBlock[] => [
    { index: 0, kind: "heading", level: 2, text: "一、业务场景分析" },
    { index: 1, kind: "heading", level: 3, text: "1.1 政策与业务背景" },
    { index: 2, kind: "paragraph", text: "近年来……" },
    { index: 3, kind: "heading", level: 3, text: "1.2 业务痛点（场景化）" },
    { index: 4, kind: "list", text: "痛点一" },
    { index: 5, kind: "image", text: "" },
    { index: 6, kind: "paragraph", text: "图 1 系统架构示意" },
    { index: 7, kind: "heading", level: 2, text: "二、需求梳理" },
    { index: 8, kind: "table", text: "" },
    { index: 9, kind: "paragraph", text: "表 1 功能需求清单" },
    { index: 10, kind: "heading", level: 2, text: "参考文献" },
    { index: 11, kind: "paragraph", text: "[1] 张三. 论文排版[J]. 2024." },
  ];

  it("标题剥离编号并归一化，保留原编号与体系", () => {
    const profile = buildContentProfile(outline());
    const first = profile.blocks[0]!;
    expect(first.normalized).toBe("业务场景分析");
    expect(first.originalNumber).toBe("一、");
    expect(first.numberingFamily).toBe("cn");
    expect(first.tokens).toContain("业务");
    const sub = profile.blocks[1]!;
    expect(sub.normalized).toBe("政策与业务背景");
    expect(sub.originalNumber).toBe("1.1");
    expect(sub.numberingFamily).toBe("decimal");
  });

  it("角色按相对深度推断：原始 H2→chapter、H3→section", () => {
    const profile = buildContentProfile(outline());
    expect(profile.blocks[0]!.role).toBe("chapter");
    expect(profile.blocks[1]!.role).toBe("section");
    expect(profile.blocks[2]!.role).toBe("body");
  });

  it("识别参考文献锚点与图表题注配对", () => {
    const profile = buildContentProfile(outline());
    expect(profile.anchors.reference).toBe("b10");
    expect(profile.blocks[6]!.isCaption).toBe(true);
    expect(profile.blocks[6]!.captionOf).toBe("b5");
    expect(profile.blocks[9]!.captionOf).toBe("b8");
    // 非紧邻的"图 x"文本不算题注
    expect(profile.blocks[2]!.isCaption).toBeUndefined();
  });

  it("章节树带块区间与父子关系", () => {
    const profile = buildContentProfile(outline());
    const chapters = flattenChapters(profile);
    const first = profile.outline[0]!;
    expect(first.text).toBe("一、业务场景分析");
    expect(first.children.map((child) => child.normalized)).toEqual(["政策与业务背景", "业务痛点场景化"]); // 归一化会去掉括号
    // 第一章子树覆盖 [0,7)：到"二、需求梳理"之前
    expect(first.blockStart).toBe(0);
    expect(first.blockEnd).toBe(7);
    expect(chapters.map((node) => node.normalized)).toEqual([
      "业务场景分析", "政策与业务背景", "业务痛点场景化", "需求梳理", "参考文献",
    ]);
    // 每个块都能指回所属章节
    expect(profile.blocks[5]!.chapterTraceId).toBe("b0");
    expect(profile.blocks[11]!.chapterTraceId).toBe("b10");
  });

  it("无标题文档记 gap 且全部为 body 角色", () => {
    const profile = buildContentProfile([{ index: 0, kind: "paragraph", text: "纯正文" }]);
    expect(profile.outline).toEqual([]);
    expect(profile.blocks[0]!.role).toBe("body");
    expect(profile.gaps.some((gap) => gap.includes("没有标题层级"))).toBe(true);
  });
});

describe("MappingPlan（M3：映射引擎）", () => {
  const templateProfile = (titles: string[]): TemplateProfile => buildTemplateProfile({
    facts: {
      styles: [], sections: [], headers: [], footers: [], coverImages: [], coverText: [],
      outline: titles.map((text, index) => ({ index, level: 1, text, inCoverRegion: false })),
      numbering: { scheme: "cn-upper", levels: [] },
      fixedBlocks: [],
    },
    card: validateThesisFormatCard({}, "模版.docx"),
    sourceName: "模版.docx",
  });

  const contentOf = (titles: Array<[number, string]>): ContentProfile =>
    buildContentProfile(titles.map(([level, text], index) => ({ index, kind: "heading" as const, level, text }))
      .flatMap((heading, position) => [heading, { index: position * 2 + 1, kind: "paragraph" as const, text: `正文${position}` }]));

  it("锚点直达固定槽位（参考资料 → reference）", () => {
    const plan = buildMappingPlan({
      template: templateProfile(["一、项目任务", "参考资料", "附录"]),
      content: contentOf([[1, "一、项目任务"], [1, "参考资料"]]),
    });
    const reference = plan.assignments.find((entry) => entry.kind === "reference");
    expect(reference?.rule).toBe("R0-anchor");
    expect(reference?.headingText).toBe("参考资料"); // 固定槽位保留模板标题
    expect(plan.conservation.matched + plan.conservation.unmatched).toBe(plan.conservation.total);
  });

  it("章节名对不上时按顺序对齐（R2）而不是丢内容", () => {
    const plan = buildMappingPlan({
      template: templateProfile(["一、项目任务", "二、项目需求分析", "三、项目系统设计"]),
      content: contentOf([[1, "一、业务场景分析"], [1, "二、需求梳理"], [1, "三、功能模块划分"]]),
    });
    expect(plan.assignments.map((entry) => entry.rule)).toEqual(["R2-order", "R2-order", "R2-order"]);
    expect(plan.conservation.matched).toBe(plan.conservation.total);
    expect(plan.report.appendedChapters).toBe(0);
  });

  it("源章节多于模板槽位：多出的追加到正文末尾（R4），不丢", () => {
    const plan = buildMappingPlan({
      template: templateProfile(["一、项目任务", "二、需求分析"]),
      content: contentOf([[1, "一、业务场景分析"], [1, "二、需求梳理"], [1, "三、功能模块划分"]]),
    });
    const appended = plan.assignments.filter((entry) => entry.rule === "R4-append");
    expect(appended).toHaveLength(1);
    expect(appended[0]!.headingText).toBe("三、功能模块划分");
    expect(appended[0]!.notes.join()).toContain("追加");
    expect(plan.report.appendedChapters).toBe(1);
  });

  it("源章节少于模板槽位：不硬塞空章节", () => {
    const plan = buildMappingPlan({
      template: templateProfile(["一、项目任务", "二、项目需求分析", "三、项目系统设计"]),
      content: contentOf([[1, "一、业务场景分析"]]),
    });
    expect(plan.assignments).toHaveLength(1);
    expect(plan.conservation.total - plan.conservation.matched).toBe(0);
  });

  it("首标题之前的散块进 R5 未匹配，就近挂到槽位且计数守恒", () => {
    const content = buildContentProfile([
      { index: 0, kind: "paragraph", text: "前置说明" },
      { index: 1, kind: "heading", level: 1, text: "一、项目任务" },
      { index: 2, kind: "paragraph", text: "正文" },
    ]);
    const plan = buildMappingPlan({ template: templateProfile(["一、项目任务"]), content });
    expect(plan.unmatched).toHaveLength(1);
    expect(plan.unmatched[0]!.reason).toBe("orphan-block");
    expect(plan.unmatched[0]!.blockRange).toEqual([0, 1]);
    expect(plan.conservation).toMatchObject({ matched: 2, unmatched: 1, total: 3 });
    expect(plan.report.unmatchedBlocks).toBe(1);
  });

  it("模糊匹配按相似度打分（R3）并给出低置信提示", () => {
    const plan = buildMappingPlan({
      template: templateProfile(["二、项目需求分析"]),
      content: contentOf([[1, "项目需求分析"]]),
    });
    const assignment = plan.assignments[0]!;
    expect(assignment.rule).toBe("R1-title"); // 归一化后完全相同 → 精确命中
    expect(assignment.confidence).toBe(0.95);
  });

  it("守恒断言：人为制造未覆盖块会导致计数不等而抛错", () => {
    // 用一个"章节区间不连续"的内容：两个章节之间夹着无标题块，必须被 R5 收走
    const content = buildContentProfile([
      { index: 0, kind: "heading", level: 1, text: "一、项目任务" },
      { index: 1, kind: "paragraph", text: "正文" },
      { index: 2, kind: "table", text: "" },
      { index: 3, kind: "heading", level: 1, text: "二、需求梳理" },
      { index: 4, kind: "paragraph", text: "正文2" },
    ]);
    const plan = buildMappingPlan({ template: templateProfile(["一、项目任务", "二、需求梳理"]), content });
    expect(plan.conservation.matched + plan.conservation.unmatched).toBe(5);
    expect(plan.unmatched).toEqual([]); // 表格在章节区间内 → 已被覆盖
  });
});

describe("MappingPlan 低置信区间与代理裁决钩子", () => {
  const templateProfile = (titles: string[]): TemplateProfile => buildTemplateProfile({
    facts: {
      styles: [], sections: [], headers: [], footers: [], coverImages: [], coverText: [],
      outline: titles.map((text, index) => ({ index, level: 1, text, inCoverRegion: false })),
      numbering: { scheme: "cn-upper", levels: [] },
      fixedBlocks: [],
    },
    card: validateThesisFormatCard({}, "模版.docx"),
    sourceName: "模版.docx",
  });

  it("字面吃不准但不算无关时，产出待裁决配对；顺序对齐仍兜底", () => {
    const content = buildContentProfile([
      { index: 0, kind: "heading", level: 1, text: "二、需求梳理" },
      { index: 1, kind: "paragraph", text: "正文" },
    ]);
    const plan = buildMappingPlan({ template: templateProfile(["一、项目任务", "二、项目需求分析"]), content });
    // 「需求梳理」与「项目需求分析」有部分共同词：落在低置信区间
    expect(plan.pendingForSemantic.length).toBeGreaterThan(0);
    expect(plan.pendingForSemantic[0]!.candidates.length).toBeGreaterThan(0);
    // 仍然按顺序兜底落位，内容不丢
    expect(plan.conservation.matched + plan.conservation.unmatched).toBe(plan.conservation.total);
  });

  it("代理裁决可以改写归属（semantic 入参生效）", () => {
    const content = buildContentProfile([
      { index: 0, kind: "heading", level: 1, text: "附：数据字典" },
      { index: 1, kind: "paragraph", text: "正文" },
    ]);
    const template = templateProfile(["一、项目任务", "二、项目需求分析"]);
    const plan = buildMappingPlan({
      template,
      content,
      semantic: [{ chapterTraceId: "b0", slotId: "slot-2", reason: "内容属于需求分析" }],
    });
    const assignment = plan.assignments[0]!;
    expect(assignment.slotId).toBe("slot-2");
    expect(assignment.notes.join()).toContain("需求分析");
    expect(plan.report.appendedChapters).toBe(0);
  });

  it("代理返回 slotId=null 时按追加处理（不丢内容）", () => {
    const content = buildContentProfile([
      { index: 0, kind: "heading", level: 1, text: "无关章节" },
      { index: 1, kind: "paragraph", text: "正文" },
    ]);
    const plan = buildMappingPlan({
      template: templateProfile(["一、项目任务"]),
      content,
      semantic: [{ chapterTraceId: "b0", slotId: null, reason: "无对应章节" }],
    });
    // 顺序对齐已经先占了槽位（容量 many），内容依然完整
    expect(plan.conservation.matched).toBe(plan.conservation.total);
  });
});

describe("M4a 映射 → 装订规格（planToBindingSpec）", () => {
  const templateProfile = (titles: string[]): TemplateProfile => buildTemplateProfile({
    facts: {
      styles: [], sections: [], headers: [], footers: [], coverImages: [], coverText: [],
      outline: titles.map((text, index) => ({ index, level: 1, text, inCoverRegion: false })),
      numbering: { scheme: "cn-upper", levels: [] },
      fixedBlocks: [],
    },
    card: validateThesisFormatCard({}, "模版.docx"),
    sourceName: "模版.docx",
  });

  const richContent = (): ContentProfile => buildContentProfile([
    { index: 0, kind: "paragraph", text: "前置说明" },
    { index: 1, kind: "heading", level: 1, text: "一、业务场景分析" },
    { index: 2, kind: "heading", level: 2, text: "1.1 政策背景" },
    { index: 3, kind: "paragraph", text: "背景正文" },
    { index: 4, kind: "heading", level: 2, text: "1.2 痛点" },
    { index: 5, kind: "paragraph", text: "痛点正文" },
    { index: 6, kind: "heading", level: 1, text: "二、需求梳理" },
    { index: 7, kind: "paragraph", text: "需求正文" },
    { index: 8, kind: "heading", level: 1, text: "参考文献" },
    { index: 9, kind: "paragraph", text: "[1] 张三. 论文排版[J]. 2024." },
    { index: 10, kind: "heading", level: 1, text: "致谢" },
    { index: 11, kind: "paragraph", text: "感谢导师" },
  ]);

  it("章节区间互不重叠、按文档序，覆盖各叶子段落", () => {
    const content = richContent();
    const plan = buildMappingPlan({ template: templateProfile(["一、项目任务", "二、项目需求分析", "参考资料", "致谢"]), content });
    const { spec } = planToBindingSpec({ plan, content, titleHint: "开题与需求、系统设计报告" });
    expect(spec.title).toBe("开题与需求、系统设计报告");
    const ranges = spec.chapters.map((chapter) => [chapter.blockStart, chapter.blockEnd]);
    // 严格递增且不重叠
    for (let index = 1; index < ranges.length; index += 1) {
      expect(ranges[index]![0]!).toBeGreaterThanOrEqual(ranges[index - 1]![1]!);
    }
    // v2：标题送干净文本（编号由渲染器按模板方案重算），避免"1.1 1.1 政策背景"重号
    expect(spec.chapters.map((chapter) => `${chapter.level}:${chapter.headingText}`)).toEqual([
      "1:业务场景分析", "2:政策背景", "2:痛点", "1:需求梳理",
    ]);
  });

  it("参考文献/致谢按槽位抽取文本，不进正文章节", () => {
    const content = richContent();
    const plan = buildMappingPlan({ template: templateProfile(["一、项目任务", "二、项目需求分析", "参考资料", "致谢"]), content });
    const { spec } = planToBindingSpec({ plan, content, titleHint: "论文" });
    expect(spec.references).toEqual(["[1] 张三. 论文排版[J]. 2024."]);
    expect(spec.acknowledgementParagraphs).toEqual(["感谢导师"]);
  });

  it("未匹配块进 spec.unmatchedBlocks（渲染器据此出高亮小节）", () => {
    const content = richContent();
    const plan = buildMappingPlan({ template: templateProfile(["一、项目任务"]), content });
    const { spec } = planToBindingSpec({ plan, content, titleHint: "论文" });
    expect(spec.unmatchedBlocks?.length).toBeGreaterThan(0);
    expect(spec.unmatchedBlocks![0]).toMatchObject({ start: 0, end: 1 });
    expect(spec.unmatchedBlocks![0]!.label).toContain("首个章节之前");
  });

  it("未匹配块进报告（当前渲染器不能标记，但不静默）", () => {
    const content = richContent();
    const plan = buildMappingPlan({ template: templateProfile(["一、项目任务"]), content });
    const { notes } = planToBindingSpec({ plan, content, titleHint: "论文" });
    expect(notes.some((note) => note.includes("未匹配块"))).toBe(true);
  });
});

describe("代理裁决接线（adjudicate_mapping）", () => {
  const pending = [
    { chapterTraceId: "b0", chapterText: "需求梳理", candidates: [{ slotId: "slot-2", score: 0.47 }] },
  ];
  const slots = [{ id: "slot-1" }, { id: "slot-2" }];

  it("只接受问过的章节与真实存在的槽位 id", () => {
    const decisions = sanitizeMappingDecisions([
      { chapterTraceId: "b0", slotId: "slot-2", reason: "同属需求分析" },
    ], pending, slots);
    expect(decisions).toEqual([{ chapterTraceId: "b0", slotId: "slot-2", reason: "同属需求分析" }]);
  });

  it("模型编造的章节 id / 槽位 id 一律丢弃或降级为 null", () => {
    const decisions = sanitizeMappingDecisions([
      { chapterTraceId: "b99", slotId: "slot-2" },      // 没问过这个章节
      { chapterTraceId: "b0", slotId: "slot-999" },      // 槽位不存在 → null
    ], pending, slots);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ chapterTraceId: "b0", slotId: null });
  });

  it("重复章节只取第一条；非数组输入返回空", () => {
    expect(sanitizeMappingDecisions([
      { chapterTraceId: "b0", slotId: "slot-1" },
      { chapterTraceId: "b0", slotId: "slot-2" },
    ], pending, slots)).toHaveLength(1);
    expect(sanitizeMappingDecisions(null, pending, slots)).toEqual([]);
    expect(sanitizeMappingDecisions("nope", pending, slots)).toEqual([]);
  });

  it("reason 截断到 120 字", () => {
    const [decision] = sanitizeMappingDecisions([
      { chapterTraceId: "b0", slotId: "slot-1", reason: "x".repeat(500) },
    ], pending, slots);
    expect(decision!.reason!.length).toBe(120);
  });

  it("代理 schema 声明了 adjudicate_mapping 任务与决策字段", () => {
    const input = JSON.parse(readFileSync(resolve(__dirname, "../../../agents/thesis-formatter/schemas/input.schema.json"), "utf8")) as {
      properties: { task: { enum: string[] }; mappingSlots?: unknown; mappingCandidates?: unknown };
    };
    const output = JSON.parse(readFileSync(resolve(__dirname, "../../../agents/thesis-formatter/schemas/output.schema.json"), "utf8")) as {
      properties: { task: { enum: string[] }; decisions?: { items: { properties: { slotId: { type: string[] } } } } };
    };
    expect(input.properties.task.enum).toContain("adjudicate_mapping");
    expect(output.properties.task.enum).toContain("adjudicate_mapping");
    expect(input.properties.mappingSlots).toBeDefined();
    expect(input.properties.mappingCandidates).toBeDefined();
    // slotId 允许 null（对不上就追加，不硬塞）
    expect(output.properties.decisions!.items.properties.slotId.type).toEqual(["string", "null"]);
  });
});

describe("排版选项（第二期规则面板）", () => {
  const content = () => buildContentProfile([
    { index: 0, kind: "heading", level: 1, text: "一、业务场景分析" },
    { index: 1, kind: "heading", level: 2, text: "1.1 政策背景" },
    { index: 2, kind: "paragraph", text: "正文" },
  ]);
  const template = () => buildTemplateProfile({
    facts: {
      styles: [], sections: [], headers: [], footers: [], coverImages: [], coverText: [],
      outline: [{ index: 0, level: 1, text: "一、项目任务", inCoverRegion: false }],
      numbering: { scheme: "cn-upper", levels: [] },
      fixedBlocks: [],
    },
    card: validateThesisFormatCard({}, "模版.docx"),
    sourceName: "模版.docx",
  });

  it("章节带上所属槽位 id（渲染器据此把内容放回模版原位）", () => {
    const plan = buildMappingPlan({ template: template(), content: content() });
    const { spec } = planToBindingSpec({ plan, content: content(), titleHint: "论文" });
    expect(spec.chapters.length).toBeGreaterThan(0);
    // 映射到的章节必须带槽位 id；槽位顺序 = 模板顺序
    const slotIds = spec.chapters.map((chapter) => chapter.slotId).filter((id): id is string => Boolean(id));
    expect(slotIds.length).toBeGreaterThan(0);
    const slotOrder = template().slots.map((slot) => slot.id);
    const positions = slotIds.map((id) => slotOrder.indexOf(id)).filter((index) => index >= 0);
    expect([...positions].sort((left, right) => left - right)).toEqual(positions);
  });

  it("标题层级映射改变输出层级（章→二级标题）", () => {
    const plan = buildMappingPlan({ template: template(), content: content() });
    const mapped = planToBindingSpec({
      plan,
      content: content(),
      titleHint: "论文",
      headingMapping: { chapter: 2, section: 3 },
    });
    // 章原本 level 1，映射后变 2；节原本 2 → 3
    expect(mapped.spec.chapters[0]!.level).toBe(2);
    expect(mapped.spec.chapters[1]!.level).toBe(3);
  });

  it("未给映射时保持默认层级（章1/节2）", () => {
    const plan = buildMappingPlan({ template: template(), content: content() });
    const plain = planToBindingSpec({ plan, content: content(), titleHint: "论文" });
    expect(plain.spec.chapters.map((chapter) => chapter.level)).toEqual([1, 2]);
  });
});

describe("任务化排版（第三期：进度与长任务）", () => {
  it("作业阶段映射到 15/45/75/100 的进度", async () => {
    const { ThesisJobRegistry } = await import("../src/modules/thesis-format/jobs.js");
    const registry = new ThesisJobRegistry();
    const job = registry.create("room-1");
    expect(job.status).toBe("running");
    expect(job.phase).toBe("parsing");
    expect(job.progress).toBe(15);
    registry.phase(job.id, "mapping");
    expect(registry.get(job.id)?.progress).toBe(45);
    registry.phase(job.id, "rendering");
    expect(registry.get(job.id)?.progress).toBe(75);
    registry.complete(job.id, { fileEntryId: "f1", originalName: "a-排版版.docx" });
    const done = registry.get(job.id);
    expect(done?.status).toBe("completed");
    expect(done?.progress).toBe(100);
    expect((done?.result as { fileEntryId: string }).fileEntryId).toBe("f1");
  });

  it("失败作业记录错误信息，未知作业返回 undefined", async () => {
    const { ThesisJobRegistry } = await import("../src/modules/thesis-format/jobs.js");
    const registry = new ThesisJobRegistry();
    const job = registry.create("room-1");
    registry.fail(job.id, new Error("thesis_source_not_docx"));
    expect(registry.get(job.id)?.status).toBe("failed");
    expect(registry.get(job.id)?.error).toBe("thesis_source_not_docx");
    expect(registry.get("nope")).toBeUndefined();
  });

  it("结构对比数据带左右两侧与未匹配块", () => {
    const content = buildContentProfile([
      { index: 0, kind: "heading", level: 1, text: "一、业务场景分析" },
      { index: 1, kind: "paragraph", text: "正文一" },
    ]);
    const template = buildTemplateProfile({
      facts: {
        styles: [], sections: [], headers: [], footers: [], coverImages: [], coverText: [],
        outline: [], numbering: { scheme: "cn-upper", levels: [] }, fixedBlocks: [],
      },
      card: validateThesisFormatCard({}, "模版.docx"),
      sourceName: "模版.docx",
    });
    const plan = buildMappingPlan({ template, content });
    const { spec } = planToBindingSpec({ plan, content, titleHint: "论文" });
    // diff 由 service 组装，这里验证左右两侧源头数据齐备
    expect(content.outline.length).toBeGreaterThan(0);
    expect(spec.chapters.length).toBeGreaterThan(0);
    expect(plan.unmatched).toBeDefined();
  });
});


describe('模板固定表单保留（评价表等）', () => {
  it('extractOoxmlFactsAsync 抽取正文顶层表格为 fixedBlocks（跳过槽位示例表与含图块）', async () => {
    const { extractOoxmlFactsAsync } = await import('../src/modules/thesis-format/ooxml-facts.js');
    // 手工构造：一个槽位标题 + 一个含图表格（应跳过）+ 一个纯表格（应保留）
    const table = '<w:tbl><w:tr><w:tc><w:tcPr/><w:p><w:r><w:t>指导教师评分及评语</w:t></w:r></w:p></w:tc></w:tr></w:tbl>';
    const tableWithPic = '<w:tbl><w:tr><w:tc><w:p><w:r><w:drawing><a:blip r:embed="rId7"/></w:drawing></w:r></w:p></w:tc></w:tr></w:tbl>';
    const doc = `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>
      <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>一、项目任务</w:t></w:r></w:p>
      <w:p><w:r><w:t>正文示例</w:t></w:r></w:p>
      ${tableWithPic}${table}
      <w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr>
    </w:body></w:document>`;
    const { default: JSZip } = await import('jszip');
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/></Types>');
    zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
    zip.file('word/_rels/document.xml.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>');
    zip.file('word/document.xml', doc);
    const bytes = await zip.generateAsync({ type: 'nodebuffer' });
    const facts = await extractOoxmlFactsAsync(bytes);
    expect(facts.fixedBlocks).toHaveLength(1);
    expect(facts.fixedBlocks[0]!.heading).toBe('一、项目任务');
    expect(facts.fixedBlocks[0]!.xml).toContain('指导教师评分及评语');
  });

  it('planToBindingSpec 透传 templateProfile.fixed.fixedBlocks 进 spec', async () => {
    const { planToBindingSpec } = await import('../src/modules/thesis-format/plan-to-spec.js');
    const { buildMappingPlan } = await import('../src/modules/thesis-format/mapping-plan.js');
    const { buildContentProfile } = await import('../src/modules/thesis-format/content-profile.js');
    const { buildTemplateProfile } = await import('../src/modules/thesis-format/template-profile.js');
    // 不引入 vendored 引擎源码：它的相对导入在 NodeNext 下会让 gateway 的 tsc 报错。
    // 这里只要一份「源文档块大纲」，手写即可（真实解析在桥那侧，由应用测试覆盖）。
    const blocks = [
      { index: 0, kind: 'heading', level: 1, text: '一、项目任务' },
      { index: 1, kind: 'paragraph', text: '项目背景与目标。' },
      { index: 2, kind: 'heading', level: 1, text: '二、需求分析' },
      { index: 3, kind: 'paragraph', text: '功能需求与非功能需求。' },
    ];
    const { readFile } = await import('node:fs/promises');
    const template = await readFile('/Users/nxcore/Downloads/人工智能创新创业实践课程设计报告(模板） (1).docx');
    const { extractOoxmlFactsAsync } = await import('../src/modules/thesis-format/ooxml-facts.js');
    const facts = await extractOoxmlFactsAsync(template);
    const { validateThesisFormatCard } = await import('../src/modules/thesis-format/validate.js');
    const card = validateThesisFormatCard({}, '模板.docx');
    (card as { numbering?: unknown }).numbering = facts.numbering;
    const profile = buildTemplateProfile({ facts, card, sourceName: '模板.docx' });
    const plan = buildMappingPlan({ template: profile, content: buildContentProfile(blocks as never) });
    const { spec } = planToBindingSpec({ plan, content: buildContentProfile(blocks as never), titleHint: 't', templateProfile: profile });
    expect((spec.fixedBlocks ?? []).length).toBeGreaterThanOrEqual(2);
    expect((spec.fixedBlocks ?? []).some((b) => (b.heading ?? '').includes('项目经理评价'))).toBe(true);
  });
});


describe('本地确定性出卡（跳过解析代理，秒级上传）', () => {
  const templatePath = '/Users/nxcore/Downloads/人工智能创新创业实践课程设计报告(模板） (1).docx';

  it('从 OOXML 事实直接产出可信卡：页面/字体/标题/封面/页眉都按模板真实值', async () => {
    const { readFile } = await import('node:fs/promises');
    const { extractOoxmlFactsAsync } = await import('../src/modules/thesis-format/ooxml-facts.js');
    const { buildCardFromFacts } = await import('../src/modules/thesis-format/card-from-facts.js');
    const facts = await extractOoxmlFactsAsync(await readFile(templatePath));
    const member = {
      styles: facts.styles, sections: facts.sections, headers: facts.headers, footers: facts.footers,
      coverImages: facts.coverImages, coverText: facts.coverText, outline: facts.outline,
      numbering: facts.numbering, fixedBlocks: facts.fixedBlocks,
    };
    const started = Date.now();
    const local = buildCardFromFacts(member as never, '模板.docx');
    const elapsed = Date.now() - started;

    // 速度：本地出卡必须是毫秒级（原来要等代理 30s+）
    expect(elapsed).toBeLessThan(200);
    expect(local.confident).toBe(true);

    // 版式取值来自模板本身，不是 schema 默认值
    expect(local.card.page.marginLeftMm).toBe(22);
    expect(local.card.page.marginTopMm).toBe(25.4);
    expect(local.card.base.font.eastAsia).toBe('宋体');
    expect(local.card.base.font.size).toBe(12);
    // 标题字号取标题段落 run（宋体 16pt），不是默认 18 也不是猜的黑体
    const h1 = local.card.headings.find((h) => h.level === 1)!;
    expect(h1.font.size).toBe(16);
    expect(h1.font.eastAsia).toBe('宋体');
    // 封面：页眉里的正式校名 + 封面真实字段标签
    expect(local.card.cover.schoolName).toBe('广州城市理工学院');
    expect(local.card.cover.degreeLine).toBe('课程考核报告');
    const labels = local.card.cover.fields.map((f) => f.label.replace(/\s+/g, ''));
    expect(labels).toContain('题目');
    expect(labels).toContain('学生学号');
    expect(labels).toContain('指导教师');
    // 页眉用模板真实文字（不是占位 {title}）
    expect(local.card.header.template).toContain('广州城市理工学院');
  });

  it('可信度把关：没有章节大纲/样式时判为不可信，交由解析代理兜底', async () => {
    const { buildCardFromFacts } = await import('../src/modules/thesis-format/card-from-facts.js');
    const empty = { styles: [], sections: [], headers: [], footers: [], coverImages: [], coverText: [], outline: [], numbering: { scheme: 'none', levels: [] }, fixedBlocks: [] };
    const local = buildCardFromFacts(empty as never, 'x.docx');
    expect(local.confident).toBe(false);
    expect(local.gaps.join('；')).toContain('章节大纲');
  });
});
