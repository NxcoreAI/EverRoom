import { randomUUID } from "node:crypto";
import { Type } from "@sinclair/typebox";
import type {
  AgentMessage,
  LocalAgentDelegationMaterial,
} from "@nxcore/agent-contract";
import type { RuntimeEvent } from "@nxcore/agent-runtime";
import type { PiAgentRuntimeTool } from "@nxcore/agent-runtime-pi";
import {
  LOCAL_AGENT_HISTORY_MESSAGE_LIMIT,
  buildLocalAgentDelegationPayload,
  sealDelegationPayload,
} from "./delegation.js";
import type { LocalAgentDispatchStore } from "./dispatch-store.js";
import type { LocalAgentDispatchMaterialRecord } from "../../infrastructure/database/schema.js";
import type { LocalAgentRuntimeRegistry } from "./runtime-registry.js";

const TERMINAL_EVENTS = new Set<RuntimeEvent["type"]>([
  "run.completed",
  "run.failed",
  "run.cancelled",
  "run.interrupted",
]);

const LOCAL_AGENT_OUTPUT_TEXT_LIMIT = 24_000;
const LOCAL_AGENT_MATERIAL_TEXT_LIMIT = 8_000;
const DEFAULT_MAX_CONCURRENT_PER_RUN = 3;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/** Main run 侧的分发材料来源：最近对话、选区、随消息附件。由 agent service 按 runId 提供。 */
export interface LocalAgentDispatchSource {
  priorMessages: Array<Pick<AgentMessage, "role" | "authorAgentId" | "content" | "createdAt">>;
  promptAttachments: Array<{ fileName: string; content?: string }>;
  selectedText?: string;
}

export interface LocalAgentDispatchToolsDeps {
  registry: Pick<LocalAgentRuntimeRegistry, "resolve">;
  store: Pick<LocalAgentDispatchStore, "create" | "markRunning" | "complete" | "fail" | "get">;
  resolveDispatchSource?: (runId: string) => LocalAgentDispatchSource | undefined;
  maxConcurrentPerRun?: number;
  timeoutMs?: number;
}

type MaterialSwitch =
  | { kind: "selection" }
  | { kind: "attachments" }
  | { kind: "activeDocument" }
  | { kind: "transcript" }
  | { kind: "text"; title: string; text: string };

function materialText(text: string): { text: string; truncated: boolean } {
  return text.length > LOCAL_AGENT_MATERIAL_TEXT_LIMIT
    ? { text: text.slice(0, LOCAL_AGENT_MATERIAL_TEXT_LIMIT), truncated: true }
    : { text, truncated: false };
}

export function createLocalAgentDispatchTools(deps: LocalAgentDispatchToolsDeps): PiAgentRuntimeTool[] {
  const { registry, store } = deps;
  const resolveDispatchSource = deps.resolveDispatchSource;
  const maxConcurrent = deps.maxConcurrentPerRun ?? DEFAULT_MAX_CONCURRENT_PER_RUN;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const inFlight = new Map<string, number>();

  return [{
    name: "local_agent_dispatch",
    label: "Dispatch local Agent",
    executionMode: "parallel",
    description: [
      "把一项分工分派给用户 @ 点名的本机 Agent（Codex/Claude Code/OpenClaw）作为子 Agent 执行并等待结果。",
      "assignment 由你以 Main Agent 身份向协作者下达工作指派：直接写目标、范围与产出要求，禁止出现“用户问你”“用户希望你”这类转述口吻。",
      "sharedGoal 传递本轮共享目标，constraints 传递硬约束；materials 按最小必要声明子 Agent 需要的材料（selection/attachments/activeDocument/transcript 开关或 text 片段），不声明则默认带入可用材料。",
      "相互独立的子任务请在同一条回复里并行发出多个调用；有依赖的子任务等前置结果返回后再发，并用 priorTaskOutputs 引用结果末尾的 taskId，前置产出会作为“Agent 产出”材料进入子包。",
      "子 Agent 不与用户直接对话，结果由你汇总转述。",
    ].join(""),
    parameters: Type.Object({
      agentId: Type.String({ minLength: 1, maxLength: 200 }),
      assignment: Type.String({ minLength: 1, maxLength: 4_000 }),
      sharedGoal: Type.Optional(Type.String({ minLength: 1, maxLength: 2_000 })),
      constraints: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 8 })),
      materials: Type.Optional(Type.Array(Type.Union([
        Type.Object({ kind: Type.Literal("selection") }, { additionalProperties: false }),
        Type.Object({ kind: Type.Literal("attachments") }, { additionalProperties: false }),
        Type.Object({ kind: Type.Literal("activeDocument") }, { additionalProperties: false }),
        Type.Object({ kind: Type.Literal("transcript") }, { additionalProperties: false }),
        Type.Object({
          kind: Type.Literal("text"),
          title: Type.String({ minLength: 1, maxLength: 200 }),
          text: Type.String({ minLength: 1, maxLength: LOCAL_AGENT_MATERIAL_TEXT_LIMIT }),
        }, { additionalProperties: false }),
      ]), { maxItems: 12 })),
      priorTaskOutputs: Type.Optional(Type.Array(Type.Object({
        taskId: Type.String({ minLength: 1, maxLength: 100 }),
        usage: Type.String({ minLength: 1, maxLength: 1_000 }),
      }), { maxItems: 4 })),
    }, { additionalProperties: false }),
    execute: async (run, params, signal) => {
      const agentId = String(params.agentId ?? "").trim();
      const target = (run.referencedLocalAgents ?? []).find((item) => item.id === agentId);
      if (!target) throw new Error("local_agent_dispatch_target_not_referenced");
      const assignment = String(params.assignment ?? "").trim();
      if (!assignment) throw new Error("local_agent_dispatch_assignment_required");
      const sharedGoal = typeof params.sharedGoal === "string" ? params.sharedGoal.trim() : undefined;
      const constraints = Array.isArray(params.constraints)
        ? params.constraints.map((item) => String(item).trim()).filter(Boolean)
        : [];
      const switches = Array.isArray(params.materials)
        ? params.materials as MaterialSwitch[]
        : null;
      const priorRefs = Array.isArray(params.priorTaskOutputs)
        ? params.priorTaskOutputs as Array<{ taskId: string; usage: string }>
        : [];

      const running = inFlight.get(run.runId) ?? 0;
      if (running >= maxConcurrent) throw new Error("local_agent_dispatch_concurrency_limit");
      inFlight.set(run.runId, running + 1);

      const subRunId = randomUUID();
      try {
        const runtime = registry.resolve(target);
        const onAbort = () => { void runtime.cancel(subRunId); };

        const source = resolveDispatchSource?.(run.runId);
        const switchKinds = switches ? new Set(switches.map((item) => item.kind)) : null;
        const include = {
          conversation: !switchKinds || switchKinds.has("transcript"),
          selection: !switchKinds || switchKinds.has("selection"),
          attachments: !switchKinds || switchKinds.has("attachments"),
          activeDocument: !switchKinds || switchKinds.has("activeDocument"),
        };
        const priorMessages = include.conversation ? source?.priorMessages ?? [] : [];

        const materials: LocalAgentDelegationMaterial[] = [];
        const summaries: LocalAgentDispatchMaterialRecord[] = [];
        const priorOutputs: Array<{ taskId: string; displayName: string; chars: number }> = [];

        for (const ref of priorRefs) {
          const prior = store.get(String(ref.taskId ?? "").trim());
          if (!prior || prior.parentRunId !== run.runId) {
            throw new Error("local_agent_dispatch_prior_task_not_found");
          }
          if (prior.status !== "completed" || !prior.resultText) {
            throw new Error("local_agent_dispatch_prior_task_not_completed");
          }
          const usage = String(ref.usage ?? "").trim();
          const full = usage ? `用途：${usage}\n\n${prior.resultText}` : prior.resultText;
          const truncated = full.length > LOCAL_AGENT_OUTPUT_TEXT_LIMIT;
          const text = truncated ? full.slice(0, LOCAL_AGENT_OUTPUT_TEXT_LIMIT) : full;
          const id = `agent_output:${prior.id}`;
          const title = `${prior.displayName} 的任务产出`;
          materials.push({
            id, kind: "agent_output", title, text,
            ...(truncated ? { truncated } : {}),
            agentOutput: true, sourceDispatchId: prior.id,
          });
          summaries.push({
            id, kind: "agent_output", title, chars: text.length, truncated,
            agentOutput: true, sourceDispatchId: prior.id,
          });
          priorOutputs.push({ taskId: prior.id, displayName: prior.displayName, chars: text.length });
        }

        if (include.conversation && priorMessages.length > 0) {
          const recent = priorMessages.slice(-LOCAL_AGENT_HISTORY_MESSAGE_LIMIT);
          summaries.push({
            id: "transcript",
            kind: "transcript",
            title: "最近对话",
            chars: recent.reduce((sum, message) => sum + message.content.length, 0),
            truncated: priorMessages.length > LOCAL_AGENT_HISTORY_MESSAGE_LIMIT,
            agentOutput: false,
            sourceDispatchId: null,
          });
        }
        if (include.selection && source?.selectedText?.trim()) {
          const { text, truncated } = materialText(source.selectedText.trim());
          materials.push({
            id: "selection", kind: "selection", title: `选区（${run.pageLabel}）`, text,
            ...(truncated ? { truncated } : {}),
            agentOutput: false,
          });
          summaries.push({
            id: "selection", kind: "selection", title: `选区（${run.pageLabel}）`,
            chars: text.length, truncated, agentOutput: false, sourceDispatchId: null,
          });
        }
        if (include.attachments) {
          for (const attachment of run.attachments ?? []) {
            const { text, truncated } = attachment.text
              ? materialText(attachment.text)
              : { text: "", truncated: false };
            const id = `attachment:${attachment.filename}`;
            materials.push({
              id, kind: "attachment", title: attachment.filename, text,
              ...(truncated ? { truncated } : {}),
              agentOutput: false,
            });
            summaries.push({
              id, kind: "attachment", title: attachment.filename,
              chars: text.length, truncated, agentOutput: false, sourceDispatchId: null,
            });
          }
          for (const attachment of source?.promptAttachments ?? []) {
            const { text, truncated } = attachment.content
              ? materialText(attachment.content)
              : { text: "", truncated: false };
            const id = `attachment:${attachment.fileName}`;
            if (summaries.some((item) => item.id === id)) continue;
            materials.push({
              id, kind: "attachment", title: attachment.fileName, text,
              ...(truncated ? { truncated } : {}),
              agentOutput: false,
            });
            summaries.push({
              id, kind: "attachment", title: attachment.fileName,
              chars: text.length, truncated, agentOutput: false, sourceDispatchId: null,
            });
          }
        }
        if (include.activeDocument && run.activeDocument) {
          const title = run.activeDocument.title || "当前文档";
          materials.push({ id: "active_document", kind: "active_document", title, text: "", agentOutput: false });
          summaries.push({
            id: "active_document", kind: "active_document", title,
            chars: 0, truncated: false, agentOutput: false, sourceDispatchId: null,
          });
        }
        for (const [index, item] of (switches ?? []).entries()) {
          if (item.kind !== "text") continue;
          const id = `note:${index}`;
          const { text, truncated } = materialText(item.text);
          materials.push({
            id, kind: "note", title: item.title, text,
            ...(truncated ? { truncated } : {}),
            agentOutput: false,
          });
          summaries.push({
            id, kind: "note", title: item.title,
            chars: text.length, truncated, agentOutput: false, sourceDispatchId: null,
          });
        }

        const sealed = sealDelegationPayload(buildLocalAgentDelegationPayload({
          targetAgentId: target.id,
          assignmentText: assignment,
          ...(sharedGoal ? { sharedGoal } : {}),
          constraints,
          materials,
          include,
          pageLabel: run.pageLabel,
          priorMessages,
          attachments: run.attachments ?? [],
          promptAttachments: source?.promptAttachments ?? [],
          ...(include.selection && source?.selectedText ? { selectedText: source.selectedText } : {}),
          rooms: run.availableRooms ?? [],
          ...(include.activeDocument && run.activeDocument ? { activeDocument: run.activeDocument } : {}),
          workingDirectory: target.workingDirectory,
          permissionProfile: target.permissionProfile,
        }));

        const dispatch = store.create({
          sessionId: run.sessionId,
          parentRunId: run.runId,
          agentId: target.id,
          displayName: target.displayName,
          provider: String(target.provider),
          assignment,
          ...(sharedGoal ? { sharedGoal } : {}),
          constraints,
          materials: summaries,
          packagePayload: sealed,
          subRunId,
        });
        store.markRunning(dispatch.id);

        signal?.addEventListener("abort", onAbort, { once: true });
        const startedAt = Date.now();
        try {
          const runtimeRun = await runtime.start({
            runId: subRunId,
            sessionId: run.sessionId,
            runtimeSessionRef: null,
            originalPrompt: assignment,
            prompt: assignment,
            pageLabel: run.pageLabel,
            roomId: null,
            delegationContext: sealed,
          });
          let answer = "";
          let failure: string | null = null;
          let cancelled = false;
          const consume = (async () => {
            for await (const event of runtimeRun.events) {
              if (event.type === "message.completed") {
                const content = (event.payload as { content?: unknown }).content;
                if (typeof content === "string" && content.trim()) answer = content;
              } else if (event.type === "run.failed") {
                failure = String((event.payload as { message?: unknown }).message ?? "local_agent_run_failed");
              } else if (event.type === "run.cancelled" || event.type === "run.interrupted") {
                cancelled = true;
              }
              if (TERMINAL_EVENTS.has(event.type)) break;
            }
          })();
          let timedOut = false;
          const timer = new Promise<"timeout">((resolveTimeout) => {
            setTimeout(() => resolveTimeout("timeout"), timeoutMs).unref?.();
          });
          if (await Promise.race([consume.then(() => "settled" as const), timer]) === "timeout") {
            timedOut = true;
            try { await runtime.cancel(subRunId); } catch { /* 取消失败也按超时落库 */ }
          }
          if (timedOut) {
            store.fail(dispatch.id, "timed_out", "local_agent_dispatch_timeout");
            throw new Error("local_agent_dispatch_timeout");
          }
          const details = {
            agentId: target.id,
            provider: String(target.provider),
            displayName: target.displayName,
            taskId: dispatch.id,
            runId: subRunId,
            assignment,
            ...(sharedGoal ? { sharedGoal } : {}),
            constraints,
            materials: summaries,
            priorOutputs,
            packageVersion: dispatch.packageVersion,
            packageDigest: dispatch.packageDigest,
            durationMs: Date.now() - startedAt,
          };
          if (failure && !answer) {
            store.fail(dispatch.id, "failed", failure);
            throw new Error(failure);
          }
          if (!answer) {
            const cancelledRun = signal?.aborted || cancelled;
            const code = cancelledRun ? "local_agent_run_cancelled" : "local_agent_no_result";
            store.fail(dispatch.id, cancelledRun ? "cancelled" : "failed", code);
            throw new Error(code);
          }
          store.complete(dispatch.id, answer);
          return {
            content: `${answer}\n\n[local_agent_dispatch_task_id:${dispatch.id}]`,
            details: { ...details, status: "completed", resultPreview: answer.slice(0, 2_000) },
          };
        } finally {
          signal?.removeEventListener("abort", onAbort);
        }
      } finally {
        const next = (inFlight.get(run.runId) ?? 1) - 1;
        if (next <= 0) inFlight.delete(run.runId);
        else inFlight.set(run.runId, next);
      }
    },
  }];
}
