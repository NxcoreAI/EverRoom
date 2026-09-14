import { randomUUID } from "node:crypto";
import { Type } from "@sinclair/typebox";
import type { RuntimeEvent } from "@nxcore/agent-runtime";
import type { PiAgentRuntimeTool } from "@nxcore/agent-runtime-pi";
import { localAgentGrant, sealDelegationPayload } from "./delegation.js";
import type { LocalAgentRuntimeRegistry } from "./runtime-registry.js";

const TERMINAL_EVENTS = new Set<RuntimeEvent["type"]>([
  "run.completed",
  "run.failed",
  "run.cancelled",
  "run.interrupted",
]);

export function createLocalAgentDispatchTools(
  registry: Pick<LocalAgentRuntimeRegistry, "resolve">,
): PiAgentRuntimeTool[] {
  return [{
    name: "local_agent_dispatch",
    label: "Dispatch local Agent",
    description: "调用用户 @ 点名的本机 Agent（Codex/Claude Code/OpenClaw）作为子 Agent 完成任务并等待结果。从被 @ 点名的 Agent 中按 agentId 选择目标；子 Agent 不与用户直接对话；任务文本由你组织，结果由你转述。",
    parameters: Type.Object({
      agentId: Type.String({ minLength: 1, maxLength: 200 }),
      task: Type.String({ minLength: 1, maxLength: 16_000 }),
    }, { additionalProperties: false }),
    execute: async (run, params, signal) => {
      const agentId = String(params.agentId ?? "").trim();
      const target = (run.referencedLocalAgents ?? []).find((item) => item.id === agentId);
      if (!target) throw new Error("local_agent_dispatch_target_not_referenced");
      const task = String(params.task ?? "").trim();
      if (!task) throw new Error("local_agent_dispatch_task_required");
      const runtime = registry.resolve(target);
      const subRunId = randomUUID();
      const onAbort = () => { void runtime.cancel(subRunId); };
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const runtimeRun = await runtime.start({
          runId: subRunId,
          sessionId: run.sessionId,
          runtimeSessionRef: null,
          originalPrompt: task,
          prompt: task,
          pageLabel: run.pageLabel,
          roomId: null,
          delegationContext: sealDelegationPayload({
            schemaVersion: 1,
            targetAgentId: target.id,
            task: { text: task },
            conversation: { messages: [], truncated: false },
            attachments: [],
            resources: { workspaceRoot: target.workingDirectory, roomIds: [] },
            grant: localAgentGrant(target.permissionProfile),
          }),
        });
        let answer = "";
        let failure: string | null = null;
        for await (const event of runtimeRun.events) {
          if (event.type === "message.completed") {
            const content = (event.payload as { content?: unknown }).content;
            if (typeof content === "string" && content.trim()) answer = content;
          } else if (event.type === "run.failed") {
            failure = String((event.payload as { message?: unknown }).message ?? "local_agent_run_failed");
          }
          if (TERMINAL_EVENTS.has(event.type)) break;
        }
        if (failure && !answer) throw new Error(failure);
        if (!answer) throw new Error(signal?.aborted ? "local_agent_run_cancelled" : "local_agent_no_result");
        return {
          content: answer,
          details: { agentId: target.id, provider: target.provider, runId: subRunId },
        };
      } finally {
        signal?.removeEventListener("abort", onAbort);
      }
    },
  }];
}
