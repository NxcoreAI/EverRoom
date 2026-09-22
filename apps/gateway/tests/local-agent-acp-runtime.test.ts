import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execPath } from "node:process";
import { describe, expect, it, onTestFinished } from "vitest";
import type {
  LocalAgentDelegationContext,
  LocalAgentInvocationTarget,
} from "@nxcore/agent-contract";
import type { RuntimeEvent } from "@nxcore/agent-runtime";
import {
  AcpAgentRuntime,
  acpAdapterCommand,
} from "../src/modules/local-agents/acp-runtime.js";
import { LocalAgentRuntimeRegistry } from "../src/modules/local-agents/runtime-registry.js";

const FAKE_AGENT = String.raw`
const mode = process.argv[2] ?? "ok";
let buf = "";
let nextSession = 1;
let nextClientRequestId = 1;
const pendingClientRequests = new Map();
const clientResponses = new Map();
const cancelled = new Set();

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}
function respond(id, result) {
  send({ jsonrpc: "2.0", id, result });
}
function chunk(sessionId, text) {
  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
    },
  });
}
function clientRequest(method, params) {
  const id = "fake-req-" + nextClientRequestId++;
  send({ jsonrpc: "2.0", id, method, params });
  return new Promise((resolve, reject) => {
    pendingClientRequests.set(String(id), { resolve, reject });
  });
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function handlePrompt(message) {
  const sessionId = message.params.sessionId;
  const prompt = (Array.isArray(message.params.prompt) ? message.params.prompt : [])
    .map((block) => block && typeof block.text === "string" ? block.text : "")
    .join("");
  if (mode === "crash") {
    chunk(sessionId, "about to crash");
    await sleep(30);
    process.exit(17);
    return;
  }
  if (mode === "cancel") {
    chunk(sessionId, "working");
    for (let i = 0; i < 500 && !cancelled.has(sessionId); i += 1) await sleep(10);
    respond(message.id, { stopReason: cancelled.has(sessionId) ? "cancelled" : "end_turn" });
    return;
  }
  if (mode === "permission") {
    const answer = await clientRequest("session/request_permission", {
      sessionId,
      toolCall: { toolCallId: "tc-1", title: "run tool", kind: "execute", status: "pending" },
      options: [
        { optionId: "allow-once", kind: "allow_once", name: "Allow" },
        { optionId: "reject-once", kind: "reject_once", name: "Reject" },
      ],
    });
    chunk(sessionId, answer.outcome.outcome === "selected" ? answer.outcome.optionId : "none:" + answer.outcome.outcome);
    respond(message.id, { stopReason: "end_turn" });
    return;
  }
  if (mode === "readfile" || mode === "readfile-escape") {
    const path = mode === "readfile" ? process.env.FAKE_READ_PATH ?? "notes.txt" : "../escape.txt";
    let text;
    try {
      const answer = await clientRequest("fs/read_text_file", { sessionId, path });
      text = "content:" + answer.content.slice(0, 40);
    } catch (error) {
      text = "error:" + String(error.message ?? error);
    }
    chunk(sessionId, text);
    respond(message.id, { stopReason: "end_turn" });
    return;
  }
  if (mode === "empty") {
    respond(message.id, { stopReason: "end_turn" });
    return;
  }
  if (mode === "refusal") {
    respond(message.id, { stopReason: "refusal" });
    return;
  }
  // ok：流式两段，回显 prompt 尾部（测试断言委派上下文注入）
  const echo = prompt.includes("<everroom_delegation_context>")
    ? "ctx:yes:" + prompt.slice(-80)
    : "ctx:no";
  chunk(sessionId, "first part ");
  await sleep(20);
  chunk(sessionId, echo);
  respond(message.id, { stopReason: "end_turn" });
}

async function handle(message) {
  if (message.method === "initialize") {
    respond(message.id, { protocolVersion: 1, agentCapabilities: { loadSession: true } });
  } else if (message.method === "session/new") {
    respond(message.id, { sessionId: "s-" + nextSession++ });
  } else if (message.method === "session/load") {
    respond(message.id, { sessionId: message.params.sessionId });
  } else if (message.method === "session/prompt") {
    await handlePrompt(message);
  } else if (message.method === "session/cancel") {
    cancelled.add(message.params.sessionId);
  }
}

process.stdin.on("data", (data) => {
  buf += data;
  for (;;) {
    const index = buf.indexOf("\n");
    if (index < 0) break;
    const line = buf.slice(0, index);
    buf = buf.slice(index + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    const response = message;
    if (message.method === undefined && message.id !== undefined && clientResponses.has(String(message.id))) continue;
    void handle(message).catch(() => process.exit(1));
  }
});
// 客户端响应（带 id 无 method）：error 响应转 reject，让 fake 能把运行时抛错写进输出。
process.stdin.on("data", (data) => {
  String(data).split("\n").forEach((line) => {
    if (!line.trim()) return;
    try {
      const message = JSON.parse(line);
      if (message.method === undefined && message.id !== undefined) {
        const pending = pendingClientRequests.get(String(message.id));
        if (pending) {
          pendingClientRequests.delete(String(message.id));
          if (message.error) {
            pending.reject(new Error(String(message.error.message ?? "client request failed")));
          } else {
            pending.resolve(message.result ?? { outcome: { outcome: "cancelled" } });
          }
        }
      }
    } catch {}
  });
});
`;

async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "everroom-acp-"));
  onTestFinished(() => void rm(dir, { recursive: true, force: true }));
  return dir;
}

async function writeFakeAgent(mode: string): Promise<{ command: string; args: string[] }> {
  const dir = await workspace();
  const script = join(dir, `fake-acp-${mode}.mjs`);
  await writeFile(script, FAKE_AGENT, "utf8");
  return { command: execPath, args: [script, mode] };
}

function runtimeFor(adapter: { command: string; args: string[] }, workingDirectory: string): AcpAgentRuntime {
  return new AcpAgentRuntime(adapter, workingDirectory, `test:${workingDirectory}`);
}

function delegation(mutationAllowed: boolean): LocalAgentDelegationContext {
  return {
    schemaVersion: 2,
    grant: mutationAllowed
      ? { workspaceAccess: "workspace-write", approvals: "agent-reviewed", mutationAllowed: true }
      : { workspaceAccess: "read-only", approvals: "disabled", mutationAllowed: false },
  } as unknown as LocalAgentDelegationContext;
}

async function collect(run: { events: AsyncIterable<RuntimeEvent> }): Promise<RuntimeEvent[]> {
  const events: RuntimeEvent[] = [];
  for await (const event of run.events) events.push(event);
  return events;
}

const baseInput = (workingDirectory: string) => ({
  runId: "run-1",
  sessionId: "session-1",
  runtimeSessionRef: null as string | null,
  prompt: "do the thing",
  pageLabel: "test",
  roomId: null,
});

describe("AcpAgentRuntime", () => {
  it("streams an end_turn answer and injects the sealed delegation context", async () => {
    const root = await workspace();
    const runtime = runtimeFor(await writeFakeAgent("ok"), root);
    onTestFinished(() => runtime.dispose());
    const run = await runtime.start({ ...baseInput(root), delegationContext: delegation(true) });
    const events = await collect(run);
    const types = events.map((event) => event.type);
    expect(types[0]).toBe("run.started");
    expect(events[0]!.payload).toMatchObject({ transport: "acp" });
    expect(types).toContain("runtime.session.updated");
    expect(types).toContain("message.started");
    expect(types).toContain("message.delta");
    const completed = events.find((event) => event.type === "message.completed");
    expect(String((completed!.payload as { content?: string }).content)).toContain("ctx:yes");
    expect(types[types.length - 1]).toBe("run.completed");
  });

  it("fails with local_agent_no_result when the agent ends without output", async () => {
    const root = await workspace();
    const runtime = runtimeFor(await writeFakeAgent("empty"), root);
    onTestFinished(() => runtime.dispose());
    const events = await collect(await runtime.start(baseInput(root)));
    const failure = events.find((event) => event.type === "run.failed");
    expect(failure?.payload).toMatchObject({ message: "local_agent_no_result" });
  });

  it("maps refusal stopReason to run.failed", async () => {
    const root = await workspace();
    const runtime = runtimeFor(await writeFakeAgent("refusal"), root);
    onTestFinished(() => runtime.dispose());
    const events = await collect(await runtime.start(baseInput(root)));
    expect(events.some((event) => event.type === "run.failed"
      && String((event.payload as { message?: string }).message).includes("refusal"))).toBe(true);
  });

  it("supports cancel mid-turn", async () => {
    const root = await workspace();
    const runtime = runtimeFor(await writeFakeAgent("cancel"), root);
    onTestFinished(() => runtime.dispose());
    const run = await runtime.start(baseInput(root));
    const collecting = collect(run);
    await new Promise((resolve) => setTimeout(resolve, 80));
    await runtime.cancel("run-1");
    const events = await collecting;
    expect(events.some((event) => event.type === "run.cancelled")).toBe(true);
  });

  it("auto-approves permissions for mutation-allowed grants and rejects read-only grants", async () => {
    const root = await workspace();
    const adapter = await writeFakeAgent("permission");
    const writer = runtimeFor(adapter, root);
    const reader = runtimeFor(adapter, root);
    onTestFinished(() => { void writer.dispose(); void reader.dispose(); });
    const allowed = await collect(await writer.start({ ...baseInput(root), delegationContext: delegation(true) }));
    expect(String((allowed.find((event) => event.type === "message.completed")!.payload as { content?: string }).content)).toBe("allow-once");
    const rejected = await collect(await reader.start({ ...baseInput(root), delegationContext: delegation(false) }));
    expect(String((rejected.find((event) => event.type === "message.completed")!.payload as { content?: string }).content)).toBe("reject-once");
  });

  it("serves fs/read_text_file inside the workspace and rejects traversal", async () => {
    const root = await workspace();
    await writeFile(join(root, "notes.txt"), "workspace material payload", "utf8");
    const adapter = await writeFakeAgent("readfile");
    const inside = runtimeFor(adapter, root);
    onTestFinished(() => void inside.dispose());
    const served = await collect(await inside.start(baseInput(root)));
    expect(String((served.find((event) => event.type === "message.completed")!.payload as { content?: string }).content))
      .toContain("content:workspace material payload");

    const outside = runtimeFor(await writeFakeAgent("readfile-escape"), root);
    onTestFinished(() => void outside.dispose());
    const blocked = await collect(await outside.start(baseInput(root)));
    expect(String((blocked.find((event) => event.type === "message.completed")!.payload as { content?: string }).content))
      .toContain("local_agent_acp_read_outside_workspace");
  });

  it("resumes through session/load when runtimeSessionRef is present", async () => {
    const root = await workspace();
    const runtime = runtimeFor(await writeFakeAgent("ok"), root);
    onTestFinished(() => runtime.dispose());
    const run = await runtime.start({ ...baseInput(root), runtimeSessionRef: "s-prev" });
    const events = await collect(run);
    const updated = events.find((event) => event.type === "runtime.session.updated");
    expect((updated!.payload as { runtimeSessionRef?: string }).runtimeSessionRef).toBe("s-prev");
  });

  it("fails the run when the adapter command is missing and works again after respawn", async () => {
    const root = await workspace();
    const runtime = runtimeFor({ command: "everroom-missing-adapter-xyz", args: [] }, root);
    onTestFinished(() => runtime.dispose());
    const events = await collect(await runtime.start(baseInput(root)));
    const failure = events.find((event) => event.type === "run.failed");
    expect(String((failure?.payload as { message?: string }).message)).toContain("local_agent_acp_adapter_unavailable");

    const healthy = runtimeFor(await writeFakeAgent("ok"), root);
    onTestFinished(() => void healthy.dispose());
    const events2 = await collect(await healthy.start(baseInput(root)));
    expect(events2[events2.length - 1]!.type).toBe("run.completed");
  });

  it("fails active runs when the adapter process dies mid-turn", async () => {
    const root = await workspace();
    const runtime = runtimeFor(await writeFakeAgent("crash"), root);
    onTestFinished(() => runtime.dispose());
    const events = await collect(await runtime.start(baseInput(root)));
    const failure = events.find((event) => event.type === "run.failed");
    expect(String((failure?.payload as { message?: string }).message)).toContain("local_agent_acp_adapter_exited");
  });
});

describe("LocalAgentRuntimeRegistry", () => {
  const target = (overrides: Partial<LocalAgentInvocationTarget> = {}): LocalAgentInvocationTarget => ({
    id: "claude:/usr/local/bin/claude",
    provider: "claude",
    displayName: "Claude",
    executablePath: "/usr/local/bin/claude",
    workingDirectory: "/tmp/everroom-sandbox/claude",
    permissionProfile: "inspect",
    card: {
      name: "Claude",
      description: "Claude Code",
      version: "1.0.0",
      supportedInterfaces: [],
      capabilities: { streaming: true },
      defaultInputModes: ["text/plain"],
      defaultOutputModes: ["text/plain"],
      skills: [],
    },
    ...overrides,
  });

  it("resolves claude/codex/openclaw to ACP runtimes and caches per workspace", async () => {
    const registry = new LocalAgentRuntimeRegistry();
    onTestFinished(() => void registry.dispose());
    const claude = registry.resolve(target());
    const claudeAgain = registry.resolve(target());
    const claudeElsewhere = registry.resolve(target({ workingDirectory: "/tmp/everroom-sandbox/other" }));
    const codex = registry.resolve(target({ id: "codex:/usr/local/bin/codex", provider: "codex", executablePath: "/usr/local/bin/codex" }));
    const openclaw = registry.resolve(target({ id: "openclaw:/usr/local/bin/openclaw", provider: "openclaw", executablePath: "/usr/local/bin/openclaw" }));
    expect(claude).toBe(claudeAgain);
    expect(claude).not.toBe(claudeElsewhere);
    expect(claude.id).toBe("local:acp:claude:/usr/local/bin/claude");
    expect(codex).not.toBe(claude);
    expect(openclaw.id).toBe("local:acp:openclaw:/usr/local/bin/openclaw");
  });

  it("rejects unsupported providers and invalid cards", () => {
    const registry = new LocalAgentRuntimeRegistry();
    expect(() => registry.resolve(target({ provider: "opencode" as LocalAgentInvocationTarget["provider"] })))
      .toThrow("local_agent_provider_not_supported");
    expect(() => registry.resolve(target({ card: { ...target().card!, name: "" } })))
      .toThrow("local_agent_card_invalid");
  });

  it("maps providers to adapter commands with env override", () => {
    expect(acpAdapterCommand("claude", "/usr/bin/claude")).toEqual({ command: "claude-code-acp", args: [] });
    expect(acpAdapterCommand("codex", "/usr/bin/codex")).toEqual({ command: "codex-acp", args: [] });
    expect(acpAdapterCommand("openclaw", "/usr/bin/openclaw")).toEqual({ command: "/usr/bin/openclaw", args: ["acp"] });
    const previous = process.env.EVERROOM_ACP_COMMAND_CLAUDE;
    process.env.EVERROOM_ACP_COMMAND_CLAUDE = "/opt/custom/adapter --flag";
    try {
      expect(acpAdapterCommand("claude", "/usr/bin/claude")).toEqual({ command: "/opt/custom/adapter", args: ["--flag"] });
    } finally {
      if (previous === undefined) delete process.env.EVERROOM_ACP_COMMAND_CLAUDE;
      else process.env.EVERROOM_ACP_COMMAND_CLAUDE = previous;
    }
  });
});
