/**
 * 宿主服务端口（依赖倒置缝）。
 *
 * gateway-module 通过这些结构化接口消费宿主能力（ingest / files /
 * external-calls / agent 工具运行时），宿主装配时注入实现。
 * 类型与宿主 `apps/gateway/src/modules/ingest|files|external-calls` 保持
 * 结构兼容（宿主实现类直接满足这些接口，无需适配层）。
 */

/** 来源种类（与宿主 ingest/types.ts 的 RefSourceKind 保持一致）。 */
export type RefSourceKind =
  | "file"
  | "everroom-doc"
  | "reality-event"
  | "connector-email"
  | "connector-document"
  | "connector-calendar"
  | "connector-todo"
  | "connector-record";

/** ingest 输入（宿主 IngestInput 的结构子集，宿主类直接满足）。 */
export interface IngestLikeInput {
  source: {
    ref?: { sourceKind: RefSourceKind; sourceId: string; sourceVersionId?: string };
    path?: string;
  };
  dataType?: string | undefined;
  title?: string | undefined;
  occurredAt?: string | undefined;
  originChannel?: string | undefined;
  roomId?: string | undefined;
}

/** ingest 结果（宿主 IngestResult 的结构子集）。 */
export interface IngestLikeResult {
  eventId: string;
  parsedId?: string | null;
}

/** 宿主 IngestService（类型借自宿主 ingest 模块）。 */
export type { IngestService } from "../../../apps/gateway/src/modules/ingest/service.js";
/** 宿主 FilesService（类型借自宿主 files 模块）。 */
export type { FilesService } from "../../../apps/gateway/src/modules/files/service.js";

/** 宿主 FilesService.importFile 输入（结构子集，宿主类直接满足）。 */
export interface FilesImportLikeInput {
  sourceKind: string;
  sourceKey: string;
  originalName: string;
  buffer: Buffer;
  mime?: string | undefined;
  provider?: string | undefined;
  connectionId?: string | undefined;
  localSourceId?: string | undefined;
  localItemId?: string | undefined;
  sourcePath?: string | undefined;
  sourceUri?: string | undefined;
  sourceModifiedAt?: string | undefined;
}

/** 宿主 FilesService.importFile 结果（结构子集）。 */
export interface FilesImportLikeResult {
  fileEntryId: string;
}

/** 宿主 FilesService 端口。 */
export interface FilesServiceLike {
  importFile(input: FilesImportLikeInput): Promise<FilesImportLikeResult>;
}

/** 外部调用预算服务（类型借自宿主 external-calls 模块；宿主类直接满足）。 */
export type { ExternalCallBudgetService } from "../../../apps/gateway/src/modules/external-calls/service.js";
/** 预算超出错误类（值借用：保持 instanceof 语义跨模块一致）。 */
export { ExternalCallBudgetExceededError } from "../../../apps/gateway/src/modules/external-calls/service.js";
