import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AxiosInstance, AxiosRequestConfig, AxiosResponse } from "axios";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NxCoreAsrProvider } from "../src/modules/asr/nxcore-asr-provider.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function jsonResponse(body: unknown, status: number, config: AxiosRequestConfig): AxiosResponse {
  return { status, statusText: "", headers: {}, config, data: body } as AxiosResponse;
}

/** 按 nxcore-asr 四步契约路由的 mock http：记录调用并按 path 分发。 */
function createContractMock(handlers: {
  createJob?: (body: { external_id?: string }) => unknown;
  auth?: { upload_url: string; headers?: Record<string, string> };
  uploadStatus?: number;
  task?: unknown;
  taskStatus?: number;
}) {
  const calls: Array<{ method: string; url: string; data?: unknown | undefined; headers?: Record<string, unknown> | undefined }> = [];
  const request = vi.fn(async (config: AxiosRequestConfig) => {
    calls.push({
      method: config.method ?? "?",
      url: config.url ?? "",
      ...(config.data !== undefined ? { data: config.data } : {}),
      ...(config.headers !== undefined ? { headers: config.headers as Record<string, unknown> } : {}),
    });
    const url = config.url ?? "";
    const method = (config.method ?? "").toUpperCase();
    if (url.endsWith("/v1/asr-jobs") && method === "POST") {
      const body = config.data as { external_id?: string };
      return jsonResponse(handlers.createJob?.(body) ?? { job_id: "job_1", session_id: "ses_1", status: "pending_upload" }, 200, config);
    }
    if (url.includes("/upload-authorization")) {
      return jsonResponse({ job_id: "job_1", upload_url: handlers.auth?.upload_url ?? "http://127.0.0.1:8300/v1/uploads/tok", method: "PUT", headers: handlers.auth?.headers }, 200, config);
    }
    if (url.includes("/upload-complete")) {
      return jsonResponse({ job_id: "job_1", status: "queued", queued: true }, 200, config);
    }
    if (method === "PUT") {
      // 直传：本地盘 URL（/v1/uploads/…）与 OSS 预签名绝对地址都走这里。
      return jsonResponse({ job_id: "job_1", received_bytes: 8, status: "uploaded" }, handlers.uploadStatus ?? 200, config);
    }
    if (url.includes("/v1/tasks/")) {
      return jsonResponse(handlers.task ?? { task_id: "job_1", status: "processing" }, handlers.taskStatus ?? 200, config);
    }
    return jsonResponse({ message: "not mocked: " + url }, 500, config);
  });
  return { request, calls };
}

async function writeSampleAudio(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "nxcore-asr-provider-"));
  temporaryDirectories.push(directory);
  const filePath = join(directory, "meeting.wav");
  await writeFile(filePath, Buffer.from("test-audio"));
  return filePath;
}

describe("NxCoreAsrProvider", () => {
  it("submits via the four-step contract with externalId grouping and local auth", async () => {
    const filePath = await writeSampleAudio();
    let seenExternalId = "";
    const { request, calls } = createContractMock({
      createJob: (body) => {
        seenExternalId = body.external_id ?? "";
        return { job_id: "job_9", session_id: "ses_9", status: "pending_upload" };
      },
    });
    const provider = new NxCoreAsrProvider({
      baseUrl: "http://127.0.0.1:8300/",
      apiKey: "tenant-key",
      http: { request } as unknown as AxiosInstance,
    });

    const submitted = await provider.submit({ filePath, diarizationEnabled: true, externalId: "rec-42" });
    expect(submitted.taskId).toBe("job_9");
    // external_id 归组（recordingId → 会话，说话人跨段连续的基础）。
    expect(seenExternalId).toBe("rec-42");
    const upload = calls.find((c) => c.method.toUpperCase() === "PUT");
    expect(upload?.url).toBe("http://127.0.0.1:8300/v1/uploads/tok");
    // 本地盘模式：upload_url 与 baseUrl 同源，PUT 必须带租户 Bearer。
    expect(upload?.headers?.Authorization).toBe("Bearer tenant-key");
    // 四步齐全：建单 → 授权 → 直传 → 确认。
    expect(calls.map((c) => c.url).filter((u) => u.includes("upload-complete"))).toHaveLength(1);
  });

  it("swallows a trailing /v1 in baseUrl", async () => {
    const filePath = await writeSampleAudio();
    const { request, calls } = createContractMock({});
    const provider = new NxCoreAsrProvider({
      baseUrl: "http://127.0.0.1:8300/v1/",
      apiKey: "k",
      http: { request } as unknown as AxiosInstance,
    });
    await provider.submit({ filePath, diarizationEnabled: false });
    const create = calls.find((c) => c.url.endsWith("/v1/asr-jobs") && c.method.toUpperCase() === "POST");
    expect(create?.url).toBe("http://127.0.0.1:8300/v1/asr-jobs");
  });

  it("omits Bearer for presigned (OSS) upload URLs", async () => {
    const filePath = await writeSampleAudio();
    const { request, calls } = createContractMock({
      auth: { upload_url: "https://bucket.oss.example/nxcore/t/a/b?sig=x", headers: { "x-oss-meta-k": "v" } },
    });
    const provider = new NxCoreAsrProvider({
      baseUrl: "http://127.0.0.1:8300",
      apiKey: "k",
      http: { request } as unknown as AxiosInstance,
    });
    await provider.submit({ filePath, diarizationEnabled: false });
    const upload = calls.find((c) => c.method.toUpperCase() === "PUT");
    expect(upload?.headers?.Authorization).toBeUndefined();
    expect(upload?.headers?.["x-oss-meta-k"]).toBe("v");
  });

  it("maps done utterances to segments with stable speaker ids", async () => {
    const { request } = createContractMock({
      task: {
        task_id: "job_1",
        status: "done",
        utterances: [
          { start_ms: 0, end_ms: 1500, text: "你好。", person_id: "per_a", person_name: "张三", named: true },
          { start_ms: 1500, end_ms: 3000, text: "请讲。", person_id: "per_b", person_name: "未知", named: false },
        ],
      },
    });
    const provider = new NxCoreAsrProvider({
      baseUrl: "http://127.0.0.1:8300",
      apiKey: "k",
      http: { request } as unknown as AxiosInstance,
    });
    const snapshot = await provider.getTask("job_1");
    expect(snapshot.status).toBe("completed");
    const result = snapshot.result as { transcript: string; segments: Array<Record<string, unknown>> };
    expect(result.transcript).toBe("你好。请讲。");
    expect(result.segments[0]).toMatchObject({ text: "你好。", beginTime: 0, endTime: 1500, speakerId: "per_a", speakerName: "张三" });
    // 未命名说话人：带稳定 ID、不带显示名（桌面侧显示"说话人N"占位）。
    expect(result.segments[1]).toMatchObject({ text: "请讲。", speakerId: "per_b" });
    expect(result.segments[1]?.speakerName).toBeUndefined();
  });

  it("maps processing to running and failed to failed with server error", async () => {
    const running = new NxCoreAsrProvider({
      baseUrl: "http://x",
      apiKey: "k",
      http: { request: createContractMock({ task: { task_id: "j", status: "queued" } }).request } as unknown as AxiosInstance,
    });
    expect((await running.getTask("j")).status).toBe("running");

    const failed = new NxCoreAsrProvider({
      baseUrl: "http://x",
      apiKey: "k",
      http: { request: createContractMock({ task: { task_id: "j", status: "failed", error: "engine exploded" } }).request } as unknown as AxiosInstance,
    });
    const failedSnapshot = await failed.getTask("j");
    expect(failedSnapshot.status).toBe("failed");
    expect(failedSnapshot.error).toContain("engine exploded");
  });

  it("surfaces provider error messages on non-2xx", async () => {
    const filePath = await writeSampleAudio();
    const { request } = createContractMock({ uploadStatus: 413 });
    const provider = new NxCoreAsrProvider({
      baseUrl: "http://127.0.0.1:8300",
      apiKey: "k",
      http: { request } as unknown as AxiosInstance,
    });
    await expect(provider.submit({ filePath, diarizationEnabled: false })).rejects.toThrow(/413/);
  });
});

describe("createAsrProvider nxcore-asr", () => {
  it("constructs from engine discriminator", async () => {
    const { createAsrProvider } = await import("../src/modules/asr/provider-factory.js");
    const provider = createAsrProvider({ asr: { engine: "nxcore-asr", baseUrl: "http://127.0.0.1:8300", apiKey: "k" } } as never);
    expect(provider?.id).toBe("nxcore-asr");
  });
});
