import type { AgentPermissionMode, LocalAgentProvider } from "@nxcore/agent-contract";

export const AGENT_PERMISSION_MODES: readonly AgentPermissionMode[] = [
  "ask_before_write",
  "accept_edits",
  "auto",
  "full_access",
];

export function isAgentPermissionMode(value: unknown): value is AgentPermissionMode {
  return typeof value === "string" && (AGENT_PERMISSION_MODES as readonly string[]).includes(value);
}

/** 语义档 → 展示元数据（渲染层文案之外的危险等级等通用属性）。 */
export const AGENT_PERMISSION_MODE_META: Record<AgentPermissionMode, { danger: "low" | "medium" | "high" }> = {
  ask_before_write: { danger: "low" },
  accept_edits: { danger: "low" },
  auto: { danger: "medium" },
  full_access: { danger: "high" },
};

/** 语义档 → ACP 适配器的 provider 原生 mode id（dontAsk/locked-down 不在支持面内）。 */
const PROVIDER_MODE_IDS: Record<Extract<LocalAgentProvider, "claude" | "codex">, Partial<Record<AgentPermissionMode, string>>> = {
  claude: {
    ask_before_write: "default",
    accept_edits: "acceptEdits",
    full_access: "bypassPermissions",
  },
  codex: {
    ask_before_write: "read-only",
    auto: "auto",
    full_access: "full-access",
  },
};

/** provider 原生 mode id → 语义档（UI 选项按适配器 availableModes 过滤后翻译）。 */
const MODE_ID_TO_SEMANTIC: Record<string, AgentPermissionMode> = Object.fromEntries(
  Object.entries(PROVIDER_MODE_IDS).flatMap(([provider, modes]) =>
    Object.entries(modes).map(([semantic, modeId]) => [`${provider}:${modeId}`, semantic as AgentPermissionMode]),
  ),
);

export function permissionModeIdForProvider(provider: LocalAgentProvider, mode: AgentPermissionMode): string | null {
  const table = PROVIDER_MODE_IDS[provider as "claude" | "codex"];
  return table ? table[mode] ?? null : null;
}

export function semanticForProviderModeId(provider: LocalAgentProvider, modeId: string): AgentPermissionMode | null {
  return MODE_ID_TO_SEMANTIC[`${provider}:${modeId}`] ?? null;
}

/** provider 的下拉可选语义档（静态表；claude/codex 按适配器能力过滤，pi 全量，其余 ACP provider 暂无 mode 映射→空）。 */
export function permissionModesForProvider(provider: string | null): readonly AgentPermissionMode[] {
  if (provider === "claude") return ["ask_before_write", "accept_edits", "full_access"];
  if (provider === "codex") return ["ask_before_write", "auto", "full_access"];
  if (provider === "openclaw") return [];
  return AGENT_PERMISSION_MODES;
}

/** provider 的默认语义档（DB 未设置时的有效值）：claude 适配器出厂 default，codex 出厂 auto，pi 维持既有行为。 */
export function defaultPermissionModeForProvider(provider: string | null): AgentPermissionMode {
  if (provider === "claude") return "ask_before_write";
  if (provider === "codex") return "auto";
  return "accept_edits";
}

/**
 * 档位是否覆盖该 ACP ToolKind 的确认请求（true=人工审批桥前直接放行）。
 * 沙箱 cwd 使全部用户文件都在「工作区外」，适配器对区外 Read 即使
 * acceptEdits 也会发确认——非破坏类（read/search/think/fetch）全档免问
 * 补偿这一架构伪影；变更类按档位语义：edit/delete/move 自 accept_edits
 * 放行（文件修改自动执行），execute 仅 full_access（bash 黑盒保守一档），
 * switch_mode/other 不放行（含 ExitPlanMode 类模式切换，须人确认）。
 */
export function permissionModeCoversToolKind(mode: AgentPermissionMode | null, toolKind: string | null | undefined): boolean {
  if (!mode || !toolKind) return false;
  if (mode === "full_access") return true;
  if (toolKind === "read" || toolKind === "search" || toolKind === "think" || toolKind === "fetch") return true;
  if (toolKind === "edit" || toolKind === "delete" || toolKind === "move") return mode === "accept_edits";
  return false;
}
