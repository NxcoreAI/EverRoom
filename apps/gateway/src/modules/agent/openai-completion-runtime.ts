import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { RuntimeCapabilities } from "@nxcore/agent-contract";
import {
  AsyncEventQueue,
  type AgentRuntime,
  type ResumeRuntimeRunInput,
  type RuntimeEvent,
  type RuntimeRun,
  type StartRuntimeRunInput,
} from "@nxcore/agent-runtime";

export interface OpenAiCompletionAgentConfig {
  runtimeId: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  systemPrompt: string;
  skillPrompts?: Record<string, string>;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  requestOptions?: Record<string, unknown>;
  sessionsDir: string;
  workingDirectory: string;
  agentDirectory: string;
}

interface ActiveRun {
  controller: AbortController;
  queue: AsyncEventQueue<RuntimeEvent>;
}

/** AgentRuntime adapter for providers whose extra request fields are not supported by Pi. */
export class OpenAiCompletionAgentRuntime implements AgentRuntime {
  readonly id: string;
  private readonly activeRuns = new Map<string, ActiveRun>();

  constructor(readonly config: OpenAiCompletionAgentConfig) {
    this.id = config.runtimeId;
  }

  async getCapabilities(): Promise<RuntimeCapabilities> {
    return { streaming: false, reasoning: false, tools: false, steering: false, resume: false };
  }

  async start(input: StartRuntimeRunInput): Promise<RuntimeRun> {
    if (this.activeRuns.has(input.runId)) throw new Error(`Agent run is already active: ${input.runId}`);
    await Promise.all([
      mkdir(this.config.sessionsDir, { recursive: true }),
      mkdir(this.config.workingDirectory, { recursive: true }),
      mkdir(this.config.agentDirectory, { recursive: true }),
    ]);
    const queue = new AsyncEventQueue<RuntimeEvent>();
    const controller = new AbortController();
    this.activeRuns.set(input.runId, { controller, queue });
    const runtimeSessionRef = input.runtimeSessionRef ?? resolve(this.config.sessionsDir, `${randomUUID()}.jsonl`);
    queue.push({ type: "run.started", payload: {} });
    queue.push({ type: "message.started", payload: { role: "assistant" } });
    void this.complete(input, queue, controller.signal);
    return { runId: input.runId, runtimeSessionRef, events: queue };
  }

  async resume(_input: ResumeRuntimeRunInput): Promise<RuntimeRun> {
    throw new Error(`${this.id} does not support resume`);
  }

  async sendInput(): Promise<void> {
    throw new Error(`${this.id} does not support steering`);
  }

  async cancel(runId: string): Promise<void> {
    this.activeRuns.get(runId)?.controller.abort(new Error("cancelled"));
  }

  async deleteSession(runtimeSessionRef: string): Promise<void> {
    const root = `${resolve(this.config.sessionsDir)}${sep}`;
    const path = resolve(runtimeSessionRef);
    if (!path.startsWith(root)) throw new Error("Agent session path is outside its sessions directory");
    await rm(path, { force: true });
  }

  async dispose(): Promise<void> {
    for (const active of this.activeRuns.values()) active.controller.abort(new Error("disposed"));
    this.activeRuns.clear();
  }

  private async complete(
    input: StartRuntimeRunInput,
    queue: AsyncEventQueue<RuntimeEvent>,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      const response = await fetch(`${this.config.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model: this.config.model,
          messages: [
            { role: "system", content: this.systemPromptFor(input.prompt) },
            { role: "user", content: input.prompt },
          ],
          ...(this.config.temperature === undefined ? {} : { temperature: this.config.temperature }),
          ...(this.config.maxTokens === undefined ? {} : { max_tokens: this.config.maxTokens }),
          ...this.config.requestOptions,
        }),
        signal: AbortSignal.any([
          signal,
          AbortSignal.timeout(this.config.timeoutMs ?? 60_000),
        ]),
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`${this.id} provider HTTP ${response.status}: ${detail.slice(0, 400)}`);
      }
      const payload = await response.json() as {
        choices?: Array<{ message?: { content?: string | null }; finish_reason?: string }>;
      };
      const choice = payload.choices?.[0];
      const content = choice?.message?.content?.trim();
      if (!content) {
        throw new Error(`${this.id} provider returned no content (finish_reason=${choice?.finish_reason ?? "unknown"})`);
      }
      queue.push({ type: "message.delta", payload: { delta: content } });
      queue.push({ type: "message.completed", payload: { role: "assistant", content } });
      queue.push({ type: "run.completed", payload: {} });
    } catch (error) {
      if (signal.aborted) {
        queue.push({ type: "run.cancelled", payload: {} });
      } else {
        queue.push({
          type: "run.failed",
          payload: { message: error instanceof Error ? error.message : `${this.id} failed` },
        });
      }
    } finally {
      queue.end();
      this.activeRuns.delete(input.runId);
    }
  }

  private systemPromptFor(prompt: string): string {
    const skillName = /^使用 Knowledge Agent 的 ([a-z0-9-]+) Skill。/iu.exec(prompt)?.[1];
    const skill = skillName ? this.config.skillPrompts?.[skillName] : undefined;
    return skill ? `${this.config.systemPrompt}\n\n<skill name="${skillName}">\n${skill}\n</skill>` : this.config.systemPrompt;
  }
}
