/**
 * 过滤规则文档（ingest-filter-agent-plan §4.3）：偏好化改造的配置载体。
 *
 * 两层文件（照 ingest policy 先例）：
 *   ① 工程默认层：`apps/gateway/filter-rules-defaults.md`（随仓库走）；
 *   ② 部署覆盖层：`<dataDir>/ingest/filter-rules.md`（运行环境改，PUT API 写这里）。
 *
 * 文档分两个标记段，物理隔离互不触碰：
 *   - user-preference：用户地盘，默认 = 原 prompt 6 行通用规则，仅 API/手改；
 *   - system-insight：洞察 job 每小时重写（rules-insight.ts）。
 *
 * fail-open 精神：缺文件/坏标记段回落工程默认并 warn，绝不阻塞过滤。
 */

import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Logger } from "pino";

/** 工程默认层文件名（gateway 包根，随仓库走；build 时拷进 dist）。 */
export const PROJECT_FILTER_RULES_FILE = "filter-rules-defaults.md";
/** 部署覆盖层目录名（dataDir 下）。 */
export const FILTER_RULES_DIR = "ingest";

export const USER_PREFERENCE_START = "<!-- everroom:filter:user-preference:start -->";
export const USER_PREFERENCE_END = "<!-- everroom:filter:user-preference:end -->";
export const SYSTEM_INSIGHT_START = "<!-- everroom:filter:system-insight:start -->";
export const SYSTEM_INSIGHT_END = "<!-- everroom:filter:system-insight:end -->";

/** 偏好段写入上限（PUT API 校验用）；注入时另按 rulesMaxBytes 截断。 */
export const PREFERENCE_MAX_BYTES = 4_096;

export interface FilterRulesConfig {
  /** 部署覆盖层路径。 */
  filePath: string;
  /** 单段注入截断上限（字节）。 */
  maxBytes: number;
}

export interface FilterRulesView {
  preference: string;
  insight: string;
  /** 规则文件 mtime；工程默认层时为打包文件 mtime。 */
  updatedAt: string | null;
}

/** 提取标记段内文（含首尾换行规整；缺标记段返回 null）。 */
function extractSegment(content: string, start: string, end: string): string | null {
  const startIndex = content.indexOf(start);
  if (startIndex < 0) return null;
  const endIndex = content.indexOf(end, startIndex);
  if (endIndex < 0) return null;
  return content.slice(startIndex + start.length, endIndex).trim();
}

/** 标记段内文是否夹带了任何标记行（防用户把文档结构改坏/注入跨界内容）。 */
function containsMarkerLine(segment: string): boolean {
  return segment.includes(USER_PREFERENCE_START) || segment.includes(USER_PREFERENCE_END)
    || segment.includes(SYSTEM_INSIGHT_START) || segment.includes(SYSTEM_INSIGHT_END);
}

/**
 * 工程默认层路径：从本模块目录逐级上溯找 filter-rules-defaults.md
 * （逻辑照 policy.projectPolicyDefaultsPath）。
 */
export async function projectFilterRulesPath(): Promise<string | null> {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  let directory = moduleDirectory;
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = join(directory, PROJECT_FILTER_RULES_FILE);
    try {
      await stat(candidate);
      return candidate;
    } catch {
      // 继续上溯
    }
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
  return null;
}

/**
 * 规则文档持有者：mtime 缓存 + 段提取 + 偏好段/洞察段替换写回。
 * 过滤器每次批判定前调 loadForPrompt()（stat 开销可忽略）。
 */
export class FilterRulesStore {
  private readonly config: FilterRulesConfig;
  private readonly logger: Logger;
  /** 缓存：<path, {mtimeMs, view}>；工程默认层同样缓存。 */
  private cache: { path: string; mtimeMs: number; view: FilterRulesView } | null = null;
  private readonly warnedDefaults = new Set<string>();

  constructor(config: FilterRulesConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
  }

  /** 过滤 prompt 注入用：两段内容（截断至 maxBytes）。永不抛——失败回落空段。 */
  async loadForPrompt(): Promise<{ preference: string; insight: string }> {
    const view = await this.load();
    return {
      preference: truncateUtf8Bytes(view.preference, this.config.maxBytes),
      insight: truncateUtf8Bytes(view.insight, this.config.maxBytes),
    };
  }

  /** 完整读取（API 展示用，不截断）。 */
  async load(): Promise<FilterRulesView> {
    const deploy = await this.loadLayer(this.config.filePath, "deploy");
    if (deploy) return deploy;
    const defaults = await this.loadLayer(
      (await projectFilterRulesPath()) ?? "",
      "project",
    );
    return defaults ?? { preference: "", insight: "", updatedAt: null };
  }

  private async loadLayer(
    path: string,
    layer: "deploy" | "project",
  ): Promise<FilterRulesView | null> {
    if (!path) return null;
    let mtimeMs: number;
    try {
      mtimeMs = (await stat(path)).mtimeMs;
    } catch {
      return null; // 缺文件：该层不存在
    }
    if (this.cache && this.cache.path === path && this.cache.mtimeMs === mtimeMs) {
      return this.cache.view;
    }
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch {
      return null;
    }
    const preference = extractSegment(raw, USER_PREFERENCE_START, USER_PREFERENCE_END);
    const insight = extractSegment(raw, SYSTEM_INSIGHT_START, SYSTEM_INSIGHT_END);
    if (preference === null || insight === null) {
      // 只 warn 一次：坏文档每次批判定都会走到这里
      if (!this.warnedDefaults.has(path)) {
        this.warnedDefaults.add(path);
        this.logger.warn(
          { event: "ingest.filter.rules.invalid", file: path },
          `过滤规则文档缺少标记段（preference=${preference !== null} insight=${insight !== null}），该层忽略`,
        );
      }
      return null;
    }
    const view: FilterRulesView = { preference, insight, updatedAt: new Date(mtimeMs).toISOString() };
    this.cache = { path, mtimeMs, view };
    return view;
  }

  /**
   * 只重写 user-preference 标记段（洞察段的唯一写者是洞察 job）。
   * 文件不存在时从工程默认层初始化骨架，再替换偏好段。
   */
  async updatePreference(content: string): Promise<FilterRulesView> {
    const trimmed = content.trim();
    if (!trimmed) throw new FilterRulesError("偏好内容不能为空", "empty_preference");
    if (Buffer.byteLength(trimmed, "utf8") > PREFERENCE_MAX_BYTES) {
      throw new FilterRulesError(
        `偏好内容超过上限 ${PREFERENCE_MAX_BYTES} 字节`,
        "preference_too_large",
      );
    }
    if (containsMarkerLine(trimmed)) {
      throw new FilterRulesError("偏好内容不得包含规则文档标记行", "marker_in_preference");
    }
    const current = await this.readFileForWrite();
    const next = replaceSegment(current, USER_PREFERENCE_START, USER_PREFERENCE_END, trimmed);
    await atomicWrite(this.config.filePath, next);
    this.cache = null;
    return this.load();
  }

  /** 洞察 job 写回入口（rules-insight.ts 调用）；同样只碰 system-insight 段。 */
  async updateInsight(content: string): Promise<FilterRulesView> {
    const trimmed = content.trim();
    const current = await this.readFileForWrite();
    const next = replaceSegment(current, SYSTEM_INSIGHT_START, SYSTEM_INSIGHT_END, trimmed);
    await atomicWrite(this.config.filePath, next);
    this.cache = null;
    return this.load();
  }

  /** 读取待写文件：dataDir 层缺失/损坏时用工程默认层（或内置骨架）初始化。 */
  private async readFileForWrite(): Promise<string> {
    try {
      const raw = await readFile(this.config.filePath, "utf8");
      const preference = extractSegment(raw, USER_PREFERENCE_START, USER_PREFERENCE_END);
      const insight = extractSegment(raw, SYSTEM_INSIGHT_START, SYSTEM_INSIGHT_END);
      if (preference !== null && insight !== null) return raw;
      this.logger.warn(
        { event: "ingest.filter.rules.reinit", file: this.config.filePath },
        "过滤规则文档标记段缺失，按默认骨架重建（保留可解析的段内容）",
      );
    } catch {
      // 缺文件：走初始化
    }
    const defaultsPath = await projectFilterRulesPath();
    if (defaultsPath) {
      try {
        return await readFile(defaultsPath, "utf8");
      } catch {
        // 工程默认层也读不到：走内置骨架
      }
    }
    return [
      "# Ingest 过滤规则",
      "",
      USER_PREFERENCE_START,
      USER_PREFERENCE_END,
      "",
      SYSTEM_INSIGHT_START,
      SYSTEM_INSIGHT_END,
      "",
    ].join("\n");
  }
}

/** 字符串里替换标记段（start/end 必须都在；段体为 trim 后内容 + 固定缩进换行）。 */
function replaceSegment(content: string, start: string, end: string, segment: string): string {
  const startIndex = content.indexOf(start);
  const endIndex = content.indexOf(end, startIndex >= 0 ? startIndex : 0);
  if (startIndex < 0 || endIndex < 0) {
    throw new FilterRulesError("规则文档缺少标记段，无法替换", "marker_missing");
  }
  return `${content.slice(0, startIndex)}${start}\n${segment}\n${content.slice(endIndex)}`;
}

/** 原子写：temp 文件 + rename（洞察 job 与 PUT 共用）。 */
async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temp, content, "utf8");
  await rename(temp, path);
}

/** 按字节截断（不撕裂多字节字符；截断即告警由调用方负责）。 */
function truncateUtf8Bytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const buffer = Buffer.from(text, "utf8");
  const ellipsis = Buffer.byteLength("…", "utf8"); // 3 字节，计入预算
  // 逐字节回退到 UTF-8 序列边界（首字节无 10 前缀）
  let end = Math.max(0, maxBytes - ellipsis);
  while (end > 0 && (buffer[end]! & 0b1100_0000) === 0b1000_0000) end -= 1;
  return `${buffer.subarray(0, end).toString("utf8")}…`;
}

export class FilterRulesError extends Error {
  constructor(
    message: string,
    readonly code:
      | "empty_preference"
      | "preference_too_large"
      | "marker_in_preference"
      | "marker_missing",
    readonly statusCode = 400,
  ) {
    super(message);
    this.name = "FilterRulesError";
  }
}
