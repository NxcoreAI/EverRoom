import { describe, expect, it } from "vitest";
import type { StartRuntimeRunInput } from "@nxcore/agent-runtime";
import {
  catalogQueryLikePatterns,
  createWorkspaceFileCatalog,
  createWorkspaceFilePreviewTool,
  createWorkspaceFilesPiTools,
  createWorkspaceFilesReadBatchTool,
  type WorkspaceFileSource,
  type WorkspaceFileTextSource,
} from "../src/modules/agent/workspace-files-tools.js";
import { createWorkspaceImageMaterialSearch } from "../src/modules/subagents/workspace-materials.js";

const UPDATED_AT = "2026-10-27T06:00:00.000Z";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

interface Row {
  id: string;
  originalName: string;
  sharedTitle: string;
  relativePath: string | null;
  bytes: number;
  dataType: string | null;
  contentHash: string;
}

function sourceOf(rows: Row[]): WorkspaceFileSource {
  return {
    // 与 FilesService 的 SQL 下推同语义：先按模式过滤，再截 limit（模拟扫描窗口）。
    listCatalog: (limit, _offset, patterns) => ({
      items: rows
        .filter((row) => !patterns?.length || patterns.some((pattern) =>
          [row.originalName, row.sharedTitle, row.relativePath ?? ""].join("\n").toLowerCase().includes(pattern)))
        .slice(0, limit)
        .map((row) => ({ ...row, updatedAt: UPDATED_AT })),
    }),
    catalogStoragePathOf: (fileEntryId) => `/data/files/${fileEntryId}`,
  };
}

const rows: Row[] = [
  {
    id: "img-1",
    originalName: "Cyplore_April26_Highres-25.jpg",
    sharedTitle: "Cyplore-25.jpg",
    relativePath: "八、补充材料/产品图/Cyplore_April26_Highres-25.jpg",
    bytes: 2048,
    dataType: "image",
    contentHash: HASH_A,
  },
  {
    id: "img-2",
    originalName: "现场照片.jpg",
    sharedTitle: "现场照片.jpg",
    relativePath: "产品图/现场照片.jpg",
    bytes: 4096,
    dataType: "image",
    contentHash: HASH_B,
  },
  // 同名同内容重复登记：素材检索应按引用去重。
  {
    id: "img-2-copy",
    originalName: "现场照片.jpg",
    sharedTitle: "现场照片.jpg",
    relativePath: "产品图/现场照片.jpg",
    bytes: 4096,
    dataType: "image",
    contentHash: HASH_B,
  },
  {
    id: "doc-1",
    originalName: "锥光 BP-1020.md",
    sharedTitle: "锥光 BP-1020",
    relativePath: "资料/锥光 BP-1020.md",
    bytes: 512,
    dataType: "document",
    contentHash: HASH_C,
  },
];

const input: StartRuntimeRunInput = {
  runId: "run-workspace-files",
  sessionId: "session-workspace-files",
  runtimeSessionRef: null,
  prompt: "",
  pageLabel: "Agent",
  roomId: null,
};

describe("workspace file catalog", () => {
  it("lists workspace images with a material ref and absolute path", () => {
    const catalog = createWorkspaceFileCatalog(sourceOf(rows));

    const images = catalog.list({ kind: "image" });
    expect(images.map((entry) => entry.name)).toEqual(["Cyplore-25.jpg", "现场照片.jpg", "现场照片.jpg"]);
    expect(images[0]).toMatchObject({
      fileEntryId: "img-1",
      kind: "image",
      type: "image",
      bytes: 2048,
      updatedAt: UPDATED_AT,
      relativePath: "八、补充材料/产品图/Cyplore_April26_Highres-25.jpg",
      absolutePath: "/data/files/img-1",
      materialRef: `everroom-material://${HASH_A}`,
    });
  });

  it("kind=image 无 query 走扩展名下推：图片被当日新增挤出扫描窗口也能列出（2026-11-05 实测漏图）", () => {
    // 500 条非图片占满「最新 500 条」窗口，图片排在窗口之外——纯 page-0 内存过滤会全漏。
    const filler: Row[] = Array.from({ length: 500 }, (_, index) => ({
      id: `doc-filler-${index}`,
      originalName: `资料汇编 ${index}.docx`,
      sharedTitle: `资料汇编 ${index}.docx`,
      relativePath: null,
      bytes: 1,
      dataType: "document",
      contentHash: HASH_C,
    }));
    const catalog = createWorkspaceFileCatalog(sourceOf([...filler, rows[0]!, rows[1]!]));
    const images = catalog.list({ kind: "image" });
    expect(images.map((entry) => entry.fileEntryId).sort()).toEqual(["img-1", "img-2"]);
    // 下推命中的误报（文件名带 jpg 字样的非图片）由 isImageEntry 剔除。
    const withDecoy = sourceOf([
      ...filler,
      { id: "doc-decoy", originalName: "jpg 转换说明.docx", sharedTitle: "jpg 转换说明.docx", relativePath: null, bytes: 1, dataType: "document", contentHash: HASH_C },
      rows[0]!,
    ]);
    expect(createWorkspaceFileCatalog(withDecoy).list({ kind: "image" }).map((entry) => entry.fileEntryId)).toEqual(["img-1"]);
  });

  it("filters by kind, query (name / display name / relative path), and limit", () => {
    const catalog = createWorkspaceFileCatalog(sourceOf(rows));

    expect(catalog.list({ kind: "document" }).map((entry) => entry.name)).toEqual(["锥光 BP-1020"]);
    // 中文 2 字窗口命中相对路径里的「产品图」。
    expect(catalog.list({ kind: "image", query: "产品图" }).map((entry) => entry.fileEntryId))
      .toEqual(["img-1", "img-2", "img-2-copy"]);
    expect(catalog.list({ query: "Cyplore" }).map((entry) => entry.fileEntryId)).toEqual(["img-1"]);
    expect(catalog.list({ query: "BP-1020" }).map((entry) => entry.fileEntryId)).toEqual(["doc-1"]);
    expect(catalog.list({ kind: "image", limit: 1 })).toHaveLength(1);
    expect(catalog.list({ query: "不存在的名字" })).toEqual([]);
  });

  it("带词检索经 LIKE 下推，能命中扫描窗口外的老文件", () => {
    // 复现线上问题：本地文件夹同步灌入上万文件后，手动上传的老文件排在扫描窗口
    // （SCAN_LIMIT=500）之外，仅内存过滤时按名检索会漏检。
    // 垃圾文件取自真实转录：路径含「p-」「-1」（whatsapp-business / polyvox_app_rn-1），
    // 旧的全 token 滑窗会召回它们灌满结果窗。
    const junkRelativePaths = [
      "polyvox_app_rn-1/src/assets/agreements/privacy.html",
      "nango-master/docs/snippets/generated/whatsapp-business/PreBuiltUseCases.mdx",
    ] as const;
    const junk: Row[] = Array.from({ length: 600 }, (_, index) => {
      const even = index % 2 === 0;
      return {
        id: `filler-${index}`,
        originalName: even ? "privacy.html" : "PreBuiltUseCases.mdx",
        sharedTitle: even ? "privacy.html" : "PreBuiltUseCases.mdx",
        relativePath: even ? junkRelativePaths[0] : junkRelativePaths[1],
        bytes: 1,
        dataType: "document",
        contentHash: HASH_C,
      } satisfies Row;
    });
    const target: Row = {
      id: "doc-1",
      originalName: "锥光 BP-1020.md",
      sharedTitle: "锥光 BP-1020",
      relativePath: "锥光 BP-1020.md",
      bytes: 512,
      dataType: "document",
      contentHash: HASH_C,
    };
    const catalog = createWorkspaceFileCatalog(sourceOf([...junk, target]));

    // 无词路径仍只看到窗口内最新文件（受缺省 limit 截断）。
    expect(catalog.list({})).toHaveLength(30);
    // 用户输入常不带空格（「锥光BP-1020」）：噪声窗已去掉，只有目标命中。
    expect(catalog.list({ query: "锥光BP-1020" }).map((entry) => entry.fileEntryId)).toEqual(["doc-1"]);
  });

  it("模式展开只在 CJK 连续段内成窗，不产生 ASCII 噪声窗", () => {
    expect(catalogQueryLikePatterns("锥光BP-1020")).toEqual(["锥光bp-1020", "锥光"]);
    expect(catalogQueryLikePatterns("产品图")).toEqual(["产品图", "产品", "品图"]);
    expect(catalogQueryLikePatterns("BP-1020")).toEqual(["bp-1020"]);
  });
});

describe("workspace_files_list tool", () => {
  it("returns the catalog as JSON content and rejects when the catalog is not ready", async () => {
    const catalog = createWorkspaceFileCatalog(sourceOf(rows));
    const [tool] = createWorkspaceFilesPiTools(() => catalog);
    expect(tool).toBeDefined();

    const result = await tool!.execute(input, { kind: "image", query: "产品" });
    const payload = JSON.parse(result.content) as {
      files: Array<{ fileEntryId: string; materialRef: string | null }>;
      total: number;
    };
    expect(payload.total).toBe(3);
    expect(payload.files[0]).toMatchObject({ fileEntryId: "img-1", materialRef: `everroom-material://${HASH_A}` });

    const [unavailable] = createWorkspaceFilesPiTools(() => null);
    await expect(unavailable!.execute(input, {})).rejects.toThrow("workspace_files_list 暂不可用");
  });

  it("会话工作区穿到目录查询：不再把别的空间的资料列进「工作区文件清单」", async () => {
    const calls: Array<{ patterns?: string[]; workspaceId?: string }> = [];
    const source: WorkspaceFileSource = {
      listCatalog: (limit, _offset, patterns, workspaceId) => {
        calls.push({ ...(patterns ? { patterns } : {}), ...(workspaceId ? { workspaceId } : {}) });
        return { items: rows.slice(0, limit).map((row) => ({ ...row, updatedAt: UPDATED_AT })) };
      },
      catalogStoragePathOf: (fileEntryId) => `/data/files/${fileEntryId}`,
    };
    const [tool] = createWorkspaceFilesPiTools(() => createWorkspaceFileCatalog(source));

    await tool!.execute({ ...input, workspaceId: "ws-current" }, { kind: "all", limit: 50 });
    expect(calls[0]!.workspaceId).toBe("ws-current");

    // 会话没有工作区时保持全库（兜底语义）。
    await tool!.execute(input, { kind: "all", limit: 50 });
    expect(calls[1]!.workspaceId).toBeUndefined();
  });
});

describe("workspace image material search", () => {
  it("returns deduped everroom-material hits for matching workspace images", () => {
    const catalog = createWorkspaceFileCatalog(sourceOf(rows));
    const search = createWorkspaceImageMaterialSearch(() => catalog);

    const hits = search("现场", 6);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      ref: `everroom-material://${HASH_B}`,
      kind: "photo",
      desc: "产品图/现场照片.jpg",
    });
    expect(search("现场", 6)).toEqual(hits);
    expect(search("", 3)).toEqual([]);
    expect(createWorkspaceImageMaterialSearch(() => null)("现场", 3)).toEqual([]);
  });
});

describe("workspace_files_preview tool", () => {
  const entries = new Map<string, { sharedTitle?: string | null; originalName: string; dataType: string | null; contentHash: string }>([
    ["img-ok", { sharedTitle: null, originalName: "现场照片.jpg", dataType: "image", contentHash: HASH_A }],
    ["img-missing", { sharedTitle: null, originalName: "无描述.png", dataType: "image", contentHash: HASH_B }],
    ["doc", { sharedTitle: "BP 正文", originalName: "bp.md", dataType: "document", contentHash: HASH_C }],
    ["binary", { sharedTitle: null, originalName: "report.pdf", dataType: "document", contentHash: "f".repeat(64) }],
  ]);
  const markdown = new Map<string, string | null>([
    ["img-ok", "一张安装在现场的设备特写，机身银色。"],
    ["img-missing", null],
    ["doc", "# BP\n\n" + "内容".repeat(400)],
    ["binary", null],
  ]);
  const RED_DOT_PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=",
    "base64",
  );
  const content = new Map<string, { buffer: Buffer; mime: string; filename: string } | null>([
    ["img-ok", { buffer: RED_DOT_PNG, mime: "image/png", filename: "现场照片.jpg" }],
  ]);
  const source: WorkspaceFileTextSource = {
    catalogEntry: (id) => entries.get(id) ?? null,
    catalogMarkdownOf: (id) => markdown.get(id) ?? null,
    catalogContentOf: async (id) => content.get(id) ?? null,
  };
  const read = async (id: string) => {
    const text = markdown.get(id);
    return text === null || text === undefined ? null : { text, filename: id };
  };

  it("图片返回缓存描述与 materialRef，不触发任何视觉分析路径", async () => {
    const payload = JSON.parse((await createWorkspaceFilePreviewTool(() => source, read)
      .execute(input, { fileIds: ["img-ok"] })).content) as {
      previews: Array<{ kind: string; description: string; materialRef: string }>;
    };
    expect(payload.previews[0]).toMatchObject({
      kind: "image",
      description: "一张安装在现场的设备特写，机身银色。",
      materialRef: `everroom-material://${HASH_A}`,
      width: 1,
      height: 1,
    });
  });

  it("无描述的图片如实标 descriptionMissing；文档按 perFile 截断；未知 id 报 not_found", async () => {
    const payload = JSON.parse((await createWorkspaceFilePreviewTool(() => source, read)
      .execute(input, { fileIds: ["img-missing", "doc", "nope"], maxCharsPerFile: 300 })).content) as {
      previews: Array<Record<string, unknown>>;
    };
    expect(payload.previews[0]).toMatchObject({ kind: "image", descriptionMissing: true, materialRef: `everroom-material://${HASH_B}` });
    expect(payload.previews[1]).toMatchObject({ kind: "document", truncated: true, chars: 6 + 800 });
    expect((payload.previews[1]!.preview as string).length).toBeLessThanOrEqual(300);
    expect(payload.previews[2]).toMatchObject({ error: "not_found" });
  });

  it("服务未就绪时明确报错", async () => {
    await expect(createWorkspaceFilePreviewTool(() => null, read).execute(input, { fileIds: ["x"] }))
      .rejects.toThrow("workspace_files_preview 暂不可用");
  });
});

describe("workspace_files_read_batch tool", () => {
  const entries = new Map<string, { sharedTitle?: string | null; originalName: string; dataType: string | null; contentHash: string }>([
    ["doc-a", { sharedTitle: "材料A", originalName: "a.md", dataType: "document", contentHash: "a".repeat(64) }],
    ["doc-b", { sharedTitle: null, originalName: "b.md", dataType: "document", contentHash: "b".repeat(64) }],
    ["img", { sharedTitle: null, originalName: "x.jpg", dataType: "image", contentHash: "c".repeat(64) }],
  ]);
  const texts = new Map<string, string>([
    ["doc-a", "A".repeat(30_000)],
    ["doc-b", "B".repeat(5_000)],
  ]);
  const source: WorkspaceFileTextSource = {
    catalogEntry: (id) => entries.get(id) ?? null,
    catalogMarkdownOf: (id) => texts.get(id) ?? null,
    catalogContentOf: async () => null,
  };
  const read = async (id: string) => {
    const text = texts.get(id);
    return text === undefined ? null : { text, filename: id };
  };

  it("一次读多篇：单篇截断带 nextOffset，短篇全量；预算按序分配", async () => {
    const payload = JSON.parse((await createWorkspaceFilesReadBatchTool(() => source, read)
      .execute(input, { fileIds: ["doc-a", "doc-b"] })).content) as {
      files: Array<{ name: string; text: string; chars: number; truncated: boolean; nextOffset?: number }>;
    };
    expect(payload.files[0]).toMatchObject({ name: "材料A", chars: 30_000, truncated: true, nextOffset: 20_000 });
    expect(payload.files[0]!.text.length).toBe(20_000);
    expect(payload.files[1]).toMatchObject({ truncated: false, chars: 5_000 });
  });

  it("图片拒读并指向 preview；未知 id 报 not_found", async () => {
    const payload = JSON.parse((await createWorkspaceFilesReadBatchTool(() => source, read)
      .execute(input, { fileIds: ["img", "nope"] })).content) as {
      files: Array<Record<string, unknown>>;
    };
    expect(payload.files[0]).toMatchObject({ error: "image_not_supported" });
    expect(payload.files[1]).toMatchObject({ error: "not_found" });
  });
});
