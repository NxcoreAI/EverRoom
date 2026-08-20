import { createHash } from "node:crypto";
import { Type } from "@sinclair/typebox";
import type { PiAgentRuntimeTool } from "@nxcore/agent-runtime-pi";
import { SubagentOrchestrator } from "./orchestrator.js";
import { SubagentRegistry } from "./registry.js";

function dispatchKey(runId: string, agentId: string, task: string, input: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify({ runId, agentId, task, input }))
    .digest("hex");
}

export function createSubagentPiTools(
  registry: SubagentRegistry,
  orchestrator: SubagentOrchestrator,
): PiAgentRuntimeTool[] {
  return [
    {
      name: "agent_catalog",
      label: "Agent catalog",
      description: "列出当前可被调度的内部子 Agent。需要委派独立任务时先调用。",
      parameters: Type.Object({}, { additionalProperties: false }),
      execute: async () => {
        const agents = registry.listAvailable().map((agent) => ({
          id: agent.id,
          name: agent.name,
          description: agent.description,
          inputSchema: agent.revision.inputSchema,
        }));
        return { content: JSON.stringify({ agents }), details: { count: agents.length } };
      },
    },
    {
      name: "agent_dispatch",
      label: "Dispatch agent",
      description: "调度一个内部子 Agent 完成边界清晰的任务并等待结果。子 Agent 不与用户直接对话。",
      parameters: Type.Object({
        agentId: Type.String({ minLength: 1 }),
        task: Type.String({ minLength: 1, maxLength: 16_000 }),
        input: Type.Optional(Type.Unknown()),
      }, { additionalProperties: false }),
      execute: async (run, params) => {
        const agentId = String(params.agentId ?? "");
        const task = String(params.task ?? "");
        const input = params.input ?? null;
        const invocation = await orchestrator.dispatch({
          agentId,
          task,
          input,
          idempotencyKey: dispatchKey(run.runId, agentId, task, input),
          source: "primary_agent",
          parentSessionId: run.sessionId,
          parentRunId: run.runId,
        });
        return {
          content: JSON.stringify({
            invocationId: invocation.id,
            agentId: invocation.agentDefinitionId,
            status: invocation.status,
            result: invocation.result,
            error: invocation.errorMessage,
          }),
          details: invocation,
        };
      },
    },
  ];
}
