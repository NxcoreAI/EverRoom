import { describe, expect, it } from "vitest";
import { instructionPageIntent, pageExclusionIntent, resolveGeneratePageScope } from "../src/modules/subagents/tools.js";

describe("instructionPageIntent：中文数词/数字解析，第 N 页、每页不算", () => {
  it("常规解析", () => {
    expect(instructionPageIntent("生成一页示例ppt")).toBe(1);
    expect(instructionPageIntent("只要 3 页")).toBe(3);
    expect(instructionPageIntent("先看两页")).toBe(2);
  });
  it("页码引用不算目标页数", () => {
    expect(instructionPageIntent("改一下第 2 页")).toBeUndefined();
    expect(instructionPageIntent("每页都要有数据")).toBeUndefined();
  });
});

describe("resolveGeneratePageScope：试看语义下的页数是落页范围不是整册页数", () => {
  it("试看词 + 页数 → 推导 previewPages（此前漏成整册跑，「一页」进批次成死循环）", () => {
    const outcome = resolveGeneratePageScope({ instruction: "先生成一页示例ppt", draftPageCount: 17 });
    expect(outcome.conflict).toBeUndefined();
    expect(outcome.previewPages).toBe(1);
    expect(outcome.autoNote).toBeTruthy();
    expect(resolveGeneratePageScope({ instruction: "先出一页预览看看", draftPageCount: 6 }).previewPages).toBe(1);
    expect(resolveGeneratePageScope({ instruction: "逐页试，先试三页", draftPageCount: 17 }).previewPages).toBe(3);
  });
  it("试看词但无页数 → 不动", () => {
    expect(resolveGeneratePageScope({ instruction: "先生成看看效果", draftPageCount: 17 })).toEqual({});
  });
  it("纯页数小于草稿 → 自动按试看处理", () => {
    expect(resolveGeneratePageScope({ instruction: "只生成一页示例", draftPageCount: 17 }).previewPages).toBe(1);
  });
  it("页数等于草稿 → 不动", () => {
    expect(resolveGeneratePageScope({ instruction: "生成 17 页", draftPageCount: 17 })).toEqual({});
  });
  it("整册重整措辞 → 冲突引导改草稿", () => {
    expect(resolveGeneratePageScope({ instruction: "把整册压到 10 页", draftPageCount: 17 }).conflict)
      .toEqual({ requested: 10, draft: 17 });
  });
  it("previewPages 参数优先于指令页数", () => {
    expect(resolveGeneratePageScope({ instruction: "先生成五页看看", draftPageCount: 17, previewPages: 2 }).previewPages).toBe(2);
  });
  it("试看上限放宽到 32：选页 UI 覆盖整册常见页数", () => {
    expect(resolveGeneratePageScope({ instruction: "先生成 12 页试试", draftPageCount: 20 }).previewPages).toBe(12);
    expect(resolveGeneratePageScope({ instruction: "本轮生成 30 页", draftPageCount: 32 }).previewPages).toBe(30);
  });
});

describe("pageExclusionIntent：页型排除意图（编排不能删页，须在草稿层改）", () => {
  it("排除措辞命中", () => {
    expect(pageExclusionIntent("不要封面页")).toBe(true);
    expect(pageExclusionIntent("去掉封面")).toBe(true);
    expect(pageExclusionIntent("不需要目录页")).toBe(true);
    expect(pageExclusionIntent("删除结尾页")).toBe(true);
  });
  it("非排除表述不误伤", () => {
    expect(pageExclusionIntent("封面要深色")).toBe(false);
    expect(pageExclusionIntent("把封面文字改小")).toBe(false);
    expect(pageExclusionIntent("生成 12 页，风格商务")).toBe(false);
  });
});
