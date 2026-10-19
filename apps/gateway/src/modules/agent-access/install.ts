import type { AgentAccessToolTarget, AgentConnectionView } from "./types.js";

/**
 * 安装代写内容（PRD 7.1.3「安装技能与 MCP／CLI 连接」）：网关只生成内容，
 * 桌面连接页（阶段 2）负责把 skill 文件写入各工具目录、把配置片段并入对应
 * 配置文件。skill 遵循 agentskills.io 开放标准六字段（可移植到 Cursor/Codex 等）。
 */

export interface InstallPlan {
  target: AgentAccessToolTarget;
  url: string;
  headers: Record<string, string>;
  /** 目标工具的 MCP 配置片段（JSON/TOML 文本，桌面端原样并入）。 */
  mcpConfig: string;
  /** 需写入的 skill 文件（相对 skill 根目录的路径 → 内容）。 */
  skillFiles: Array<{ path: string; content: string }>;
  /** skill 安装根目录（空表示该宿主无 skill 机制）。 */
  skillRoot: string | null;
  notes: string[];
}

function skillBody(connection: AgentConnectionView, url: string): string {
  return `---
name: everroom-agent
description: 在当前工具中继续使用 EverRoom 的积累：搜索 Room/会话/文档/文件/记忆、精读原文、按授权范围回写结果与候选。当任务需要找回历史讨论、核查出处、复用个人知识或把成果保存回 EverRoom 时使用。
compatibility: 需要 MCP 客户端（HTTP 传输）；Claude Code、Cursor、Codex、Cherry Studio 等均支持。
metadata:
  connection: ${connection.name}
  gateway: ${url}
---

# EverRoom Agent

你已接入 EverRoom（连接名「${connection.name}」）。本技能约定使用姿势；能力由 MCP 服务器 \`${url}\` 提供。

## 工作流

1. **了解范围**：先调用 \`everroom_get_status\`（或 \`everroom_list_rooms\`）确认授权的 Room 与能力。
2. **搜索**：\`everroom_search { query, kinds? }\` 跨类型检索。命中带稳定对象 ID、版本与 \`everroom://\` URI；会话命中含 conversationId/messageId。
3. **精读**：\`everroom_fetch { uri, basedOnVersion?, offset? }\` 读原文；引用时携带返回的 \`version\`。若返回 \`stale\`，说明你手上的副本过期——内容仍是最新版，更新引用即可。
4. **读文件**：\`everroom_read_file { fileId, variant }\`（markdown 或 base64）。
5. **回写**：\`everroom_submit { submissionId, items[] }\`——submissionId 由你生成（建议 \`任务标识-序号\`），重试必须复用同一个（幂等，重放返回 duplicate 与原结果）。可提交：会话增量、结果文本、产物文件、来源引用、记忆/Wiki/偏好候选。
6. **规则**：\`everroom_get_rules\` 读取本次适用的写作风格与偏好。

## 状态语义（所有工具的 structuredContent.status）

- \`ok\` 正常；\`empty\` 无命中（换关键词或补问用户）；\`no_permission\` 超出授权范围（附所需能力）；\`source_lost\` 来源已删（换来源）；\`parse_failed\` 解析失败（换变体/来源）；\`stale\` 副本过期（data 为最新内容）；\`duplicate\` 提交重放。

## 约束

- 候选（记忆/Wiki/偏好）只进入待确认队列：未经用户确认，不要声称"已记住"。
- 遇到失败先 \`everroom_get_status\` 判断能力/服务状态，不要盲目重试。
- 引用 EverRoom 内容时给出对象 ID 与版本，便于用户回溯原文。
`;
}

function toolsReference(): string {
  return `# everroom 工具速查

- \`everroom_get_status\` — 连接与能力自述（常驻可见）
- \`everroom_list_rooms\` { } — 授权范围内的 Room（revision/更新时间）[read_metadata]
- \`everroom_search\` { query, kinds?: room|conversation|document|file|artifact|memory, limit?, offset? } [search]
- \`everroom_fetch\` { uri, basedOnVersion?, offset?, limit?, variant? } — 精读 everroom:// URI [按目标分能力]
- \`everroom_read_file\` { fileId, variant?: markdown|content } [read_files]
- \`everroom_get_rules\` { } — 本次规则（写作风格/偏好底料）[read_rules]
- \`everroom_register_file\` { filename, contentBase64, roomId? } [register_files]
- \`everroom_submit\` { submissionId, items[] } — 幂等回写（session_increment/result_text/artifact_file/citation/candidate）[write_session|write_candidates]
- \`everroom_submit_status\` { submissionId } — 查询提交结果（常驻可见）

URI 空间：\`everroom://rooms/{id}\`、\`everroom://conversations/{sessionId}\`、\`everroom://documents/{id}\`、\`everroom://files/{id}\`、\`everroom://memory/{id}\`；人类可打开位置为 \`everroom://open/{kind}/{id}\`（桌面端注册后可用）。
`;
}

export function buildInstallPlan(input: {
  target: AgentAccessToolTarget;
  connection: AgentConnectionView;
  url: string;
  token: string;
}): InstallPlan {
  const { target, connection, url, token } = input;
  const headers = { Authorization: `Bearer ${token}` };
  const skillFiles = [
    { path: "SKILL.md", content: skillBody(connection, url) },
    { path: "references/tools.md", content: toolsReference() },
  ];
  const skillRootByTarget: Record<AgentAccessToolTarget, string | null> = {
    "claude-code": "~/.claude/skills/everroom-agent/",
    cursor: "~/.cursor/skills/everroom-agent/",
    codex: "~/.codex/skills/everroom-agent/",
    "cherry-studio": null,
    openclaw: null,
    hermes: null,
    generic: null,
  };
  const notes = [
    "网关当前地址写入配置；端口随网关重启变化时需重新安装（固定端口在桌面连接页后续版本提供）。",
  ];

  switch (target) {
    case "claude-code":
      return {
        target,
        url,
        headers,
        mcpConfig: JSON.stringify(
          { mcpServers: { everroom: { type: "http", url, headers } } },
          null,
          2,
        ),
        skillFiles,
        skillRoot: skillRootByTarget[target],
        notes: [
          ...notes,
          "项目级写入 .mcp.json；用户级写入 ~/.claude.json 的 mcpServers（Claude Code 会请求批准项目级服务器）。",
        ],
      };
    case "cursor":
      return {
        target,
        url,
        headers,
        mcpConfig: JSON.stringify({ mcpServers: { everroom: { url, headers } } }, null, 2),
        skillFiles,
        skillRoot: skillRootByTarget[target],
        notes: [...notes, "写入 ~/.cursor/mcp.json（用户级）；Cursor 兼容读取 ~/.claude/skills 目录。"],
      };
    case "codex":
      return {
        target,
        url,
        headers,
        mcpConfig: [
          "[mcp_servers.everroom]",
          `url = "${url}"`,
          'http_headers = { Authorization = "Bearer <token>" }',
        ].join("\n"),
        skillFiles,
        skillRoot: skillRootByTarget[target],
        notes: [
          ...notes,
          "写入 ~/.codex/config.toml；<token> 占位需替换为本响应 headers 中的实际值（TOML 不便嵌 JSON，桌面端落盘时替换）。",
        ],
      };
    case "cherry-studio":
      return {
        target,
        url,
        headers,
        mcpConfig: JSON.stringify({ mcpServers: { everroom: { url, headers } } }, null, 2),
        skillFiles,
        skillRoot: null,
        notes: [
          ...notes,
          "Cherry Studio 在 设置 → MCP 服务器 手动添加（类型 StreamableHTTP）；按目标版本验证支持情况（PRD 7.3）。",
        ],
      };
    case "openclaw":
    case "hermes":
    case "generic":
    default:
      return {
        target,
        url,
        headers,
        mcpConfig: JSON.stringify({ mcpServers: { everroom: { url, headers } } }, null, 2),
        skillFiles,
        skillRoot: skillRootByTarget[target],
        notes: [...notes, "按宿主实际支持的 MCP 配置方式接入；技能文件内容可手工放入宿主技能目录。"],
      };
  }
}
