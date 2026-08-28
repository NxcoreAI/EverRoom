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
  /** 单次来源采集的期限；MemoryCore 等外部依赖卡死时运行不会永久停在 running。 */
  collectTimeoutMs?: number;
  /** 单次 Agent 生成的期限（服务层兜底；生成器自身有更早的会话级超时）。 */
  maxRunMs?: number;
  /** 自动刷新（感知完成/来源变化触发的重生成）的每日期冷却。 */
  autoRefreshCooldownMs?: number;
  /** 稳态巡检（markChangedDaysStale）里单个日子的最小复查间隔。 */
  staleCheckIntervalMs?: number;
  now?: () => Date;
  logger?: Logger;
}
