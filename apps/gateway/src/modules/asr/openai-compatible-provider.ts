import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { AxiosInstance, AxiosResponse } from "axios";
import type { Logger } from "pino";
import { createLoggedHttpClient } from "../../http/logged-axios.js";
import { contentType } from "./aliyun-client.js";
import { OpenAiAsrError } from "./errors.js";
import type { AsrProvider, AsrResult, AsrTaskSnapshot, SubmitAsrInput, SubmittedAsrTask } from "./types.js";

const DEFAULT_MODEL = "whisper-1";
// 长录音的本地转写可能接近实时时长，覆盖 logged 客户端默认 15s 超时。
const REQUEST_TIMEOUT_MS = 600_000;

export interface OpenAiCompatibleAsrProviderOptions {
  baseUrl: string;
  apiKey?: string;
  model?: string;
  language?: string;
  http?: AxiosInstance;
  logger?: Logger;
}

interface TranscriptionResponse {
  text?: unknown;
  error?: { message?: unknown } | null;
  message?: unknown;
}

function providerError(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  // 兼容两种错误形状：OpenAI 的 error.message 与国内兼容服务（如 SiliconFlow）
  // 的顶层 {code, message}——否则用户只看到干巴巴的 HTTP 400，无从自查。
  const candidate = (body as TranscriptionResponse).error?.message ?? (body as TranscriptionResponse).message;
  return typeof candidate === "string" && candidate.trim() ? candidate.trim() : null;
}

/**
 * 自建 OpenAI 兼容转写服务（faster-whisper / whisper.cpp server 等）。
 * 转写接口是同步的，但 AsrProvider 面向异步任务模型：submit() 在后台执行
 * 整个转写并把终态快照暂存内存，服务层提交后轮询 getTask() 取走。
 */
export class OpenAiCompatibleAsrProvider implements AsrProvider {
  readonly id = "openai-compatible";
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly model: string;
  private readonly language: string | undefined;
  private readonly http: AxiosInstance;
  private readonly snapshots = new Map<string, AsrTaskSnapshot>();

  constructor(options: OpenAiCompatibleAsrProviderOptions) {
    // 去尾斜杠 + 吞掉用户顺手带的 /v1 后缀（OpenAI 生态习惯把 baseURL 填成
    // 含 /v1 的完整形式），下方统一拼 /v1/audio/transcriptions——两种填法同权，
    // 否则 …/v1/v1/… 直接 404。
    this.baseUrl = options.baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
    this.apiKey = options.apiKey;
    this.model = options.model ?? DEFAULT_MODEL;
    this.language = options.language;
    this.http = options.http ?? createLoggedHttpClient("openai-asr", options.logger);
  }

  async submit(input: SubmitAsrInput): Promise<SubmittedAsrTask> {
    let audio: Buffer;
    try {
      audio = await readFile(input.filePath);
    } catch (cause) {
      throw new OpenAiAsrError("upload file", "recording file could not be read", { cause });
    }
    const form = new FormData();
    // 读进来的 Buffer 底层可能是 SharedArrayBuffer（BlobPart 不收），复制成纯 Uint8Array。
    form.append("file", new Blob([new Uint8Array(audio)], { type: contentType(input.filePath) }), basename(input.filePath));
    form.append("model", this.model);
    // 显式 language 优先；请求携带的语言提示（桌面转写多为单语）作回退。
    const language = this.language ?? input.languageHints?.[0];
    if (language) form.append("language", language);

    let response: AxiosResponse<TranscriptionResponse>;
    try {
      response = await this.http.request<TranscriptionResponse>({
        url: `${this.baseUrl}/v1/audio/transcriptions`,
        method: "POST",
        data: form,
        timeout: REQUEST_TIMEOUT_MS,
        headers: {
          Accept: "application/json",
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        validateStatus: () => true,
      });
    } catch (cause) {
      throw new OpenAiAsrError("transcribe", "network request failed", { cause });
    }
    const body = response.data;
    if (response.status >= 400) {
      throw new OpenAiAsrError("transcribe", providerError(body) ?? `HTTP ${response.status}`);
    }
    if (!body || typeof body !== "object" || typeof body.text !== "string") {
      throw new OpenAiAsrError("transcribe", `invalid response (HTTP ${response.status})`);
    }
    const result: AsrResult = { transcript: body.text.trim(), segments: [] };
    const taskId = randomUUID();
    this.snapshots.set(taskId, { taskId, status: "completed", result });
    return { taskId };
  }

  async getTask(taskId: string): Promise<AsrTaskSnapshot> {
    const snapshot = this.snapshots.get(taskId);
    if (!snapshot) {
      throw new OpenAiAsrError("query transcription", "task snapshot is unavailable (gateway may have restarted)");
    }
    this.snapshots.delete(taskId);
    return snapshot;
  }
}
