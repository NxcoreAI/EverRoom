import type { PiAgentRuntimeTool, PiAgentRuntimeToolResult } from "@nxcore/agent-runtime-pi";
import type { MemoryHit } from "./hippo-adapter.js";
import type { MemoryService } from "./service.js";

/** 注入给 pi agent 的记忆工具名（未启用记忆时不注册）。 */
export const MEMORY_TOOL_NAMES = ["memory_search", "memory_remember", "memory_feedback"] as const;

/**
 * 记忆工具的行为指引（注入系统提示词的 Guidelines 段）。
 *
 * 注意：这里必须走 `integration.promptGuidelines`，**不能**只写在工具的
 * `promptGuidelines` 上——本仓库的 agent runtime 一律提供自定义 system prompt，
 * pi 的 buildSystemPrompt 在 `if (customPrompt)` 分支里提前 return，工具级
 * snippet/guideline 不会进入上下文（见 pi-coding-agent/dist/core/system-prompt.js）。
 */
export const MEMORY_PROMPT_GUIDELINES: readonly string[] = [
  "当用户提到过去的偏好、决定或之前讨论过的内容，而当前对话里没有依据时，先用 memory_search 检索长期记忆再回答；检索为空就如实说没有相关记忆，不要编造。",
  "用户明确提出要把某事记下来、给出稳定偏好、或确立一个以后应遵守的约定/决策时，用 memory_remember 记下一条一句话事实；日常寒暄、一次性要求、工具输出、文档正文不要记。",
  "memory_search 命中的记忆如果确实帮你把这次任务做对了，用 memory_feedback 标 useful=true；如果它跟用户当场纠正的事实相冲突（记错了/已过期），标 useful=false 并别再按它办事。没用到就不要标记。",
];

/** 单个工具结果的硬上限：记忆是上下文增强，不能挤占对话预算。 */
const MAX_HITS = 8;
/** 单次 run 的反馈次数上限（防刷分）。 */
const MAX_FEEDBACK_PER_RUN = 6;
/** 计数表上限：超过就整表清空（只影响在跑的几个 run，避免长跑进程里无限增长）。 */
const FEEDBACK_RUN_CACHE_LIMIT = 500;
const feedbackCalls = new Map<string, number>();

/** 取（并自增）某个 run 已用的反馈次数配额。 */
function takeFeedbackBudget(runKey: string): { allowed: boolean; used: number } {
  if (feedbackCalls.size > FEEDBACK_RUN_CACHE_LIMIT) feedbackCalls.clear();
  const used = feedbackCalls.get(runKey) ?? 0;
  if (used >= MAX_FEEDBACK_PER_RUN) return { allowed: false, used };
  feedbackCalls.set(runKey, used + 1);
  return { allowed: true, used: used + 1 };
}
const HIT_CONTENT_LIMIT = 600;

/**
 * 记忆工具：给 agent 主动检索/写入跨会话长期记忆。
 *
 * memory 面向"用户偏好、既往决策、踩过的坑"——即使换了工作区也成立的事实；
 * 工作区资料/产物的检索走 files 域的 file_search / library_browse / file_read。
 * 写入是显式的：只有 agent 判断值得记时才写，不做全量会话蒸馏。
 */
export function createMemoryPiTools(service: MemoryService): PiAgentRuntimeTool[] {
  const searchTool: PiAgentRuntimeTool = {
    name: "memory_search",
    label: "长期记忆检索",
    description:
      "检索跨会话的长期记忆（用户偏好、既往决策与约定、上次踩过的坑、项目约束）。默认检索「当前工作空间 + 全局」两层。当用户提到「之前」「上次」「我们说过」、或你需要知道用户的稳定偏好/既定做法而当前上下文中没有时调用。返回按相关性排序的记忆条目，不包含本轮对话内容。",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "检索关键词或一句问句，用与记忆相同语言（中文记忆用中文查）。",
        },
        limit: {
          type: "number",
          description: `返回条数，1-${MAX_HITS}，默认 5。`,
        },
        category: {
          type: "string",
          enum: ["fact", "lesson"],
          description: "只取某一类：fact=长期事实（偏好/决策/约束），lesson=经验（坑与解法）；省略则两者都取。",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    executionMode: "parallel",
    execute: async (input, params, signal): Promise<PiAgentRuntimeToolResult> => {
      if (signal?.aborted) throw new Error("memory_search 已取消");
      const query = typeof params.query === "string" ? params.query.trim() : "";
      if (!query) throw new Error("memory_search 参数 query 不能为空");
      const limit =
        typeof params.limit === "number" && Number.isFinite(params.limit)
          ? Math.min(Math.max(Math.trunc(params.limit), 1), MAX_HITS)
          : undefined;
      const category = params.category === "lesson" ? "lesson" : params.category === "fact" ? "fact" : undefined;
      // 作用域由运行时输入决定：本工作空间 + 全局，模型无需也不应自选。
      const workspaceId = normalizeWorkspace(input?.workspaceId);
      const hits = service.recall({
        query,
        ...(limit !== undefined ? { limit } : {}),
        ...(category !== undefined ? { category } : {}),
        ...(workspaceId !== undefined ? { workspaceId } : {}),
      });
      if (hits.length === 0) {
        return {
          content: "没有检索到相关长期记忆。",
          details: { count: 0, query },
        };
      }
      // 检索回流：命中的条目刷新衰减锚点并延长半衰期（没被用上的条目会自然先退场）。
      const hitIds = hits.map((hit) => hit.id);
      service.markUsed(hitIds);
      // 只登记「这次 run 读到了什么」，不立刻记分：等 run 结束、看这轮是否顺利再结算
      // （见 MemoryOutcomeTracker）。用户全程无感，也不需要任何按钮。
      service.recordRecall(input?.runId ?? input?.sessionId ?? "unknown", hitIds);
      return {
        content: formatHits(hits),
        details: { count: hits.length, query, ids: hits.map((hit) => hit.id) },
      };
    },
  };

  const rememberTool: PiAgentRuntimeTool = {
    name: "memory_remember",
    label: "记住长期事实",
    description:
      "把值得跨会话保留的事实写入长期记忆：用户的稳定偏好、明确的约定或决策、以及已验证的坑（做了什么会出错）。只记脱离当前对话仍成立的一句话事实；不要记一次性任务指令、工具原始输出、文档正文或你自己的推测。",
    parameters: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description: "一句话事实，脱离本对话仍成立（例：「用户偏好用简体中文撰写正式文档」）。",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "可选分类标签（如 偏好、决策、坑、约束）。",
        },
        category: {
          type: "string",
          enum: ["fact", "lesson"],
          description: "fact=长期事实（偏好/决策/约束，默认）；lesson=经验，写法固定为「问题 → 解法」一句话。",
        },
        scope: {
          type: "string",
          enum: ["workspace", "global"],
          description:
            "写到哪里：workspace=只在这个工作空间成立（项目资料、团队流程、本空间约定，默认）；global=跨工作空间仍成立（用户本人的语言、沟通习惯、通用偏好）。拿不准选 workspace。",
        },
      },
      required: ["content"],
      additionalProperties: false,
    },
    executionMode: "sequential",
    execute: async (input, params, signal): Promise<PiAgentRuntimeToolResult> => {
      if (signal?.aborted) throw new Error("memory_remember 已取消");
      const content = typeof params.content === "string" ? params.content.trim() : "";
      if (!content) throw new Error("memory_remember 参数 content 不能为空");
      const tags = Array.isArray(params.tags)
        ? params.tags.filter((tag): tag is string => typeof tag === "string" && tag.trim().length > 0)
        : [];
      const category = params.category === "lesson" ? "lesson" : "fact";
      // 只有显式 global 才写全局；其余落当前工作空间（全局会话无空间时也只能写全局）。
      const workspaceId = params.scope === "global" ? undefined : normalizeWorkspace(input?.workspaceId);
      const id = service.remember({
        content,
        category,
        ...(tags.length > 0 ? { tags } : {}),
        ...(workspaceId !== undefined ? { workspaceId } : {}),
      });
      if (!id) throw new Error("记忆写入失败（记忆库可能未就绪）");
      return {
        content: `已记住：${content}`,
        details: { id, category, workspaceId: workspaceId ?? null, tags },
      };
    },
  };

  const feedbackTool: PiAgentRuntimeTool = {
    name: "memory_feedback",
    label: "反馈记忆是否有用",
    description:
      "给检索到的长期记忆打分：这次它确实帮上了（useful=true），或它跟现状/用户纠正的事实冲突（useful=false）。这是记忆强弱的唯一人工信号——没用到就别调用，不要凭感觉批量标记。",
    parameters: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "memory_search 返回的记忆 id。",
        },
        useful: {
          type: "boolean",
          description: "true=这次用上了且是对的；false=记错了/已过期/误导了你。",
        },
      },
      required: ["id", "useful"],
      additionalProperties: false,
    },
    executionMode: "sequential",
    execute: async (input, params, signal): Promise<PiAgentRuntimeToolResult> => {
      if (signal?.aborted) throw new Error("memory_feedback 已取消");
      const id = typeof params.id === "string" ? params.id.trim() : "";
      if (!id) throw new Error("memory_feedback 参数 id 不能为空");
      const useful = params.useful === true;
      // 单次 run 上限：避免模型把反馈当刷分手段（一次对话最多标这么多次）。
      const budget = takeFeedbackBudget(input?.runId ?? input?.sessionId ?? "unknown");
      if (!budget.allowed) {
        return {
          content: `本轮已标记 ${MAX_FEEDBACK_PER_RUN} 次记忆反馈，其余跳过。`,
          details: { applied: false, reason: "rate_limited" },
        };
      }
      const ok = service.feedback(id, useful);
      return {
        content: ok
          ? `已记录：${useful ? "这条记忆有用" : "这条记忆不可信"}。`
          : "没有找到这条记忆（可能已被删除）。",
        details: { applied: ok, useful },
      };
    },
  };

  return [searchTool, rememberTool, feedbackTool];
}

/** 工作空间 id 归一：空串/缺省视为全局会话（不写 scope）。 */
function normalizeWorkspace(value: string | null | undefined): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length > 0 ? trimmed : undefined;
}

function formatHits(hits: MemoryHit[]): string {
  const lines = ["以下是检索到的长期记忆（按相关性排序）："];
  for (const [index, hit] of hits.entries()) {
    const body =
      hit.content.length > HIT_CONTENT_LIMIT ? `${hit.content.slice(0, HIT_CONTENT_LIMIT)}…` : hit.content;
    const date = hit.createdAt.slice(0, 10);
    const tagSuffix = hit.tags.length > 0 ? `（${hit.tags.join("、")}）` : "";
    lines.push(`${index + 1}. [${date}] ${body}${tagSuffix}`);
  }
  return lines.join("\n");
}
