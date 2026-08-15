import type { AxiosInstance, AxiosRequestConfig, AxiosResponse } from "axios";
import type { Logger } from "pino";
import { createLoggedHttpClient } from "../../http/logged-axios.js";
import { AliyunAsrError } from "./errors.js";
import type { AsrAudioStorage } from "./audio-storage.js";
import type { AsrResult, AsrSegment, AsrTaskSnapshot, SubmitAsrInput, SubmittedAsrTask } from "./types.js";

interface DashScopeEnvelope<T> {
  output?: T;
  data?: T;
  request_id?: string;
  code?: string;
  message?: string;
}

interface TaskOutput {
  task_id?: string;
  task_status?: string;
  [key: string]: unknown;
}

interface TranscriptionResultReference {
  transcription_url?: string;
}

export interface AliyunAsrClientOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  http?: AxiosInstance;
  logger?: Logger;
  audioStorage?: AsrAudioStorage;
}

const TERMINAL_STATUS = new Map<string, AsrTaskSnapshot["status"]>([
  ["SUCCEEDED", "completed"],
  ["SUCCESS", "completed"],
  ["FAILED", "failed"],
  ["CANCELED", "cancelled"],
  ["CANCELLED", "cancelled"],
]);

function contentType(fileName: string): string {
  const extension = fileName.split(".").pop()?.toLowerCase();
  const types: Record<string, string> = {
    aac: "audio/aac",
    flac: "audio/flac",
    m4a: "audio/mp4",
    mp3: "audio/mpeg",
    mp4: "video/mp4",
    ogg: "audio/ogg",
    opus: "audio/ogg",
    wav: "audio/wav",
    webm: "audio/webm",
  };
  return (extension && types[extension]) || "application/octet-stream";
}

function finiteNumber(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeSentence(value: unknown): AsrSegment | null {
  if (!value || typeof value !== "object") return null;
  const sentence = value as Record<string, unknown>;
  const text = typeof sentence.text === "string" ? sentence.text.trim() : "";
  if (!text) return null;
  return {
    text,
    beginTime: finiteNumber(sentence.begin_time) ?? 0,
    endTime: finiteNumber(sentence.end_time) ?? 0,
    speakerId: finiteNumber(sentence.speaker_id),
  };
}

function normalizeTranscriptionResults(values: unknown[]): AsrResult {
  const transcripts: string[] = [];
  const segments: AsrSegment[] = [];
  for (const value of values) {
    if (!value || typeof value !== "object") continue;
    const root = value as Record<string, unknown>;
    const items = Array.isArray(root.transcripts) ? root.transcripts : [root];
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const transcript = item as Record<string, unknown>;
      const transcriptText = typeof transcript.transcript === "string"
        ? transcript.transcript
        : transcript.text;
      if (typeof transcriptText === "string" && transcriptText.trim()) {
        transcripts.push(transcriptText.trim());
      }
      if (Array.isArray(transcript.sentences)) {
        segments.push(...transcript.sentences
          .map(normalizeSentence)
          .filter((sentence): sentence is AsrSegment => sentence !== null));
      }
    }
  }
  if (transcripts.length === 0 && segments.length === 0) {
    throw new AliyunAsrError("download transcription", "transcription result was empty");
  }
  return {
    transcript: transcripts.join("\n") || segments.map((segment) => segment.text).join(""),
    segments,
  };
}

export class AliyunAsrClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly http: AxiosInstance;
  private readonly audioStorage: AsrAudioStorage | undefined;
  private readonly cleanupByTaskId = new Map<string, () => Promise<void>>();

  constructor(options: AliyunAsrClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.model = options.model;
    this.http = options.http ?? createLoggedHttpClient("aliyun-asr", options.logger);
    this.audioStorage = options.audioStorage;
  }

  async submit(input: SubmitAsrInput): Promise<SubmittedAsrTask> {
    if (!this.audioStorage) {
      throw new AliyunAsrError(
        "upload file",
        "own OSS is required; configure NXCORE_ASR_ALIYUN_OSS_*",
      );
    }
    const uploaded = await this.audioStorage.upload(input.filePath, contentType(input.filePath));
    let response: DashScopeEnvelope<TaskOutput>;
    try {
      response = await this.request<TaskOutput>(
        "submit transcription",
        `${this.baseUrl}/services/audio/asr/transcription`,
        {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-DashScope-Async": "enable",
        },
        data: {
          model: this.model,
          input: {
            file_urls: [uploaded.url],
            ...(input.contextPrompt?.trim()
              ? {
                  context: [{
                    role: "user",
                    content: [{
                      type: "input_text",
                      text: input.contextPrompt.trim().slice(0, 400),
                    }],
                  }],
                }
              : {}),
          },
          parameters: {
            diarization_enabled: input.diarizationEnabled,
            ...(input.languageHints?.length ? { language_hints: input.languageHints } : {}),
          },
        },
        },
      );
    } catch (error) {
      await uploaded.cleanup?.().catch(() => undefined);
      throw error;
    }
    const taskId = response.output?.task_id;
    if (!taskId) {
      await uploaded.cleanup?.().catch(() => undefined);
      throw new AliyunAsrError("submit transcription", "missing task_id");
    }
    if (uploaded.cleanup) this.cleanupByTaskId.set(taskId, uploaded.cleanup);
    return { taskId };
  }

  async getTask(taskId: string): Promise<AsrTaskSnapshot> {
    const response = await this.request<TaskOutput>(
      "query transcription",
      `${this.baseUrl}/tasks/${encodeURIComponent(taskId)}`,
      {},
    );
    if (!response.output) {
      throw new AliyunAsrError("query transcription", "missing response output");
    }
    const providerStatus = String(response.output.task_status ?? "").toUpperCase();
    const status = TERMINAL_STATUS.get(providerStatus) ?? "running";
    const error = status === "failed"
      ? response.message
        ?? (typeof response.output.message === "string" ? response.output.message : undefined)
        ?? (typeof response.output.code === "string" ? response.output.code : undefined)
        ?? "Transcription failed"
      : undefined;
    try {
      const result = status === "completed"
        ? await this.downloadTranscriptionResult(response.output)
        : undefined;
      return {
        taskId,
        status,
        ...(result ? { result } : {}),
        ...(error ? { error } : {}),
      };
    } finally {
      if (status !== "running") await this.cleanupUploadedAudio(taskId);
    }
  }

  private async downloadTranscriptionResult(output: TaskOutput): Promise<AsrResult> {
    const references = Array.isArray(output.results)
      ? output.results as TranscriptionResultReference[]
      : [];
    const urls = references
      .map((result) => result.transcription_url)
      .filter((url): url is string => typeof url === "string" && url.length > 0);
    if (urls.length === 0) {
      throw new AliyunAsrError("download transcription", "missing transcription_url");
    }

    const results = await Promise.all(urls.map(async (url) => {
      let response: AxiosResponse<unknown>;
      try {
        response = await this.http.request({
          url,
          headers: { Accept: "application/json" },
          validateStatus: () => true,
        });
      } catch (cause) {
        throw new AliyunAsrError("download transcription", "network request failed", { cause });
      }
      if (response.status >= 400) {
        throw new AliyunAsrError("download transcription", `HTTP ${response.status}`);
      }
      if (typeof response.data === "string") {
        throw new AliyunAsrError("download transcription", "invalid JSON response");
      }
      return response.data;
    }));
    return normalizeTranscriptionResults(results);
  }

  private async cleanupUploadedAudio(taskId: string): Promise<void> {
    const cleanup = this.cleanupByTaskId.get(taskId);
    if (!cleanup) return;
    this.cleanupByTaskId.delete(taskId);
    await cleanup().catch(() => undefined);
  }

  private async request<T>(
    operation: string,
    url: string | URL,
    config: AxiosRequestConfig = {},
  ): Promise<DashScopeEnvelope<T>> {
    let response: AxiosResponse<DashScopeEnvelope<T>>;
    try {
      response = await this.http.request<DashScopeEnvelope<T>>({
        url: String(url),
        ...config,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: "application/json",
          ...config.headers,
        },
        validateStatus: () => true,
      });
    } catch (cause) {
      throw new AliyunAsrError(operation, "network request failed", { cause });
    }

    const body = response.data;
    if (!body || typeof body !== "object") {
      throw new AliyunAsrError(operation, `invalid JSON response (HTTP ${response.status})`);
    }
    if (response.status >= 400 || body.code) {
      throw new AliyunAsrError(
        operation,
        body.message ?? body.code ?? `HTTP ${response.status}`,
      );
    }
    return body;
  }
}
