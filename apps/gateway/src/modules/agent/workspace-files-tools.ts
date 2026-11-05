import type { PiAgentRuntimeTool, PiAgentRuntimeToolResult } from "@nxcore/agent-runtime-pi";
import { imageDimensions } from "../slides-layout/tree/aspect-ratio.js";

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
  /** 工作区过滤；缺省 = 全库（兼容素材检索等不区分空间的调用）。 */
  workspaceId?: string;
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
    /** 工作区过滤；缺省 = 全库（兼容素材检索等不区分空间的调用）。 */
    workspaceId?: string,
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
/**
 * kind=image 无 query 时的 SQL 下推模式：图片扩展名直接进库内过滤。否则只扫
 * 「最新 500 条」再内存筛选——库大 + 当日新增多时图片全被挤出窗口（2026-11-05
 * 实测 14 张图全漏）。SQL 命中的误报（文件名含 png/jpg 字样的非图片）由 isImageEntry 兜底剔除。
 */
const IMAGE_SCAN_QUERY = "png jpg jpeg gif webp bmp heic heif";

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
  let cachedKey = "";
  let cachedRows: ReturnType<WorkspaceFileSource["listCatalog"]>["items"] | null = null;
  const rows = (query: string | undefined, workspaceId: string | undefined) => {
    if (query) {
      // 带词检索在库内完成（结果集与无词缓存不同，不走共享缓存）。
      return source.listCatalog(SCAN_LIMIT, 0, catalogQueryLikePatterns(query), workspaceId).items;
    }
    const key = workspaceId ?? "all";
    const now = Date.now();
    if (cachedKey !== key || !cachedRows || now - cachedAt > cacheTtlMs) {
      cachedRows = source.listCatalog(SCAN_LIMIT, 0, undefined, workspaceId).items;
      cachedKey = key;
      cachedAt = now;
    }
    return cachedRows;
  };
  return {
    list(input) {
      const kind = input.kind ?? "all";
      const limit = Math.min(MAX_LIMIT, Math.max(1, input.limit ?? DEFAULT_LIMIT));
      const query = input.query?.trim() ?? "";
      // 无 query 的 kind=image 走图片扩展名下推（见 IMAGE_SCAN_QUERY）；其余走原路径。
      const scanQuery = query || (kind === "image" ? IMAGE_SCAN_QUERY : "");
      const workspaceId = input.workspaceId?.trim() || undefined;
      const entries: WorkspaceFileEntry[] = [];
      for (const row of rows(scanQuery || undefined, workspaceId)) {
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
  catalogEntry(fileEntryId: string): {
    sharedTitle?: string | null;
    originalName: string;
    /** 文件格式类别（图片为 "image"），预览用它区分图片描述与文本前缀。 */
    dataType: string | null;
    /** 内容哈希：图片据此生成 materialRef。 */
    contentHash: string;
  } | null;
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

/** workspace_file_read / 预览共用的正文读取函数形态。 */
export type WorkspaceFileTextReader = (fileEntryId: string) => Promise<{ text: string; filename: string } | null>;

const PREVIEW_MAX_FILES = 20;
const BATCH_READ_MAX_FILES = 4;
const BATCH_READ_DEFAULT_CHARS = 20_000;
const BATCH_READ_MAX_CHARS = 40_000;
/** 整批总预算：对齐旧 planner sourceDocuments 预取口径（合计 60k），防止一次读爆上下文。 */
const BATCH_READ_TOTAL_BUDGET = 60_000;
const PREVIEW_DEFAULT_CHARS = 500;
const PREVIEW_MAX_CHARS = 4_000;
const PREVIEW_MIN_CHARS = 100;
const PREVIEW_TOTAL_BUDGET = 24_000;

/**
 * 批量预览工作区文件：一次调用返回多个文件的「图片视觉描述 / 文本正文前缀」。
 *
 * 动机：图片导入时 image-vlm 已把视觉描述落库（catalogMarkdownOf 直读即可），
 * 模型却常逐张发起视觉分析——N 张图 = N 次串行 VLM 秒级调用。本工具把这一步
 * 变成一次零推理的批量 DB 查询；文本文件同样受益（前缀筛内容，替代逐个全文读）。
 */
export function createWorkspaceFilePreviewTool(
  getTextSource: () => WorkspaceFileTextSource | null,
  readFileText: WorkspaceFileTextReader,
): PiAgentRuntimeTool {
  return {
    name: "workspace_files_preview",
    label: "批量预览工作区文件",
    description: "一次调用批量获取多个工作区文件的内容预览，替代对每个文件逐个调用读取/视觉分析。"
      + "图片返回导入时已解析好的视觉描述（不触发新的视觉分析，秒回）、宽高（width/height，配图按比例定框用）与 materialRef；"
      + "文档/文本返回正文开头与是否截断。"
      + "用途：选定要用的素材、判断文件是否与主题相关时先用本工具；只有确定承担页面内容的文件才需要再读全文。"
      + "图片若返回 descriptionMissing（导入时解析失败），确需该图再单独做视觉分析。",
    parameters: {
      type: "object",
      properties: {
        fileIds: {
          type: "array",
          items: { type: "string", minLength: 1 },
          minItems: 1,
          maxItems: PREVIEW_MAX_FILES,
          description: "workspace_files_list / file_search / content_search 返回的 fileEntryId 列表（最多 20 个）",
        },
        maxCharsPerFile: {
          type: "integer",
          minimum: PREVIEW_MIN_CHARS,
          maximum: PREVIEW_MAX_CHARS,
          description: `单文件返回字符上限，缺省 ${String(PREVIEW_DEFAULT_CHARS)}（图片描述一般几百字内）；超出上下限会自动收敛`,
        },
      },
      required: ["fileIds"],
      additionalProperties: false,
    },
    promptSnippet: "批量预览工作区文件",
    promptGuidelines: [
      "需要了解多张图片或多个文件的内容时，用 workspace_files_preview 一次批量拿描述/前缀；不要对素材图片逐张调视觉分析。",
    ],
    executionMode: "sequential",
    execute: async (_input, params, signal): Promise<PiAgentRuntimeToolResult> => {
      if (signal?.aborted) throw new Error("workspace_files_preview 已取消");
      const source = getTextSource();
      if (!source) throw new Error("workspace_files_preview 暂不可用：工作区文件服务尚未就绪，请稍后重试。");
      const ids = [...new Set(
        (Array.isArray(params.fileIds) ? params.fileIds : [])
          .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
          .map((value) => value.trim()),
      )].slice(0, PREVIEW_MAX_FILES);
      const requestedPerFile = typeof params.maxCharsPerFile === "number" && Number.isFinite(params.maxCharsPerFile)
        ? Math.min(PREVIEW_MAX_CHARS, Math.max(PREVIEW_MIN_CHARS, Math.trunc(params.maxCharsPerFile)))
        : PREVIEW_DEFAULT_CHARS;
      let budget = PREVIEW_TOTAL_BUDGET;
      const previews: Array<Record<string, unknown>> = [];
      for (const fileEntryId of ids) {
        const entry = source.catalogEntry(fileEntryId);
        if (!entry) {
          previews.push({ fileEntryId, error: "not_found" });
          continue;
        }
        const image = entry.dataType === "image" || IMAGE_NAME.test(entry.originalName);
        const name = entry.sharedTitle || entry.originalName;
        const perFile = Math.min(requestedPerFile, budget);
        if (perFile <= 0) {
          previews.push({ fileEntryId, name, kind: image ? "image" : "document", skipped: "budget_exhausted" });
          continue;
        }
        const markdown = source.catalogMarkdownOf(fileEntryId);
        if (image) {
          // 宽高比是配图版式的刚需：没有这一对数字模型会去应用数据目录里 exiftool
          // 挖元数据（2026-11-06 实测 15 次 bash 风暴）。本地字节头解析，无 VLM。
          let dimensions: { w: number; h: number } | null = null;
          try {
            const content = await source.catalogContentOf(fileEntryId);
            dimensions = content ? imageDimensions(content.buffer) : null;
          } catch {
            dimensions = null;
          }
          previews.push({
            fileEntryId,
            name,
            kind: "image",
            ...(dimensions ? { width: dimensions.w, height: dimensions.h } : {}),
            ...(markdown && markdown.trim()
              ? { description: markdown.slice(0, perFile), descriptionTruncated: markdown.length > perFile }
              : { descriptionMissing: true }),
            ...(entry.contentHash && /^[a-f0-9]{64}$/.test(entry.contentHash)
              ? { materialRef: `everroom-material://${entry.contentHash}` }
              : {}),
          });
          budget -= Math.min(markdown?.length ?? 0, perFile);
          continue;
        }
        let text = markdown;
        if (text === null) {
          const read = await readFileText(fileEntryId);
          text = read?.text ?? null;
        }
        previews.push({
          fileEntryId,
          name,
          kind: "document",
          ...(text !== null && text.trim()
            ? { preview: text.slice(0, perFile), truncated: text.length > perFile, chars: text.length }
            : { noText: true }),
        });
        budget -= Math.min(text?.length ?? 0, perFile);
      }
      const payload = { previews, total: previews.length };
      return { content: JSON.stringify(payload), details: payload };
    },
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
      "把图片用于 PPT 时，把返回的 materialRef（everroom-material://…）直接作为 slides_create 脚本里 addImage 的 path（或公网 http(s) 链接）；封面/产品图优先用素材，不要把图片读进自己的上下文，也不要用 AI 生图替代用户素材。",
    ],
    executionMode: "sequential",
    execute: async (input, params, signal): Promise<PiAgentRuntimeToolResult> => {
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
      const workspaceId = input.workspaceId?.trim();
      const files = catalog.list({
        ...(kind ? { kind } : {}),
        ...(query ? { query } : {}),
        ...(limit ? { limit } : {}),
        // 工具语义是「工作区文件清单」：默认收敛到会话所属工作区，不再全库扫。
        ...(workspaceId ? { workspaceId } : {}),
      });
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

/**
 * 批量全文读取：一次调用拿 2~4 篇材料的正文（单篇与总量都有预算），替代逐个
 * workspace_file_read 分页读——2026-11-06 实测生成 PPT 时模型逐篇读了 11 次。
 * 预算口径对齐旧 planner sourceDocuments 预取（单篇 40k、合计 60k）：超出部分
 * 截断并给 nextOffset，确需余篇再用 file_read 续读，不默认全量进上下文。
 */
export function createWorkspaceFilesReadBatchTool(
  getTextSource: () => WorkspaceFileTextSource | null,
  readFileText: WorkspaceFileTextReader,
): PiAgentRuntimeTool {
  return {
    name: "workspace_files_read_batch",
    label: "批量读取工作区文件正文",
    description: "一次调用读取 2~4 篇工作区文件的正文（完整或带截断标记），替代对多份材料逐个分页读取。"
      + "单篇默认 20000 字符（上限 40000）、整批合计 60000 字符封顶——超出部分截断并返回 nextOffset，需要余篇再用 file_read 续读。"
      + "用途：确定要引用进产物的少数材料（PPT 页面内容、报告论据）在 preview 筛选后一次读齐；不要用它穷举整个资料库。"
      + "图片不支持正文读取（用 workspace_files_preview 拿描述与宽高）。",
    parameters: {
      type: "object",
      properties: {
        fileIds: {
          type: "array",
          items: { type: "string", minLength: 1 },
          minItems: 1,
          maxItems: BATCH_READ_MAX_FILES,
          description: `要读正文的 fileEntryId 列表（最多 ${String(BATCH_READ_MAX_FILES)} 篇，按重要性排序——预算不够时排前的拿全量）`,
        },
        maxCharsPerFile: {
          type: "integer",
          minimum: 2_000,
          maximum: BATCH_READ_MAX_CHARS,
          description: `单篇字符上限，缺省 ${String(BATCH_READ_DEFAULT_CHARS)}；超出上下限自动收敛`,
        },
      },
      required: ["fileIds"],
      additionalProperties: false,
    },
    promptSnippet: "批量读取工作区文件正文",
    promptGuidelines: [
      "多篇材料的正文用 workspace_files_read_batch 一次读齐（每篇截断处有 nextOffset），不要逐个分页读。",
    ],
    executionMode: "sequential",
    execute: async (_input, params, signal): Promise<PiAgentRuntimeToolResult> => {
      if (signal?.aborted) throw new Error("workspace_files_read_batch 已取消");
      const source = getTextSource();
      if (!source) throw new Error("workspace_files_read_batch 暂不可用：工作区文件服务尚未就绪，请稍后重试。");
      const ids = [...new Set(
        (Array.isArray(params.fileIds) ? params.fileIds : [])
          .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
          .map((value) => value.trim()),
      )].slice(0, BATCH_READ_MAX_FILES);
      const requestedPerFile = typeof params.maxCharsPerFile === "number" && Number.isFinite(params.maxCharsPerFile)
        ? Math.min(BATCH_READ_MAX_CHARS, Math.max(2_000, Math.trunc(params.maxCharsPerFile)))
        : BATCH_READ_DEFAULT_CHARS;
      let budget = BATCH_READ_TOTAL_BUDGET;
      const files: Array<Record<string, unknown>> = [];
      for (const fileEntryId of ids) {
        const entry = source.catalogEntry(fileEntryId);
        if (!entry) {
          files.push({ fileEntryId, error: "not_found" });
          continue;
        }
        const name = entry.sharedTitle || entry.originalName;
        if (entry.dataType === "image" || IMAGE_NAME.test(entry.originalName)) {
          files.push({ fileEntryId, name, error: "image_not_supported", hint: "用 workspace_files_preview 获取图片描述与宽高" });
          continue;
        }
        const read = await readFileText(fileEntryId);
        if (!read || !read.text.trim()) {
          files.push({ fileEntryId, name, noText: true });
          continue;
        }
        const perFile = Math.min(requestedPerFile, budget);
        if (perFile <= 0) {
          files.push({ fileEntryId, name, skipped: "budget_exhausted", chars: read.text.length });
          continue;
        }
        const text = read.text.slice(0, perFile);
        budget -= text.length;
        files.push({
          fileEntryId,
          name,
          text,
          chars: read.text.length,
          truncated: read.text.length > text.length,
          ...(read.text.length > text.length ? { nextOffset: text.length } : {}),
        });
      }
      const payload = {
        files,
        total: files.length,
        note: "截断的文件用 file_read(fileId, offset=nextOffset) 续读余篇；图片走 workspace_files_preview。",
      };
      return { content: JSON.stringify(payload), details: payload };
    },
  };
}
