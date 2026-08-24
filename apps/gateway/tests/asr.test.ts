import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GatewayConfig } from "../src/config.js";
import type {
  AsrProvider,
  AsrTaskSnapshot,
  SubmitAsrInput,
  SubmittedAsrTask,
} from "../src/modules/asr/types.js";
import { createServer } from "../src/server/create-server.js";

const temporaryDirectories: string[] = [];

class FakeAsrProvider implements AsrProvider {
  readonly id = "fake-asr";
  submitted: SubmitAsrInput[] = [];

  async submit(input: SubmitAsrInput): Promise<SubmittedAsrTask> {
    this.submitted.push(input);
    return { taskId: "remote-task-123" };
  }

  async getTask(taskId: string): Promise<AsrTaskSnapshot> {
    return {
      taskId,
      status: "completed",
      result: { text: "hello", speakers: [{ id: 0 }] },
    };
  }
}

async function testConfig(): Promise<GatewayConfig> {
  const dataDir = await mkdtemp(join(tmpdir(), "nxcore-asr-test-"));
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
    memory: null,
    pi: null,
    cursorCompletionPi: null,
    knowledge: null,
    ingestFilter: { enabled: false, mode: "observe", confidenceThreshold: 0.7, batchSize: 5, batchDelayMs: 0, exemptSourceKinds: [], toolsEnabled: false, maxToolCalls: 8, rulesFile: "", rulesMaxBytes: 2048, insightEnabled: false, insightIntervalMs: 3_600_000 },
    backgroundPi: null,
    asrInputDir: join(dataDir, "recordings"),
    webSearch: null,
    mcpConfigPath: join(dataDir, 'agent', 'mcp.json'),
    asr: null,
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ));
});

describe("ASR routes", () => {
  it("creates and refreshes an authenticated asynchronous transcription job", async () => {
    const config = await testConfig();
    await mkdir(config.asrInputDir, { recursive: true });
    await writeFile(join(config.asrInputDir, "meeting.wav"), Buffer.from("test-audio"));
    const provider = new FakeAsrProvider();
    const app = await createServer(config, { asrProvider: provider });
    const headers = { authorization: `Bearer ${config.authToken}` };

    const createdResponse = await app.inject({
      method: "POST",
      url: "/v1/asr/jobs",
      headers,
      payload: {
        filePath: "meeting.wav",
        languageHints: ["zh", "en"],
        diarizationEnabled: true,
        contextPrompt: "NxCore、百炼",
      },
    });
    expect(createdResponse.statusCode).toBe(202);
    const created = createdResponse.json<{ id: string; status: string }>();

    let queried: { status: string; result: unknown } | undefined;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const response = await app.inject({
        method: "GET",
        url: `/v1/asr/jobs/${created.id}`,
        headers,
      });
      queried = response.json();
      if (queried?.status === "completed") break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
    }
    await app.close();

    expect(queried).toMatchObject({
      status: "completed",
      result: { text: "hello", speakers: [{ id: 0 }] },
    });
    expect(provider.submitted).toHaveLength(1);
    expect(provider.submitted[0]).toMatchObject({
      languageHints: ["zh", "en"],
      diarizationEnabled: true,
      contextPrompt: "NxCore、百炼",
    });
  });

  it("rejects files outside the recordings directory", async () => {
    const config = await testConfig();
    const externalFile = join(config.dataDir, "outside.wav");
    await writeFile(externalFile, Buffer.from("test-audio"));
    const app = await createServer(config, { asrProvider: new FakeAsrProvider() });

    const response = await app.inject({
      method: "POST",
      url: "/v1/asr/jobs",
      headers: { authorization: `Bearer ${config.authToken}` },
      payload: { filePath: externalFile },
    });
    await app.close();

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "asr_file_outside_input_directory" });
  });

  it("reports a disabled ASR provider without exposing configuration", async () => {
    const config = await testConfig();
    const app = await createServer(config);
    const response = await app.inject({
      method: "POST",
      url: "/v1/asr/jobs",
      headers: { authorization: `Bearer ${config.authToken}` },
      payload: { filePath: "meeting.wav" },
    });
    await app.close();

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: "asr_not_configured" });
  });
});
