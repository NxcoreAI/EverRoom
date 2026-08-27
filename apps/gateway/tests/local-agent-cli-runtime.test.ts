import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RuntimeEvent } from "@nxcore/agent-runtime";
import { ClaudeCliAgentRuntime, CodexCliAgentRuntime, OpenClawCliAgentRuntime } from "../src/modules/local-agents/cli-runtime.js";
import { LocalA2AHost } from "../src/modules/local-agents/a2a-host.js";
import { A2ALocalAgentRuntime } from "../src/modules/local-agents/a2a-runtime.js";
import { LocalAgentRuntimeRegistry } from "../src/modules/local-agents/runtime-registry.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fakeCodex(script: string): Promise<{ executable: string; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "everroom-codex-runtime-"));
  roots.push(root);
  const executable = join(root, "codex");
  await writeFile(executable, `#!/bin/sh\n${script}\n`, "utf8");
  await chmod(executable, 0o755);
  return { executable, root };
}

async function fakeClaude(script: string): Promise<{ executable: string; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "everroom-claude-runtime-"));
  roots.push(root);
  const executable = join(root, "claude");
  await writeFile(executable, `#!/bin/sh\n${script}\n`, "utf8");
  await chmod(executable, 0o755);
  return { executable, root };
}

async function fakeOpenClaw(script: string): Promise<{ executable: string; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "everroom-openclaw-runtime-"));
  roots.push(root);
  const executable = join(root, "openclaw");
  await writeFile(executable, `#!/bin/sh\n${script}\n`, "utf8");
  await chmod(executable, 0o755);
  return { executable, root };
}

describe("CodexCliAgentRuntime", () => {
  it("isolates cached runtimes by canonical workspace", async () => {
    const first = await fakeCodex("exit 0");
    const second = await fakeCodex("exit 0");
    const registry = new LocalAgentRuntimeRegistry();
    const target = (workingDirectory: string) => ({
      id: "codex:test",
      provider: "codex" as const,
      displayName: "Codex",
      executablePath: first.executable,
      workingDirectory,
      permissionProfile: "workspace_write" as const,
      card: {
        name: "Codex", description: "Local Codex", version: "1.0.0",
        supportedInterfaces: [], capabilities: { streaming: true },
        defaultInputModes: ["text/plain"], defaultOutputModes: ["text/plain"], skills: [],
      },
    });

    const firstRuntime = registry.resolve(target(first.root));
    expect(registry.resolve(target(first.root))).toBe(firstRuntime);
    expect(registry.resolve(target(second.root))).not.toBe(firstRuntime);
    await registry.dispose();
  });

  it("streams Codex through an authenticated loopback A2A JSON-RPC host", async () => {
    const { executable, root } = await fakeCodex(`
cat >/dev/null
printf '%s\\n' '{"type":"thread.started","thread_id":"thread-a2a"}'
printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"A2A result"}}'
printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":8,"output_tokens":3}}'
`);
    const runtime = new A2ALocalAgentRuntime(
      new LocalA2AHost(executable, root, "codex:test"),
      "codex:test",
    );
    const run = await runtime.start({
      runId: "run-a2a",
      sessionId: "session-a2a",
      runtimeSessionRef: null,
      prompt: "Do work",
      pageLabel: "Test",
      roomId: null,
    });
    const events: RuntimeEvent[] = [];
    for await (const event of run.events) events.push(event);

    expect(events[0]).toMatchObject({
      type: "run.started",
      payload: { transport: "a2a-jsonrpc", taskId: expect.any(String) },
    });
    expect(events).toContainEqual({ type: "runtime.session.updated", payload: { runtimeSessionRef: "thread-a2a" } });
    expect(events).toContainEqual({ type: "message.delta", payload: { delta: "A2A result" } });
    expect(events).toContainEqual({
      type: "message.completed",
      payload: { role: "assistant", content: "A2A result" },
    });
    expect(events.at(-1)?.type).toBe("run.completed");
    await runtime.dispose();
  });

  it("cancels an active Codex process through the A2A task API", async () => {
    const { executable, root } = await fakeCodex(`
cat >/dev/null
sleep 30
`);
    const runtime = new A2ALocalAgentRuntime(
      new LocalA2AHost(executable, root, "codex:test-cancel"),
      "codex:test-cancel",
    );
    const run = await runtime.start({
      runId: "run-a2a-cancel",
      sessionId: "session-a2a-cancel",
      runtimeSessionRef: null,
      prompt: "Wait for cancellation",
      pageLabel: "Test",
      roomId: null,
    });
    const events: RuntimeEvent[] = [];
    for await (const event of run.events) {
      events.push(event);
      if (event.type === "run.started") await runtime.cancel(run.runId);
    }

    expect(events[0]).toMatchObject({
      type: "run.started",
      payload: { transport: "a2a-jsonrpc", taskId: expect.any(String) },
    });
    expect(events.at(-1)?.type).toBe("run.cancelled");
    await runtime.dispose();
  });

  it("maps Codex JSONL events into typed runtime events", async () => {
    const { executable, root } = await fakeCodex(`
cat >/dev/null
printf '%s\\n' '{"type":"thread.started","thread_id":"thread-1"}'
printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"Structured result"}}'
printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":12,"output_tokens":4,"cached_input_tokens":2}}'
`);
    const runtime = new CodexCliAgentRuntime(executable, root, "codex:test");
    const run = await runtime.start({
      runId: "run-1",
      sessionId: "session-1",
      runtimeSessionRef: null,
      prompt: "Do work",
      pageLabel: "Test",
      roomId: null,
    });
    const events: RuntimeEvent[] = [];
    for await (const event of run.events) events.push(event);

    expect(events.map((event) => event.type)).toEqual([
      "run.started",
      "runtime.session.updated",
      "message.started",
      "message.delta",
      "message.completed",
      "run.completed",
    ]);
    expect(events[1]?.payload).toEqual({ runtimeSessionRef: "thread-1" });
    expect(events[4]?.payload).toEqual({ role: "assistant", content: "Structured result" });
    expect(events[5]?.payload).toEqual({ usage: { input: 12, output: 4, cacheRead: 2, cacheWrite: 0 } });
  });

  it("resumes the captured Codex thread with workspace-write native tools", async () => {
    const { executable, root } = await fakeCodex("exit 0");
    const argvPath = join(root, "argv.txt");
    await writeFile(executable, `#!/bin/sh\nprintf '%s\\n' "$@" > "${argvPath}"\ncat >/dev/null\nprintf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"Continued"}}'\nprintf '%s\\n' '{"type":"turn.completed","usage":{}}'\n`, "utf8");
    const runtime = new CodexCliAgentRuntime(executable, root, "codex:test");
    const run = await runtime.start({
      runId: "run-resume",
      sessionId: "session-1",
      runtimeSessionRef: "thread-existing",
      prompt: "Continue",
      pageLabel: "Test",
      roomId: null,
      delegationContext: {
        schemaVersion: 1,
        targetAgentId: "codex:test",
        task: { text: "Continue" },
        conversation: { messages: [], truncated: false },
        attachments: [],
        resources: { workspaceRoot: root, roomIds: [] },
        grant: { workspaceAccess: "workspace-write", approvals: "agent-reviewed", mutationAllowed: true },
        provenance: {
          source: "everroom.local-agent-delegation",
          generatedAt: "2026-08-26T00:00:01.000Z",
          digestAlgorithm: "sha256",
          digest: "a".repeat(64),
        },
      },
    });
    for await (const _event of run.events) {
      // Drain the process before reading its captured arguments.
    }

    const argv = (await readFile(argvPath, "utf8")).trim().split("\n");
    expect(argv).toEqual([
      "--sandbox", "workspace-write",
      "exec", "--json", "--skip-git-repo-check", "-C", root,
      "resume", "thread-existing", "-",
    ]);
    expect(argv).not.toContain("--approve-for-me");
    expect(argv).not.toContain("--ephemeral");
  });

  it("fails closed on malformed JSONL", async () => {
    const { executable, root } = await fakeCodex("printf '%s\\n' 'not-json'");
    const runtime = new CodexCliAgentRuntime(executable, root, "codex:test");
    const run = await runtime.start({
      runId: "run-2",
      sessionId: "session-1",
      runtimeSessionRef: null,
      prompt: "Do work",
      pageLabel: "Test",
      roomId: null,
    });
    const events: RuntimeEvent[] = [];
    for await (const event of run.events) events.push(event);
    expect(events.at(-1)?.type).toBe("run.failed");
  });

  it("writes the structured delegation context to Codex stdin", async () => {
    const { executable, root } = await fakeCodex(`
cat > "${join(tmpdir(), "unused")}" 2>/dev/null || true
printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"Done"}}'
printf '%s\\n' '{"type":"turn.completed","usage":{}}'
`);
    const stdinPath = join(root, "stdin.txt");
    await writeFile(executable, `#!/bin/sh\ncat > "${stdinPath}"\nprintf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"Done"}}'\nprintf '%s\\n' '{"type":"turn.completed","usage":{}}'\n`, "utf8");
    const runtime = new CodexCliAgentRuntime(executable, root, "codex:test");
    const run = await runtime.start({
      runId: "run-context",
      sessionId: "session-1",
      runtimeSessionRef: null,
      prompt: "fallback prompt",
      pageLabel: "Test",
      roomId: null,
      delegationContext: {
        schemaVersion: 1,
        targetAgentId: "codex:test",
        task: { text: "Review this change" },
        conversation: {
          messages: [{ role: "user", authorAgentId: null, content: "Earlier request", createdAt: "2026-08-26T00:00:00.000Z" }],
          truncated: false,
        },
        attachments: [],
        resources: { workspaceRoot: root, roomIds: [] },
        grant: { workspaceAccess: "read-only", approvals: "disabled", mutationAllowed: false },
        provenance: {
          source: "everroom.local-agent-delegation",
          generatedAt: "2026-08-26T00:00:01.000Z",
          digestAlgorithm: "sha256",
          digest: "a".repeat(64),
        },
      },
    });
    for await (const _event of run.events) {
      // Drain the run so the fake process has closed its stdin capture.
    }

    const stdin = await readFile(stdinPath, "utf8");
    expect(stdin).toContain("<everroom_delegation_context>");
    expect(stdin).toContain('"task":{"text":"Review this change"}');
    expect(stdin).toContain('"workspaceAccess":"read-only"');
    expect(stdin).not.toContain("fallback prompt");
  });
});

describe("ClaudeCliAgentRuntime", () => {
  it("maps stream-json output and captures the native session id", async () => {
    const { executable, root } = await fakeClaude(`
cat >/dev/null
printf '%s\\n' '{"type":"system","subtype":"init","session_id":"claude-thread"}'
printf '%s\\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"Claude result"}]}}'
printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"result":"Claude result","usage":{"input_tokens":5,"output_tokens":2,"cache_read_input_tokens":1}}'
`);
    const runtime = new ClaudeCliAgentRuntime(executable, root, "claude:test");
    const run = await runtime.start({
      runId: "run-claude",
      sessionId: "session-claude",
      runtimeSessionRef: null,
      prompt: "Do work",
      pageLabel: "Test",
      roomId: null,
    });
    const events: RuntimeEvent[] = [];
    for await (const event of run.events) events.push(event);

    expect(events).toContainEqual({ type: "runtime.session.updated", payload: { runtimeSessionRef: "claude-thread" } });
    expect(events).toContainEqual({ type: "message.completed", payload: { role: "assistant", content: "Claude result" } });
    expect(events.at(-1)).toEqual({
      type: "run.completed",
      payload: { usage: { input: 5, output: 2, cacheRead: 1, cacheWrite: 0 } },
    });
  });

  it("resumes an imported thread with the workspace-write permission mode", async () => {
    const { executable, root } = await fakeClaude("exit 0");
    const argvPath = join(root, "argv.txt");
    await writeFile(executable, `#!/bin/sh\nprintf '%s\\n' "$@" > "${argvPath}"\ncat >/dev/null\nprintf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"result":"Continued","usage":{}}'\n`, "utf8");
    const runtime = new ClaudeCliAgentRuntime(executable, root, "claude:test");
    const run = await runtime.start({
      runId: "run-claude-resume",
      sessionId: "session-claude",
      runtimeSessionRef: "imported-claude-thread",
      prompt: "Continue",
      pageLabel: "Test",
      roomId: null,
      delegationContext: {
        schemaVersion: 1,
        targetAgentId: "claude:test",
        task: { text: "Continue" },
        conversation: { messages: [], truncated: false },
        attachments: [],
        resources: { workspaceRoot: root, roomIds: [] },
        grant: { workspaceAccess: "workspace-write", approvals: "agent-reviewed", mutationAllowed: true },
        provenance: {
          source: "everroom.local-agent-delegation",
          generatedAt: "2026-08-26T00:00:01.000Z",
          digestAlgorithm: "sha256",
          digest: "a".repeat(64),
        },
      },
    });
    for await (const _event of run.events) {
      // Drain before reading the fake executable's captured arguments.
    }

    expect((await readFile(argvPath, "utf8")).trim().split("\n")).toEqual([
      "-p",
      "--output-format", "stream-json",
      "--verbose",
      "--permission-mode", "acceptEdits",
      "--resume", "imported-claude-thread",
    ]);
  });
});

describe("OpenClawCliAgentRuntime", () => {
  it("maps JSON output and uses a stable OpenClaw session id", async () => {
    const { executable, root } = await fakeOpenClaw(`
printf '%s\\n' '{"payloads":[{"text":"OpenClaw result"}],"meta":{"agentMeta":{"usage":{"input":7,"output":3,"cacheRead":2,"cacheWrite":1}}}}'
`);
    const runtime = new OpenClawCliAgentRuntime(executable, root, "openclaw:test");
    const run = await runtime.start({
      runId: "run-openclaw",
      sessionId: "session-openclaw",
      runtimeSessionRef: null,
      prompt: "Do work",
      pageLabel: "Test",
      roomId: null,
    });
    const events: RuntimeEvent[] = [];
    for await (const event of run.events) events.push(event);

    expect(run.runtimeSessionRef).toBe("everroom-session-openclaw");
    expect(events).toContainEqual({
      type: "runtime.session.updated",
      payload: { runtimeSessionRef: "everroom-session-openclaw" },
    });
    expect(events).toContainEqual({
      type: "message.completed",
      payload: { role: "assistant", content: "OpenClaw result" },
    });
    expect(events.at(-1)).toEqual({
      type: "run.completed",
      payload: { usage: { input: 7, output: 3, cacheRead: 2, cacheWrite: 1 } },
    });
  });

  it("resumes through the native session without exposing structured context in argv", async () => {
    const { executable, root } = await fakeOpenClaw("exit 0");
    const argvPath = join(root, "argv.txt");
    const promptPath = join(root, "prompt.txt");
    await writeFile(executable, `#!/bin/sh\nprintf '%s\\n' "$@" > "${argvPath}"\ncp "$6" "${promptPath}"\nprintf '%s\\n' '{"result":{"payloads":[{"text":"Continued"}]}}'\n`, "utf8");
    const runtime = new OpenClawCliAgentRuntime(executable, root, "openclaw:test");
    const run = await runtime.start({
      runId: "run-openclaw-resume",
      sessionId: "session-openclaw",
      runtimeSessionRef: "native-openclaw-session",
      prompt: "Continue",
      pageLabel: "Test",
      roomId: null,
    });
    for await (const _event of run.events) {
      // Drain before reading the fake executable's captured arguments.
    }

    const argv = (await readFile(argvPath, "utf8")).trim().split("\n");
    expect(argv.slice(0, 5)).toEqual([
      "--no-color", "agent", "--session-id", "native-openclaw-session", "--message-file",
    ]);
    expect(argv[5]).not.toContain("Continue");
    expect(argv.slice(-1)).toEqual(["--json"]);
    expect(await readFile(promptPath, "utf8")).toBe("Continue");
  });
});
