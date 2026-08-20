import { existsSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { BUILTIN_AGENT_IDS, type BuiltinAgentId } from "./resolver.js";

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
  for (const skill of skills) {
    const skillDirectory = resolve(directory, skill);
    const skillFile = join(skillDirectory, "SKILL.md");
    if (!skillDirectory.startsWith(`${resolve(directory)}${sep}`) || !existsSync(skillFile)) {
      throw new Error(`Builtin Agent Skill is missing: ${id}/${skill}`);
    }
    const skillText = readFileSync(skillFile, "utf8").trim();
    const name = /^---\s*\nname:\s*([^\n]+)\n/m.exec(skillText)?.[1]?.trim();
    if (!name) throw new Error(`Builtin Agent Skill name is missing: ${id}/${skill}`);
    skillPrompts[name] = skillText;
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
    directory,
  };
}

export function loadAllBuiltinAgentBundles(definitionsDirectory: string): BuiltinAgentBundle[] {
  return Object.values(BUILTIN_AGENT_IDS).map((id) => loadBuiltinAgentBundle(definitionsDirectory, id));
}
