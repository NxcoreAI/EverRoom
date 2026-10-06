export type AsrJobStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export interface SubmitAsrInput {
  filePath: string;
  languageHints?: string[];
  diarizationEnabled: boolean;
  contextPrompt?: string;
  /** 会话归组键（如 recordingId）：同键任务在 nxcore-asr 侧落同一会话，
   * 说话人跨段连续识别；其他引擎忽略。 */
  externalId?: string;
}

export interface AsrSegment {
  text: string;
  beginTime: number;
  endTime: number;
  /** 云端 SaaS 与 nxcore-asr 用稳定字符串 ID，Aliyun 数字 ID。 */
  speakerId: number | string | null;
  speakerName?: string | null;
}

export interface AsrResult {
  transcript: string;
  segments: AsrSegment[];
}

export interface SubmittedAsrTask {
  taskId: string;
}

export interface AsrTaskSnapshot {
  taskId: string;
  status: Exclude<AsrJobStatus, "pending">;
  result?: unknown;
  error?: string;
}

export interface AsrProvider {
  readonly id: string;
  submit(input: SubmitAsrInput): Promise<SubmittedAsrTask>;
  getTask(taskId: string): Promise<AsrTaskSnapshot>;
}

export interface AsrJob {
  id: string;
  provider: string;
  status: AsrJobStatus;
  fileName: string;
  languageHints: string[];
  diarizationEnabled: boolean;
  contextPrompt: string;
  result: unknown | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}
