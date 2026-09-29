import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AxiosInstance, AxiosRequestConfig, AxiosResponse, InternalAxiosRequestConfig } from "axios";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayConfig } from "../src/config.js";
import { AliyunAsrProvider } from "../src/modules/asr/aliyun-provider.js";
import { OpenAiCompatibleAsrProvider } from "../src/modules/asr/openai-compatible-provider.js";
import { createAsrProvider } from "../src/modules/asr/provider-factory.js";

const temporaryDirectories: string[] = [];

function jsonResponse(
  body: unknown,
  status = 200,
  config: AxiosRequestConfig = {},
): AxiosResponse {
  return {
    data: body,
    status,
    statusText: status >= 400 ? "Error" : "OK",
    headers: { "content-type": "application/json" },
    config: config as InternalAxiosRequestConfig,
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ));
});

describe("OpenAiCompatibleAsrProvider", () => {
  it("posts multipart transcription with defaults, then serves the completed snapshot once", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nxcore-openai-asr-"));
    temporaryDirectories.push(directory);
    const filePath = join(directory, "meeting.wav");
    await writeFile(filePath, Buffer.from("test-audio"));

    const requestMock = vi.fn(async (config: AxiosRequestConfig) =>
      jsonResponse({ text: " 你好，欢迎使用 NxCore。 " }, 200, config)
    );
    const provider = new OpenAiCompatibleAsrProvider({
      baseUrl: "http://127.0.0.1:8000/",
      http: { request: requestMock } as unknown as AxiosInstance,
    });

    const submitted = await provider.submit({
      filePath,
      languageHints: ["zh"],
      diarizationEnabled: true,
    });
    expect(submitted.taskId).toBeTruthy();

    const [submitConfig] = requestMock.mock.calls[0]!;
    expect(submitConfig.url).toBe("http://127.0.0.1:8000/v1/audio/transcriptions");
    expect(submitConfig.method).toBe("POST");
    expect(submitConfig.timeout).toBeGreaterThan(15_000);
    expect(submitConfig.headers).not.toHaveProperty("Authorization");
    const form = submitConfig.data as FormData;
    expect(form.get("model")).toBe("whisper-1");
    expect(form.get("language")).toBe("zh");
    const file = form.get("file") as File;
    expect(file.name).toBe("meeting.wav");
    expect(file.type).toBe("audio/wav");

    const snapshot = await provider.getTask(submitted.taskId);
    expect(snapshot).toMatchObject({
      taskId: submitted.taskId,
      status: "completed",
      result: { transcript: "你好，欢迎使用 NxCore。", segments: [] },
    });
    await expect(provider.getTask(submitted.taskId)).rejects.toThrow(/snapshot is unavailable/);
  });

  it("swallows a trailing /v1 in baseUrl (OpenAI 生态习惯填完整 baseURL)", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nxcore-openai-asr-"));
    temporaryDirectories.push(directory);
    const filePath = join(directory, "meeting.wav");
    await writeFile(filePath, Buffer.from("test-audio"));

    const requestMock = vi.fn(async (config: AxiosRequestConfig) =>
      jsonResponse({ text: "ok" }, 200, config)
    );
    const provider = new OpenAiCompatibleAsrProvider({
      baseUrl: "https://api.siliconflow.cn/v1/",
      http: { request: requestMock } as unknown as AxiosInstance,
    });

    await provider.submit({ filePath, diarizationEnabled: false });
    const [submitConfig] = requestMock.mock.calls[0]!;
    // /v1 后缀被吞，不得拼成 …/v1/v1/audio/transcriptions（404）。
    expect(submitConfig.url).toBe("https://api.siliconflow.cn/v1/audio/transcriptions");
  });

  it("sends bearer auth and explicit model/language overrides", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nxcore-openai-asr-"));
    temporaryDirectories.push(directory);
    const filePath = join(directory, "meeting.m4a");
    await writeFile(filePath, Buffer.from("test-audio"));

    const requestMock = vi.fn(async (config: AxiosRequestConfig) =>
      jsonResponse({ text: "hello" }, 200, config)
    );
    const provider = new OpenAiCompatibleAsrProvider({
      baseUrl: "https://whisper.internal.example.com",
      apiKey: "self-hosted-key",
      model: "whisper-large-v3",
      language: "en",
      http: { request: requestMock } as unknown as AxiosInstance,
    });

    await provider.submit({ filePath, languageHints: ["zh"], diarizationEnabled: false });

    const [submitConfig] = requestMock.mock.calls[0]!;
    expect(submitConfig.url).toBe("https://whisper.internal.example.com/v1/audio/transcriptions");
    expect(submitConfig.headers).toMatchObject({ Authorization: "Bearer self-hosted-key" });
    const form = submitConfig.data as FormData;
    expect(form.get("model")).toBe("whisper-large-v3");
    expect(form.get("language")).toBe("en");
    expect((form.get("file") as File).type).toBe("audio/mp4");
  });

  it("maps provider and network failures to OpenAiAsrError", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nxcore-openai-asr-"));
    temporaryDirectories.push(directory);
    const filePath = join(directory, "meeting.wav");
    await writeFile(filePath, Buffer.from("test-audio"));
    const base = { baseUrl: "http://127.0.0.1:8000" };

    const failing = new OpenAiCompatibleAsrProvider({
      ...base,
      http: { request: vi.fn(async (config: AxiosRequestConfig) =>
        jsonResponse({ error: { message: "model not loaded" } }, 500, config)) } as unknown as AxiosInstance,
    });
    await expect(failing.submit({ filePath, diarizationEnabled: false }))
      .rejects.toThrow("OpenAI-compatible ASR transcribe failed: model not loaded");

    const unreachable = new OpenAiCompatibleAsrProvider({
      ...base,
      http: { request: vi.fn(async () => { throw new Error("connect ECONNREFUSED"); }) } as unknown as AxiosInstance,
    });
    await expect(unreachable.submit({ filePath, diarizationEnabled: false }))
      .rejects.toThrow("OpenAI-compatible ASR transcribe failed: network request failed");

    const malformed = new OpenAiCompatibleAsrProvider({
      ...base,
      http: { request: vi.fn(async (config: AxiosRequestConfig) => jsonResponse({}, 200, config)) } as unknown as AxiosInstance,
    });
    await expect(malformed.submit({ filePath, diarizationEnabled: false }))
      .rejects.toThrow("invalid response");
  });
});

describe("createAsrProvider", () => {
  it("dispatches by engine and defaults to aliyun", () => {
    expect(createAsrProvider({ asr: null } as unknown as GatewayConfig)).toBeNull();

    const aliyun = createAsrProvider({
      asr: { apiKey: "key", baseUrl: "https://dashscope.aliyuncs.com/api/v1", model: "m", oss: null },
    } as unknown as GatewayConfig);
    expect(aliyun).toBeInstanceOf(AliyunAsrProvider);

    const explicitAliyun = createAsrProvider({
      asr: { engine: "aliyun", apiKey: "key", baseUrl: "https://dashscope.aliyuncs.com/api/v1", model: "m", oss: null },
    } as unknown as GatewayConfig);
    expect(explicitAliyun).toBeInstanceOf(AliyunAsrProvider);

    const openai = createAsrProvider({
      asr: { engine: "openai-compatible", baseUrl: "http://127.0.0.1:8000" },
    } as unknown as GatewayConfig);
    expect(openai).toBeInstanceOf(OpenAiCompatibleAsrProvider);
  });
});
