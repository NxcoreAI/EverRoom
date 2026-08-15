import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AxiosInstance, AxiosRequestConfig, AxiosResponse, InternalAxiosRequestConfig } from "axios";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AliyunAsrClient } from "../src/modules/asr/aliyun-client.js";
import type { AsrAudioStorage } from "../src/modules/asr/audio-storage.js";

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

describe("AliyunAsrClient", () => {
  it("uploads a local recording through configured storage and submits a FileTrans task", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nxcore-aliyun-client-"));
    temporaryDirectories.push(directory);
    const filePath = join(directory, "meeting.wav");
    await writeFile(filePath, Buffer.from("test-audio"));

    const audioStorage: AsrAudioStorage = {
      upload: vi.fn(async () => ({ url: "https://upload.example.com/meeting.wav?signed=true" })),
    };
    const requestMock = vi.fn(async (config: AxiosRequestConfig) =>
      jsonResponse({ output: { task_id: "task-123", task_status: "PENDING" } }, 200, config)
    );
    const client = new AliyunAsrClient({
      apiKey: "test-api-key",
      baseUrl: "https://workspace.example.com/api/v1/",
      model: "qwen-audio-3.0-asr-flash-filetrans",
      http: { request: requestMock } as unknown as AxiosInstance,
      audioStorage,
    });

    await expect(client.submit({
      filePath,
      languageHints: ["zh", "en"],
      diarizationEnabled: true,
      contextPrompt: "NxCore、Everroom",
    })).resolves.toEqual({ taskId: "task-123" });

    expect(audioStorage.upload).toHaveBeenCalledWith(filePath, "audio/wav");
    const [submitConfig] = requestMock.mock.calls[0]!;
    expect(submitConfig.url).toBe("https://workspace.example.com/api/v1/services/audio/asr/transcription");
    expect(submitConfig.data).toEqual({
      model: "qwen-audio-3.0-asr-flash-filetrans",
      input: {
        file_urls: ["https://upload.example.com/meeting.wav?signed=true"],
        context: [{
          role: "user",
          content: [{ type: "input_text", text: "NxCore、Everroom" }],
        }],
      },
      parameters: { diarization_enabled: true, language_hints: ["zh", "en"] },
    });
  });

  it("maps a successful provider task to a completed snapshot", async () => {
    const requestMock = vi.fn(async (config: AxiosRequestConfig) => {
      if (requestMock.mock.calls.length === 1) {
        return jsonResponse({
          output: {
            task_id: "task-123",
            task_status: "SUCCEEDED",
            results: [{ transcription_url: "https://results.example.com/result.json" }],
          },
        }, 200, config);
      }
      return jsonResponse({
        transcripts: [{
          transcript: "你好，欢迎使用 NxCore。",
          sentences: [{
            begin_time: 120,
            end_time: 2140,
            text: "你好，欢迎使用 NxCore。",
            speaker_id: 0,
          }],
        }],
      }, 200, config);
    });
    const client = new AliyunAsrClient({
      apiKey: "test-api-key",
      baseUrl: "https://workspace.example.com/api/v1",
      model: "qwen-audio-3.0-asr-flash-filetrans",
      http: { request: requestMock } as unknown as AxiosInstance,
    });

    const snapshot = await client.getTask("task-123");

    expect(snapshot.status).toBe("completed");
    expect(snapshot.result).toEqual({
      transcript: "你好，欢迎使用 NxCore。",
      segments: [{
        beginTime: 120,
        endTime: 2140,
        text: "你好，欢迎使用 NxCore。",
        speakerId: 0,
      }],
    });
    expect(requestMock.mock.calls[0]?.[0].url).toBe(
      "https://workspace.example.com/api/v1/tasks/task-123",
    );
    expect(requestMock.mock.calls[0]?.[0].headers).not.toHaveProperty("X-DashScope-Async");
    expect(requestMock.mock.calls[1]?.[0].url).toBe(
      "https://results.example.com/result.json",
    );
    expect(requestMock.mock.calls[1]?.[0].headers).not.toHaveProperty("Authorization");
  });

  it("submits a signed OSS URL and removes the object after completion", async () => {
    const cleanup = vi.fn(async () => undefined);
    const audioStorage: AsrAudioStorage = {
      upload: vi.fn(async () => ({
        url: "https://private-recordings.oss-cn-beijing.aliyuncs.com/meeting.wav?signed=true",
        cleanup,
      })),
    };
    const requestMock = vi.fn(async (config: AxiosRequestConfig) => {
      if (requestMock.mock.calls.length === 1) {
        expect(config.data.input.file_urls).toEqual([
          "https://private-recordings.oss-cn-beijing.aliyuncs.com/meeting.wav?signed=true",
        ]);
        return jsonResponse({ output: { task_id: "task-oss-123" } }, 200, config);
      }
      if (requestMock.mock.calls.length === 2) {
        return jsonResponse({
          output: {
            task_id: "task-oss-123",
            task_status: "SUCCEEDED",
            results: [{ transcription_url: "https://results.example.com/result.json" }],
          },
        }, 200, config);
      }
      return jsonResponse({ transcripts: [{ transcript: "OSS works", sentences: [] }] }, 200, config);
    });
    const client = new AliyunAsrClient({
      apiKey: "test-api-key",
      baseUrl: "https://workspace.example.com/api/v1",
      model: "qwen-audio-3.0-asr-flash-filetrans",
      http: { request: requestMock } as unknown as AxiosInstance,
      audioStorage,
    });

    await client.submit({
      filePath: "/recordings/meeting.wav",
      languageHints: [],
      diarizationEnabled: false,
    });
    const snapshot = await client.getTask("task-oss-123");

    expect(snapshot.status).toBe("completed");
    expect(cleanup).toHaveBeenCalledOnce();
  });
});
