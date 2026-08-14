import { openAsBlob } from "node:fs";
import { basename } from "node:path";
import { AliyunAsrError } from "./errors.js";
import type { AsrResult, AsrSegment, AsrTaskSnapshot, SubmitAsrInput, SubmittedAsrTask } from "./types.js";

interface DashScopeEnvelope<T> {
  output?: T;
  data?: T;
  request_id?: string;
  code?: string;
  message?: string;
}

interface UploadCertificate {
  oss_access_key_id: string;
  signature: string;
  policy: string;
  upload_dir: string;
  upload_host: string;
  x_oss_object_acl: string;
  x_oss_forbid_overwrite: string;
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
  fetch?: typeof globalThis.fetch;
}

const TERMINAL_STATUS = new Map<string, AsrTaskSnapshot["status"]>([
  ["SUCCEEDED", "completed"],
  ["SUCCESS", "completed"],
  ["FAILED", "failed"],
  ["CANCELED", "cancelled"],
  ["CANCELLED", "cancelled"],
]);

function requireString(
  value: unknown,
  field: keyof UploadCertificate,
): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new AliyunAsrError("get upload certificate", `missing ${field}`);
  }
  return value;
}

function parseUploadCertificate(value: unknown): UploadCertificate {
  if (!value || typeof value !== "object") {
    throw new AliyunAsrError("get upload certificate", "missing response output");
  }
  const output = value as Record<string, unknown>;
  return {
    oss_access_key_id: requireString(output.oss_access_key_id, "oss_access_key_id"),
    signature: requireString(output.signature, "signature"),
    policy: requireString(output.policy, "policy"),
    upload_dir: requireString(output.upload_dir, "upload_dir"),
    upload_host: requireString(output.upload_host, "upload_host"),
    x_oss_object_acl: requireString(output.x_oss_object_acl, "x_oss_object_acl"),
    x_oss_forbid_overwrite: requireString(
      output.x_oss_forbid_overwrite,
      "x_oss_forbid_overwrite",
    ),
  };
}

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
  private readonly fetch: typeof globalThis.fetch;

  constructor(options: AliyunAsrClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.model = options.model;
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  async submit(input: SubmitAsrInput): Promise<SubmittedAsrTask> {
    const certificate = await this.getUploadCertificate();
    const fileUrl = await this.uploadFile(input.filePath, certificate);
    const response = await this.request<TaskOutput>(
      "submit transcription",
      `${this.baseUrl}/services/audio/asr/transcription`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-DashScope-Async": "enable",
        },
        body: JSON.stringify({
          model: this.model,
          input: {
            file_urls: [fileUrl],
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
        }),
      },
    );
    const taskId = response.output?.task_id;
    if (!taskId) throw new AliyunAsrError("submit transcription", "missing task_id");
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
    const result = status === "completed"
      ? await this.downloadTranscriptionResult(response.output)
      : undefined;
    return {
      taskId,
      status,
      ...(result ? { result } : {}),
      ...(error ? { error } : {}),
    };
  }

  private async getUploadCertificate(): Promise<UploadCertificate> {
    const url = new URL(`${this.baseUrl}/uploads`);
    url.searchParams.set("action", "getPolicy");
    url.searchParams.set("model", this.model);
    const response = await this.request<UploadCertificate>(
      "get upload certificate",
      url,
    );
    return parseUploadCertificate(response.output ?? response.data);
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
      let response: Response;
      try {
        response = await this.fetch(url, { headers: { Accept: "application/json" } });
      } catch (cause) {
        throw new AliyunAsrError("download transcription", "network request failed", { cause });
      }
      if (!response.ok) {
        throw new AliyunAsrError("download transcription", `HTTP ${response.status}`);
      }
      try {
        return await response.json() as unknown;
      } catch (cause) {
        throw new AliyunAsrError("download transcription", "invalid JSON response", { cause });
      }
    }));
    return normalizeTranscriptionResults(results);
  }

  private async uploadFile(filePath: string, certificate: UploadCertificate): Promise<string> {
    const fileName = basename(filePath);
    const mimeType = contentType(fileName);
    const form = new FormData();
    form.set("OSSAccessKeyId", certificate.oss_access_key_id);
    form.set("Signature", certificate.signature);
    form.set("policy", certificate.policy);
    form.set("key", `${certificate.upload_dir}/${fileName}`);
    form.set("x-oss-object-acl", certificate.x_oss_object_acl);
    form.set("x-oss-forbid-overwrite", certificate.x_oss_forbid_overwrite);
    form.set("success_action_status", "200");
    form.set("x-oss-content-type", mimeType);
    form.set("file", await openAsBlob(filePath, { type: mimeType }), fileName);

    let response: Response;
    try {
      response = await this.fetch(certificate.upload_host, { method: "POST", body: form });
    } catch (cause) {
      throw new AliyunAsrError("upload file", "network request failed", { cause });
    }
    if (!response.ok) {
      throw new AliyunAsrError("upload file", `HTTP ${response.status}`);
    }
    return `oss://${certificate.upload_dir}/${fileName}`;
  }

  private async request<T>(
    operation: string,
    url: string | URL,
    init: RequestInit = {},
  ): Promise<DashScopeEnvelope<T>> {
    let response: Response;
    try {
      response = await this.fetch(url, {
        ...init,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: "application/json",
          ...init.headers,
        },
      });
    } catch (cause) {
      throw new AliyunAsrError(operation, "network request failed", { cause });
    }

    let body: DashScopeEnvelope<T>;
    try {
      body = await response.json() as DashScopeEnvelope<T>;
    } catch (cause) {
      throw new AliyunAsrError(operation, `invalid JSON response (HTTP ${response.status})`, { cause });
    }
    if (!response.ok || body.code) {
      throw new AliyunAsrError(
        operation,
        body.message ?? body.code ?? `HTTP ${response.status}`,
      );
    }
    return body;
  }
}
