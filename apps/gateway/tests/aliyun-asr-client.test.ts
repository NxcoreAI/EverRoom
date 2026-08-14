import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AliyunAsrClient } from "../src/modules/asr/aliyun-client.js";

const temporaryDirectories: string[] = [];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ));
});

describe("AliyunAsrClient", () => {
  it("uploads a local recording and submits a FileTrans task", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nxcore-aliyun-client-"));
    temporaryDirectories.push(directory);
    const filePath = join(directory, "meeting.wav");
    await writeFile(filePath, Buffer.from("test-audio"));

    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => {
      switch (fetchMock.mock.calls.length) {
        case 1:
          return jsonResponse({ data: {
            oss_access_key_id: "temporary-id",
            signature: "temporary-signature",
            policy: "temporary-policy",
            upload_dir: "dashscope-inference/a-random-directory",
            upload_host: "https://upload.example.com",
            x_oss_object_acl: "private",
            x_oss_forbid_overwrite: "true",
          } });
        case 2:
          return new Response(null, { status: 200 });
        case 3:
          return jsonResponse({ output: { task_id: "task-123", task_status: "PENDING" } });
        default:
          throw new Error("Unexpected request");
      }
    });
    const client = new AliyunAsrClient({
      apiKey: "test-api-key",
      baseUrl: "https://workspace.example.com/api/v1/",
      model: "qwen-audio-3.0-asr-flash-filetrans",
      fetch: fetchMock as typeof fetch,
    });

    await expect(client.submit({
      filePath,
      languageHints: ["zh", "en"],
      diarizationEnabled: true,
      contextPrompt: "NxCore、Everroom",
    })).resolves.toEqual({ taskId: "task-123" });

    const [policyUrl, policyInit] = fetchMock.mock.calls[0]!;
    expect(String(policyUrl)).toBe(
      "https://workspace.example.com/api/v1/uploads?action=getPolicy&model=qwen-audio-3.0-asr-flash-filetrans",
    );
    expect(new Headers(policyInit?.headers).get("Authorization")).toBe("Bearer test-api-key");

    const [uploadUrl, uploadInit] = fetchMock.mock.calls[1]!;
    expect(String(uploadUrl)).toBe("https://upload.example.com");
    expect(new Headers(uploadInit?.headers).has("Authorization")).toBe(false);
    const form = uploadInit?.body as FormData;
    expect(form.get("key")).toBe("dashscope-inference/a-random-directory/meeting.wav");
    expect(form.get("x-oss-content-type")).toBe("audio/wav");
    expect(form.get("file")).toBeInstanceOf(Blob);

    const [submitUrl, submitInit] = fetchMock.mock.calls[2]!;
    expect(String(submitUrl)).toBe("https://workspace.example.com/api/v1/services/audio/asr/transcription");
    expect(JSON.parse(String(submitInit?.body))).toEqual({
      model: "qwen-audio-3.0-asr-flash-filetrans",
      input: {
        file_urls: ["oss://dashscope-inference/a-random-directory/meeting.wav"],
        context: [{
          role: "user",
          content: [{ type: "input_text", text: "NxCore、Everroom" }],
        }],
      },
      parameters: { diarization_enabled: true, language_hints: ["zh", "en"] },
    });
  });

  it("maps a successful provider task to a completed snapshot", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => {
      if (fetchMock.mock.calls.length === 1) {
        return jsonResponse({
          output: {
            task_id: "task-123",
            task_status: "SUCCEEDED",
            results: [{ transcription_url: "https://results.example.com/result.json" }],
          },
        });
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
      });
    });
    const client = new AliyunAsrClient({
      apiKey: "test-api-key",
      baseUrl: "https://workspace.example.com/api/v1",
      model: "qwen-audio-3.0-asr-flash-filetrans",
      fetch: fetchMock as typeof fetch,
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
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://workspace.example.com/api/v1/tasks/task-123",
    );
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).has("X-DashScope-Async")).toBe(false);
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
      "https://results.example.com/result.json",
    );
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).has("Authorization")).toBe(false);
  });
});
