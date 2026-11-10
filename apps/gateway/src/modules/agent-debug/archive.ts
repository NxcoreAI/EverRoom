import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import type {
  AgentDebugArchiveInfo,
  AgentDebugEvent,
  AgentDebugRun,
} from "@nxcore/agent-contract";

/** 归档保留天数默认值（写入后即时裁剪）。 */
export const DEFAULT_AGENT_DEBUG_ARCHIVE_DAYS = 7;
/** 归档最多保留的 run 条数默认值。 */
export const DEFAULT_AGENT_DEBUG_ARCHIVE_RUNS = 2_000;
/** 归档总字节上限默认值（1 GiB）。 */
export const DEFAULT_AGENT_DEBUG_ARCHIVE_MAX_BYTES = 1024 * 1024 * 1024;

const INDEX_VERSION = 1;
const INDEX_FILE = "index.json";
const RUNS_DIR = "runs";
const DAY_MS = 24 * 60 * 60 * 1_000;

/** 磁盘归档概况对象（关闭时的占位值，供 store.archiveInfo 复用）。 */
export const DISABLED_ARCHIVE_INFO: AgentDebugArchiveInfo = Object.freeze({
  enabled: false,
  retentionDays: 0,
  runCount: 0,
  bytes: 0,
  oldestStartedAt: null,
});

export interface AgentDebugArchiveOptions {
  /** `<dataDir>/agent-debug/<source>`：index.json + runs/<YYYYMMDD>/<safeRunId>.ndjson。 */
  dir: string;
  /** 保留天数，默认 7。 */
  retentionDays?: number;
  /** 最多保留的 run 条数，默认 2000。 */
  maxRuns?: number;
  /** 归档总字节上限，默认 1 GiB。 */
  maxBytes?: number;
  now?: () => number;
  /** 归档异常（磁盘满 / 权限）的告警回调；不传则静默忽略。 */
  warn?: (message: string, error?: unknown) => void;
}

export interface AgentDebugArchiveIndexEntry {
  /** 归档时的终态 run 元数据（不含 origin / sessionTitle）。 */
  run: AgentDebugRun;
  /** 相对 `<source>` 目录的 ndjson 路径，始终使用 `/` 分隔。 */
  file: string;
  bytes: number;
}

/** index.json 结构。 */
interface ArchiveIndexFile {
  version: number;
  runs: AgentDebugArchiveIndexEntry[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 只保留 `[A-Za-z0-9._-]`，其它字符替换为 `_`，避免路径穿越。 */
export function safeAgentDebugRunId(runId: string): string {
  const safe = runId.replace(/[^A-Za-z0-9._-]/g, "_");
  return safe.length > 0 ? safe : "_";
}

/** run 开始时间对应的 UTC 日期目录（YYYYMMDD）。 */
function runDay(run: AgentDebugRun): string {
  const timestamp = Date.parse(run.startedAt);
  const date = Number.isFinite(timestamp) ? new Date(timestamp) : new Date();
  const year = date.getUTCFullYear().toString().padStart(4, "0");
  const month = (date.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = date.getUTCDate().toString().padStart(2, "0");
  return `${year}${month}${day}`;
}

/** 归档落盘时剥离来源与查询时补全字段，避免把 `live` / 会话标题写进历史。 */
function archiveRunRecord(run: AgentDebugRun, eventCount: number): AgentDebugRun {
  const { origin: _origin, sessionTitle: _sessionTitle, ...rest } = run;
  // 归档事件已按事件流物化（合并 delta 已累计），条数以实际落盘为准。
  return { ...rest, eventCount };
}

function readRunRecord(value: unknown): AgentDebugRun | null {
  if (!isRecord(value)) return null;
  if (typeof value.runId !== "string" || value.runId.length === 0) return null;
  if (typeof value.startedAt !== "string" || typeof value.status !== "string") return null;
  // 归档文件由本模块写入：结构可信，仅做最小形状校验后按契约类型使用。
  return value as unknown as AgentDebugRun;
}

function readEventRecord(value: unknown): AgentDebugEvent | null {
  if (!isRecord(value)) return null;
  if (typeof value.seq !== "number" || !Number.isFinite(value.seq)) return null;
  if (typeof value.type !== "string" || typeof value.occurredAt !== "string") return null;
  return value as unknown as AgentDebugEvent;
}

function readIndexEntry(value: unknown): AgentDebugArchiveIndexEntry | null {
  if (!isRecord(value)) return null;
  const run = readRunRecord(value.run);
  if (!run) return null;
  if (typeof value.file !== "string" || value.file.length === 0) return null;
  const bytes = typeof value.bytes === "number" && Number.isFinite(value.bytes) ? value.bytes : 0;
  return { run, file: value.file, bytes };
}

/** 把索引里的相对路径安全地解析到归档目录内（防止损坏索引指向目录外）。 */
function resolveInside(root: string, file: string): string | null {
  const absolute = resolve(root, file);
  const rootWithSep = root.endsWith(sep) ? root : `${root}${sep}`;
  return absolute.startsWith(rootWithSep) ? absolute : null;
}

/**
 * Agent 调试台磁盘归档：终态 run 的元数据 + 全部事件写入
 * `<dir>/runs/<YYYYMMDD>/<safeRunId>.ndjson`，并用 `<dir>/index.json` 建索引。
 *
 * - 构造时同步加载索引（只含元数据，不加载事件正文）；索引缺失/损坏时扫描
 *   `runs/**\/*.ndjson` 的第一行重建。
 * - 写入串行排队，先写 `.tmp` 再 `rename`（原子）；`index.json` 同样 tmp+rename。
 * - 写入后立即按「天数 / 条数 / 字节」裁剪最旧 run。
 * - 所有异常（磁盘满 / 权限 / 坏行）都被吞掉并 warn，不影响 Agent 行为与启动。
 * - `archiveRun` 幂等：同 runId 重复写入直接忽略；永不 reject。
 */
export class AgentDebugArchive {
  private readonly dir: string;
  private readonly retentionDays: number;
  private readonly maxRuns: number;
  private readonly maxBytes: number;
  private readonly now: () => number;
  private readonly warn: (message: string, error?: unknown) => void;
  private readonly entries = new Map<string, AgentDebugArchiveIndexEntry>();
  private readonly knownRunIds = new Set<string>();
  private writeChain: Promise<void> = Promise.resolve();

  constructor(options: AgentDebugArchiveOptions) {
    this.dir = resolve(options.dir);
    this.retentionDays = options.retentionDays ?? DEFAULT_AGENT_DEBUG_ARCHIVE_DAYS;
    this.maxRuns = options.maxRuns ?? DEFAULT_AGENT_DEBUG_ARCHIVE_RUNS;
    this.maxBytes = options.maxBytes ?? DEFAULT_AGENT_DEBUG_ARCHIVE_MAX_BYTES;
    this.now = options.now ?? Date.now;
    this.warn = options.warn ?? (() => {});
    for (const entry of this.loadIndex()) {
      this.entries.set(entry.run.runId, entry);
      this.knownRunIds.add(entry.run.runId);
    }
  }

  info(): AgentDebugArchiveInfo {
    let bytes = 0;
    let oldestStartedAt: number | null = null;
    for (const entry of this.entries.values()) {
      bytes += entry.bytes;
      const startedAt = Date.parse(entry.run.startedAt);
      if (Number.isFinite(startedAt) && (oldestStartedAt === null || startedAt < oldestStartedAt)) {
        oldestStartedAt = startedAt;
      }
    }
    return {
      enabled: true,
      retentionDays: this.retentionDays,
      runCount: this.entries.size,
      bytes,
      oldestStartedAt: oldestStartedAt === null ? null : new Date(oldestStartedAt).toISOString(),
    };
  }

  /** 写入一条终态 run；同 runId 重复写入直接忽略，永不 reject。 */
  archiveRun(run: AgentDebugRun, events: readonly AgentDebugEvent[]): Promise<void> {
    const runId = run.runId;
    if (this.knownRunIds.has(runId)) return Promise.resolve();
    this.knownRunIds.add(runId);
    const task = this.writeChain
      .then(() => this.writeRun(run, events))
      .catch((error: unknown) => {
        this.warn(`agent debug archive write failed: ${runId}`, error);
      });
    this.writeChain = task;
    return task;
  }

  /** 归档里的历史 run（按 startedAt 倒序，带 origin:"archive"）；可排除指定 runId。 */
  listRuns(limit: number, excludeRunIds?: ReadonlySet<string>): AgentDebugRun[] {
    return [...this.entries.values()]
      .filter((entry) => !excludeRunIds?.has(entry.run.runId))
      .sort((left, right) => Date.parse(right.run.startedAt) - Date.parse(left.run.startedAt))
      .slice(0, Math.max(0, limit))
      .map((entry) => ({ ...entry.run, origin: "archive" as const }));
  }

  getRun(runId: string): AgentDebugRun | null {
    const entry = this.entries.get(runId);
    return entry ? { ...entry.run, origin: "archive" } : null;
  }

  /**
   * 按需读取归档事件：过滤 `seq > afterSeq`、截断 `limit`；
   * `latestSeq` 为文件内最大 seq；解析失败的坏行跳过。
   */
  readEvents(
    runId: string,
    afterSeq = 0,
    limit = 1_000,
  ): { events: AgentDebugEvent[]; latestSeq: number } | null {
    const entry = this.entries.get(runId);
    if (!entry) return null;
    const absoluteFile = resolveInside(this.dir, entry.file);
    if (!absoluteFile) {
      this.warn(`agent debug archive entry points outside archive dir: ${entry.file}`);
      return null;
    }
    let content: string;
    try {
      content = readFileSync(absoluteFile, "utf8");
    } catch (error) {
      this.warn(`agent debug archive file unreadable: ${absoluteFile}`, error);
      return null;
    }
    const events: AgentDebugEvent[] = [];
    let latestSeq = 0;
    const max = Math.max(0, limit);
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        // 坏行（进程中断留下的半行 / 磁盘损坏）跳过，不影响其余事件。
        continue;
      }
      if (!isRecord(parsed) || parsed.kind !== "event") continue;
      const event = readEventRecord(parsed.event);
      if (!event) continue;
      if (event.seq > latestSeq) latestSeq = event.seq;
      if (event.seq > afterSeq && events.length < max) events.push(event);
    }
    return { events, latestSeq };
  }

  /** 等待所有排队写入完成（dispose 用）。 */
  async flush(): Promise<void> {
    await this.writeChain;
  }

  private loadIndex(): AgentDebugArchiveIndexEntry[] {
    const indexed = this.readIndexFile();
    if (indexed) return indexed;
    const rebuilt = this.rebuildIndex();
    if (rebuilt.length > 0) this.writeIndexFile(rebuilt);
    return rebuilt;
  }

  private readIndexFile(): AgentDebugArchiveIndexEntry[] | null {
    const indexPath = join(this.dir, INDEX_FILE);
    if (!existsSync(indexPath)) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(indexPath, "utf8"));
    } catch (error) {
      this.warn(`agent debug archive index unreadable, rebuilding: ${indexPath}`, error);
      return null;
    }
    if (!isRecord(parsed) || parsed.version !== INDEX_VERSION || !Array.isArray(parsed.runs)) {
      this.warn(`agent debug archive index malformed, rebuilding: ${indexPath}`);
      return null;
    }
    const entries: AgentDebugArchiveIndexEntry[] = [];
    for (const item of parsed.runs) {
      const entry = readIndexEntry(item);
      // 任意一条残缺都视为索引损坏：整体从 ndjson 首行重建，避免半坏索引丢历史。
      if (!entry) {
        this.warn(`agent debug archive index entry malformed, rebuilding: ${indexPath}`);
        return null;
      }
      entries.push(entry);
    }
    return entries;
  }

  /** 扫描 `runs/**\/*.ndjson` 的首行重建索引；单个坏文件只跳过该文件。 */
  private rebuildIndex(): AgentDebugArchiveIndexEntry[] {
    const runsRoot = join(this.dir, RUNS_DIR);
    const files: string[] = [];
    const walk = (directory: string): void => {
      let dirents;
      try {
        dirents = readdirSync(directory, { withFileTypes: true });
      } catch {
        return;
      }
      for (const dirent of dirents) {
        const full = join(directory, dirent.name);
        if (dirent.isDirectory()) walk(full);
        else if (dirent.isFile() && dirent.name.endsWith(".ndjson")) files.push(full);
      }
    };
    walk(runsRoot);

    const entries: AgentDebugArchiveIndexEntry[] = [];
    for (const file of files) {
      try {
        const content = readFileSync(file, "utf8");
        const firstLine = content.slice(0, content.indexOf("\n") >= 0 ? content.indexOf("\n") : content.length);
        const parsed = JSON.parse(firstLine) as unknown;
        if (!isRecord(parsed) || parsed.kind !== "run") continue;
        const run = readRunRecord(parsed.run);
        if (!run) continue;
        const bytes = statSync(file).size;
        entries.push({
          run,
          file: relative(this.dir, file).split(sep).join("/"),
          bytes,
        });
      } catch (error) {
        this.warn(`agent debug archive file skipped during rebuild: ${file}`, error);
      }
    }
    return entries;
  }

  private writeRun(run: AgentDebugRun, events: readonly AgentDebugEvent[]): void {
    const record = archiveRunRecord(run, events.length);
    const lines: string[] = [JSON.stringify({ kind: "run", run: record })];
    for (const event of events) lines.push(JSON.stringify({ kind: "event", event }));
    const content = `${lines.join("\n")}\n`;

    const day = runDay(record);
    const safeRunId = safeAgentDebugRunId(record.runId);
    const relativeFile = `${RUNS_DIR}/${day}/${safeRunId}.ndjson`;
    const absoluteFile = join(this.dir, RUNS_DIR, day, `${safeRunId}.ndjson`);
    mkdirSync(dirname(absoluteFile), { recursive: true });
    const tmpFile = `${absoluteFile}.tmp`;
    writeFileSync(tmpFile, content, "utf8");
    renameSync(tmpFile, absoluteFile);

    const bytes = Buffer.byteLength(content, "utf8");
    this.entries.set(record.runId, { run: record, file: relativeFile, bytes });
    this.enforceRetention();
    this.writeIndexFile([...this.entries.values()]);
  }

  /** 写入后即时裁剪：先按天数、再按条数、最后按总字节，从最旧开始删。 */
  private enforceRetention(): void {
    try {
      const cutoff = this.now() - this.retentionDays * DAY_MS;
      const ordered = [...this.entries.values()].sort(
        (left, right) => Date.parse(left.run.startedAt) - Date.parse(right.run.startedAt),
      );
      const kept: AgentDebugArchiveIndexEntry[] = [];
      for (const entry of ordered) {
        const startedAt = Date.parse(entry.run.startedAt);
        if (Number.isFinite(startedAt) && startedAt < cutoff) this.removeEntry(entry);
        else kept.push(entry);
      }
      while (kept.length > this.maxRuns) {
        const victim = kept.shift();
        if (!victim) break;
        this.removeEntry(victim);
      }
      let totalBytes = kept.reduce((sum, entry) => sum + entry.bytes, 0);
      while (totalBytes > this.maxBytes && kept.length > 0) {
        const victim = kept.shift();
        if (!victim) break;
        totalBytes -= victim.bytes;
        this.removeEntry(victim);
      }
    } catch (error) {
      this.warn("agent debug archive retention failed", error);
    }
  }

  private removeEntry(entry: AgentDebugArchiveIndexEntry): void {
    this.entries.delete(entry.run.runId);
    try {
      unlinkSync(join(this.dir, entry.file));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") this.warn(`agent debug archive file delete failed: ${entry.file}`, error);
    }
  }

  private writeIndexFile(entries: readonly AgentDebugArchiveIndexEntry[]): void {
    const index: ArchiveIndexFile = { version: INDEX_VERSION, runs: [...entries] };
    const indexPath = join(this.dir, INDEX_FILE);
    try {
      mkdirSync(this.dir, { recursive: true });
      const tmpFile = `${indexPath}.tmp`;
      writeFileSync(tmpFile, `${JSON.stringify(index)}\n`, "utf8");
      renameSync(tmpFile, indexPath);
    } catch (error) {
      this.warn(`agent debug archive index write failed: ${indexPath}`, error);
    }
  }
}
