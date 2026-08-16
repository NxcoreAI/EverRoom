export const REALITY_PROTOCOL_VERSION = 1 as const;

export type RealityEventStatus =
  | "ongoing"
  | "pending_confirmation"
  | "completed"
  | "failed"
  | "pending_sync";

export type RealityProcessingState =
  | "capturing"
  | "saving"
  | "transcribing"
  | "understanding"
  | "ready"
  | "failed";

export type RealityAudioSource = "microphone" | "system";
export type RealityCaptureDeviceKind = "desktop" | "iphone" | "apple_watch";

export interface RealityCaptureDevice {
  id: string;
  name: string;
  kind: RealityCaptureDeviceKind;
}

export interface RealityTranscriptSegment {
  id: string;
  text: string;
  beginTime: number;
  endTime: number;
  speakerId: number | null;
  version: number;
  isFinal: boolean;
  manuallyEdited: boolean;
}

export interface RealityMarker {
  id: string;
  atMs: number;
  label: string;
  createdAt: string;
}

export type RealityEventType = "MEETING" | "MEAL" | "WORK" | "REST" | "EXERCISE" | "OTHER";

export interface RealityInsights {
  source?: "mock" | "generated";
  eventType?: RealityEventType;
  currentTopic: string | null;
  summary: string | null;
  keyPoints: string[];
  decisions: string[];
  actionItems: string[];
  people: string[];
  projects: string[];
  unresolvedQuestions: string[];
}

export interface RealityEvent {
  id: string;
  title: string;
  status: RealityEventStatus;
  processingState: RealityProcessingState;
  captureDevice: RealityCaptureDevice;
  processingDevice: string;
  audioSource: RealityAudioSource;
  audioFileName: string | null;
  audioMimeType: string | null;
  durationMs: number;
  currentTopic: string | null;
  transcript: string;
  transcriptSegments: RealityTranscriptSegment[];
  transcriptEditedAt: string | null;
  insights: RealityInsights;
  markers: RealityMarker[];
  important: boolean;
  asrJobId: string | null;
  asrSource: "local" | "saas" | null;
  error: string | null;
  version: number;
  startedAt: string;
  endedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateRealityEventInput {
  id: string;
  title?: string;
  captureDevice: RealityCaptureDevice;
  audioSource: RealityAudioSource;
  audioMimeType?: string;
  contextPrompt?: string;
  startedAt?: string;
}

export interface FinishRealityCaptureInput {
  durationMs: number;
  audioFileName: string;
  endedAt?: string;
}

export interface ImportRealityEventInput {
  id: string;
  title: string;
  captureDevice: RealityCaptureDevice;
  audioSource: RealityAudioSource;
  durationMs: number;
  transcript: string;
  transcriptSegments: Array<{
    text: string;
    beginTime: number;
    endTime: number;
    speakerId: number | null;
  }>;
  insights?: RealityInsights;
  resultVersion: number;
  startedAt: string;
  endedAt: string;
}

export interface ApplyRealityAsrInput {
  jobId: string;
  source: "local" | "saas";
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  result?: {
    transcript: string;
    insights?: RealityInsights;
    segments: Array<{
      text: string;
      beginTime: number;
      endTime: number;
      speakerId: number | null;
    }>;
  } | null;
  error?: string | null;
  resultVersion?: number;
}

export interface UpdateRealityTranscriptInput {
  transcript: string;
  expectedVersion: number;
}

export interface MarkRealityEventInput {
  atMs: number;
  label?: string;
}

export interface FailRealityEventInput {
  error: string;
}

export interface RealityEventChange {
  event: RealityEvent;
  version: number;
}

export interface RealityReadyFrame {
  type: "ready";
  protocol: typeof REALITY_PROTOCOL_VERSION;
}

export interface RealityEventFrame {
  type: "event.updated";
  protocol: typeof REALITY_PROTOCOL_VERSION;
  change: RealityEventChange;
}

export type RealitySocketFrame = RealityReadyFrame | RealityEventFrame;

export function isRealitySocketFrame(value: unknown): value is RealitySocketFrame {
  if (!value || typeof value !== "object") return false;
  const frame = value as Partial<RealitySocketFrame>;
  if (frame.protocol !== REALITY_PROTOCOL_VERSION) return false;
  if (frame.type === "ready") return true;
  if (frame.type !== "event.updated" || !frame.change || typeof frame.change !== "object") return false;
  const change = frame.change as Partial<RealityEventChange>;
  return Boolean(
    change.event &&
    typeof change.event === "object" &&
    typeof change.event.id === "string" &&
    Number.isInteger(change.version),
  );
}
