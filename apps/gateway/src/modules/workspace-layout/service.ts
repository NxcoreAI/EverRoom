import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { cp, rm } from "node:fs/promises";
import { basename, dirname, join, posix, resolve } from "node:path";
import type {
  AgentSpaceCandidate,
  AgentSpaceHealth,
  AgentSpaceLayout,
  AgentSpaceRepairReport,
  AgentWorkspaceRootMode,
} from "@nxcore/agent-contract";

import {
  buildSpaceMarker,
  defaultSpaceLayout,
  META_DIRNAME,
  readSpaceMarker,
  SPACE_MARKER_FILENAME,
  CURRENT_LAYOUT_VERSION,
  CURRENT_MARKER_VERSION,
  spaceMarkerPath,
  writeSpaceMarker,
  type SpaceLayoutMap,
  type SpaceMarker,
  type SpaceMarkerReadResult,
  type SpaceRootMode,
} from "./markers.js";
import { isSafeSlug, slugifySpaceName, uniqueSpaceSlug, workspaceContainer } from "./paths.js";

/**
 * 项目空间目录服务：全仓唯一的"往空间目录里写东西"的地方（单写者）。
 *
 * 设计见 docs/project-space-layout-plan.zh-CN.md：
 * - 一个空间只有一个标记（v2 起在 `.everoffice/space.json`），它同时声明内部布局；
 * - 判定"目录是不是空间"只看这个标记；
 * - 所有动作幂等：`ensure` 只补缺，不删不改用户内容，并把 v1 布局就地迁到 v2；
 * - 这里不碰数据库：DB 的 `path/slug/root_mode/layout_version` 由 AgentService 维护。
 */

export interface WorkspaceLayoutLogger {
  info(fields: Record<string, unknown>, message: string): void;
}

export interface WorkspaceLayoutServiceOptions {
  /** 应用数据根（`~/Library/Application Support/<APP_NAME>`，当前为 EverOffice）。 */
  dataDir: string;
  /** 应用版本，写进标记的 `createdBy`。 */
  appVersion?: string;
  logger?: WorkspaceLayoutLogger;
}

/** 解析后的绝对路径集合（全部从标记的 `layout` 映射派生）。 */
export interface ResolvedSpacePaths {
  root: string;
  /** 资料库根：v2 起就是空间根本身。 */
  library: string;
  /** 应用元数据目录（v1 未迁移时为空间根）。 */
  meta: string;
  memory: string;
  conversation: string;
  trash: string;
  /** 元数据目录下的 cache 容器（派生缓存的父目录）。 */
  cache: string;
  tmp: string;
  derived: string;
  objects: string;
}


export interface ProvisionedSpace {
  paths: ResolvedSpacePaths;
  marker: SpaceMarker;
  markerPath: string;
  /** 目录此前是否已存在（false = 本次新建）。 */
  existed: boolean;
}

const DEFAULT_LOG: WorkspaceLayoutLogger = { info: () => {} };

export class WorkspaceLayoutService {
  /** 当前布局版本：DB 的 `layout_version` 与"是否需要迁移"的判定都以此为准。 */
  readonly layoutVersion = CURRENT_LAYOUT_VERSION;
  private readonly dataDir: string;
  private readonly appVersion: string;
  private readonly logger: WorkspaceLayoutLogger;

  constructor(options: WorkspaceLayoutServiceOptions) {
    this.dataDir = options.dataDir;
    this.appVersion = options.appVersion ?? "0.0.0";
    this.logger = options.logger ?? DEFAULT_LOG;
  }

  /** 容器根：`<dataDir>/Workspace`。 */
  container(): string {
    return workspaceContainer(this.dataDir);
  }

  /**
   * 默认落点预览：`<container>/<slug>`。
   * `exists=true` 表示同名目录已占用，调用方应提示（最终 slug 会去重）。
   */
  defaultRoot(name: string): { root: string; slug: string; exists: boolean } {
    const container = this.container();
    const base = slugifySpaceName(name);
    const slug = uniqueSpaceSlug(container, base);
    return { root: join(container, slug), slug, exists: slug !== base };
  }

  /** 判定某目录是不是项目空间（只看根上的标记）。 */
  detect(dir: string): SpaceMarkerReadResult {
    const absolute = resolve(dir);
    if (!existsSync(absolute)) return { status: "missing" };
    return readSpaceMarker(absolute);
  }

  /** 布局映射 → 绝对路径；标记缺失时用默认布局兜底。空串角色 = 空间根本身。 */
  pathsOf(root: string, layout?: SpaceLayoutMap): ResolvedSpacePaths {
    const map = layout ?? defaultSpaceLayout();
    const at = (relative: string): string => (relative && relative !== "." ? join(root, relative) : root);
    // 派生缓存的父目录（`meta/cache`）：保留"cache 容器"概念给统计/清理用。
    const derivedParent = posix.dirname(map.derived);
    return {
      root,
      library: at(map.library),
      meta: at(map.meta),
      memory: at(map.memory),
      conversation: at(map.conversation),
      trash: at(map.trash),
      cache: derivedParent && derivedParent !== "." ? at(derivedParent) : at(map.meta),
      tmp: at(map.tmp),
      derived: at(map.derived),
      objects: at(map.objects),
    };
  }

  /** 期望存在的目录清单（相对空间根，用于 health/repair 对齐；空角色跳过）。 */
  private expectedDirectories(layout: SpaceLayoutMap): string[] {
    return [
      layout.meta,
      layout.memory,
      layout.conversation,
      layout.trash,
      layout.objects,
      layout.derived,
      layout.tmp,
    ].filter((relative): relative is string => Boolean(relative) && relative !== ".");
  }

  /** 目录健康快照：是否在、标记在不在/是不是只读、哪些目录缺了。 */
  health(root: string): AgentSpaceHealth & { marker: SpaceMarker | null; markerPath: string | null } {
    const absolute = resolve(root);
    let exists = false;
    try {
      exists = statSync(absolute).isDirectory();
    } catch {
      exists = false;
    }
    if (!exists) {
      return {
        root: absolute,
        exists: false,
        markerPresent: false,
        markerReadonly: false,
        missingDirectories: [],
        marker: null,
        markerPath: null,
      };
    }
    const read = readSpaceMarker(absolute);
    const marker = read.status === "ok" ? read.marker : null;
    const layout = marker?.layout ?? defaultSpaceLayout();
    const missingDirectories = this.expectedDirectories(layout)
      .filter((relative) => !existsSync(join(absolute, relative)));
    return {
      root: absolute,
      exists: true,
      markerPresent: read.status === "ok",
      markerReadonly: read.status === "unsupported",
      missingDirectories,
      marker,
      markerPath: read.status === "ok" ? read.markerPath : (read.status === "missing" ? null : read.markerPath),
    };
  }

  /** 完整 layout 快照（供 `/layout` 接口与渲染层目录卡片）。 */
  layoutOf(spaceId: string, root: string, rootMode: AgentWorkspaceRootMode = "managed"): AgentSpaceLayout {
    const health = this.health(root);
    const marker = health.marker;
    return {
      spaceId,
      rootMode,
      layoutVersion: marker?.layoutVersion ?? 0,
      paths: this.pathsOf(resolve(root), marker?.layout),
      health: {
        root: health.root,
        exists: health.exists,
        markerPresent: health.markerPresent,
        markerReadonly: health.markerReadonly,
        missingDirectories: health.missingDirectories,
      },
      markerPath: health.markerPath,
    };
  }

  /**
   * 创建空间目录（幂等）。
   *
   * - 目录已存在：就地接管（外部目录/上次创建中断），有别的空间标记则抛 `space_marker_conflict`；
   * - 目录不存在：先在同卷 `.staging-<uuid>` 建完整骨架再 rename，避免半成品目录；
   * - 任何失败都清理 staging，不留残骸。
   */
  provision(input: {
    spaceId: string;
    name: string;
    root?: string | null;
    rootMode?: SpaceRootMode;
  }): ProvisionedSpace {
    const mode: SpaceRootMode = input.rootMode ?? "managed";
    const { rootPath, slug } = this.resolveTargetRoot(input.name, input.root, mode);
    if (existsSync(rootPath)) {
      const ensured = this.ensure(rootPath, {
        spaceId: input.spaceId,
        name: input.name,
        slug,
        rootMode: mode,
      });
      return {
        paths: this.pathsOf(rootPath, ensured.marker?.layout),
        marker: ensured.marker ?? buildSpaceMarker({
          spaceId: input.spaceId,
          name: input.name,
          slug,
          rootMode: mode,
          appVersion: this.appVersion,
        }),
        markerPath: spaceMarkerPath(rootPath),
        existed: true,
      };
    }

    const parent = dirname(rootPath);
    mkdirSync(parent, { recursive: true });
    const staging = join(parent, `.staging-${randomUUID()}`);
    const marker = buildSpaceMarker({
      spaceId: input.spaceId,
      name: input.name,
      slug,
      rootMode: mode,
      appVersion: this.appVersion,
    });
    try {
      mkdirSync(staging, { recursive: true });
      for (const relative of this.expectedDirectories(marker.layout)) {
        mkdirSync(join(staging, relative), { recursive: true });
      }
      writeSpaceMarker(staging, marker);
      renameSync(staging, rootPath);
    } catch (error) {
      try {
        rmSync(staging, { recursive: true, force: true });
      } catch {
        // 清理失败不应覆盖原始错误。
      }
      throw error;
    }
    this.logger.info({ event: "workspace_layout.provisioned", spaceId: input.spaceId, root: rootPath }, "project space directory created");
    return {
      paths: this.pathsOf(rootPath, marker.layout),
      marker,
      markerPath: spaceMarkerPath(rootPath),
      existed: false,
    };
  }

  /**
   * 幂等补缺：建缺失目录、补缺失标记；只读标记（未来版本）一律不写。
   * 返回修复报告，`createdDirectories` 是相对空间根的路径。
   */
  repair(input: {
    spaceId: string;
    name: string;
    root: string;
    rootMode: SpaceRootMode;
    slug?: string;
  }): AgentSpaceRepairReport & { layout: SpaceLayoutMap; layoutVersion: number } {
    const ensured = this.ensure(resolve(input.root), {
      spaceId: input.spaceId,
      name: input.name,
      slug: input.slug ?? basename(resolve(input.root)),
      rootMode: input.rootMode,
    });
    return {
      spaceId: input.spaceId,
      createdDirectories: ensured.createdDirectories,
      createdMarker: ensured.createdMarker,
      readonly: ensured.readonly,
      layout: ensured.marker?.layout ?? defaultSpaceLayout(),
      layoutVersion: ensured.marker?.layoutVersion ?? CURRENT_LAYOUT_VERSION,
    };
  }

  /** 扫描容器根，列出磁盘上存在但未必已注册的项目空间。 */
  discover(): AgentSpaceCandidate[] {
    const container = this.container();
    let entries: Array<{ name: string; isDirectory(): boolean }> = [];
    try {
      entries = readdirSync(container, { withFileTypes: true });
    } catch {
      return [];
    }
    const candidates: AgentSpaceCandidate[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const root = join(container, entry.name);
      const read = readSpaceMarker(root);
      if (read.status !== "ok") continue;
      candidates.push({
        root,
        spaceId: read.marker.spaceId,
        name: read.marker.name,
        slug: read.marker.slug || entry.name,
        layoutVersion: read.marker.layoutVersion,
        readonly: false,
        registered: false,
        workspaceId: null,
      });
    }
    return candidates;
  }

  /**
   * 重新分配身份（P4）：把一个目录里的空间改成新的 spaceId/名字。
   *
   * 用于「复制品以新空间注册」：两份目录带着同一个 spaceId，只允许一份绑定，
   * 另一份必须换 id 才能在应用里独立存在。
   */
  reassignIdentity(root: string, input: { spaceId: string; name: string; slug?: string }): void {
    const absolute = resolve(root);
    if (!existsSync(absolute)) throw new Error("space_root_missing");
    const read = readSpaceMarker(absolute);
    if (read.status === "unsupported") throw new Error("space_marker_unsupported");
    const identity = {
      spaceId: input.spaceId,
      name: input.name,
      slug: input.slug ?? basename(absolute),
    };
    // v1 标记：先连目录布局一起迁到 v2，再写新身份（`buildSpaceMarker` 会打 v2 版本号，
    // 若只换身份不迁目录，就会写出"v2 标记 + v1 路径"的坏状态）。
    if (read.status === "ok" && read.marker.$everoffice < CURRENT_MARKER_VERSION) {
      this.migrateLegacyLayout(absolute, { ...read.marker, ...identity });
      return;
    }
    // 身份和目录名都没变就不用重写；只改 slug（搬移后目录名变了）也要重写。
    if (read.status === "ok"
      && read.marker.spaceId === identity.spaceId
      && (!input.slug || read.marker.slug === input.slug)) return;
    const marker = buildSpaceMarker({
      ...identity,
      rootMode: read.status === "ok" ? read.marker.rootMode : "external",
      appVersion: this.appVersion,
      ...(read.status === "ok" ? { layout: read.marker.layout } : {}),
    });
    writeSpaceMarker(absolute, marker, { overwrite: true });
    for (const relative of this.expectedDirectories(marker.layout)) {
      mkdirSync(join(absolute, relative), { recursive: true });
    }
  }

  /**
   * 搬移空间目录（P4）：同卷 rename（快、原子）；跨卷 copy → 校验 → 删旧。
   *
   * 不动标记内容（`spaceId` 是稳定身份，`slug` 由调用方随后改写）。
   */
  async relocateDirectory(fromRoot: string, toRoot: string): Promise<void> {
    const from = resolve(fromRoot);
    const to = resolve(toRoot);
    if (from === to) return;
    if (!existsSync(from)) throw new Error("space_root_missing");
    if (existsSync(to)) throw new Error("space_root_exists");
    mkdirSync(dirname(to), { recursive: true });
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EXDEV" && code !== "EPERM" && code !== "EACCES") throw error;
    }
    await cp(from, to, { recursive: true, preserveTimestamps: true, errorOnExist: true });
    // 校验：目标必须已经有标记，否则视为复制失败，保留原目录不动。
    if (readSpaceMarker(to).status !== "ok") {
      await rm(to, { recursive: true, force: true }).catch(() => undefined);
      throw new Error("space_relocate_failed");
    }
    await rm(from, { recursive: true, force: true });
  }

  private resolveTargetRoot(
    name: string,
    requested: string | null | undefined,
    mode: SpaceRootMode,
  ): { rootPath: string; slug: string } {
    if (requested && requested.trim()) {
      const rootPath = resolve(requested.trim());
      const base = basename(rootPath);
      return { rootPath, slug: isSafeSlug(base) ? base : slugifySpaceName(name) };
    }
    const container = this.container();
    const slug = uniqueSpaceSlug(container, slugifySpaceName(name));
    // managed 模式下 root 缺省：落在容器里；external 模式必须显式给 root。
    return { rootPath: join(container, slug), slug };
  }

  /**
   * v1 → v2 布局就地迁移（幂等、非破坏）：
   *
   * | v1                                    | v2                          |
   * | ------------------------------------- | --------------------------- |
   * | `Library/<child>`（inbox/outputs/…）  | `<root>/<child>`（普通资料） |
   * | `Library/.cache/objects`              | `.everoffice/objects`        |
   * | `Library/.cache/derived`              | `.everoffice/cache/derived`  |
   * | `Library/.cache/tmp`                  | 丢弃（scratch 本就是临时的） |
   * | `Memory/`                             | `.everoffice/memory`         |
   * | `Conversation/`                       | `.everoffice/conversation`   |
   * | `.trash/`                             | `.everoffice/trash`          |
   * | 根上 `space.everoffice`               | `.everoffice/space.json`（重写为 v2） |
   *
   * `file_entries.relative_path` 原本就相对 `Library/`，children 原样上移后**保持不变**。
   * 任何目标位置已有同名条目时跳过该条（不合并、不覆盖），迁移继续。
   */
  private migrateLegacyLayout(root: string, marker: SpaceMarker): SpaceMarker {
    const legacy = marker.layout; // 已被 legacyLayoutToV2 翻译成扁平结构
    const next = defaultSpaceLayout();
    const moves: Array<[string, string]> = [
      [legacy.memory, next.memory],
      [legacy.conversation, next.conversation],
      [legacy.trash, next.trash],
      [legacy.objects, next.objects],
      [legacy.derived, next.derived],
    ];
    for (const [from, to] of moves) {
      this.moveIfPresent(join(root, from), join(root, to));
    }
    // 旧 scratch 是小时级临时文件：直接清理，不搬运。
    if (legacy.tmp && legacy.tmp !== next.tmp) {
      rmSync(join(root, legacy.tmp), { recursive: true, force: true });
    }
    // Library 的 children 上移到根（保留 inbox/outputs/imports 等子目录名）。
    const legacyLibrary = join(root, legacy.library);
    if (legacy.library && legacy.library !== "." && existsSync(legacyLibrary)) {
      for (const entry of readdirSync(legacyLibrary)) {
        if (entry === ".cache") continue;
        this.moveIfPresent(join(legacyLibrary, entry), join(root, entry));
      }
      rmSync(legacyLibrary, { recursive: true, force: true });
    }
    // 重写为 v2 标记（`writeSpaceMarker` 会顺手把 `.everoffice/` 建好）。
    const migrated: SpaceMarker = {
      ...marker,
      $everoffice: CURRENT_MARKER_VERSION,
      layoutVersion: CURRENT_LAYOUT_VERSION,
      layout: next,
    };
    writeSpaceMarker(root, migrated, { overwrite: true });
    // 旧标记还在根上就移走（新标记已经在 .everoffice/ 里，不冲突）。
    const legacyMarkerPath = join(root, SPACE_MARKER_FILENAME);
    if (existsSync(legacyMarkerPath)) {
      try {
        renameSync(legacyMarkerPath, join(root, META_DIRNAME, `${SPACE_MARKER_FILENAME}.migrated`));
      } catch {
        rmSync(legacyMarkerPath, { force: true });
      }
    }
    this.logger.info(
      { event: "workspace_layout.migrated_v2", root },
      "space layout migrated to v2 (library root = space root)",
    );
    return migrated;
  }

  /** 同目录树挪位：目标已存在就不动（幂等；宁可留旧位置也不覆盖用户内容）。 */
  private moveIfPresent(from: string, to: string): void {
    if (!existsSync(from) || existsSync(to)) return;
    mkdirSync(dirname(to), { recursive: true });
    try {
      renameSync(from, to);
    } catch {
      // 跨卷等失败：保留原位置，功能仍可用（对账按旧路径找不到才标 missing）。
    }
  }

  private ensure(
    root: string,
    input: { spaceId: string; name: string; slug: string; rootMode: SpaceRootMode },
  ): {
    marker: SpaceMarker | null;
    createdDirectories: string[];
    createdMarker: boolean;
    readonly: boolean;
  } {
    const createdDirectories: string[] = [];
    let createdMarker = false;
    let readonly = false;
    let marker: SpaceMarker | null = null;

    // 目录可能被用户整个删掉（离线后点「修复」）：先把根建回来再补标记与子目录。
    if (!existsSync(root)) mkdirSync(root, { recursive: true });
    const read = readSpaceMarker(root);
    if (read.status === "unsupported") {
      // 未来版本：只读降级，绝不改写用户目录里的新格式标记。
      readonly = true;
      this.logger.info({ event: "workspace_layout.marker_unsupported", root, version: read.version }, "space marker newer than app; read-only");
      return { marker: null, createdDirectories, createdMarker, readonly };
    }
    if (read.status === "ok") {
      if (read.marker.spaceId !== input.spaceId) throw new Error("space_marker_conflict");
      marker = read.marker;
      // v1 布局（`Library/` + 根上标记）就地迁到 v2（根即资料库）。幂等、非破坏：
      // 目标位置已有同名条目就不动它，绝覆盖用户文件。
      if (marker.$everoffice < CURRENT_MARKER_VERSION) {
        marker = this.migrateLegacyLayout(root, marker);
      }
    } else {
      // 缺失或损坏：补写一份（损坏时保留原文件备查，另存 .bak）。
      if (read.status === "invalid") {
        try {
          renameSync(read.markerPath, `${read.markerPath}.bak`);
        } catch {
          // 备份失败不阻塞修复。
        }
      }
      marker = buildSpaceMarker({
        spaceId: input.spaceId,
        name: input.name,
        slug: input.slug,
        rootMode: input.rootMode,
        appVersion: this.appVersion,
      });
      writeSpaceMarker(root, marker, { overwrite: true });
      createdMarker = true;
    }

    for (const relative of this.expectedDirectories(marker.layout)) {
      const absolute = join(root, relative);
      if (existsSync(absolute)) continue;
      mkdirSync(absolute, { recursive: true });
      createdDirectories.push(relative);
    }
    return { marker, createdDirectories, createdMarker, readonly };
  }
}
