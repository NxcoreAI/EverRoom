import { describe, expect, it } from "vitest";
import { buildContentProfile } from "../src/modules/thesis-format/content-profile.js";

/**
 * 模版标题识别的两个启发式回归（2026-10 复查发现）：
 *
 * 1) `outlineFacts` 的普通段落标题识别会把正文/目录/表格行误认成章节标题，
 *    槽位骨架被污染 → 章节落不到模版原位；
 * 2) `promoteDocumentTitle` 把「只有一个一级标题」的文档一律当题目处理，
 *    单章文档（第一章 绪论 + 1.1/1.2）的章名会整章消失。
 */

/** 用最小 document.xml 跑一遍 OOXML 事实抽取（与线上同一条解析路径）。 */
async function outlineOf(bodyXml: string): Promise<Array<{ level: number; text: string }>> {
  const { extractOoxmlFactsAsync } = await import("../src/modules/thesis-format/ooxml-facts.js");
  const JSZip = (await import("jszip")).default;
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/></Types>',
  );
  zip.file(
    "_rels/.rels",
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  );
  zip.file(
    "word/_rels/document.xml.rels",
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>',
  );
  zip.file(
    "word/document.xml",
    `<?xml version="1.0"?><w:document xmlns:w="x"><w:body>${bodyXml}<w:sectPr/></w:body></w:document>`,
  );
  const facts = await extractOoxmlFactsAsync(await zip.generateAsync({ type: "nodebuffer" }));
  return (facts.outline ?? []).map((entry) => ({ level: entry.level, text: entry.text }));
}

const para = (text: string, pPr = ""): string => `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ""}<w:r><w:t>${text}</w:t></w:r></w:p>`;

describe("普通段落标题识别：不再误认正文/目录/表格行", () => {
  it("小数开头的正文行不算标题（3.5万元预算）", async () => {
    const outline = await outlineOf(para("3.5万元预算"));
    expect(outline).toEqual([]);
  });

  it("无引导点的手工目录行不当正文标题（页码黏在标题后）", async () => {
    // 正文标题识别不认它们（否则目录行会把骨架成倍污染）；
    // 但整篇没有真标题时，它们会作为「目录派生骨架」补回来——见下一条测试。
    const outline = await outlineOf(
      para("一、项目任务1") + para("1.1 背景2") + para("二、项目需求分析10"),
    );
    expect(outline.map((entry) => entry.text)).toEqual(["一、项目任务", "1.1 背景", "二、项目需求分析"]);
  });

  it("整篇不用标题样式时，用模版目录行派生章节骨架", async () => {
    const outline = await outlineOf(
      para("目    录") +
        para("第一章 前言1") +
        para("1.1 课程设计的目标1") +
        para("第二章 设计内容3") +
        para("参考文献5") +
        para("宋体小四号，行距1.5倍，余同"),
    );
    expect(outline).toEqual([
      { level: 1, text: "第一章 前言" },
      { level: 2, text: "1.1 课程设计的目标" },
      { level: 1, text: "第二章 设计内容" },
      { level: 1, text: "参考文献" },
    ]);
  });

  it("表格单元格里的编号行不算标题（表单行不是章节）", async () => {
    const outline = await outlineOf(
      `${para("一、项目任务")}<w:tbl><w:tr><w:tc>${para("（一）成员分工")}</w:tc></w:tr></w:tbl>${para("二、需求分析")}`,
    );
    expect(outline).toEqual([
      { level: 1, text: "一、项目任务" },
      { level: 1, text: "二、需求分析" },
    ]);
  });

  it("真正的标题仍然认得出来（一、/（一）/第一章/1.1/1.）", async () => {
    const outline = await outlineOf(
      para("一、项目任务") + para("（一）成员分工") + para("第一章 绪论") + para("1.1 背景") + para("2. 内容"),
    );
    expect(outline.map((entry) => `${entry.level}:${entry.text}`)).toEqual([
      "1:一、项目任务",
      "2:（一）成员分工",
      "1:第一章 绪论",
      "2:1.1 背景",
      "1:2. 内容",
    ]);
  });

  it("紧贴汉字的单级编号仍算标题（1.绪论），紧贴数字则不算（1.5倍）", async () => {
    const outline = await outlineOf(para("1.绪论") + para("1.5倍增长"));
    expect(outline).toEqual([{ level: 1, text: "1.绪论" }]);
  });
});

describe("单根标题提升：单章文档不再被误当成「题目」", () => {
  it("「第一章 绪论」+ 两个小节 → 不提升，章名保留", () => {
    const profile = buildContentProfile([
      { index: 0, kind: "heading", level: 1, text: "第一章 绪论" },
      { index: 1, kind: "heading", level: 2, text: "1.1 研究背景" },
      { index: 2, kind: "paragraph", text: "a" },
      { index: 3, kind: "heading", level: 2, text: "1.2 研究意义" },
      { index: 4, kind: "paragraph", text: "b" },
    ]);
    expect(profile.outline.map((node) => `${node.role}:${node.text}`)).toEqual(["chapter:第一章 绪论"]);
    expect(profile.outline[0]!.children.map((child) => `${child.role}:${child.text}`)).toEqual([
      "section:1.1 研究背景",
      "section:1.2 研究意义",
    ]);
  });

  it("「一、XX」形式的唯一一级标题同样不提升", () => {
    const profile = buildContentProfile([
      { index: 0, kind: "heading", level: 1, text: "一、总体设计" },
      { index: 1, kind: "heading", level: 2, text: "1.1 目标" },
      { index: 2, kind: "heading", level: 2, text: "1.2 范围" },
    ]);
    expect(profile.outline[0]!.text).toBe("一、总体设计");
    expect(profile.outline[0]!.role).toBe("chapter");
  });

  it("真正的题目（不挂编号）仍然提升，子标题成为章节", () => {
    const profile = buildContentProfile([
      { index: 0, kind: "heading", level: 1, text: "学生体质健康报告" },
      { index: 1, kind: "paragraph", text: "前言" },
      { index: 2, kind: "heading", level: 2, text: "一、背景" },
      { index: 3, kind: "paragraph", text: "a" },
      { index: 4, kind: "heading", level: 2, text: "二、方法" },
      { index: 5, kind: "paragraph", text: "b" },
    ]);
    expect(profile.outline.map((node) => `${node.role}:${node.text}`)).toEqual([
      "chapter:一、背景",
      "chapter:二、方法",
    ]);
  });
});