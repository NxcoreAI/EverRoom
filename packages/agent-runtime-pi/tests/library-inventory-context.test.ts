import { describe, expect, it } from "vitest";
import { buildLibraryInventoryContext } from "../src/library-inventory-context.js";

describe("buildLibraryInventoryContext", () => {
  it("没有库内容时不注入任何提示", () => {
    expect(buildLibraryInventoryContext(undefined)).toBeNull();
    expect(buildLibraryInventoryContext(null)).toBeNull();
    expect(buildLibraryInventoryContext({ library: 0, artifacts: 0, total: 0 })).toBeNull();
  });

  it("只报数量，并说清条目要自己查（不含任何条目清单）", () => {
    const context = buildLibraryInventoryContext({ library: 1284, artifacts: 37, total: 1321 })!;
    expect(context).toContain("资料库 1284 份");
    expect(context).toContain("产物 37 份");
    expect(context).not.toContain("《");
  });

  it("把检索路径指到 library_browse / file_search / file_read", () => {
    const context = buildLibraryInventoryContext({ library: 12, artifacts: 1, total: 13 })!;
    expect(context).toContain("file_search");
    expect(context).toContain("library_browse");
    expect(context).toContain("nextOffset");
    expect(context).toContain("file_read");
  });

  it("明确要求单 Agent 完成、不把找文件推回用户", () => {
    const context = buildLibraryInventoryContext({ library: 3, artifacts: 0, total: 3 })!;
    expect(context).toContain("不调度子 Agent");
    expect(context).toContain("不要把“你先上传/先打开文件”推回给用户");
  });
});
