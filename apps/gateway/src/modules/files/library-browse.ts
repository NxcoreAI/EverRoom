import { Type } from "@sinclair/typebox";
import type { PiAgentRuntimeTool } from "@nxcore/agent-runtime-pi";
import type { StartRuntimeRunInput } from "@nxcore/agent-runtime";
import type { FileCatalogScope } from "./service.js";
import { describeFileKind, scopeLabelOf } from "./file-kind.js";

/** 单页条数：默认 25，最多 100。再多就换 offset 翻页，别一次塞满上下文。 */
export const LIBRARY_BROWSE_DEFAULT_LIMIT = 25;
export const LIBRARY_BROWSE_MAX_LIMIT = 100;

/** 分类摘要/标签的展示长度：只是「标题之外的一点提示」，不能变成正文。 */
const SUMMARY_MAX = 80;
const TAGS_MAX = 4;

interface BrowseCatalogHit {
  id: string;
  originalName: string;
  displayName: string | null;
  sourceKind: string;
  dataType: string | null;
  summary: string | null;
  tags: string[];
  workspaceId: string;
  updatedAt: string;
}

export interface LibraryBrowseToolDeps {
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
    ): { items: BrowseCatalogHit[]; total: number } | null;
  } | null;
}

function positiveInt(value: unknown, fallback: number, max: number): number {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < 0) return fallback;
  return Math.min(numeric, max);
}

function clip(text: string | null | undefined, max: number): string | null {
  const trimmed = text?.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? `${trimmed.slice(0, Math.max(1, max - 1))}…` : trimmed;
}

/**
 * `library_browse`：分页浏览工作区「资料库 / 产物」里有什么。
 *
 * 为什么不能靠运行提示塞一份清单：资料库可能有上千份，任何「最近 N 条」都是抽样，
 * 模型看到就会以为看完了全库；而按问题现查又需要「没有关键词时也能看」的入口。
 * 本工具把「库里有什么」交给模型自己翻：按更新时间倒序、分页、可带 scope/extension，
 * 每页只给标题级的定位信息（标题/类型/fileId/分类摘要），要不要 file_read 解析由模型判断。
 *
 * 与 file_search 的分工：file_search 是「带着关键词找」；本工具是「不知道有什么时翻」。
 */
export function createLibraryBrowsePiTool(deps: LibraryBrowseToolDeps): PiAgentRuntimeTool {
  return {
    name: "library_browse",
    label: "分页浏览资料库/产物",
    description:
      "分页浏览当前工作区的「资料库 / 产物」里有哪些文件（按最近更新倒序），返回标题、类型、fileId 与分类摘要。"
      + "用来回答“库里有线索吗/有没有相关材料”：用户问的自有事实（项目/公司的数字、结论、决策、方案、之前生成的产物）"
      + "一旦可能落在库内材料里，先用本工具或 file_search 确认，再把候选交给 file_read 解析正文后作答。"
      + "scope 对应界面两个页签：artifacts = 产物库（Agent 生成/产物导入），library = 资料库（上传/本地目录/连接器/剪藏），省略 = 整库；"
      + "extension 可过滤类型（docx/xlsx/pptx/pdf…，也接受数组）。每页默认 25 条、最多 100 条，"
      + "用 offset 翻页（hasMore/nextOffset 标明还有没有）；total 是符合条件的总数，不是本页条数。"
      + "本工具只列标题级信息，不给正文：要正文用 file_read（PDF/Office 会现场解析）；看标题还不够、想按关键词找就用 file_search。",
    parameters: Type.Object({
      scope: Type.Optional(Type.Union([
        Type.Literal("all"),
        Type.Literal("library"),
        Type.Literal("artifacts"),
      ], {
        description: "浏览范围：artifacts = 产物库，library = 资料库，all 或省略 = 整库",
      })),
      extension: Type.Optional(Type.Union([
        Type.String({ minLength: 2, maxLength: 12 }),
        Type.Array(Type.String({ minLength: 2, maxLength: 12 }), { minItems: 1, maxItems: 8 }),
      ], {
        description: "扩展名过滤，如 pdf / .docx；也可传数组（[\"pdf\",\"docx\"]）。大小写不敏感",
      })),
      offset: Type.Optional(Type.Integer({
        minimum: 0,
        description: "分页偏移（翻页时传上一页的 nextOffset，缺省 0）",
      })),
      limit: Type.Optional(Type.Integer({
        minimum: 1,
        maximum: LIBRARY_BROWSE_MAX_LIMIT,
        description: `本页最多返回多少条（缺省 ${LIBRARY_BROWSE_DEFAULT_LIMIT}，最多 ${LIBRARY_BROWSE_MAX_LIMIT}）`,
      })),
      workspaceId: Type.Optional(Type.String({
        minLength: 1,
        maxLength: 200,
        description: "限定工作区；省略 = 当前会话所属工作区（资料库/产物按空间隔离，通常不要传）",
      })),
    }, { additionalProperties: false }),
    executionMode: "sequential",
    // 行为指引不在工具级：本仓库 runtime 用自定义 system prompt，工具级 guideline 不渲染。
    // 「什么时候必须先查库」写在 agents/main/SYSTEM.md 的「库内材料优先」。
    execute: async (input: StartRuntimeRunInput, params: Record<string, unknown>) => {
      const files = deps.files();
      if (!files) throw new Error("FILE_SERVICE_UNAVAILABLE: 文件服务尚未就绪");
      const rawExtensions = Array.isArray(params.extension)
        ? params.extension
        : typeof params.extension === "string"
          ? [params.extension]
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
      const limit = Math.max(1, positiveInt(params.limit, LIBRARY_BROWSE_DEFAULT_LIMIT, LIBRARY_BROWSE_MAX_LIMIT));
      const offset = positiveInt(params.offset, 0, 1_000_000);
      const found = files.searchCatalog("", {
        ...(extensions.length > 0 ? { extensions } : {}),
        ...(scope !== "all" ? { scope } : {}),
        ...(workspaceId ? { workspaceId } : {}),
        limit,
        offset,
      });
      if (!found) throw new Error("FILE_BROWSE_UNAVAILABLE: 文件目录尚未就绪");
      const items = found.items.map((item) => {
        const described = describeFileKind(item.originalName);
        const { scope: scopeLabel, scopeKey } = scopeLabelOf(item.sourceKind);
        const summary = clip(item.summary, SUMMARY_MAX);
        return {
          fileId: item.id,
          title: item.displayName ?? item.originalName,
          originalName: item.originalName,
          extension: described.extension,
          kind: described.kind,
          readable: described.readable,
          scope: scopeLabel,
          scopeKey,
          dataType: item.dataType,
          ...(summary ? { summary } : {}),
          ...(item.tags.length > 0 ? { tags: item.tags.slice(0, TAGS_MAX) } : {}),
          updatedAt: item.updatedAt,
        };
      });
      const nextOffset = offset + items.length;
      const hasMore = nextOffset < found.total;
      const scopeLabelText = scope === "artifacts" ? "产物库" : scope === "library" ? "资料库" : "文件库";
      const payload = {
        scope,
        ...(extensions.length > 0 ? { extension: extensions.length === 1 ? extensions[0] : extensions } : {}),
        ...(workspaceId ? { workspaceId } : {}),
        total: found.total,
        offset,
        returned: items.length,
        hasMore,
        ...(hasMore ? { nextOffset } : {}),
        items,
        hint: items.length === 0
          ? found.total === 0
            ? `${scopeLabelText}里还没有符合条件的文件；去掉 extension 或换 scope 再确认一次。`
            : `这一页没有条目（offset 超出范围），total 是 ${found.total}，从 0 重新翻。`
          : "标题/摘要只用来挑候选：要判断内容就 file_read 那份（传 fileId，PDF/Office 会现场解析），不要只看标题就下结论。"
            + (hasMore ? `还有 ${found.total - nextOffset} 份没看，需要就传 offset=${nextOffset} 继续翻。` : ""),
      };
      return {
        content: JSON.stringify(payload),
        details: { scope, offset, limit, total: found.total, returned: items.length, hasMore },
      };
    },
  };
}
