import { readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";

import {
  loadBuiltinAgentBundle,
  type BuiltinAgentBundle,
} from "../agent/builtin-bundles.js";
import { BUILTIN_AGENT_IDS } from "../agent/resolver.js";
import type { LoadedSubagentDefinition } from "../subagents/types.js";
import { skillDirectoryNameOf, skillIdOf, type SkillGate, type SkillOwnerKind } from "./gate.js";
import { parseSkillMarkdown } from "./skill-markdown.js";
import { AgentSkillStateStore } from "./state-store.js";
import {
  SkillInputError,
  USER_SKILL_OWNER_ID,
  assertSkillDirectoryName,
  type CreateUserSkillInput,
  type UserSkillStore,
} from "./user-skills.js";

/** 「技能」页的一行。 */
export interface SkillView {
  /** `<kind>:<ownerId>:<目录名>`，启停状态按它落库。 */
  id: string;
  /** SKILL.md frontmatter 的 name。 */
  name: string;
  /** SKILL.md frontmatter 的 description（可能为空：子 Agent 技能历史上有只写 name 的）。 */
  description: string;
  ownerId: string;
  ownerName: string;
  ownerKind: SkillOwnerKind;
  /** manifest 里声明的相对路径，如 ./skills/document-export。 */
  path: string;
  enabled: boolean;
  /** SKILL.md 字节数（前端用来判断「这个技能有多大一份说明」）。 */
  bytes: number;
  /** 最近一次显式启停的时刻；从未改过为 null。 */
  updatedAt: string | null;
}

/** 详情：多带 SKILL.md 全文。 */
export interface SkillDetailView extends SkillView {
  prompt: string;
}

interface CatalogEntry extends SkillDetailView {
  /** 技能目录名（用户技能删目录、内置技能定位文件都要它）。 */
  directoryName: string;
  /** 技能正文在磁盘上的位置（仅用于排障）。 */
  filePath: string;
}

export interface SkillServiceOptions {
  store: AgentSkillStateStore;
  /** 内置 Agent bundle 所在目录（随应用发布）。 */
  definitionsDir: string;
  /**
   * 子 Agent 定义（含当前 Revision）。惰性取值：注册表在 create-server 里晚于
   * 本服务创建，且注册失败不应连累内置技能展示。
   */
  subagents?: () => readonly LoadedSubagentDefinition[];
  /** 用户技能（`<dataDir>/agent/skills`）；缺失时「新增/删除」接口不可用。 */
  userSkills?: UserSkillStore;
  logger?: { warn: (fields: Record<string, unknown>, message: string) => void };
}

/** 技能不存在（路由层转 404）。 */
export class SkillNotFoundError extends Error {
  constructor(readonly skillId: string) {
    super("skill_not_found");
  }
}

/**
 * 技能目录 + 启停状态。
 *
 * 技能没有独立存储：清单来自磁盘上的两处权威来源——内置 Agent bundle 的
 * `agent.yaml → skills` 与子 Agent 清单的 `skills`；这里只做「列出来、读正文、
 * 记住开关」三件事，正文永远来自 SKILL.md 本身，不写第二份。
 *
 * 同时实现 `SkillGate`：runtime-factory 与子 Agent runtime-manager 装配时
 * 通过它过滤掉被停用的技能，开关才有真实效果。
 */
export class SkillService implements SkillGate {
  private readonly store: AgentSkillStateStore;
  private readonly definitionsDir: string;
  private readonly subagents: (() => readonly LoadedSubagentDefinition[]) | null;
  private readonly userSkills: UserSkillStore | null;
  private readonly logger: SkillServiceOptions["logger"];

  constructor(options: SkillServiceOptions) {
    this.store = options.store;
    this.definitionsDir = options.definitionsDir;
    this.subagents = options.subagents ?? null;
    this.userSkills = options.userSkills ?? null;
    this.logger = options.logger;
  }

  list(): SkillView[] {
    return this.catalog().map(stripPrompt);
  }

  get(id: string): SkillDetailView | null {
    const entry = this.catalog().find((candidate) => candidate.id === id);
    if (!entry) return null;
    const { filePath: _filePath, ...detail } = entry;
    return detail;
  }

  /** 改开关；返回改完的视图。技能不存在时抛 SkillNotFoundError。 */
  setEnabled(id: string, enabled: boolean): SkillView {
    const entry = this.catalog().find((candidate) => candidate.id === id);
    if (!entry) throw new SkillNotFoundError(id);
    const state = this.store.set(id, enabled);
    return {
      ...stripPrompt(entry),
      enabled: state.enabled,
      updatedAt: state.updatedAt?.toISOString() ?? null,
    };
  }

  /** 手写一个用户技能（生成 frontmatter + 落盘）。 */
  createUserSkill(input: CreateUserSkillInput): SkillView {
    const store = this.requireUserSkills();
    const created = store.create(input);
    return this.viewOf(created.directoryName);
  }

  /** 从本地文件夹导入一个用户技能。 */
  importUserSkill(sourceDirectory: string): SkillView {
    const store = this.requireUserSkills();
    const created = store.importDirectory(sourceDirectory);
    return this.viewOf(created.directoryName);
  }

  /**
   * 删除一个用户技能。只允许删自己加的那些：内置技能在应用包内、子 Agent 技能
   * 在 Revision 里，都是发布物，删不了（也给了明确的错误码）。
   */
  removeSkill(id: string): void {
    const entry = this.catalog().find((candidate) => candidate.id === id);
    if (!entry) throw new SkillNotFoundError(id);
    if (entry.ownerKind !== "user") throw new SkillInputError("skill_not_removable");
    this.requireUserSkills().remove(entry.directoryName);
    // 状态行跟着技能一起消失：否则同名技能下次进来会继承上一个的开关。
    this.store.clear(id);
  }

  /** 用户技能根目录（路由层用于在错误里回报位置）。 */
  get userSkillsRoot(): string | null {
    return this.userSkills?.root ?? null;
  }

  // ── SkillGate ────────────────────────────────────────────────

  builtinSkillPrompts(bundle: BuiltinAgentBundle): Record<string, string> {
    const prompts: Record<string, string> = {};
    for (const skill of bundle.skillEntries) {
      if (!this.store.isEnabled(skillIdOf("builtin", bundle.id, skill.directoryName))) continue;
      prompts[skill.name] = skill.prompt;
    }
    // 用户技能是「我给自己加的能力」：只注入用户档 Agent（main 三档共用 primary
    // bundle）。子 Agent 与补全/联网代理有各自的输出契约，塞进去只会污染它们。
    if (bundle.id === BUILTIN_AGENT_IDS.primary && this.userSkills) {
      for (const skill of this.userSkills.list()) {
        if (!this.store.isEnabled(skillIdOf("user", USER_SKILL_OWNER_ID, skill.directoryName))) continue;
        if (prompts[skill.name]) {
          // 与内置技能同名：用户技能不覆盖发布物，只留一条 warn。
          this.warn(
            { skill: skill.directoryName, agentId: bundle.id },
            "skills: user skill name collides with a bundled skill",
          );
          continue;
        }
        prompts[skill.name] = skill.prompt;
      }
    }
    return prompts;
  }

  subagentSkillPaths(agentId: string, paths: readonly string[]): string[] {
    return paths.filter((path) => this.store.isEnabled(
      skillIdOf("subagent", agentId, skillDirectoryNameOf(path)),
    ));
  }

  // ── 目录构建 ─────────────────────────────────────────────────

  private catalog(): CatalogEntry[] {
    return [...this.builtinEntries(), ...this.subagentEntries(), ...this.userEntries()];
  }

  /** 用户技能：写在网关数据目录里，可以随时新增/删除（其余两类是发布物）。 */
  private userEntries(): CatalogEntry[] {
    if (!this.userSkills) return [];
    return this.userSkills.list().map((skill): CatalogEntry => {
      const skillId = skillIdOf("user", USER_SKILL_OWNER_ID, skill.directoryName);
      const state = this.store.get(skillId);
      return {
        id: skillId,
        name: skill.name,
        description: skill.description,
        ownerId: USER_SKILL_OWNER_ID,
        ownerName: "自定义技能",
        ownerKind: "user",
        // 展示用相对路径（相对网关数据目录），与内置技能的 ./skills/<dir> 形态对齐。
        path: `agent/skills/${skill.directoryName}`,
        enabled: state.enabled,
        bytes: skill.bytes,
        updatedAt: state.updatedAt?.toISOString() ?? null,
        prompt: skill.prompt,
        directoryName: skill.directoryName,
        filePath: join(skill.directory, "SKILL.md"),
      };
    });
  }

  private builtinEntries(): CatalogEntry[] {
    const entries: CatalogEntry[] = [];
    for (const id of new Set(Object.values(BUILTIN_AGENT_IDS))) {
      const bundle = this.loadBundle(id);
      if (!bundle) continue;
      for (const skill of bundle.skillEntries) {
        const skillId = skillIdOf("builtin", bundle.id, skill.directoryName);
        const state = this.store.get(skillId);
        entries.push({
          id: skillId,
          name: skill.name,
          description: skill.description,
          ownerId: bundle.id,
          ownerName: bundle.name,
          ownerKind: "builtin",
          path: skill.path,
          enabled: state.enabled,
          bytes: skill.bytes,
          updatedAt: state.updatedAt?.toISOString() ?? null,
          prompt: skill.prompt,
          directoryName: skill.directoryName,
          filePath: join(bundle.directory, skill.path.replace(/^\.\//, ""), "SKILL.md"),
        });
      }
    }
    return entries;
  }

  private subagentEntries(): CatalogEntry[] {
    if (!this.subagents) return [];
    let definitions: readonly LoadedSubagentDefinition[];
    try {
      definitions = this.subagents();
    } catch (error) {
      this.warn({ error: errorMessage(error) }, "skills: subagent definitions unavailable");
      return [];
    }
    const entries: CatalogEntry[] = [];
    for (const definition of definitions) {
      const paths = definition.revision.manifest.skills ?? [];
      for (const path of paths) {
        const directoryName = skillDirectoryNameOf(path);
        const skillId = skillIdOf("subagent", definition.id, directoryName);
        const state = this.store.get(skillId);
        const filePath = resolveSkillFile(definition.revision.agentDirectory, directoryName);
        const markdown = filePath ? readSkillFile(filePath) : null;
        if (!markdown) {
          this.warn({ agentId: definition.id, path }, "skills: SKILL.md unreadable");
        }
        const meta = parseSkillMarkdown(markdown?.text ?? "");
        entries.push({
          id: skillId,
          name: meta.name || directoryName,
          description: meta.description,
          ownerId: definition.id,
          ownerName: definition.name,
          ownerKind: "subagent",
          path,
          enabled: state.enabled,
          bytes: markdown?.bytes ?? 0,
          updatedAt: state.updatedAt?.toISOString() ?? null,
          prompt: markdown?.text ?? "",
          directoryName,
          filePath: filePath ?? "",
        });
      }
    }
    return entries;
  }

  /** 刚写入的用户技能 → 视图（catalog 立刻能读到它，所以直接走同一条路）。 */
  private viewOf(directoryName: string): SkillView {
    const skillId = skillIdOf("user", USER_SKILL_OWNER_ID, directoryName);
    const entry = this.catalog().find((candidate) => candidate.id === skillId);
    if (!entry) throw new SkillNotFoundError(skillId);
    return stripPrompt(entry);
  }

  private requireUserSkills(): UserSkillStore {
    if (!this.userSkills) throw new SkillInputError("skill_source_invalid", "user skill store is not configured");
    return this.userSkills;
  }

  private loadBundle(id: string): BuiltinAgentBundle | null {
    try {
      return loadBuiltinAgentBundle(this.definitionsDir, id as BuiltinAgentBundle["id"]);
    } catch (error) {
      this.warn({ agentId: id, error: errorMessage(error) }, "skills: builtin bundle unavailable");
      return null;
    }
  }

  private warn(fields: Record<string, unknown>, message: string): void {
    this.logger?.warn(fields, message);
  }
}

function stripPrompt({ prompt: _prompt, filePath: _filePath, directoryName: _directoryName, ...view }: CatalogEntry): SkillView {
  return view;
}

/** Revision 里技能文件的绝对路径；越界（符号链接/../）一律视为不可读。 */
function resolveSkillFile(agentDirectory: string, directoryName: string): string | null {
  const root = `${resolve(agentDirectory)}${sep}`;
  const target = resolve(agentDirectory, "skills", directoryName, "SKILL.md");
  return target.startsWith(root) ? target : null;
}

function readSkillFile(path: string): { text: string; bytes: number } | null {
  try {
    const text = readFileSync(path, "utf8").trim();
    return { text, bytes: Buffer.byteLength(text, "utf8") };
  } catch {
    return null;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
