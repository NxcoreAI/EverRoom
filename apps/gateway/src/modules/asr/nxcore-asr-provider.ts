import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { AxiosInstance, AxiosResponse, RawAxiosRequestHeaders } from "axios";
import type { Logger } from "pino";

import { createLoggedHttpClient } from "../../http/logged-axios.js";
import { contentType } from "./aliyun-client.js";
import { NxCoreAsrError } from "./errors.js";
import type { AsrProvider, AsrResult, AsrTaskSnapshot, SubmitAsrInput, SubmittedAsrTask } from "./types.js";

/**
 * nxcore-asr 自建转写服务（FunASR 离线引擎 + 说话人识别/跨音频认人）：
 * https://code.vyitec.com/nexcore/nxcoreasr 。
 *
 * 接口是自有四步契约（非 OpenAI 兼容）：
 *   建任务(external_id 幂等建会话) → 换直传授权 → PUT 裸字节 → 确认入队；
 *   GET /v1/tasks/{tid} 轮询，done 时含 utterances（带 person_id/person_name）。
 *
 * 说话人连续性：同一 external_id 的任务落同一会话，服务端跨音频认人——
 * 桌面把 recordingId 传作 externalId，实时分段的每一段就共享说话人库。
 */
export interface NxCoreAsrProviderOptions {
  baseUrl: string;
  apiKey: string;
  http?: AxiosInstance;
  logger?: Logger;
}

interface NxCoreJobResponse {
  job_id: string;
  session_id: string;
  status: string;
}

interface NxCoreUploadAuthResponse {
  upload_url: string;
  method: string;
  headers?: Record<string, string>;
}

interface NxCoreUtterance {
  start_ms: number;
  end_ms: number;
  text: string;
  person_id: string;
  person_name: string;
  named: boolean;
}

interface NxCoreTaskResponse {
  task_id: string;
  status: string;
  error?: string | null;
  utterances?: NxCoreUtterance[];
}

// 本地盘模式的直传 PUT 与建单同服务，完成即返回；OSS 模式字节直达对象存储。
// 覆盖 logged 客户端默认 15s 超时，长音频上传需要余量。
const UPLOAD_TIMEOUT_MS = 300_000;

export class NxCoreAsrProvider implements AsrProvider {
  readonly id = "nxcore-asr";
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly http: AxiosInstance;

  constructor(options: NxCoreAsrProviderOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
    this.apiKey = options.apiKey;
    this.http = options.http ?? createLoggedHttpClient("nxcore-asr", options.logger);
  }

  async submit(input: SubmitAsrInput): Promise<SubmittedAsrTask> {
    // external_id 决定会话归组（说话人跨段连续）；缺省一次任务一个会话。
    const externalId = input.externalId?.trim() || `everroom-${randomUUID()}`;
    const job = await this.post<NxCoreJobResponse>("/v1/asr-jobs", { external_id: externalId });
    const auth = await this.post<NxCoreUploadAuthResponse>(
      `/v1/asr-jobs/${encodeURIComponent(job.job_id)}/upload-authorization`,
      {},
    );
    if (!auth.upload_url) throw new NxCoreAsrError("upload", "nxcore-asr 返回的上传地址为空");

    let audio: Buffer;
    try {
      audio = await readFile(input.filePath);
    } catch (cause) {
      throw new NxCoreAsrError("upload file", "recording file could not be read", { cause });
    }

    // 本地盘模式 upload_url 指向本服务（须带 Bearer）；OSS 模式是预签名绝对
    // 地址（绝不能附 Authorization）。按是否同源区分鉴权方式。
    const isLocal = auth.upload_url.startsWith(this.baseUrl);
    const headers: RawAxiosRequestHeaders = {
      "Content-Type": contentType(input.filePath) || "application/octet-stream",
      ...(auth.headers ?? {}),
      ...(isLocal ? { Authorization: `Bearer ${this.apiKey}` } : {}),
    };
    let uploadResponse: AxiosResponse;
    try {
      uploadResponse = await this.http.request({
        url: auth.upload_url,
        method: "PUT",
        data: audio,
        headers,
        timeout: UPLOAD_TIMEOUT_MS,
        validateStatus: () => true,
      });
    } catch (cause) {
      throw new NxCoreAsrError("upload", "audio upload request failed", { cause });
    }
    if (uploadResponse.status >= 400) {
      const message = (uploadResponse.data as { message?: unknown } | undefined)?.message;
      throw new NxCoreAsrError(
        "upload",
        `音频上传失败（${uploadResponse.status}）${typeof message === "string" ? `：${message}` : ""}`,
      );
    }

    await this.post(`/v1/asr-jobs/${encodeURIComponent(job.job_id)}/upload-complete`, {});
    return { taskId: job.job_id };
  }

  async getTask(taskId: string): Promise<AsrTaskSnapshot> {
    const task = await this.get<NxCoreTaskResponse>(`/v1/tasks/${encodeURIComponent(taskId)}`);
    if (task.status === "done") {
      const utterances = task.utterances ?? [];
      const result: AsrResult = {
        transcript: utterances.map((u) => u.text).join(""),
        segments: utterances.map((u) => ({
          text: u.text,
          beginTime: u.start_ms,
          endTime: u.end_ms,
          // 说话人 ID 是服务端稳定 person_id（字符串），跨段一致；桌面按
          // speakerId 归位说话人标签，named 时带显示名。
          speakerId: u.person_id,
          ...(u.named ? { speakerName: u.person_name } : {}),
        })),
      };
      return { taskId, status: "completed", result };
    }
    if (task.status === "failed") {
      return { taskId, status: "failed", error: task.error ?? "nxcore-asr 转写失败" };
    }
    // pending_upload / uploaded / queued / processing 均视为进行中。
    return { taskId, status: "running" };
  }

  private authHeaders(): RawAxiosRequestHeaders {
    return { Authorization: `Bearer ${this.apiKey}` };
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const response = await this.http.request<T & { message?: unknown }>({
      url: `${this.baseUrl}${path}`,
      method: "POST",
      data: body,
      headers: { ...this.authHeaders(), "Content-Type": "application/json" },
      timeout: 30_000,
      validateStatus: () => true,
    });
    return this.unwrap(response, path);
  }

  private async get<T>(path: string): Promise<T> {
    const response = await this.http.request<T & { message?: unknown }>({
      url: `${this.baseUrl}${path}`,
      method: "GET",
      headers: this.authHeaders(),
      timeout: 30_000,
      validateStatus: () => true,
    });
    return this.unwrap(response, path);
  }

  private unwrap<T>(response: AxiosResponse<T & { message?: unknown }>, path: string): T {
    if (response.status >= 400) {
      const message = response.data?.message;
      throw new NxCoreAsrError(
        "request",
        `nxcore-asr 请求失败（${response.status} ${path}）${typeof message === "string" ? `：${message}` : ""}`,
      );
    }
    return response.data;
  }
}
