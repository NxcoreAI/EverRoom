import { Type } from "@sinclair/typebox";
import type { PiAgentRuntimeTool } from "@nxcore/agent-runtime-pi";
import type { StartRuntimeRunInput } from "@nxcore/agent-runtime";
import { type FileCatalogScope } from "./service.js";
import { describeFileKind, scopeLabelOf } from "./file-kind.js";

/** 单次读取预算：与 document_read 对齐（避免整篇长文进上下文）。 */
export const FILE_READ_DEFAULT_LIMIT = 40_000;
export const FILE_READ_MAX_LIMIT = 80_000;

/** file_search 返回条数：默认 10，最多 50（再多大模型也读不完，只会挤占上下文）。 */
export const FILE_SEARCH_DEFAULT_LIMIT = 10;
export const FILE_SEARCH_MAX_LIMIT = 50;

/** 打开中的文件可能刚被导入：条目落库前短暂轮询，别把「正在导入」报成「不存在」。 */
const ENTRY_WAIT_MS = 3_000;
const ENTRY_POLL_MS = 300;

interface CatalogEntryLike {
  id: string;
  originalName: string;
  displayName: string | null;
  currentVersionId: string | null;
  processingState: string;
}

interface ParsedLike {
  markdown: string;
}

export interface FileReadToolDeps {
  /** 惰性取：filesService 在 create-server 里晚于工具装配创建。 */
  files: () => {
    catalogEntry(fileEntryId: string): CatalogEntryLike | null;
    catalogMarkdownOf(fileEntryId: string): string | null;
    markdownOf(fileId: string): string | null;
  } | null;
  /** 文档理解服务：按版本解析 Office/PDF → Markdown（惰性取，同上）。 */
  understanding: () => {
    markdownForFile(fileEntryId: string): string | null;
    parseVersion(fileEntryId: string, fileVersionId: string): Promise<ParsedLike | null>;
  } | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function positiveInt(value: unknown, fallback: number, max: number): number {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < 1) return fallback;
  return Math.min(numeric, max);
}

/**
 * `file_read`：读取「用户当前正在浏览的 Office 文件」或显式 fileId 的正文。
 *
 * 为什么需要独立工具：Office 文件是 file_entries（docx/xlsx/pptx/pdf），不是文档
 * 内核里的 documents；document_read 只认 documentId，模型在用户说“这份文档”时
 * 只能去猜工作区里的文稿。本工具用运行上下文里的 activeFile（桌面 main 注入的
 * 焦点页签）兜底 fileId，并用当前版本已解析的 Markdown 作答。
 */
export function createFileReadPiTool(deps: FileReadToolDeps): PiAgentRuntimeTool {
  return {
    name: "file_read",
    label: "读取任意已入库文件正文（含资料库/产物里的 PDF、Office）",
    description:
      "读取用户当前正在浏览的 Office 文件（Word/Excel/PPT/PDF）或指定 fileId 的正文（Markdown）。"
      + "fileId 省略 = 用户当前打开/浏览的那个文件；回答“这份文档写了什么”之前先调用本工具，"
      + "不要用 document_list/document_read 去猜工作区里的其他文稿。"
      + "传资料库/产物里任意条目的 fileId 也能读（file_search 可拿到，或用运行提示里的库内线索）；"
      + "PDF/Office 没解析过时会现解析（首次可能几秒），解析结果会缓存到该版本。"
      + "用户的问题答案可能落在库内某份材料里时，先 file_search 定位、再本工具读，不要凭常识作答。"
      + "读的是最近一次保存到磁盘的版本（未保存的编辑不在其中）；长文按 offset/limit 分页，"
      + "truncated/nextOffset 标明是否还有后续。空白文件会返回 empty=true。",
    parameters: Type.Object({
      fileId: Type.Optional(Type.String({
        minLength: 1,
        maxLength: 200,
        description: "文件 id（fileEntryId）；省略 = 当前正在浏览的文件",
      })),
      offset: Type.Optional(Type.Integer({
        minimum: 0,
        description: "Markdown 字符偏移（分页时传上一页的 nextOffset）",
      })),
      limit: Type.Optional(Type.Integer({
        minimum: 1,
        maximum: FILE_READ_MAX_LIMIT,
        description: `本次返回的字符数上限（缺省 ${FILE_READ_DEFAULT_LIMIT}）`,
      })),
    }, { additionalProperties: false }),
    executionMode: "sequential",
    // 行为指引不写在这里：本仓库 runtime 一律用自定义 system prompt，工具级
    // promptSnippet/promptGuidelines 不会渲染（见 modules/memory/pi-tools.ts 注释）。
    // 「用户说这份文档就先读它」的规矩写在 agents/main/SYSTEM.md 路由表。
    execute: async (input: StartRuntimeRunInput, params: Record<string, unknown>) => {
      const requestedFileId = typeof params.fileId === "string" ? params.fileId.trim() : "";
      const fileId = requestedFileId || input.activeFile?.fileId || "";
      if (!fileId) {
        throw new Error(
          "NO_ACTIVE_FILE: 当前没有正在浏览的 Office 文件。请让用户先打开文件，或在调用时显式传 fileId。",
        );
      }
      const files = deps.files();
      const understanding = deps.understanding();
      if (!files || !understanding) throw new Error("FILE_SERVICE_UNAVAILABLE: 文件服务尚未就绪");

      let entry = files.catalogEntry(fileId);
      if (!entry && fileId === input.activeFile?.fileId) {
        const deadline = Date.now() + ENTRY_WAIT_MS;
        while (!entry && Date.now() < deadline) {
          await sleep(ENTRY_POLL_MS);
          entry = files.catalogEntry(fileId);
        }
      }
      if (!entry) throw new Error(`FILE_NOT_FOUND: ${fileId} 不在资料中（可能仍在导入或已被删除）`);

      let markdown = files.catalogMarkdownOf(fileId)
        ?? files.markdownOf(fileId)
        ?? understanding.markdownForFile(fileId);
      if (markdown === null && entry.currentVersionId) {
        const parsed = await understanding.parseVersion(fileId, entry.currentVersionId);
        markdown = parsed?.markdown ?? null;
      }
      if (markdown === null) {
        throw new Error(
          `FILE_NOT_PARSABLE: ${entry.displayName ?? entry.originalName} 的格式暂不支持读取正文`,
        );
      }

      const total = markdown.length;
      const offset = Math.min(Number.isSafeInteger(Number(params.offset)) ? Math.max(0, Number(params.offset)) : 0, total);
      const limit = positiveInt(params.limit, FILE_READ_DEFAULT_LIMIT, FILE_READ_MAX_LIMIT);
      const end = Math.min(offset + limit, total);
      const content = markdown.slice(offset, end);
      const payload = {
        fileId,
        title: entry.displayName ?? entry.originalName,
        originalName: entry.originalName,
        active: fileId === input.activeFile?.fileId,
        content,
        empty: total === 0,
        offset,
        totalCharacters: total,
        truncated: end < total,
        ...(end < total ? { nextOffset: end } : {}),
        source: "saved-version",
      };
      return {
        content: JSON.stringify(payload),
        details: {
          fileId,
          offset,
          totalCharacters: total,
          truncated: end < total,
        },
      };
    },
  };
}

/** file_search 依赖的最小文件访问面（FilesService 的结构子集）。 */
interface CatalogSearchHit {
  id: string;
  originalName: string;
  displayName: string | null;
  workspaceId: string;
  updatedAt: string;
  dataType: string | null;
  /** 来源（产物/资料的判据）：agent-generated / artifact-imported 属产物库。 */
  sourceKind: string;
}

export interface FileSearchToolDeps {
  /** 惰性取：filesService 在 create-server 里晚于工具装配创建。 */
  files: () => {
    searchCatalog(
      query: string,
      options?: {
        extensions?: readonly string[];
        workspaceId?: string;
        scope?: FileCatalogScope;
        limit?: number;
        offset?: number;
      },
    ): { items: CatalogSearchHit[]; total: number } | null;
  } | null;
}

/**
 * `file_search`：按文件名在文件库里定位条目，拿到 fileId。
 *
 * 为什么需要：Word/Excel 编辑已经支持「任意已入库 docx/xlsx 按 fileId 后台编辑」，
 * 但模型手里往往只有「那份调研报告」这种模糊指代——file_read / word_agent_* /
 * sheets_agent_* 都只认 fileId。本工具把「用户说的是哪份文件」变成确定 id，
 * 用户不必先把文件打开或在页签里翻。
 */
export function createFileSearchPiTool(deps: FileSearchToolDeps): PiAgentRuntimeTool {
  return {
    name: "file_search",
    label: "按文件名搜索文件（可限定产物/资料）",
    description:
      "在资料里按文件名子串搜索已入库的文件（Word/Excel/PPT/PDF/Markdown/图片等），返回 fileId 列表。"
      + "用户的问题可能落在工作区资料库/产物的某份材料里时，先用它把「哪份文件」变成确定 fileId，"
      + "不必等用户报出文件名，也不要要求用户先上传或打开文件。"
      + "query 同时匹配原始文件名和显示名（不区分大小写，中文按子串）；extension 可以是单个扩展名或数组。"
      + "scope 用来对应用户界面上的两个页签：用户说“产物库/你生成的/上次做的”传 artifacts，"
      + "说“资料库/我上传的/我的资料”传 library，不提则省略（= 整库搜）。"
      + "用户说“那份/之前生成的/叫 XX 的报告”但没给 fileId、或者要改的文件当前没打开时，先用本工具定位 fileId，"
      + "再把 fileId 传给 file_read / word_agent_read / word_agent_edit / word_agent_ops / slides_read / sheets_agent_read / sheets_agent_edit。"
      + "用户提到“刚上传的 logo / 之前生成的那张图”时也先用本工具（extension 传 [\"png\",\"jpg\",\"jpeg\"]）找图片 fileId，再作为图片入参的 fileId。"
      + "query 省略 = 按最近更新时间倒序列出（可在 scope/extension 过滤后浏览）。"
      + "每条结果带 scope 字段（产物/资料），可用来核对命中是不是用户说的那一栏。",
    parameters: Type.Object({
      query: Type.Optional(Type.String({
        minLength: 1,
        maxLength: 200,
        description: "文件名关键词（子串匹配原始文件名/显示名）；省略 = 最近更新的文件",
      })),
      extension: Type.Optional(Type.Union([
        Type.String({ minLength: 2, maxLength: 160 }),
        Type.Array(Type.String({ minLength: 2, maxLength: 12 }), { minItems: 1, maxItems: 8 }),
      ], {
        description: "扩展名过滤，如 docx / .xlsx / pptx / pdf；也可以传数组（[\"png\",\"jpg\"] 找图片）、逗号分隔或 JSON 数组字符串（自动解析）。大小写不敏感",
      })),
      scope: Type.Optional(Type.Union([
        Type.Literal("all"),
        Type.Literal("library"),
        Type.Literal("artifacts"),
      ], {
        description: "来源范围：artifacts = 产物库（Agent 生成/产物导入），library = 资料库（上传/本地目录/连接器/剪藏等），all 或省略 = 整库",
      })),
      workspaceId: Type.Optional(Type.String({
        minLength: 1,
        maxLength: 200,
        description: "限定工作区；省略 = 当前会话所属工作区（再缺省则全库）",
      })),
      limit: Type.Optional(Type.Integer({
        minimum: 1,
        maximum: FILE_SEARCH_MAX_LIMIT,
        description: `返回条数上限（缺省 ${FILE_SEARCH_DEFAULT_LIMIT}，最多 ${FILE_SEARCH_MAX_LIMIT}）`,
      })),
      offset: Type.Optional(Type.Integer({
        minimum: 0,
        description: "分页偏移：命中多于 limit 时传上一页的 nextOffset 继续翻",
      })),
    }, { additionalProperties: false }),
    executionMode: "sequential",
    // 行为指引不写在这里：本仓库 runtime 一律用自定义 system prompt，工具级
    // promptSnippet/promptGuidelines 不会渲染（见 modules/memory/pi-tools.ts 注释）。
    // 「什么时候该先搜、不许要求用户先打开文件」这类规矩写在 agents/main/SYSTEM.md 路由表。
    execute: async (input: StartRuntimeRunInput, params: Record<string, unknown>) => {
      const files = deps.files();
      if (!files) throw new Error("FILE_SERVICE_UNAVAILABLE: 文件服务尚未就绪");
      const query = typeof params.query === "string" ? params.query.trim() : "";
      // 模型常把数组参数序列化成 JSON 字符串（实测 deepseek："[\"md\",\"txt\"]"）或写成语义
      // 等价的逗号分隔——扩展名本身不含逗号/括号，直接解开，省一轮校验失败重试。
      const parseExtensionList = (value: string): string[] => {
        const trimmed = value.trim();
        if (trimmed.startsWith("[")) {
          try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) return parsed.filter((item): item is string => typeof item === "string");
          } catch { /* 落到逗号分隔 */ }
        }
        return trimmed.split(/[,，\s]+/);
      };
      const rawExtensions = Array.isArray(params.extension)
        ? params.extension
        : typeof params.extension === "string"
          ? parseExtensionList(params.extension)
          : [];
      const extensions = rawExtensions
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean)
        .slice(0, 8);
      const rawScope = typeof params.scope === "string" ? params.scope.trim().toLowerCase() : "";
      const scope: FileCatalogScope = rawScope === "artifacts" || rawScope === "library" ? rawScope : "all";
      const requestedWorkspace = typeof params.workspaceId === "string" ? params.workspaceId.trim() : "";
      const workspaceId = requestedWorkspace || input.workspaceId?.trim() || undefined;
      const limit = positiveInt(params.limit, FILE_SEARCH_DEFAULT_LIMIT, FILE_SEARCH_MAX_LIMIT);
      const offset = Number.isSafeInteger(Number(params.offset)) && Number(params.offset) > 0
        ? Number(params.offset)
        : 0;
      const found = files.searchCatalog(query, {
        ...(extensions.length > 0 ? { extensions } : {}),
        ...(scope !== "all" ? { scope } : {}),
        ...(workspaceId ? { workspaceId } : {}),
        limit,
        ...(offset > 0 ? { offset } : {}),
      });
      if (!found) throw new Error("FILE_SEARCH_UNAVAILABLE: 文件目录尚未就绪");
      const items = found.items.map((item) => {
        const described = describeFileKind(item.originalName);
        const { scope: itemScope, scopeKey } = scopeLabelOf(item.sourceKind);
        return {
          fileId: item.id,
          originalName: item.originalName,
          displayName: item.displayName,
          extension: described.extension,
          kind: described.kind,
          readable: described.readable,
          scope: itemScope,
          scopeKey,
          sourceKind: item.sourceKind,
          dataType: item.dataType,
          workspaceId: item.workspaceId,
          updatedAt: item.updatedAt,
        };
      });
      const scopeLabel = scope === "artifacts" ? "产物" : scope === "library" ? "资料" : "全部文件";
      const payload = {
        query,
        ...(extensions.length > 0 ? { extension: extensions.length === 1 ? extensions[0] : extensions } : {}),
        scope,
        ...(workspaceId ? { workspaceId } : {}),
        total: found.total,
        offset,
        returned: items.length,
        hasMore: offset + items.length < found.total,
        ...(offset + items.length < found.total ? { nextOffset: offset + items.length } : {}),
        items,
        ...(items.length === 0
          ? {
              hint: query
                ? `${scopeLabel}里没有文件名包含“${query}”的文件；换个关键词或去掉扩展名过滤再试。`
                  + (scope === "all" ? "" : "确认真没有，再用 scope=all 搜一次整库。")
                : `${scopeLabel}里还没有匹配的文件。`,
            }
          : {
              hint: "要改 Word 就取其中一条的 fileId，按 word_agent_read → word_agent_edit/word_agent_ops 走；不需要用户先打开文件。"
                + (offset + items.length < found.total
                  ? `命中 ${found.total} 份，还有没列出的；要接着看传 offset=${offset + items.length}。`
                  : "")
                + (scope === "all" && items.some((item) => item.scopeKey === "artifacts") && items.some((item) => item.scopeKey === "library")
                  ? "结果里既有产物也有资料，按 scope 字段挑对那一栏再回话。"
                  : ""),
            }),
      };
      return {
        content: JSON.stringify(payload),
        details: { query, scope, offset, total: found.total, returned: items.length },
      };
    },
  };
}
