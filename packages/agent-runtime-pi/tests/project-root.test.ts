import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RuntimeEvent } from "@nxcore/agent-runtime";
import { loadProjectInstructions, PiAgentRuntime } from "../src/index.js";

/**
 * 项目空间工作目录（P2）：绑了目录的项目空间，本轮 run 的 cwd 换成空间根，
 * 空间里的 AGENTS.md 作为 project instructions 注入；未绑目录时行为与旧版一致。
 *
 * 断言口径取「发给模型的 system prompt」：它同时证明 cwd 解析、AGENTS.md 加载
 * 与提示注入三条链路都到位（模型侧请求体是唯一可观测的真实出口）。
 */

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  ));
});

type CapturedPrompt = { messages?: Array<{ role: string; content: unknown }> };

function sseEndpoint(captured: CapturedPrompt[]) {
  const endpoint = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => { raw += chunk.toString(); });
    request.on("end", () => {
      captured.push(JSON.parse(raw) as CapturedPrompt);
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end([
        `data: ${JSON.stringify({ id: "project-root", object: "chat.completion.chunk", model: "nxcore-test-model", choices: [{ index: 0, delta: { content: "收到" }, finish_reason: null }] })}`,
        `data: ${JSON.stringify({ id: "project-root", object: "chat.completion.chunk", model: "nxcore-test-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}`,
        "data: [DONE]",
        "",
      ].join("\n\n"));
    });
  });
  return endpoint;
}

/** 取某次请求的 system prompt 纯文本（内容块兼容字符串与数组两种形态）。 */
function systemText(captured: CapturedPrompt | undefined): string {
  const system = (captured?.messages ?? []).find((message) => message.role === "system");
  if (!system) return "";
  if (typeof system.content === "string") return system.content;
  return (system.content as Array<{ type?: string; text?: string }>)
    .map((block) => block?.text ?? "")
    .join("\n");
}

describe("PiAgentRuntime project space root", () => {
  it("uses the space root as cwd and injects its AGENTS.md", async () => {
    const captured: CapturedPrompt[] = [];
    const endpoint = sseEndpoint(captured);
    await new Promise<void>((resolvePromise) => endpoint.listen(0, "127.0.0.1", resolvePromise));
    const address = endpoint.address();
    if (!address || typeof address === "string") throw new Error("Test endpoint did not bind a TCP port");

    const dataDir = await mkdtemp(join(tmpdir(), "nxcore-pi-project-root-"));
    temporaryDirectories.push(dataDir);
    const spaceA = join(dataDir, "space-a");
    const spaceB = join(dataDir, "space-b");
    await mkdir(spaceA, { recursive: true });
    await mkdir(spaceB, { recursive: true });
    await writeFile(join(spaceA, "AGENTS.md"), "# A 空间约定\n所有产出落 outputs/。", "utf8");
    await writeFile(join(spaceB, "AGENTS.md"), "# B 空间约定\n周报用简体中文。", "utf8");

    const roots: Record<string, string | null> = { "ws-a": spaceA, "ws-b": spaceB, "ws-unbound": null };
    const runtime = new PiAgentRuntime({
      provider: "nxcore-test-provider",
      model: "nxcore-test-model",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      apiKey: "nxcore-test-key",
      api: "openai-completions",
      maxTokens: 1024,
      contextWindow: 8192,
      temperature: 0.3,
      reasoning: "off",
      sessionsDir: join(dataDir, "sessions"),
      workingDirectory: join(dataDir, "workspace"),
      agentDirectory: join(dataDir, "config"),
    }, {
      resolveProjectRoot: (input) => roots[input.workspaceId ?? ""] ?? null,
    });

    const runOnce = async (input: {
      runId: string;
      sessionId: string;
      runtimeSessionRef: string | null;
      workspaceId?: string | null;
    }): Promise<string> => {
      const run = await runtime.start({
        runId: input.runId,
        sessionId: input.sessionId,
        runtimeSessionRef: input.runtimeSessionRef,
        prompt: "整理一下这个空间",
        pageLabel: "项目空间",
        ...(input.workspaceId !== undefined ? { workspaceId: input.workspaceId } : {}),
      });
      for await (const _event of run.events as AsyncIterable<RuntimeEvent>) { /* consume */ }
      return run.runtimeSessionRef;
    };

    try {
      // 1) 空间 A：cwd = A 根，A 的 AGENTS.md 进 system prompt。
      const refA = await runOnce({ runId: "run-a", sessionId: "session-a", runtimeSessionRef: null, workspaceId: "ws-a" });
      const promptA = systemText(captured[0]);
      expect(promptA).toContain(`当前会话的项目空间目录：${spaceA}`);
      expect(promptA).toContain("A 空间约定");
      expect(promptA).not.toContain("B 空间约定");

      // 2) 同一会话换到空间 B：句柄按新 cwd 重建，历史不丢、约定换成 B。
      await runOnce({ runId: "run-b", sessionId: "session-a", runtimeSessionRef: refA, workspaceId: "ws-b" });
      const promptB = systemText(captured[1]);
      expect(promptB).toContain(`当前会话的项目空间目录：${spaceB}`);
      expect(promptB).toContain("B 空间约定");
      expect(promptB).not.toContain("A 空间约定");
      // 重建会话句柄不丢历史：第一轮的用户输入仍在上下文里。
      expect(JSON.stringify(captured[1]?.messages ?? [])).toContain("整理一下这个空间");

      // 3) 未绑目录的空间：不注入任何项目根，退回 agent 默认工作目录。
      await runOnce({ runId: "run-plain", sessionId: "session-plain", runtimeSessionRef: null, workspaceId: "ws-unbound" });
      const promptPlain = systemText(captured[2]);
      expect(promptPlain).not.toContain("当前会话的项目空间目录");
      expect(promptPlain).not.toContain("<project-instructions");
    } finally {
      await runtime.dispose();
      await new Promise<void>((resolvePromise, reject) =>
        endpoint.close((error) => error ? reject(error) : resolvePromise()));
    }
  });

  it("falls back to the agent workspace when the project root disappears", async () => {
    const captured: CapturedPrompt[] = [];
    const endpoint = sseEndpoint(captured);
    await new Promise<void>((resolvePromise) => endpoint.listen(0, "127.0.0.1", resolvePromise));
    const address = endpoint.address();
    if (!address || typeof address === "string") throw new Error("Test endpoint did not bind a TCP port");

    const dataDir = await mkdtemp(join(tmpdir(), "nxcore-pi-project-root-missing-"));
    temporaryDirectories.push(dataDir);
    const runtime = new PiAgentRuntime({
      provider: "nxcore-test-provider",
      model: "nxcore-test-model",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      apiKey: "nxcore-test-key",
      api: "openai-completions",
      maxTokens: 1024,
      contextWindow: 8192,
      temperature: 0.3,
      reasoning: "off",
      sessionsDir: join(dataDir, "sessions"),
      workingDirectory: join(dataDir, "workspace"),
      agentDirectory: join(dataDir, "config"),
    }, {
      // 空间登记过，但目录已被用户删掉（P0 §8.2：只标离线，不重建）。
      resolveProjectRoot: () => join(dataDir, "vanished-space"),
    });

    try {
      const run = await runtime.start({
        runId: "run-missing",
        sessionId: "session-missing",
        runtimeSessionRef: null,
        prompt: "你好",
        pageLabel: "项目空间",
        workspaceId: "ws-vanished",
      });
      for await (const _event of run.events) { /* consume */ }

      const prompt = systemText(captured[0]);
      expect(prompt).not.toContain("vanished-space");
      expect(prompt).not.toContain("当前会话的项目空间目录");
    } finally {
      await runtime.dispose();
      await new Promise<void>((resolvePromise, reject) =>
        endpoint.close((error) => error ? reject(error) : resolvePromise()));
    }
  });

  it("loads AGENTS.md with a size cap and tolerates missing files", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "nxcore-pi-agents-md-"));
    temporaryDirectories.push(dataDir);
    expect(await loadProjectInstructions(dataDir)).toBeNull();

    await writeFile(join(dataDir, "AGENTS.md"), "   空间约定 v1   \n", "utf8");
    expect(await loadProjectInstructions(dataDir)).toBe("空间约定 v1");

    await writeFile(join(dataDir, "AGENTS.md"), "x".repeat(20_000), "utf8");
    const capped = await loadProjectInstructions(dataDir);
    expect(capped?.length).toBeLessThan(20_000);
    expect(capped).toContain("已截断");
  });
});
