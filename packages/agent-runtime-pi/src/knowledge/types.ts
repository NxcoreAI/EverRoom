/** Knowledge Service（TencentDB Agent Memory Wiki 引擎）接入配置。 */
export interface KnowledgeRuntimeConfig {
  /** 服务根地址（不含 /v3 前缀）。 */
  baseUrl: string;
  serviceId: string;
  /** 当前 wiki 归属 team；读接口为 id-only 不需要，保留用于后续管理操作。 */
  teamId: string;
  /**
   * 全局默认 wiki（旧单 wiki 模式）。Room 级 wiki 模式下留空，
   * 由会话按 roomId 解析出 wikiIds；两者可并存（Room 未命中时回退默认）。
   */
  wikiId?: string;
  /** 会话可用的 wiki 集合（Room 级模式）；未提供时取 wikiId 单元素集。 */
  wikiIds?: string[];
  searchLimit: number;
  /** 单请求超时（毫秒），默认 3s。 */
  timeoutMs?: number;
}

/** 解析配置里的默认 wiki 集合：wikiIds 优先，回退到 wikiId 单元素集。 */
export function resolveDefaultWikiIds(config: KnowledgeRuntimeConfig): string[] {
  if (config.wikiIds && config.wikiIds.length > 0) return [...config.wikiIds];
  return config.wikiId ? [config.wikiId] : [];
}

/** wiki/search 命中项（BM25 + 可选图扩展）。 */
export interface KnowledgeSearchResult {
  /** 相对 wiki/ 的页面路径（即 wiki_read 的 ref）。 */
  path: string;
  title: string;
  snippet: string;
  score: number;
  type: string;
  /** 0 = BM25 直接命中，>0 = 图谱扩展跳数。 */
  hop: number;
  /** 命中来源页（hop>0 时携带）。 */
  via?: string | undefined;
}

/** wiki/page/ls 目录项。 */
export interface KnowledgePageEntry {
  id: string;
  title: string;
  type: string;
  /** 完整引用路径（wiki/<相对路径>）。 */
  path: string;
  description?: string | undefined;
}

/** wiki/page/read 单页结果；文件不存在时 not_found 为 true。 */
export interface KnowledgePageReadItem {
  ref: string;
  content?: string | undefined;
  not_found?: boolean | undefined;
}
