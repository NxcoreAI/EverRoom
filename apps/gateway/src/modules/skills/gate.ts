import type { BuiltinAgentBundle } from "../agent/builtin-bundles.js";

/**
 * 技能的归属类别：
 * - builtin：内置 Agent bundle 里的 SKILL.md（装配进系统提示词，见 runtime-factory）；
 * - subagent：子 Agent Revision 里的 Skill（由 `read` 工具按需读取，见 runtime-manager）；
 * - user：用户自己加在 `<dataDir>/agent/skills` 下的 SKILL.md（只注入用户档 Agent）。
 */
export type SkillOwnerKind = "builtin" | "subagent" | "user";

/**
 * 技能 id：`<kind>:<ownerId>:<目录名>`。
 *
 * 只用目录名、不带 revision 与文件摘要：技能随应用版本变化，但用户的启停选择
 * 应该跟着技能本身走（改了一行 SKILL.md 不该把用户关掉的技能悄悄打开）。
 */
export function skillIdOf(kind: SkillOwnerKind, ownerId: string, directoryName: string): string {
  return `${kind}:${ownerId}:${directoryName}`;
}

/** 从 manifest 声明的相对路径（./skills/draft-create）取目录名。 */
export function skillDirectoryNameOf(path: string): string {
  const segments = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return segments[segments.length - 1] || path;
}

/**
 * 运行时的技能闸门：装配 runtime 时按它过滤被用户关掉的技能。
 *
 * 只暴露两个最小能力，避免 runtime-factory / subagent runtime-manager 反向依赖
 * 「技能」模块的存储与目录实现（它们只需要「这个技能还能用吗」的答案）。
 */
export interface SkillGate {
  /** 内置 bundle 的技能正文，已剔除被停用的条目（返回的就是要注入的 skillPrompts）。 */
  builtinSkillPrompts(bundle: BuiltinAgentBundle): Record<string, string>;
  /** 子 Agent 清单里仍然启用的技能路径（保持原顺序）。 */
  subagentSkillPaths(agentId: string, paths: readonly string[]): string[];
}

/** 不做任何过滤的闸门（未装配技能服务时保持旧行为）。 */
export const PASSTHROUGH_SKILL_GATE: SkillGate = {
  builtinSkillPrompts: (bundle) => bundle.skillPrompts,
  subagentSkillPaths: (_agentId, paths) => [...paths],
};
