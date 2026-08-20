import type { IngestPipelines } from "../../infrastructure/database/schema.js";
import type { DocEnvelope } from "../knowledge/envelope.js";

/**
 * 统一理解引擎的类型注册表与输入契约（docs/unified-ingest-plan.md §4/§5）。
 * 引擎 = 接入面：normalize/classify/policy/fan-out/ledger 全确定性零 LLM
 * （U1）——三条链路的"理解"环节（实体抽取/L1 提炼/KS ingest）各自自理。
 */

/** 三链路开关的请求/策略形态。 */
export type Pipelines = IngestPipelines;

/** 内置数据类型：识别规则 + 默认策略（注册表与 defaults 在代码；覆盖走配置文件）。 */
export interface DataTypeDef {
  key: string;
  label: string;
  /** 扩展名 → 类型（path 路径形态的识别依据）。 */
  matchExtensions: string[];
  /** json 载荷的 jsonType → 类型。 */
  jsonType?: string;
  defaults: Pipelines;
}

/**
 * 类型注册表（开放集合：加一行 + 一个 normalizer 即新类型）。
 * 默认策略保守取向：表格/幻灯片/网页的 L1 提炼噪音大，memory 默认关。
 */
export const DATA_TYPES: DataTypeDef[] = [
  {
    key: "document",
    label: "文档",
    matchExtensions: ["md", "markdown", "txt"],
    defaults: { room: true, wiki: true, memory: true },
  },
  {
    key: "meeting-minutes",
    label: "会议纪要",
    matchExtensions: [],
    jsonType: "meeting-minutes",
    defaults: { room: true, wiki: true, memory: true },
  },
  {
    key: "perception-event",
    label: "视觉感知事件",
    matchExtensions: [],
    defaults: { room: true, wiki: true, memory: true },
  },
  {
    key: "office-doc",
    label: "Office 文档",
    matchExtensions: ["docx"],
    defaults: { room: true, wiki: true, memory: true },
  },
  {
    key: "spreadsheet",
    label: "表格",
    matchExtensions: ["xlsx", "csv"],
    defaults: { room: true, wiki: true, memory: false },
  },
  {
    key: "slides",
    label: "幻灯片",
    matchExtensions: ["pptx"],
    defaults: { room: true, wiki: true, memory: false },
  },
  {
    key: "html",
    label: "网页",
    matchExtensions: ["html", "htm"],
    defaults: { room: true, wiki: true, memory: false },
  },
  {
    key: "mail",
    label: "邮件（连接器）",
    matchExtensions: [],
    defaults: { room: true, wiki: true, memory: true },
  },
  {
    key: "calendar",
    label: "日程（连接器）",
    matchExtensions: [],
    defaults: { room: true, wiki: true, memory: true },
  },
];

export function dataTypeDef(key: string): DataTypeDef | null {
  return DATA_TYPES.find((def) => def.key === key) ?? null;
}

export function dataTypeByExtension(extension: string): DataTypeDef | null {
  const normalized = extension.trim().toLowerCase();
  return DATA_TYPES.find((def) => def.matchExtensions.includes(normalized)) ?? null;
}

export function dataTypeByJsonType(jsonType: string): DataTypeDef | null {
  return DATA_TYPES.find((def) => def.jsonType === jsonType) ?? null;
}

/** 台账的识别依据（可解释、错案可追）。 */
export type DetectedBy = "explicit" | "json-type" | "extension" | "source-kind" | "sniff";

/** 来源渠道（台账审计用）：进入系统的字节从哪个口进来的。 */
export type OriginChannel =
  | "file"
  | "paste-file"
  | "connector"
  | "reality"
  | "everroom-doc"
  | "upload";

/** 引擎接受的源形态（U8 定死：只收有家数据——本地路径或库表引用）。 */
export type RefSourceKind = "file" | "everroom-doc" | "reality-event";

export interface IngestSourceInput {
  /** 本地路径（逃生舱：明确不想入库的一次性文件；引擎只读不拷贝）。 */
  path?: string;
  /** 库表引用：uploaded_files / documents / reality_events 行。 */
  ref?: { sourceKind: RefSourceKind; sourceId: string };
}

export interface IngestInput {
  source: IngestSourceInput;
  /** 显式类型声明 > jsonType 映射 > 扩展名注册表 > 嗅探（§4 识别优先级）。 */
  dataType?: string | undefined;
  title?: string | undefined;
  occurredAt?: string | undefined;
  /** 请求级覆盖 > 配置文件（ingest-policies.json）> 类型 defaults。 */
  pipelines?: Pipelines | undefined;
  /** Room 内上传的显式归属：入口直达该 Room（知识路由 ① 层），不进全局路由。 */
  roomId?: string | undefined;
  entrySignals?: DocEnvelope["entrySignals"] | undefined;
  originChannel?: OriginChannel | undefined;
}

/**
 * 归一化终产物（§5.1）：引擎内的一切下游（台账/扇出）只消费 IngestUnit。
 * 引擎仅有的持久化指针是解析产物 + 内容指纹——原文不落引擎（U8）。
 */
export interface IngestUnit {
  ref: { sourceKind: RefSourceKind; sourceId: string; sourceVersion: number };
  dataType: string;
  detectedBy: DetectedBy;
  title: string;
  /** 归一化终产物（全文 ≤20MB；消费端按各自上限截断，U7）。 */
  markdown: string;
  occurredAt?: string;
  entrySignals?: DocEnvelope["entrySignals"];
  origin: { channel: OriginChannel };
  derived: { parsedId: string; contentHash: string };
  pipelines: Pipelines;
}

/** 引擎错误（routes 映射 HTTP 状态）。 */
export type IngestErrorCode =
  | "source_required"
  | "source_conflict"
  | "path_unreadable"
  | "ref_not_found"
  | "unsupported_type"
  | "unknown_data_type"
  | "invalid_pipelines"
  | "no_pipelines"
  | "convert_failed"
  | "empty_content"
  | "router_disabled"
  | "not_filtered"
  | "parsed_missing";

export class IngestError extends Error {
  constructor(
    message: string,
    readonly code: IngestErrorCode,
    readonly statusCode = 422,
  ) {
    super(message);
    this.name = "IngestError";
  }
}
