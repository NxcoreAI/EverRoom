import { existsSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { parseSkillMarkdown } from "../skills/skill-markdown.js";
import { BUILTIN_AGENT_IDS, type BuiltinAgentId } from "./resolver.js";

/** bundle 里的一个技能：目录名是它的稳定身份，name 是注入系统提示词时的键。 */
export interface BuiltinAgentSkill {
  /** `agents/<agent>/skills/` 下的目录名（如 document-export）。 */
  directoryName: string;
  /** SKILL.md frontmatter 的 name（注入 skillPrompts 的键）。 */
  name: string;
  /** SKILL.md frontmatter 的 description（「技能」页的说明文案）。 */
  description: string;
  /** manifest 里声明的相对路径（如 ./skills/document-export）。 */
  path: string;
  /** SKILL.md 全文。 */
  prompt: string;
  bytes: number;
}

export interface BuiltinAgentBundle {
  id: BuiltinAgentId;
  name: string;
  description: string;
  runtime: "pi" | "openai-completions";
  systemPrompt: string;
  capabilities: string[];
  tools: string[];
  skills: string[];
  skillPrompts: Record<string, string>;
  /** 与 skills 一一对应的结构化技能清单（顺序、名字、描述、正文都在这里）。 */
  skillEntries: BuiltinAgentSkill[];
  directory: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Invalid builtin Agent ${field}`);
  return value.trim();
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`Invalid builtin Agent ${field}`);
  }
  return [...new Set(value.map((item) => String(item).trim()))];
}

function manifestPath(directory: string): string {
  for (const name of ["agent.yaml", "agent.yml", "agent.json"]) {
    const candidate = join(directory, name);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`Builtin Agent manifest is missing: ${directory}`);
}

function readRelativeFile(directory: string, path: string, field: string): string {
  const root = `${resolve(directory)}${sep}`;
  const target = resolve(directory, path);
  if (!target.startsWith(root)) throw new Error(`Builtin Agent ${field} escapes its bundle`);
  return readFileSync(target, "utf8").trim();
}

/** Load the immutable, shipped definition for one built-in runtime. */
export function loadBuiltinAgentBundle(definitionsDirectory: string, id: BuiltinAgentId): BuiltinAgentBundle {
  const directory = join(resolve(definitionsDirectory), id);
  const path = manifestPath(directory);
  const text = readFileSync(path, "utf8");
  const raw = path.endsWith(".json") ? JSON.parse(text) as unknown : parseYaml(text) as unknown;
  if (!isRecord(raw) || raw.schemaVersion !== 1 || raw.kind !== "builtin") {
    throw new Error(`Invalid builtin Agent manifest: ${id}`);
  }
  if (raw.id !== id) throw new Error(`Builtin Agent manifest id does not match directory: ${id}`);
  const runtime = requiredString(raw.runtime, "runtime");
  if (runtime !== "pi" && runtime !== "openai-completions") {
    throw new Error(`Unsupported builtin Agent runtime: ${runtime}`);
  }
  const systemPrompt = readRelativeFile(directory, requiredString(raw.systemPrompt, "systemPrompt"), "systemPrompt");
  if (!systemPrompt) throw new Error(`Builtin Agent systemPrompt is empty: ${id}`);
  const skills = stringArray(raw.skills ?? [], "skills");
  const skillPrompts: Record<string, string> = {};
  const skillEntries: BuiltinAgentSkill[] = [];
  for (const skill of skills) {
    const skillDirectory = resolve(directory, skill);
    const skillFile = join(skillDirectory, "SKILL.md");
    if (!skillDirectory.startsWith(`${resolve(directory)}${sep}`) || !existsSync(skillFile)) {
      throw new Error(`Builtin Agent Skill is missing: ${id}/${skill}`);
    }
    const skillText = readFileSync(skillFile, "utf8").trim();
    const skillMeta = parseSkillMarkdown(skillText);
    const name = /^---\s*\nname:\s*([^\n]+)\n/m.exec(skillText)?.[1]?.trim() ?? skillMeta.name;
    if (!name) throw new Error(`Builtin Agent Skill name is missing: ${id}/${skill}`);
    skillPrompts[name] = skillText;
    skillEntries.push({
      directoryName: skill.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? name,
      name,
      description: skillMeta.description,
      path: skill,
      prompt: skillText,
      bytes: Buffer.byteLength(skillText, "utf8"),
    });
  }
  return {
    id,
    name: requiredString(raw.name, "name"),
    description: requiredString(raw.description, "description"),
    runtime,
    systemPrompt,
    capabilities: stringArray(raw.capabilities ?? [], "capabilities"),
    tools: stringArray(raw.tools ?? [], "tools"),
    skills,
    skillPrompts,
    skillEntries,
    directory,
  };
}

export function loadAllBuiltinAgentBundles(definitionsDirectory: string): BuiltinAgentBundle[] {
  return Object.values(BUILTIN_AGENT_IDS).map((id) => loadBuiltinAgentBundle(definitionsDirectory, id));
}
