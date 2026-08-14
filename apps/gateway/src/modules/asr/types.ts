export type AsrJobStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export interface SubmitAsrInput {
  filePath: string;
  languageHints?: string[];
  diarizationEnabled: boolean;
  contextPrompt?: string;
}

export interface AsrSegment {
  text: string;
  beginTime: number;
  endTime: number;
  speakerId: number | null;
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
