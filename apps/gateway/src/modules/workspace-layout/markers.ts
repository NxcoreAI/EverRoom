import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 项目空间 manifest 契约。
 *
 * 一个空间**只有这一个标记文件**：它同时声明"我是项目空间"和"我的内部布局在哪"。
 * 设计见 docs/project-space-layout-plan.zh-CN.md §4 与 §16（v2 布局）。
 *
 * v2 起标记从空间根移进 `.everoffice/space.json`：空间根就是用户的资料库，
 * 根上不再出现任何本应用的文件——把一个"已经存满资料"的目录直接设成空间也不会冲突。
 *
 * 纪律：
 * - 原子写（tmp + rename），不允许半截 JSON 落盘；
 * - 只加字段不改语义；更高版本号一律只读降级，不写不改；
 * - v1 标记（根上 `space.everoffice` + `Library/` 布局）继续可读，由 service 迁移到 v2；
 * - `integrity` 只做"被手改过"的提示，校验失败不影响解析。
 */

/** v1 标记文件名（落在空间根上）。v2 起只在兼容读取与迁移时出现。 */
export const SPACE_MARKER_FILENAME = "space.everoffice";
/** v1 标记后缀：判定空间时兼容用户改过名的情况。 */
export const SPACE_MARKER_SUFFIX = ".everoffice";

/**
 * 应用元数据目录（v2）：空间里**唯一**保留的隐藏目录，收纳标记、记忆、回收站、
 * 对象快照与派生缓存。资料库视图里看不到它。
 */
export const META_DIRNAME = ".everoffice";
/** v2 标记文件名（在元数据目录内）。 */
export const SPACE_MARKER_BASENAME = "space.json";
/** v2 标记相对空间根的路径：`.everoffice/space.json`。 */
export const SPACE_MARKER_REL_PATH = `${META_DIRNAME}/${SPACE_MARKER_BASENAME}`;
/** Agent 过程缓存目录（v2）：与元数据分开，用户能从访达里整目录清掉。 */
export const SCRATCH_DIRNAME = ".tmp";

/** 当前契约版本（2 = 根即资料库；1 = 旧版 `Library/` 布局，只读兼容 + 自动迁移）。 */
export const CURRENT_MARKER_VERSION = 2;
/** 当前布局版本（写进标记的 `layoutVersion`）。 */
export const CURRENT_LAYOUT_VERSION = 2;

export type SpaceRootMode = "managed" | "external";

/**
 * 空间内角色目录映射（**全部相对空间根**，POSIX 分隔符；空串 = 空间根本身）。
 *
 * v2 语义（方案 §16）：
 * - `library` 为空串：资料库根＝空间根，新资料/产物直接平铺在根上；
 * - `meta`：应用私有元数据（标记/记忆/回收站/对象快照/派生缓存），资料库视图隐藏；
 * - `tmp`：Agent 过程缓存，独立于 `meta`，可整目录清掉。
 *
 * 读 v1 标记时会被翻译成本结构（`library: "Library"`、`meta: ""` 等），
 * 所以下游（pathsOf / 落盘 / 对账 / GC）不需要区分两代布局。
 */
export interface SpaceLayoutMap {
  library: string;
  meta: string;
  memory: string;
  conversation: string;
  trash: string;
  /** 内容寻址快照（导入去重 + 版本历史），默认 `meta/objects`。 */
  objects: string;
  /** 可重建派生数据（解析 md、缩略图、切片），默认 `meta/cache/derived`。 */
  derived: string;
  /** Agent 过程缓存（scratch），默认 `<空间根>/.tmp`。 */
  tmp: string;
}

/** 缓存 GC 策略（写在标记里，别的工具读到也能照此清理）。 */
export interface SpaceCacheGcPolicy {
  tmpMaxAgeHours: number;
  derivedMaxAgeDays: number;
  objectsMaxAgeDays: number;
  maxBytes: number;
}

export interface SpaceMarker {
  $everoffice: number;
  kind: "space";
  spaceId: string;
  name: string;
  slug: string;
  layoutVersion: number;
  rootMode: SpaceRootMode;
  createdAt: string;
  createdBy: { app: string; version: string; platform: string };
  layout: SpaceLayoutMap;
  roles: {
    library: { writable: boolean; retention: string };
    memory: { writable: boolean; retention: string };
    cache: { writable: boolean; retention: string; gc: SpaceCacheGcPolicy };
    trash: { retention: string };
  };
  flags: { conversationMirror: boolean; memoryLocal: boolean };
  integrity?: string;
}

function metaPath(...segments: string[]): string {
  return [META_DIRNAME, ...segments].join("/");
}

/** 默认布局（v2：根即资料库，`.everoffice/` 收元数据，`.tmp/` 收过程缓存）。 */
export function defaultSpaceLayout(): SpaceLayoutMap {
  return {
    library: "",
    meta: META_DIRNAME,
    memory: metaPath("memory"),
    conversation: metaPath("conversation"),
    trash: metaPath("trash"),
    objects: metaPath("objects"),
    derived: metaPath("cache", "derived"),
    tmp: SCRATCH_DIRNAME,
  };
}

export function defaultCacheGcPolicy(): SpaceCacheGcPolicy {
  return {
    tmpMaxAgeHours: 24,
    derivedMaxAgeDays: 90,
    objectsMaxAgeDays: 30,
    // 2 GiB
    maxBytes: 2_147_483_648,
  };
}

export type SpaceMarkerReadResult =
  | { status: "ok"; marker: SpaceMarker; markerPath: string; readonly: boolean }
  | { status: "missing" }
  | { status: "invalid"; markerPath: string; reason: string }
  | { status: "unsupported"; markerPath: string; version: number };

/** 标记文件里允许出现的 kind；目前只有 space。 */
const KNOWN_KINDS = new Set(["space"]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * v1 布局（`Library/` + `Memory/` + `Conversation/` + `.trash/` + `Library/.cache/*`）
 * 翻译成 v2 扁平结构：未迁移的空间仍能被读、被统计、被展示，只是还没有搬家。
 */
export function legacyLayoutToV2(raw: unknown): SpaceLayoutMap {
  const record = asRecord(raw) ?? {};
  const pick = (key: string, fallback: string): string => nonEmptyString(record[key]) ?? fallback;
  const library = pick("library", "Library");
  const cache = pick("cache", `${library}/.cache`);
  const parts = asRecord(record.cacheParts) ?? {};
  const part = (key: string, fallback: string): string => `${cache}/${nonEmptyString(parts[key]) ?? fallback}`;
  return {
    library,
    // v1 没有元数据目录：标记与各角色目录都在空间根上，`meta` 留空表示"没有专用 meta"。
    meta: "",
    memory: pick("memory", "Memory"),
    conversation: pick("conversation", "Conversation"),
    trash: pick("trash", ".trash"),
    objects: part("objects", "objects"),
    derived: part("derived", "derived"),
    tmp: part("tmp", "tmp"),
  };
}

function layoutFrom(raw: unknown, version: number): SpaceLayoutMap {
  if (version < CURRENT_MARKER_VERSION) return legacyLayoutToV2(raw);
  const base = defaultSpaceLayout();
  const record = asRecord(raw);
  if (!record) return base;
  // `library` 允许是空串（根即资料库），所以这里不能用 nonEmptyString 兜底。
  const path = (key: keyof SpaceLayoutMap): string => {
    const value = record[key];
    if (typeof value !== "string") return base[key];
    if (key === "library") return value.trim();
    return value.trim() || base[key];
  };
  return {
    library: path("library"),
    meta: path("meta"),
    memory: path("memory"),
    conversation: path("conversation"),
    trash: path("trash"),
    objects: path("objects"),
    derived: path("derived"),
    tmp: path("tmp"),
  };
}

function rolesFrom(raw: unknown): SpaceMarker["roles"] {
  const record = asRecord(raw);
  const cache = asRecord(record?.cache);
  const gc = asRecord(cache?.gc);
  const policy = defaultCacheGcPolicy();
  const numberOr = (value: unknown, fallback: number): number =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
  const retention = (value: unknown, fallback: string): string => nonEmptyString(value) ?? fallback;
  const writable = (value: unknown, fallback: boolean): boolean =>
    typeof value === "boolean" ? value : fallback;
  return {
    library: {
      writable: writable(asRecord(record?.library)?.writable, true),
      retention: retention(asRecord(record?.library)?.retention, "keep"),
    },
    memory: {
      writable: writable(asRecord(record?.memory)?.writable, true),
      retention: retention(asRecord(record?.memory)?.retention, "keep"),
    },
    cache: {
      writable: writable(cache?.writable, true),
      retention: retention(cache?.retention, "ephemeral"),
      gc: {
        tmpMaxAgeHours: numberOr(gc?.tmpMaxAgeHours, policy.tmpMaxAgeHours),
        derivedMaxAgeDays: numberOr(gc?.derivedMaxAgeDays, policy.derivedMaxAgeDays),
        objectsMaxAgeDays: numberOr(gc?.objectsMaxAgeDays, policy.objectsMaxAgeDays),
        maxBytes: numberOr(gc?.maxBytes, policy.maxBytes),
      },
    },
    trash: { retention: retention(asRecord(record?.trash)?.retention, "30d") },
  };
}

function flagsFrom(raw: unknown): SpaceMarker["flags"] {
  const record = asRecord(raw);
  return {
    conversationMirror: record?.conversationMirror === true,
    memoryLocal: record?.memoryLocal === true,
  };
}

function createdByFrom(raw: unknown): SpaceMarker["createdBy"] {
  const record = asRecord(raw);
  return {
    app: nonEmptyString(record?.app) ?? "EverOffice",
    version: nonEmptyString(record?.version) ?? "0.0.0",
    platform: nonEmptyString(record?.platform) ?? process.platform,
  };
}

/** `integrity` 值：标记除 integrity 外全部字段的 sha256。仅用于"被手改过"的提示。 */
export function markerIntegrity(marker: SpaceMarker): string {
  const { integrity: _ignored, ...rest } = marker;
  return `sha256:${createHash("sha256").update(JSON.stringify(rest), "utf8").digest("hex")}`;
}

/** 解析并校验标记；任何不合规都返回状态而不是抛错（调用方按状态降级）。 */
export function parseSpaceMarker(raw: unknown, markerPath: string): SpaceMarkerReadResult {
  const record = asRecord(raw);
  if (!record) return { status: "invalid", markerPath, reason: "not_object" };
  const version = record.$everoffice;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    return { status: "invalid", markerPath, reason: "missing_version" };
  }
  if (version > CURRENT_MARKER_VERSION) return { status: "unsupported", markerPath, version };
  const kind = nonEmptyString(record.kind);
  if (!kind || !KNOWN_KINDS.has(kind)) {
    return { status: "invalid", markerPath, reason: "unknown_kind" };
  }
  const spaceId = nonEmptyString(record.spaceId);
  if (!spaceId) return { status: "invalid", markerPath, reason: "missing_space_id" };
  const marker: SpaceMarker = {
    $everoffice: version,
    kind: "space",
    spaceId,
    name: nonEmptyString(record.name) ?? spaceId,
    slug: nonEmptyString(record.slug) ?? "",
    layoutVersion: typeof record.layoutVersion === "number" && record.layoutVersion >= 0
      ? record.layoutVersion
      : version,
    rootMode: record.rootMode === "external" ? "external" : "managed",
    createdAt: nonEmptyString(record.createdAt) ?? new Date(0).toISOString(),
    createdBy: createdByFrom(record.createdBy),
    layout: layoutFrom(record.layout, version),
    roles: rolesFrom(record.roles),
    flags: flagsFrom(record.flags),
    ...(nonEmptyString(record.integrity) ? { integrity: String(record.integrity) } : {}),
  };
  return { status: "ok", marker, markerPath, readonly: false };
}

/** v2 标记的绝对路径（文件夹可能还不存在）。 */
export function spaceMarkerPath(dir: string): string {
  return join(dir, META_DIRNAME, SPACE_MARKER_BASENAME);
}

/**
 * 判定目录是不是项目空间：先看 `.everoffice/space.json`（v2），
 * 再宽容地看元数据目录里被改过名的标记，最后回落到根上的 v1 `space.everoffice`。
 */
export function readSpaceMarker(dir: string): SpaceMarkerReadResult {
  const candidates: string[] = [];
  const preferred = spaceMarkerPath(dir);
  if (isReadableFile(preferred)) candidates.push(preferred);
  const metaDir = join(dir, META_DIRNAME);
  if (existsSync(metaDir)) {
    // 宽容：用户把 `space.json` 改成别的名字（如 `feishu.json`）也认，前提是 kind=space。
    for (const entry of safeReaddir(metaDir)) {
      if (!entry.endsWith(".json") && !entry.endsWith(SPACE_MARKER_SUFFIX)) continue;
      const candidate = join(metaDir, entry);
      if (candidate !== preferred && isReadableFile(candidate)) candidates.push(candidate);
    }
  }
  // v1：标记直接躺在空间根上。
  const legacyPreferred = join(dir, SPACE_MARKER_FILENAME);
  if (isReadableFile(legacyPreferred)) candidates.push(legacyPreferred);
  for (const entry of safeReaddir(dir)) {
    if (!entry.endsWith(SPACE_MARKER_SUFFIX)) continue;
    const candidate = join(dir, entry);
    if (candidate !== legacyPreferred && isReadableFile(candidate)) candidates.push(candidate);
  }
  // 有损坏的候选就报 invalid（`ensure` 会把它另存 `.bak` 再补写），只有完全没有候选才算缺失。
  let invalid: SpaceMarkerReadResult | null = null;
  for (const candidate of candidates) {
    const result = readMarkerFile(candidate);
    if (result.status === "ok" || result.status === "unsupported") return result;
    invalid ??= result;
  }
  return invalid ?? { status: "missing" };
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

function isReadableFile(path: string): boolean {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
}

function readMarkerFile(markerPath: string): SpaceMarkerReadResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(markerPath, "utf8"));
  } catch {
    return { status: "invalid", markerPath, reason: "not_json" };
  }
  return parseSpaceMarker(parsed, markerPath);
}

/**
 * 写标记（v2：`.everoffice/space.json`）：先写 `space.json.tmp-<uuid>` 再 rename，
 * 失败清理临时文件。`overwrite=false` 时若已有可读标记则抛 `space_marker_exists`。
 */
export function writeSpaceMarker(
  dir: string,
  marker: SpaceMarker,
  options: { overwrite?: boolean } = {},
): string {
  const metaDir = join(dir, META_DIRNAME);
  mkdirSync(metaDir, { recursive: true });
  const target = join(metaDir, SPACE_MARKER_BASENAME);
  const payload: SpaceMarker = { ...marker, integrity: markerIntegrity(marker) };
  const serialized = `${JSON.stringify(payload, null, 2)}\n`;
  const temporary = join(metaDir, `${SPACE_MARKER_BASENAME}.tmp-${createHash("sha1").update(`${Date.now()}-${Math.random()}`).digest("hex").slice(0, 8)}`);
  if (!options.overwrite && isReadableFile(target)) throw new Error("space_marker_exists");
  writeFileSync(temporary, serialized, { encoding: "utf8", mode: 0o644 });
  try {
    renameSync(temporary, target);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // 临时文件清理失败不影响主流程。
    }
    throw error;
  }
  return target;
}

/** 现成的空间标记对象（provision 用）。 */
export function buildSpaceMarker(input: {
  spaceId: string;
  name: string;
  slug: string;
  rootMode: SpaceRootMode;
  appVersion?: string;
  layout?: SpaceLayoutMap;
  now?: Date;
}): SpaceMarker {
  const created = (input.now ?? new Date()).toISOString();
  const gc = defaultCacheGcPolicy();
  return {
    $everoffice: CURRENT_MARKER_VERSION,
    kind: "space",
    spaceId: input.spaceId,
    name: input.name,
    slug: input.slug,
    layoutVersion: CURRENT_LAYOUT_VERSION,
    rootMode: input.rootMode,
    createdAt: created,
    createdBy: {
      app: "EverOffice",
      version: input.appVersion ?? "0.0.0",
      platform: process.platform,
    },
    layout: input.layout ?? defaultSpaceLayout(),
    roles: {
      library: { writable: true, retention: "keep" },
      memory: { writable: true, retention: "keep" },
      cache: { writable: true, retention: "ephemeral", gc },
      trash: { retention: "30d" },
    },
    flags: { conversationMirror: false, memoryLocal: false },
  };
}
