import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { RealityEvent, RealitySocketFrame } from "@nxcore/reality-contract";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { GatewayConfig } from "../src/config.js";
import { createServer } from "../src/server/create-server.js";

const temporaryDirectories: string[] = [];

async function testConfig(): Promise<GatewayConfig> {
  const dataDir = await mkdtemp(join(tmpdir(), "nxcore-reality-test-"));
  temporaryDirectories.push(dataDir);
  return {
    host: "127.0.0.1",
    port: 0,
    dataDir,
    databasePath: join(dataDir, "database", "gateway.sqlite"),
    migrationsDir: resolve("drizzle"),
    runtimeManifestPath: join(dataDir, "runtime", "gateway.json"),
    logLevel: "silent",
    authToken: "test-token-0123456789",
    agentRuntime: "fake",
    remoteAgent: null,
    pi: null,
    asrInputDir: join(dataDir, "recordings"),
    asr: null,
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ));
});

describe("reality routes", () => {
  it("keeps at most one active capture and recovers it after restart", async () => {
    const config = await testConfig();
    const headers = { authorization: `Bearer ${config.authToken}` };
    const firstId = randomUUID();
    const secondId = randomUUID();
    const payload = (id: string) => ({
      id,
      captureDevice: { id: "desktop-local", name: "这台 Mac", kind: "desktop" },
      audioSource: "microphone",
    });
    let app = await createServer(config);

    expect((await app.inject({ method: "POST", url: "/v1/reality/events", headers, payload: payload(firstId) })).statusCode).toBe(201);
    expect((await app.inject({ method: "POST", url: "/v1/reality/events", headers, payload: payload(secondId) })).statusCode).toBe(201);
    expect((await app.inject({ method: "GET", url: `/v1/reality/events/${firstId}`, headers })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/v1/reality/events/${secondId}`, headers })).json<RealityEvent>()).toMatchObject({
      status: "ongoing",
      processingState: "capturing",
    });
    await app.close();

    app = await createServer(config);
    expect((await app.inject({ method: "GET", url: `/v1/reality/events/${secondId}`, headers })).statusCode).toBe(404);
    await app.close();
  });

  it("discards a short capture before transcription", async () => {
    const config = await testConfig();
    await mkdir(config.asrInputDir, { recursive: true });
    const recordingPath = join(config.asrInputDir, "short.webm");
    await writeFile(recordingPath, Buffer.from("short-audio"));
    const app = await createServer(config);
    const headers = { authorization: `Bearer ${config.authToken}` };
    const eventId = randomUUID();

    expect((await app.inject({
      method: "POST",
      url: "/v1/reality/events",
      headers,
      payload: {
        id: eventId,
        captureDevice: { id: "desktop-local", name: "这台 Mac", kind: "desktop" },
        audioSource: "microphone",
      },
    })).statusCode).toBe(201);
    expect((await app.inject({
      method: "POST",
      url: `/v1/reality/events/${eventId}/capture-finished`,
      headers,
      payload: { durationMs: 8_000, audioFileName: "short.webm" },
    })).statusCode).toBe(200);

    expect((await app.inject({
      method: "DELETE",
      url: `/v1/reality/events/${eventId}`,
      headers,
    })).statusCode).toBe(204);
    expect((await app.inject({
      method: "GET",
      url: `/v1/reality/events/${eventId}`,
      headers,
    })).statusCode).toBe(404);
    await expect(access(recordingPath)).rejects.toThrow();
    await app.close();
  });

  it("persists a complete event workflow and protects manual transcript edits", async () => {
    const config = await testConfig();
    await mkdir(config.asrInputDir, { recursive: true });
    await writeFile(join(config.asrInputDir, "meeting.webm"), Buffer.from("audio-data"));
    const app = await createServer(config);
    const headers = { authorization: `Bearer ${config.authToken}` };
    const eventId = randomUUID();

    const createdResponse = await app.inject({
      method: "POST",
      url: "/v1/reality/events",
      headers,
      payload: {
        id: eventId,
        title: "产品评审",
        captureDevice: { id: "desktop-local", name: "这台 Mac", kind: "desktop" },
        audioSource: "microphone",
        audioMimeType: "audio/webm",
        contextPrompt: "EverRoom 产品评审",
      },
    });
    expect(createdResponse.statusCode).toBe(201);
    expect(createdResponse.json<RealityEvent>()).toMatchObject({
      id: eventId,
      status: "ongoing",
      processingState: "capturing",
      version: 1,
    });

    expect((await app.inject({
      method: "POST",
      url: `/v1/reality/events/${eventId}/capture-finished`,
      headers,
      payload: { durationMs: 12_000, audioFileName: "meeting.webm" },
    })).statusCode).toBe(200);

    const completed = (await app.inject({
      method: "POST",
      url: `/v1/reality/events/${eventId}/asr`,
      headers,
      payload: {
        jobId: "job-1",
        source: "saas",
        status: "completed",
        resultVersion: 10,
        result: {
          transcript: "我们决定周五发布。小王负责跟进测试。还有风险吗？",
          insights: {
            source: "mock",
            eventType: "MEETING",
            currentTopic: "产品发布评审",
            summary: "SaaS 模拟总结",
            keyPoints: ["确认周五发布"],
            decisions: [],
            actionItems: [],
            people: [],
            projects: [],
            unresolvedQuestions: [],
          },
          segments: [{ text: "我们决定周五发布。", beginTime: 0, endTime: 2_000, speakerId: 0 }],
        },
      },
    })).json<RealityEvent>();
    expect(completed.status).toBe("pending_confirmation");
    expect(completed.insights).toMatchObject({
      source: "mock",
      eventType: "MEETING",
      currentTopic: "产品发布评审",
      summary: "SaaS 模拟总结",
    });

    const edited = (await app.inject({
      method: "PATCH",
      url: `/v1/reality/events/${eventId}/transcript`,
      headers,
      payload: { transcript: "人工确认后的转写", expectedVersion: completed.version },
    })).json<RealityEvent>();
    expect(edited.transcriptEditedAt).not.toBeNull();

    const automaticUpdate = (await app.inject({
      method: "POST",
      url: "/v1/reality/asr-jobs/job-1",
      headers,
      payload: {
        jobId: "job-1",
        source: "local",
        status: "completed",
        resultVersion: 11,
        result: { transcript: "不应覆盖人工内容", segments: [] },
      },
    })).json<RealityEvent>();
    expect(automaticUpdate.transcript).toBe("人工确认后的转写");

    const marked = (await app.inject({
      method: "POST",
      url: `/v1/reality/events/${eventId}/markers`,
      headers,
      payload: { atMs: 3_000 },
    })).json<RealityEvent>();
    expect(marked.important).toBe(true);
    expect(marked.markers).toHaveLength(1);

    const audio = await app.inject({
      method: "GET",
      url: `/v1/reality/events/${eventId}/audio`,
      headers,
    });
    expect(audio.statusCode).toBe(200);
    expect(audio.rawPayload.toString()).toBe("audio-data");

    const confirmed = (await app.inject({
      method: "POST",
      url: `/v1/reality/events/${eventId}/confirm`,
      headers,
    })).json<RealityEvent>();
    expect(confirmed.status).toBe("completed");
    await app.close();
  });

  it("streams versioned event changes over the authenticated WebSocket", async () => {
    const config = await testConfig();
    const app = await createServer(config);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const headers = { authorization: `Bearer ${config.authToken}` };
    const socket = new WebSocket(`${address.replace(/^http/, "ws")}/v1/reality/stream`, {
      headers: { Authorization: `Bearer ${config.authToken}` },
    });
    const frames: RealitySocketFrame[] = [];
    await new Promise<void>((resolvePromise, reject) => {
      socket.once("open", resolvePromise);
      socket.once("error", reject);
    });
    const changed = new Promise<void>((resolvePromise, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timed out waiting for reality event")), 4_000);
      socket.on("message", (data) => {
        const frame = JSON.parse(data.toString()) as RealitySocketFrame;
        frames.push(frame);
        if (frame.type === "event.updated") {
          clearTimeout(timeout);
          resolvePromise();
        }
      });
    });

    const eventId = randomUUID();
    const created = await app.inject({
      method: "POST",
      url: "/v1/reality/events",
      headers,
      payload: {
        id: eventId,
        captureDevice: { id: "desktop-local", name: "这台 Mac", kind: "desktop" },
        audioSource: "system",
      },
    });
    expect(created.statusCode).toBe(201);
    await changed;

    expect(frames.some((frame) => frame.type === "event.updated"
      && frame.change.event.id === eventId
      && frame.change.version === 1)).toBe(true);
    socket.close();
    await app.close();
  });
});
