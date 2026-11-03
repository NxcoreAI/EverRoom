import type { PiAgentRuntimeTool, PiAgentRuntimeToolResult } from "@nxcore/agent-runtime-pi";

/**
 * 工作区文件（用户上传/导入的文档与图片）的只读目录。
 *
 * 背景：Room 移除后，会话既拿不到「当前 Room 的附件」，也没有工具能列出
 * 工作区里的图片。用户说「用这个 room 里的图片做 PPT」时，模型只能绕过
 * 工具面去 bash + sqlite 反查应用数据库/blob 存储（既慢又越过授权边界）。
 * 这个目录把「工作区有哪些文件/图片、它们的可引用句柄是什么」变成一等能力。
 */
export interface WorkspaceFileEntry {
  fileEntryId: string;
  name: string;
  kind: "image" | "document" | "other";
  /** 文件格式类别（如 image / document / slides），未知时为空。 */
  type: string | null;
  bytes: number;
  updatedAt: string;
  /** 导入时的相对路径/来源目录（如「八、补充材料/产品图/…」），用于理解文件归属。 */
  relativePath: string | null;
  /** 本地绝对路径；仅内部存储/本地源可解析，缺失时为空。 */
  absolutePath: string | null;
  /** 图片素材引用（everroom-material://<contentHash>），可直接放进 slides 的 materials。 */
  materialRef: string | null;
}

export type WorkspaceFileKind = "image" | "document" | "all";

export interface WorkspaceFileListInput {
  kind?: WorkspaceFileKind;
  query?: string;
  limit?: number;
}

export interface WorkspaceFileCatalog {
  list(input: WorkspaceFileListInput): WorkspaceFileEntry[];
}

/**
 * FilesService 的结构子集：目录查询（含相对路径）与路径解析，便于测试替换。
 * 用 catalog 而不是 uploaded_files 直查：相对路径（中文目录名）对「产品图」这类
 * 检索很关键，uploaded_files 行里没有。
 */
export interface WorkspaceFileSource {
  listCatalog(
    limit: number,
    offset: number,
    /** 检索词的 LIKE 模式（见 catalogQueryLikePatterns）：在库内过滤，避免大目录只扫最新一页而漏检。 */
    nameLikePatterns?: string[],
  ): {
    items: ReadonlyArray<{
      id: string;
      originalName: string;
      sharedTitle: string;
      relativePath: string | null;
      bytes: number;
      dataType: string | null;
      contentHash: string;
      updatedAt: string;
    }>;
  };
  catalogStoragePathOf(fileEntryId: string): string | null;
}

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 50;
/** 单次扫描上限：工作区文件量大时也不做全表遍历。 */
const SCAN_LIMIT = 500;
const IMAGE_NAME = /\.(png|jpe?g|gif|webp|bmp|heic|heif)$/i;

function isImageEntry(entry: { dataType: string | null; originalName: string }): boolean {
  return entry.dataType === "image" || IMAGE_NAME.test(entry.originalName);
}

/** 见 catalogQueryLikePatterns：内存过滤与 SQL 下推共用同一套模式展开。 */
function matchesQuery(text: string, query: string): boolean {
  const haystack = text.toLowerCase();
  return catalogQueryLikePatterns(query).some((pattern) => haystack.includes(pattern));
}

/**
 * 把检索词展开成匹配模式（token 本身 + CJK 连续段的 2 字窗口）。
 * 窗口只在 CJK 段内成窗、不跨 ASCII 字符：「锥光BP-1020」展开为「锥光bp-1020 / 锥光」。
 * 旧的全 token 滑窗会产生「p-」「-1」这类噪声窗，把 whatsapp-business、polyvox_app_rn-1
 * 等批量同步文件全召回来，灌满 500 条结果窗后目标文件仍被挤出。
 * 段内窗口保留兜底语义：文件名「锥光 BP-1020.md」带空格时整串 includes 不中，「锥光」窗仍命中。
 */
export function catalogQueryLikePatterns(query: string): string[] {
  const patterns: string[] = [];
  for (const token of query.toLowerCase().split(/\s+/).filter(Boolean)) {
    patterns.push(token);
    for (const run of token.match(/[\u2e80-\u9fff]{2,}/g) ?? []) {
      const chars = [...run];
      for (let index = 0; index + 2 <= chars.length; index += 1) {
        patterns.push(chars.slice(index, index + 2).join(""));
      }
    }
  }
  // 模式数硬上限：模型会把已知文件名/路径全串进一次 query（实测数百 token、重复三遍），
  // 展开出上百个 LIKE 既烧库也把工具参数撑爆上下文。超限只取前 16 个模式。
  return [...new Set(patterns)].slice(0, 16);
}

/** 用 FilesService 构造目录（生产实现）。 */
export function createWorkspaceFileCatalog(
  source: WorkspaceFileSource,
  options?: { cacheTtlMs?: number },
): WorkspaceFileCatalog {
  // arrange 素材预取会按页多次调用检索：短 TTL 缓存目录行，避免每次全量查库。
  const cacheTtlMs = options?.cacheTtlMs ?? 10_000;
  let cachedAt = 0;
  let cachedRows: ReturnType<WorkspaceFileSource["listCatalog"]>["items"] | null = null;
  const rows = (query?: string) => {
    if (query) {
      // 带词检索在库内完成（结果集与无词缓存不同，不走共享缓存）。
      return source.listCatalog(SCAN_LIMIT, 0, catalogQueryLikePatterns(query)).items;
    }
    const now = Date.now();
    if (!cachedRows || now - cachedAt > cacheTtlMs) {
      cachedRows = source.listCatalog(SCAN_LIMIT, 0).items;
      cachedAt = now;
    }
    return cachedRows;
  };
  return {
    list(input) {
      const kind = input.kind ?? "all";
      const limit = Math.min(MAX_LIMIT, Math.max(1, input.limit ?? DEFAULT_LIMIT));
      const query = input.query?.trim() ?? "";
      const entries: WorkspaceFileEntry[] = [];
      for (const row of rows(query || undefined)) {
        const image = isImageEntry(row);
        if (kind === "image" && !image) continue;
        if (kind === "document" && image) continue;
        const searchable = [row.originalName, row.sharedTitle, row.relativePath ?? ""].join("\n");
        if (query && !matchesQuery(searchable, query)) continue;
        entries.push({
          fileEntryId: row.id,
          name: row.sharedTitle || row.originalName,
          kind: image ? "image" : row.dataType ? "document" : "other",
          type: row.dataType,
          bytes: row.bytes,
          updatedAt: row.updatedAt,
          relativePath: row.relativePath,
          absolutePath: source.catalogStoragePathOf(row.id),
          materialRef: image && /^[a-f0-9]{64}$/.test(row.contentHash)
            ? `everroom-material://${row.contentHash}`
            : null,
        });
        if (entries.length >= limit) break;
      }
      return entries;
    },
  };
}

/** 文本类原文件兜底：按扩展名判断（mime 常缺失）。 */
const TEXT_FILENAME = /\.(md|markdown|txt|csv|json|xml|html?)$/i;

/** FilesService 的结构子集：读文件库正文本体（文档解析结果优先，文本原文件兜底）。 */
export interface WorkspaceFileTextSource {
  catalogEntry(fileEntryId: string): { sharedTitle?: string | null; originalName: string } | null;
  catalogMarkdownOf(fileEntryId: string): string | null;
  catalogContentOf(fileEntryId: string): Promise<{ buffer: Buffer; mime: string; filename: string } | null>;
}

/**
 * 读工作区上传文件的文本正文：先取文档解析出的 Markdown（docx/pdf 等只有这条路），
 * 没有解析结果时对文本类原文件（md/txt 等）直接 utf8 读字节；二进制无解析返回 null。
 */
export function createWorkspaceFileTextReader(
  getSource: () => WorkspaceFileTextSource | null,
): (fileEntryId: string) => Promise<{ text: string; filename: string } | null> {
  return async (fileEntryId) => {
    const source = getSource();
    if (!source) return null;
    const entry = source.catalogEntry(fileEntryId);
    if (!entry) return null;
    const markdown = source.catalogMarkdownOf(fileEntryId);
    if (markdown) return { text: markdown, filename: entry.sharedTitle || entry.originalName };
    const content = await source.catalogContentOf(fileEntryId);
    if (!content) return null;
    if (TEXT_FILENAME.test(content.filename) || content.mime.startsWith("text/")) {
      return { text: content.buffer.toString("utf8"), filename: content.filename };
    }
    return null;
  };
}

/**
 * 主 Agent 的「工作区文件清单」工具：只读、无审批。
 * 目录用 getter 注入：filesService 在 runtime 装配之后才创建（晚绑定）。
 */
export function createWorkspaceFilesPiTools(
  getCatalog: () => WorkspaceFileCatalog | null,
): PiAgentRuntimeTool[] {
  const tool: PiAgentRuntimeTool = {
    name: "workspace_files_list",
    label: "工作区文件清单",
    description: "列出用户工作区里的文件（可按图片/文档筛选、按文件名/目录搜索），返回 fileEntryId、文件名、类型、大小、本地绝对路径，以及图片可直接用于 PPT 配图的 everroom-material 引用。query 支持空格分隔多个关键词、任一命中即返回：找图片一次传「png jpg jpeg webp gif」，找资料一次传多个主题词或扩展名，不要按扩展名逐个查询；要浏览全部图片直接 kind=image 不带 query。用户要求使用工作区/上传/历史资料里的图片或文件时先调用它；不要用 shell、sqlite 或直接读应用数据目录来查找文件。",
    parameters: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: ["image", "document", "all"],
          description: "筛选文件类型：image 只看图片，document 只看非图片文件，all 全部（缺省）。",
        },
        query: {
          type: "string",
          description: "按文件名、显示名或目录搜索的关键词，例如「产品图」「Cyplore」。留空表示不筛选。",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: MAX_LIMIT,
          description: `最多返回条数，缺省 ${String(DEFAULT_LIMIT)}，上限 ${String(MAX_LIMIT)}。`,
        },
      },
      additionalProperties: false,
    },
    promptSnippet: "工作区文件清单",
    promptGuidelines: [
      "需要工作区里的文件或图片（例如「用上传的图片做 PPT」「用资料里的照片」）时，先调用 workspace_files_list 获取清单与引用；不要用 shell、sqlite 或读应用数据目录去找文件。",
      "把图片用于 PPT 时，把图片文件名或画面主题写进 slides_draft 的 instruction，由 slides 子代理按素材引用配图；不要把图片读进自己的上下文。",
    ],
    executionMode: "sequential",
    execute: async (_input, params, signal): Promise<PiAgentRuntimeToolResult> => {
      if (signal?.aborted) throw new Error("workspace_files_list 已取消");
      const catalog = getCatalog();
      if (!catalog) throw new Error("workspace_files_list 暂不可用：工作区文件服务尚未就绪，请稍后重试。");
      const kindParam = params.kind;
      const kind: WorkspaceFileKind | undefined = kindParam === "image" || kindParam === "document" || kindParam === "all"
        ? kindParam
        : undefined;
      const query = typeof params.query === "string" ? params.query.trim() : "";
      const limit = typeof params.limit === "number" && Number.isFinite(params.limit)
        ? Math.trunc(params.limit)
        : undefined;
      const files = catalog.list({ ...(kind ? { kind } : {}), ...(query ? { query } : {}), ...(limit ? { limit } : {}) });
      const payload = {
        files,
        total: files.length,
        note: "图片的 materialRef 可直接用于 PPT 配图；需要本地路径的工具可用 absolutePath。",
      };
      return {
        content: JSON.stringify(payload),
        details: payload,
      };
    },
  };
  return [tool];
}
