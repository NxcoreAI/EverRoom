/**
 * 外部 Agent 访问（PRD 0.2.0 第 7 章 L2.5 / 附录 A.3）的类型面。
 *
 * 设计文档：docs/design/agent-access-mcp-skills.zh-CN.md。
 * 能力集对应 PRD 7.1「选择可访问的 Room／来源、允许读取的类型和回写位置」；
 * 提交项五类对应 PRD 7.4；状态语义对应 PRD 7.2「空结果、无权限、来源丢失、
 * 解析失败时使用不同状态」与 1.1「修正后的新读取校验有效版本，未刷新的副本可见」。
 */

export const AGENT_ACCESS_CAPABILITIES = [
  "read_metadata",
  "search",
  "read_documents",
  "read_conversations",
  "read_files",
  "read_rules",
  "write_session",
  "write_candidates",
  "register_files",
] as const;
export type AgentAccessCapability = (typeof AGENT_ACCESS_CAPABILITIES)[number];

export const AGENT_ACCESS_TOOL_TARGETS = [
  "claude-code",
  "cursor",
  "codex",
  "cherry-studio",
  "openclaw",
  "hermes",
  "generic",
] as const;
export type AgentAccessToolTarget = (typeof AGENT_ACCESS_TOOL_TARGETS)[number];

export interface AgentAccessScopes {
  roomIds: string[] | "all";
  capabilities: AgentAccessCapability[];
  writebackRoomId: string | null;
}

export type AgentConnectionStatus = "active" | "paused" | "revoked";

/** 连接页可见的脱敏视图（不含 token 与 tokenHash）。 */
export interface AgentConnectionView {
  id: string;
  name: string;
  tool: string;
  status: AgentConnectionStatus;
  scopes: AgentAccessScopes;
  tokenPrefix: string;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
  exampleQueryAt: string | null;
}

/** 鉴权通过后注入工具层的连接上下文。 */
export interface ResolvedAgentConnection {
  id: string;
  name: string;
  tool: string;
  scopes: AgentAccessScopes;
}

export type AgentAccessStateStatus =
  | "ok"
  | "empty"
  | "no_permission"
  | "source_lost"
  | "parse_failed"
  | "stale"
  | "duplicate"
  | "pending_review"
  | "invalid_input";

/** 所有对外工具的统一返回形状（MCP structuredContent，文本块同步镜像 JSON）。 */
export interface AgentAccessState<T = unknown> {
  status: AgentAccessStateStatus;
  message?: string;
  /** no_permission 时指出所需能力，便于 Agent 决定补问还是换来源。 */
  requiredCapability?: AgentAccessCapability;
  /** stale 时给出最新版本号（未刷新的副本仍随 data 返回，由调用方标记过期）。 */
  latestVersion?: string;
  data?: T;
}

export interface AgentSessionIncrementMessage {
  messageId: string;
  role: "user" | "assistant";
  content: string;
  occurredAt?: string;
}

/** PRD 7.4 回写五类。 */
export type AgentSubmissionItem =
  | {
      kind: "session_increment";
      platform: string;
      threadId: string;
      title?: string;
      messages: AgentSessionIncrementMessage[];
    }
  | { kind: "result_text"; title: string; content: string; roomId?: string }
  | { kind: "artifact_file"; filename: string; contentBase64: string; roomId?: string }
  | { kind: "citation"; targetUri: string; quote?: string; note?: string }
  | {
      kind: "candidate";
      candidateType: "memory" | "wiki" | "preference";
      content: string;
      evidence?: string;
      roomId?: string;
    };

export interface AgentSubmissionItemResult {
  index: number;
  kind: string;
  status: "saved" | "recorded" | "pending_review" | "rejected" | "duplicate";
  objectId?: string;
  objectType?: string;
  title?: string;
  deepLink?: string;
  error?: string;
}

export interface AgentSubmissionOutcome {
  submissionId: string;
  clientSubmissionId: string;
  status: "accepted" | "duplicate";
  results: AgentSubmissionItemResult[];
}

export function isAgentAccessCapability(value: unknown): value is AgentAccessCapability {
  return typeof value === "string" && (AGENT_ACCESS_CAPABILITIES as readonly string[]).includes(value);
}

export function isAgentAccessToolTarget(value: unknown): value is AgentAccessToolTarget {
  return typeof value === "string" && (AGENT_ACCESS_TOOL_TARGETS as readonly string[]).includes(value);
}

/** Room 范围判定（scopes.roomIds 为 "all" 时全放行）。 */
export function roomInScope(scopes: AgentAccessScopes, roomId: string | null | undefined): boolean {
  if (scopes.roomIds === "all") return true;
  if (!roomId) return false;
  return scopes.roomIds.includes(roomId);
}
