import { describe, expect, it, vi } from "vitest";
import type { StartRuntimeRunInput } from "@nxcore/agent-runtime";
import { createContentSearchPiTool } from "../src/modules/search/pi-tools.js";
import type { SearchService } from "../src/modules/search/service.js";

const input: StartRuntimeRunInput = {
  runId: "run-content-search",
  sessionId: "session-content-search",
  runtimeSessionRef: null,
  prompt: "",
  pageLabel: "Agent",
  roomId: null,
};

function serviceOf(search: SearchService["search"]): SearchService {
  return { search } as unknown as SearchService;
}

describe("content_search pi 工具", () => {
  it("透传 query 与 limit，types 固定 file，返回 fileEntryId/name/snippet", async () => {
    const search = vi.fn(() => ({
      items: [{
        id: "file:x", itemType: "file" as const, refId: "file-1", title: "现场照片.jpg",
        snippet: "…一张安装在现场的设备特写…", sourceKind: "manual-upload", roomIds: [],
        occurredAt: null, ingestedAt: "2026-11-05T00:00:00.000Z", timeBasis: "ingested" as const,
        versionLabel: null, fileVersionId: null, status: "indexed" as const, sessionId: null, pageId: null,
      }],
      total: 1,
      scope: { indexedCount: 10, pendingCount: 0 },
    }));
    const result = await createContentSearchPiTool(() => serviceOf(search)).execute(input, { query: "设备特写", limit: 5 });
    expect(search).toHaveBeenCalledWith("设备特写", { types: ["file"] }, 5, 0);
    const payload = JSON.parse(result.content) as { items: Array<Record<string, unknown>>; hint: string };
    expect(payload.items[0]).toMatchObject({ fileEntryId: "file-1", name: "现场照片.jpg", snippet: "…一张安装在现场的设备特写…" });
    expect(payload.hint).toContain("workspace_files_preview");
  });

  it("空结果给可执行提示；空 query 报错", async () => {
    const empty = serviceOf(() => ({ items: [], total: 0, scope: { indexedCount: 0, pendingCount: 0 } }));
    const tool = createContentSearchPiTool(() => empty);
    const payload = JSON.parse((await tool.execute(input, { query: "不存在的词" })).content) as { hint: string };
    expect(payload.hint).toContain("file_search");
    await expect(tool.execute(input, { query: "  " })).rejects.toThrow("query 不能为空");
    await expect(createContentSearchPiTool(() => null).execute(input, { query: "x" }))
      .rejects.toThrow("content_search 暂不可用");
  });
});
