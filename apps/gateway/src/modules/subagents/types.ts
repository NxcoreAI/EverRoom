import type { SubagentDefinition, SubagentRevision } from "@nxcore/agent-contract";

export interface SubagentMcpBinding {
  server: string;
  includeTools?: string[];
  excludeTools?: string[];
}

export interface SubagentModelPolicy {
  /** 该子 Agent 的模型输出上限（缺省继承 background/主模型档）。 */
  maxTokens?: number;
  /** 该子 Agent 的上下文窗口口径（缺省继承 background/主模型档）。 */
  contextWindow?: number;
  /** 该子 Agent 的思考档位；审页这类「看+判」代理降到 low 可避免思考吃满输出预算。 */
  reasoning?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
}

export interface SubagentPolicy {
  allowedCallers: Array<"primary-agent" | "scheduler" | "internal-workflow">;
  maxConcurrency: number;
  timeoutMs: number;
  /**
   * 单次 run 的工具调用上限；缺省＝不设上限（run 仍受 timeoutMs 与输出预算约束）。
   * 布局这类「读资料 → 校验 → 修复」多轮任务，硬预算耗尽会把已收敛的树一起丢掉，
   * 因此允许 agent 不声明。
   */
  maxToolCalls?: number;
  /** 模型档位覆盖；缺省沿用 background/主模型档（见 runtime-manager.buildPiConfig）。 */
  model?: SubagentModelPolicy;
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
