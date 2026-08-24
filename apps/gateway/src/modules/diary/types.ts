import type { RealityTag } from "@nxcore/reality-contract";
import type { Logger } from "pino";
import type { DiaryPayload } from "../../infrastructure/database/schema.js";

export type DiarySourceKind = "document_version" | "file" | "visual_node" | "recording" | "connector_email" | "connector_document" | "connector_calendar" | "memory";

export interface DiaryKnowledgeEntity {
  entityId: string;
  name: string;
  kind: string;
  status: string;
  role: "primary" | "mention" | "manual";
  salience: number;
  evidence?: string;
}

export interface DiarySource {
  sourceId: string;
  kind: DiarySourceKind;
  version: string;
  occurredAt: string;
  endedAt?: string;
  timeBasis?: string;
  fingerprint: string;
  evidenceSummary: string;
  assetFileId?: string;
  content?: string;
  keyPoints?: string[];
  insightTags?: RealityTag[];
  knowledgeEntities?: DiaryKnowledgeEntity[];
}

export interface DiaryGenerationInput {
  date: string;
  range: { start: string; end: string };
  timezone: string;
  sources: DiarySource[];
  readSource: (sourceId: string) => Promise<string | null>;
  runId: string;
}

export interface DiaryGenerator {
  model?: string;
  generate(input: DiaryGenerationInput): Promise<DiaryPayload>;
}

export interface DiaryMemoryProvider {
  query?: (input: { start: Date; end: Date }) => Promise<DiarySource[]>;
}

export interface DiaryServiceOptions {
  generator?: DiaryGenerator | undefined;
  memory?: DiaryMemoryProvider | undefined;
  ownerId?: string;
  workerId?: string;
  pollIntervalMs?: number;
  leaseMs?: number;
  maxAttempts?: number;
  scheduleManagedExternally?: boolean;
  now?: () => Date;
  logger?: Logger;
}
