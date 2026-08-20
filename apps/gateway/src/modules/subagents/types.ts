import type { SubagentDefinition, SubagentRevision } from "@nxcore/agent-contract";

export interface SubagentMcpBinding {
  server: string;
  includeTools?: string[];
  excludeTools?: string[];
}

export interface SubagentPolicy {
  allowedCallers: Array<"primary-agent" | "scheduler" | "internal-workflow">;
  maxConcurrency: number;
  timeoutMs: number;
  maxToolCalls: number;
}

export interface SubagentManifest {
  schemaVersion: 1;
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  mode: "dispatch_only";
  promptPath: string;
  skills: string[];
  mcp: SubagentMcpBinding[];
  inputSchemaPath: string | null;
  outputSchemaPath: string | null;
  policy: SubagentPolicy;
}

export interface LoadedSubagentDefinition extends SubagentDefinition {
  revision: LoadedSubagentRevision;
}

export interface LoadedSubagentRevision extends SubagentRevision {
  manifest: SubagentManifest;
  systemPrompt: string;
  agentDirectory: string;
  mcpServers: Record<string, unknown>;
  policy: SubagentPolicy;
  inputSchema: Record<string, unknown> | null;
  outputSchema: Record<string, unknown> | null;
}

export interface SubagentLogger {
  info(bindings: Record<string, unknown>, message: string): void;
  warn(bindings: Record<string, unknown>, message: string): void;
}
