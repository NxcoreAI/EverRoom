/**
 * 即席查询契约（connector-agent-query-refactor-plan §4.3）。
 *
 * 与同步时代的 Normalized* / SyncScope 不同：这里没有任何持久化形态，
 * 只有「一次查询的输入、命中、覆盖情况」和「一份 provider 查询档案」。
 */

/** 命中类型；决定 read 时走哪种详情 action。 */
export type HitKind = "mail" | "document" | "event" | "message" | "record";

/** Agent 可见的命中：摘要级，正文需要 connector_read 打开。 */
export interface QueryHit {
  /** 不透明引用（base64url），read 只认这个值。 */
  ref: string;
  service: string;
  connection: string;
  kind: HitKind;
  title: string;
  snippet: string;
  /** ISO 时间；provider 没给就是 null。 */
  time: string | null;
  url?: string;
}

/** 覆盖情况：让 Agent 分得清「没找到」和「没查」。 */
export interface QueryCoverage {
  searched: Array<{ service: string; connection: string; action: string }>;
  skipped: Array<{
    service: string;
    reason: "no_profile" | "no_connection" | "unsupported";
  }>;
  failed: Array<{ service: string; connection: string; message: string }>;
  /** 有跳过或失败，结果可能不完整。 */
  partial: boolean;
}

export interface QueryResult {
  query: string;
  hits: QueryHit[];
  coverage: QueryCoverage;
  /** 命中数超过返回上限。 */
  truncated: boolean;
}

export interface QueryInput {
  /** 用户问题里的概念/关键词。 */
  concept: string;
  /** Agent 扩展出的同义词/多语言词；与 concept 合并使用。 */
  terms?: string[];
  /** 限定服务；省略 = 所有已连接且支持查询的服务。 */
  services?: string[];
  /** ISO 日期或相对时间（如 90d / 12w / 6m）。 */
  since?: string;
  until?: string;
  /** 返回上限，默认 20、最大 50。 */
  limit?: number;
}

/** read 的返回：正文按上限截断，truncated 为 true 时需要分页读取。 */
export interface QueryReadResult {
  ref: string;
  service: string;
  connection: string;
  kind: HitKind;
  title?: string;
  url?: string;
  markdown: string;
  truncated: boolean;
  totalChars: number;
}

/** provider 档案产出的单次 action 调用。 */
export interface ProfileQuery {
  action: string;
  input: Record<string, unknown>;
}

/** 从 provider 原始结果里提取出的命中（还未带 service/connection/ref）。 */
export interface ProfileHit {
  kind: HitKind;
  id: string;
  title: string;
  snippet: string;
  time: string | null;
  url?: string;
}

export interface QueryContext {
  concept: string;
  terms: string[];
  limit: number;
  since?: string;
  until?: string;
}

/**
 * 查询档案：每个 provider 一个文件，描述「怎么搜、结果怎么映射、详情怎么读」。
 * 档案不做拉取、不写库、不管理游标。
 */
export interface QueryProfile {
  service: string;
  dataTypes: readonly HitKind[];
  /** 把概念 + 条件翻译成 1–2 个只读 action 调用。 */
  buildQueries(ctx: QueryContext): ProfileQuery[];
  /** 从 action 原始结果提取统一命中。 */
  parseHits(data: unknown, ctx: QueryContext): ProfileHit[];
  /** 命中 → 详情 action；返回 null 表示该 provider 只支持摘要。 */
  buildRead(ref: { kind: HitKind; id: string }): ProfileQuery | null;
  /** 详情结果 → Markdown；缺省时由 Query 服务降级为 JSON。 */
  renderRead?(
    data: unknown,
    ref: { kind: HitKind; id: string },
  ): { markdown: string; title?: string; url?: string } | null;
}

/** Query 服务依赖的窄运行时接口（测试注入 fake，生产包装 OpenConnectorHttpClient）。 */
export interface ConnectorActionRuntime {
  /** 当前租户下的连接清单（oo /v1/apps）。 */
  listConnections(): Promise<Array<{ service: string; connectionName: string; status?: string }>>;
  /** 执行单个只读 action；必须响应 AbortSignal。 */
  runAction(
    service: string,
    action: string,
    input: Record<string, unknown>,
    options: { connectionName: string; signal?: AbortSignal },
  ): Promise<unknown>;
}
