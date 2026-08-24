import { lstat, readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { FakeAgentRuntime } from "@nxcore/agent-runtime/testing";
import { UnconfiguredAgentRuntime, type AgentRuntime } from "@nxcore/agent-runtime";
import { PiAgentRuntime, type PiAgentRuntimeTool } from "@nxcore/agent-runtime-pi";
import { Type } from "@sinclair/typebox";
import type { GatewayConfig, PiRuntimeConfig, SubagentFrameworkConfig } from "../../config.js";
import { isPiRuntimeConfigured } from "../agent/runtime-factory.js";
import type { LoadedSubagentRevision } from "./types.js";

export function createSubagentSkillReadTool(revision: LoadedSubagentRevision): PiAgentRuntimeTool {
  const root = `${resolve(revision.agentDirectory)}${sep}`;
  return {
    name: "read",
    label: "Read skill resource",
    description: "读取当前子 Agent Revision 中的 Skill 文件。只能访问系统提示词列出的 Skill 目录。",
    parameters: Type.Object({
      path: Type.String({ minLength: 1 }),
      offset: Type.Optional(Type.Integer({ minimum: 1 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 2_000 })),
    }, { additionalProperties: false }),
    execute: async (_input, params) => {
      const requestedPath = resolve(String(params.path ?? ""));
      if (!requestedPath.startsWith(root)) throw new Error("subagent_skill_path_not_allowed");
      const stats = await lstat(requestedPath);
      if (!stats.isFile() || stats.isSymbolicLink()) throw new Error("subagent_skill_file_not_readable");
      if (stats.size > 256 * 1024) throw new Error("subagent_skill_file_too_large");
      const lines = (await readFile(requestedPath, "utf8")).split("\n");
      const offset = Number(params.offset ?? 1);
      const limit = Number(params.limit ?? 2_000);
      const selected = lines.slice(offset - 1, offset - 1 + limit);
      return {
        content: selected.map((line, index) => `${offset + index}: ${line}`).join("\n"),
        details: { path: requestedPath, offset, lines: selected.length },
      };
    },
  };
}

export class SubagentRuntimeManager {
  private readonly runtimes = new Map<string, AgentRuntime>();

  constructor(
    private readonly gatewayConfig: GatewayConfig,
    private readonly config: SubagentFrameworkConfig,
  ) {}

  acquire(revision: LoadedSubagentRevision): AgentRuntime {
    const cached = this.runtimes.get(revision.id);
    if (cached) return cached;
    const runtime = this.createRuntime(revision);
    this.runtimes.set(revision.id, runtime);
    return runtime;
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.runtimes.values()].map((runtime) => runtime.dispose()));
    this.runtimes.clear();
  }

  /**
   * runtime config 变更后作废缓存：下次 acquire 用新配置重建。
   * dispose 会中断进行中的子 Agent run（orchestrator 有重启恢复），
   * 配置变更是罕见手动操作，可接受。
   */
  async invalidate(): Promise<void> {
    await this.dispose();
  }

  private createRuntime(revision: LoadedSubagentRevision): AgentRuntime {
    if (this.gatewayConfig.agentRuntime === "fake") return new FakeAgentRuntime();
    const base = this.gatewayConfig.backgroundPi ?? this.gatewayConfig.pi;
    if (!base) throw new Error("subagent_pi_runtime_not_configured");
    // 降级启动：空字段 PiAgentRuntime 会在 pi SDK 深处炸出晦涩错误，
    // 换成类型化占位（runtime_config_not_ready）。
    if (!isPiRuntimeConfigured(base)) {
      return new UnconfiguredAgentRuntime(`subagent:${revision.id}`);
    }
    const config = this.buildPiConfig(base, revision);
    return new PiAgentRuntime(config, {
      tools: revision.manifest.skills.length > 0 ? [createSubagentSkillReadTool(revision)] : [],
    });
  }

  private buildPiConfig(base: PiRuntimeConfig, revision: LoadedSubagentRevision): PiRuntimeConfig {
    const { memory: _memory, knowledge: _knowledge, mcp: _mcp, ...model } = base;
    return {
      ...model,
      runtimeId: `pi:subagent:${revision.id}`,
      systemPrompt: revision.systemPrompt,
      runtimeRole: "internal",
      skillsEnabled: revision.manifest.skills.length > 0,
      builtinTools: [],
      includeBashTool: false,
      maxToolCallsPerRun: revision.policy.maxToolCalls,
      agentDirectory: revision.agentDirectory,
      sessionsDir: join(this.config.runtimeDir, "sessions", revision.id),
      workingDirectory: join(this.config.runtimeDir, "workspaces", revision.id),
      ...(Object.keys(revision.mcpServers).length > 0
        ? { mcp: { mcpServers: revision.mcpServers } }
        : {}),
    };
  }

}
