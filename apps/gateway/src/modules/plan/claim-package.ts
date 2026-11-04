import type {
  PlanClaimMaterial,
  PlanClaimPackage,
  PlanItem,
  PlanItemEvent,
  PlanStatus,
} from "@nxcore/agent-contract";

/** 认领包的 history 上限：再多就挤占上下文（见设计文档 §5）。 */
export const CLAIM_HISTORY_LIMIT = 8;

/** 认领租约默认 TTL（秒）。 */
export const CLAIM_LEASE_TTL_SEC = 600;

export interface ClaimPackageSpace {
  name: string;
  root: string | null;
  libraryPath: string | null;
  artifactsPath: string | null;
}

export interface BuildClaimPackageInput {
  item: PlanItem;
  events: readonly PlanItemEvent[];
  dependencies: ReadonlyArray<{ id: string; title: string; status: PlanStatus }>;
  space: ClaimPackageSpace | null;
  /** 指派时写进 `why.assignReason` 的一句话（用户点「交给 Agent」时的缺省说明）。 */
  assignReason?: string | null;
  leaseTtlSec?: number;
}

/** 材料引用的可读性提示：告诉模型"这是什么、怎么取"，不代替它读。 */
function materialHint(kind: PlanItem["refs"][number]["kind"]): string {
  switch (kind) {
    case "file": return "用 file_read 按 fileId 读正文";
    case "document": return "用 document_read 按 documentId 读正文";
    case "session": return "用会话工具或计划详情查看这段历史";
    case "url": return "外部链接，需要时联网取";
    default: return "";
  }
}

function toMaterial(ref: PlanItem["refs"][number]): PlanClaimMaterial {
  return { kind: ref.kind, id: ref.id, title: ref.title, hint: materialHint(ref.kind) };
}

/**
 * 组装认领包。
 *
 * 纯函数：只做"取哪几层、怎么截断"，不读库、不做 IO，方便快照测试守住上下文质量。
 * 四条原则见设计文档 §5（意图原文照搬 / 材料只给引用 / 历史封顶 / 契约写清写回）。
 */
export function buildClaimPackage(input: BuildClaimPackageInput): PlanClaimPackage {
  const { item } = input;
  const history = [...input.events]
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
    .slice(0, CLAIM_HISTORY_LIMIT)
    .map((event) => ({
      at: event.createdAt,
      kind: event.kind,
      actor: event.actorKind === "user"
        ? "你（用户）"
        : event.actorKind === "agent"
          ? `Agent ${event.actorId ?? ""}`.trim()
          : "系统",
      summary: event.summary,
    }));

  const space = input.space ?? {
    name: "",
    root: null,
    libraryPath: null,
    artifactsPath: null,
  };

  return {
    item: {
      id: item.id,
      workspaceId: item.workspaceId,
      title: item.title,
      detail: item.detail,
      acceptance: item.acceptance,
      constraints: item.constraints,
      priority: item.priority,
      dueAt: item.dueAt,
      tags: item.tags,
      checklist: item.checklist,
      status: item.status,
    },
    why: {
      createdBy: item.createdBy,
      createdByLabel: item.createdBy === "agent"
        ? `Agent ${item.createdByAgentId ?? "unknown"}`
        : "你（用户）",
      createdAt: item.createdAt,
      assignReason: input.assignReason ?? null,
    },
    space: {
      name: space.name,
      root: space.root,
      libraryPath: space.libraryPath,
      artifactsPath: space.artifactsPath,
    },
    materials: item.refs.map(toMaterial),
    history,
    dependencies: input.dependencies.map((dependency) => ({
      id: dependency.id,
      title: dependency.title,
      status: dependency.status,
    })),
    contract: {
      mustUpdateStatus: true,
      mustWriteResultSummary: true,
      leaseTtlSec: input.leaseTtlSec ?? CLAIM_LEASE_TTL_SEC,
      outputHint: space.artifactsPath
        ? `产物写到 ${space.artifactsPath}`
        : space.root
          ? `产物写到 ${space.root}`
          : null,
    },
  };
}
