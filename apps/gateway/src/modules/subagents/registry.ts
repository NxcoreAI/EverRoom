import { createHash, randomUUID } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { and, desc, eq } from "drizzle-orm";
import { parse as parseYaml } from "yaml";
import type { GatewayDatabase } from "../../infrastructure/database/client.js";
import { subagentDefinitions, subagentRevisions } from "../../infrastructure/database/schema.js";
import type { SubagentFrameworkConfig } from "../../config.js";
import type {
  LoadedSubagentDefinition,
  LoadedSubagentRevision,
  SubagentLogger,
  SubagentManifest,
  SubagentMcpBinding,
  SubagentPolicy,
} from "./types.js";

const MAX_PROMPT_BYTES = 128 * 1024;
const MAX_SCHEMA_BYTES = 256 * 1024;
const MAX_SKILL_BYTES = 5 * 1024 * 1024;
const MAX_SKILL_FILES = 256;
const AGENT_ID_PATTERN = /^[a-z][a-z0-9-]{1,63}$/;

interface SourceFile {
  absolutePath: string;
  relativePath: string;
  bytes: number;
  digest: string;
}

interface CompiledBundle {
  manifest: SubagentManifest;
  systemPrompt: string;
  inputSchema: Record<string, unknown> | null;
  outputSchema: Record<string, unknown> | null;
  mcpServers: Record<string, unknown>;
  skillFiles: SourceFile[];
  digest: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty string`);
  return value.trim();
}

function stringArray(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`${field} must be an array of non-empty strings`);
  }
  return [...new Set(value.map((item) => item.trim()))];
}

function positiveInteger(value: unknown, fallback: number, field: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || Number(value) < 1) throw new Error(`${field} must be a positive integer`);
  return Number(value);
}

function resolveInside(root: string, path: string, field: string): string {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(resolvedRoot, path);
  if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(`${resolvedRoot}${sep}`)) {
    throw new Error(`${field} escapes the agent bundle`);
  }
  return resolvedPath;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function digestJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");
}

function parseMcpBindings(value: unknown): SubagentMcpBinding[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("mcp must be an array");
  return value.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`mcp[${index}] must be an object`);
    return {
      server: requiredString(entry.server, `mcp[${index}].server`),
      ...(entry.includeTools === undefined
        ? {}
        : { includeTools: stringArray(entry.includeTools, `mcp[${index}].includeTools`) }),
      ...(entry.excludeTools === undefined
        ? {}
        : { excludeTools: stringArray(entry.excludeTools, `mcp[${index}].excludeTools`) }),
    };
  });
}

function parseManifest(raw: unknown, defaults: SubagentFrameworkConfig): SubagentManifest {
  if (!isRecord(raw)) throw new Error("agent manifest must be an object");
  if (raw.schemaVersion !== 1) throw new Error("schemaVersion must be 1");
  const id = requiredString(raw.id, "id");
  if (!AGENT_ID_PATTERN.test(id)) throw new Error("id must match /^[a-z][a-z0-9-]{1,63}$/");
  if (raw.mode !== undefined && raw.mode !== "dispatch_only") {
    throw new Error("mode must be dispatch_only");
  }
  const policyValue = raw.policy === undefined ? {} : raw.policy;
  if (!isRecord(policyValue)) throw new Error("policy must be an object");
  const allowedCallers = policyValue.allowedCallers === undefined
    ? ["primary-agent"]
    : stringArray(policyValue.allowedCallers, "policy.allowedCallers");
  const validCallers = new Set(["primary-agent", "scheduler", "internal-workflow"]);
  if (allowedCallers.some((caller) => !validCallers.has(caller))) {
    throw new Error("policy.allowedCallers contains an unsupported caller");
  }
  const timeoutMs = positiveInteger(
    policyValue.timeoutMs ?? (typeof policyValue.timeoutSeconds === "number"
      ? policyValue.timeoutSeconds * 1_000
      : undefined),
    defaults.defaultTimeoutMs,
    "policy.timeoutMs",
  );
  const policy: SubagentPolicy = {
    allowedCallers: allowedCallers as SubagentPolicy["allowedCallers"],
    maxConcurrency: positiveInteger(policyValue.maxConcurrency, 1, "policy.maxConcurrency"),
    timeoutMs,
    maxToolCalls: positiveInteger(policyValue.maxToolCalls, 40, "policy.maxToolCalls"),
  };
  return {
    schemaVersion: 1,
    id,
    name: requiredString(raw.name, "name"),
    description: requiredString(raw.description, "description"),
    enabled: raw.enabled === undefined ? true : raw.enabled === true,
    mode: "dispatch_only",
    promptPath: requiredString(raw.systemPrompt ?? raw.prompt, "systemPrompt"),
    skills: stringArray(raw.skills, "skills"),
    mcp: parseMcpBindings(raw.mcp),
    inputSchemaPath: raw.inputSchema === undefined ? null : requiredString(raw.inputSchema, "inputSchema"),
    outputSchemaPath: raw.outputSchema === undefined ? null : requiredString(raw.outputSchema, "outputSchema"),
    policy,
  };
}

async function readLimitedText(path: string, maximumBytes: number, field: string): Promise<string> {
  const stats = await lstat(path);
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error(`${field} must be a regular file`);
  if (stats.size > maximumBytes) throw new Error(`${field} exceeds ${maximumBytes} bytes`);
  return readFile(path, "utf8");
}

async function readSchema(bundleRoot: string, path: string | null, field: string): Promise<Record<string, unknown> | null> {
  if (!path) return null;
  const text = await readLimitedText(resolveInside(bundleRoot, path, field), MAX_SCHEMA_BYTES, field);
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) throw new Error(`${field} must contain a JSON object`);
  return parsed;
}

async function collectSkillFiles(bundleRoot: string, skillPaths: string[]): Promise<SourceFile[]> {
  const files: SourceFile[] = [];
  let totalBytes = 0;
  const destinationNames = new Set<string>();

  const visit = async (path: string, skillRoot: string, destinationRoot: string): Promise<void> => {
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) throw new Error(`skill contains a symbolic link: ${relative(bundleRoot, path)}`);
    if (stats.isDirectory()) {
      for (const entry of (await readdir(path)).sort()) await visit(join(path, entry), skillRoot, destinationRoot);
      return;
    }
    if (!stats.isFile()) throw new Error(`skill contains an unsupported file: ${relative(bundleRoot, path)}`);
    totalBytes += stats.size;
    if (totalBytes > MAX_SKILL_BYTES) throw new Error("skills exceed the total size limit");
    if (files.length >= MAX_SKILL_FILES) throw new Error("skills exceed the file count limit");
    const content = await readFile(path);
    files.push({
      absolutePath: path,
      relativePath: join(destinationRoot, relative(skillRoot, path)),
      bytes: stats.size,
      digest: createHash("sha256").update(content).digest("hex"),
    });
  };

  for (const skillPath of skillPaths) {
    const root = resolveInside(bundleRoot, skillPath, "skills");
    const name = basename(root);
    if (destinationNames.has(name)) throw new Error(`duplicate skill directory name: ${name}`);
    destinationNames.add(name);
    const skillManifest = await lstat(join(root, "SKILL.md")).catch(() => null);
    if (!skillManifest?.isFile() || skillManifest.isSymbolicLink()) {
      throw new Error(`skill ${skillPath} does not contain a regular SKILL.md`);
    }
    await visit(root, root, join("skills", name));
  }
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function resolveMcpServers(
  bindings: SubagentMcpBinding[],
  registered: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(bindings.map((binding) => {
    const definition = registered[binding.server];
    if (!isRecord(definition)) throw new Error(`MCP server is not registered: ${binding.server}`);
    return [binding.server, {
      ...definition,
      ...(binding.includeTools ? { includeTools: binding.includeTools } : {}),
      ...(binding.excludeTools ? { excludeTools: binding.excludeTools } : {}),
    }];
  }));
}

async function materializeRevision(runtimeDir: string, digest: string, files: SourceFile[]): Promise<string> {
  const revisionRoot = join(runtimeDir, "revisions", digest);
  const agentDirectory = join(revisionRoot, "agent");
  if ((await lstat(agentDirectory).catch(() => null))?.isDirectory()) return agentDirectory;

  const temporaryRoot = `${revisionRoot}.${randomUUID()}.tmp`;
  try {
    await mkdir(join(temporaryRoot, "agent"), { recursive: true });
    for (const file of files) {
      const target = join(temporaryRoot, "agent", file.relativePath);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(file.absolutePath, target);
    }
    await mkdir(dirname(revisionRoot), { recursive: true });
    await rename(temporaryRoot, revisionRoot).catch(async (error: unknown) => {
      if ((await lstat(agentDirectory).catch(() => null))?.isDirectory()) return;
      throw error;
    });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
  return agentDirectory;
}

function toLoadedRevision(row: typeof subagentRevisions.$inferSelect): LoadedSubagentRevision {
  return {
    id: row.id,
    agentDefinitionId: row.agentDefinitionId,
    version: row.version,
    digest: row.digest,
    manifest: row.manifest as unknown as SubagentManifest,
    systemPrompt: row.systemPrompt,
    agentDirectory: row.agentDirectory,
    mcpServers: row.mcpServers,
    policy: row.policy as unknown as SubagentPolicy,
    inputSchema: row.inputSchema,
    outputSchema: row.outputSchema,
    createdAt: row.createdAt.toISOString(),
  };
}

export class SubagentRegistry {
  private readonly definitions = new Map<string, LoadedSubagentDefinition>();

  constructor(
    private readonly db: GatewayDatabase,
    private readonly config: SubagentFrameworkConfig,
    private readonly registeredMcpServers: Record<string, unknown>,
    private readonly logger: SubagentLogger,
  ) {}

  async initialize(): Promise<void> {
    this.definitions.clear();
    if (!this.config.enabled) return;
    await Promise.all([
      mkdir(this.config.definitionsDir, { recursive: true }),
      mkdir(this.config.runtimeDir, { recursive: true }),
    ]);
    const entries = await readdir(this.config.definitionsDir, { withFileTypes: true });
    for (const entry of entries.filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      const bundleRoot = join(this.config.definitionsDir, entry.name);
      try {
        const loaded = await this.loadBundle(bundleRoot);
        if (this.definitions.has(loaded.id)) throw new Error(`duplicate agent id: ${loaded.id}`);
        this.definitions.set(loaded.id, loaded);
      } catch (error) {
        this.logger.warn({
          bundleRoot,
          error: error instanceof Error ? error.message : String(error),
        }, "subagent bundle rejected");
      }
    }
    this.logger.info({
      definitionsDir: this.config.definitionsDir,
      loaded: this.definitions.size,
      enabled: this.listAvailable().length,
    }, "subagent registry loaded");
  }

  listAvailable(): LoadedSubagentDefinition[] {
    return [...this.definitions.values()].filter((definition) => definition.enabled);
  }

  listAll(): LoadedSubagentDefinition[] {
    return [...this.definitions.values()];
  }

  get(agentId: string): LoadedSubagentDefinition | null {
    return this.definitions.get(agentId) ?? null;
  }

  private async loadBundle(bundleRoot: string): Promise<LoadedSubagentDefinition> {
    const manifestPath = await this.findManifest(bundleRoot);
    const rawText = await readLimitedText(manifestPath, MAX_SCHEMA_BYTES, "agent manifest");
    const raw = manifestPath.endsWith(".json") ? JSON.parse(rawText) as unknown : parseYaml(rawText) as unknown;
    const manifest = parseManifest(raw, this.config);
    const systemPrompt = (await readLimitedText(
      resolveInside(bundleRoot, manifest.promptPath, "systemPrompt"),
      MAX_PROMPT_BYTES,
      "systemPrompt",
    )).trim();
    if (!systemPrompt) throw new Error("systemPrompt file is empty");
    const [inputSchema, outputSchema, skillFiles] = await Promise.all([
      readSchema(bundleRoot, manifest.inputSchemaPath, "inputSchema"),
      readSchema(bundleRoot, manifest.outputSchemaPath, "outputSchema"),
      collectSkillFiles(bundleRoot, manifest.skills),
    ]);
    const mcpServers = resolveMcpServers(manifest.mcp, this.registeredMcpServers);
    const compiled: Omit<CompiledBundle, "digest"> = {
      manifest,
      systemPrompt,
      inputSchema,
      outputSchema,
      mcpServers,
      skillFiles,
    };
    const digest = digestJson({
      manifest,
      systemPrompt,
      inputSchema,
      outputSchema,
      mcpServers,
      skillFiles: skillFiles.map(({ relativePath, bytes, digest: fileDigest }) => ({
        relativePath,
        bytes,
        digest: fileDigest,
      })),
    });
    return this.persistCompiled({ ...compiled, digest });
  }

  private async findManifest(bundleRoot: string): Promise<string> {
    for (const name of ["agent.yaml", "agent.yml", "agent.json"]) {
      const candidate = join(bundleRoot, name);
      if ((await lstat(candidate).catch(() => null))?.isFile()) return candidate;
    }
    throw new Error("agent.yaml, agent.yml, or agent.json is required");
  }

  private async persistCompiled(compiled: CompiledBundle): Promise<LoadedSubagentDefinition> {
    const now = new Date();
    const existingDefinition = this.db.select().from(subagentDefinitions)
      .where(eq(subagentDefinitions.id, compiled.manifest.id)).get();
    const existingRevision = this.db.select().from(subagentRevisions).where(and(
      eq(subagentRevisions.agentDefinitionId, compiled.manifest.id),
      eq(subagentRevisions.digest, compiled.digest),
    )).get();
    let revisionRow = existingRevision;
    if (!revisionRow) {
      const previous = this.db.select({ version: subagentRevisions.version }).from(subagentRevisions)
        .where(eq(subagentRevisions.agentDefinitionId, compiled.manifest.id))
        .orderBy(desc(subagentRevisions.version)).get();
      const revisionId = randomUUID();
      const agentDirectory = await materializeRevision(
        this.config.runtimeDir,
        compiled.digest,
        compiled.skillFiles,
      );
      this.db.transaction((tx) => {
        if (!existingDefinition) {
          tx.insert(subagentDefinitions).values({
            id: compiled.manifest.id,
            name: compiled.manifest.name,
            description: compiled.manifest.description,
            enabled: compiled.manifest.enabled,
            currentRevisionId: revisionId,
            createdAt: now,
            updatedAt: now,
          }).run();
        }
        tx.insert(subagentRevisions).values({
          id: revisionId,
          agentDefinitionId: compiled.manifest.id,
          version: (previous?.version ?? 0) + 1,
          digest: compiled.digest,
          manifest: compiled.manifest as unknown as Record<string, unknown>,
          systemPrompt: compiled.systemPrompt,
          agentDirectory,
          mcpServers: compiled.mcpServers,
          policy: compiled.manifest.policy as unknown as Record<string, unknown>,
          inputSchema: compiled.inputSchema,
          outputSchema: compiled.outputSchema,
          createdAt: now,
        }).run();
      });
      revisionRow = this.db.select().from(subagentRevisions).where(eq(subagentRevisions.id, revisionId)).get();
    }
    if (!revisionRow) throw new Error("failed to persist subagent revision");
    const definitionRow = this.db.insert(subagentDefinitions).values({
      id: compiled.manifest.id,
      name: compiled.manifest.name,
      description: compiled.manifest.description,
      enabled: compiled.manifest.enabled,
      currentRevisionId: revisionRow.id,
      createdAt: existingDefinition?.createdAt ?? now,
      updatedAt: now,
    }).onConflictDoUpdate({
      target: subagentDefinitions.id,
      set: {
        name: compiled.manifest.name,
        description: compiled.manifest.description,
        enabled: compiled.manifest.enabled,
        currentRevisionId: revisionRow.id,
        updatedAt: now,
      },
    }).returning().get();
    const revision = toLoadedRevision(revisionRow);
    return {
      id: definitionRow.id,
      name: definitionRow.name,
      description: definitionRow.description,
      enabled: definitionRow.enabled,
      currentRevisionId: definitionRow.currentRevisionId,
      createdAt: definitionRow.createdAt.toISOString(),
      updatedAt: definitionRow.updatedAt.toISOString(),
      revision,
    };
  }
}
