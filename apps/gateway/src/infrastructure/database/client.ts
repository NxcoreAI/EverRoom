import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { runSqliteMigrations } from "@nxcore/migration-kit";
import * as schema from "./schema.js";
import { gatewayDataMigrations } from "./data-migrations.js";

export interface DatabaseClient {
  db: BetterSQLite3Database<typeof schema>;
  sqlite: Database.Database;
}

interface MigrationJournalEntry {
  tag?: string;
  when?: number;
}

function readMigrationJournal(migrationsDir: string): MigrationJournalEntry[] {
  try {
    const journal = JSON.parse(readFileSync(join(migrationsDir, "meta", "_journal.json"), "utf8")) as {
      entries?: MigrationJournalEntry[];
    };
    return journal.entries ?? [];
  } catch {
    return [];
  }
}

function recordMigration(
  sqlite: Database.Database,
  migrationsDir: string,
  entry: MigrationJournalEntry,
): void {
  if (!entry.tag || typeof entry.when !== "number") return;
  if (sqlite.prepare("SELECT 1 FROM __drizzle_migrations WHERE created_at = ? LIMIT 1").get(entry.when)) return;
  const migrationSql = readFileSync(join(migrationsDir, `${entry.tag}.sql`), "utf8");
  sqlite.prepare("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)")
    .run(createHash("sha256").update(migrationSql).digest("hex"), entry.when);
}

function runAdditiveMigrationIdempotently(
  sqlite: Database.Database,
  migrationsDir: string,
  tag: string,
): void {
  const migrationPath = join(migrationsDir, `${tag}.sql`);
  if (!existsSync(migrationPath)) return;
  const hasObject = (type: "table" | "index", name: string) => Boolean(sqlite.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = ? AND name = ? LIMIT 1",
  ).get(type, name));
  const hasColumn = (table: string, column: string) => hasObject("table", table) && new Set(
    (sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name),
  ).has(column);

  const sql = readFileSync(migrationPath, "utf8");
  for (const raw of sql.split(/--> statement-breakpoint/g)) {
    const statement = raw.replace(/^--[^\n]*$/gm, "").trim();
    if (!statement) continue;
    const createTable = statement.match(/^CREATE TABLE(?: IF NOT EXISTS)? [`"]([^`"]+)[`"]/)?.[1];
    if (createTable && hasObject("table", createTable)) continue;
    const createIndex = statement.match(/^CREATE(?: UNIQUE)? INDEX(?: IF NOT EXISTS)? [`"]([^`"]+)[`"]/)?.[1];
    if (createIndex && hasObject("index", createIndex)) continue;
    const addColumn = statement.match(/^ALTER TABLE [`"]([^`"]+)[`"] ADD [`"]([^`"]+)[`"]+/);
    if (addColumn && (!hasObject("table", addColumn[1]!) || hasColumn(addColumn[1]!, addColumn[2]!))) continue;
    // 种子行插入（如默认工作区）也要可重放：重复回放时命中主键就忽略，
    // 而不是让补丁路径以 UNIQUE 冲突炸掉启动。
    const isInsert = /^INSERT INTO\b/i.test(statement);
    sqlite.exec(isInsert ? statement.replace(/^INSERT INTO\b/i, "INSERT OR IGNORE INTO") : statement);
  }
}

/**
 * The connector branch shipped migrations 0010-0012 with later timestamps than
 * the main branch's document migrations. On an upgraded install Drizzle would
 * therefore skip the document/knowledge migrations and only retry 0015. Move
 * that legacy cursor back to the shared 0009 baseline so the canonical chain
 * can run once; the 0015 connector migration is idempotent for its old tables.
 */
function repairLegacyMigrationCursor(sqlite: Database.Database, migrationsDir: string): void {
  const hasTable = (name: string) => Boolean(sqlite.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
  ).get(name));
  if (!hasTable("__drizzle_migrations") || !hasTable("connector_accounts") || hasTable("document_block_references")) {
    return;
  }

  const entry = readMigrationJournal(migrationsDir).find((item) => item.tag === "0010_tricky_mongoose");
  const canonicalFirstMigrationAt = typeof entry?.when === "number" ? entry.when : null;
  if (canonicalFirstMigrationAt === null) return;

  const hasLegacyCursor = sqlite.prepare(
    "SELECT 1 FROM __drizzle_migrations WHERE created_at >= ? LIMIT 1",
  ).get(canonicalFirstMigrationAt);
  if (!hasLegacyCursor) return;
  sqlite.prepare("DELETE FROM __drizzle_migrations WHERE created_at >= ?").run(canonicalFirstMigrationAt);
}

/**
 * Development builds briefly shipped the connector configuration schema as
 * 0013 before it was rebased onto the canonical migration chain as 0016. If
 * that complete schema is already present, adopt it instead of replaying the
 * same CREATE TABLE / ALTER TABLE statements and losing the existing data.
 */
function adoptPreReleaseConnectorConfigMigration(sqlite: Database.Database, migrationsDir: string): void {
  const hasTable = (name: string) => Boolean(sqlite.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
  ).get(name));
  if (!hasTable("__drizzle_migrations")) return;

  const entries = readMigrationJournal(migrationsDir);
  const previous = entries.find((item) => item.tag === "0015_low_overlord");
  const canonical = entries.find((item) => item.tag === "0016_dazzling_silver_samurai");
  if (typeof previous?.when !== "number" || typeof canonical?.when !== "number") return;

  const latest = sqlite.prepare(
    "SELECT created_at FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1",
  ).get() as { created_at?: number } | undefined;
  if (typeof latest?.created_at !== "number"
    || latest.created_at < previous.when
    || latest.created_at >= canonical.when) return;

  for (const table of [
    "connector_prompt_profiles",
    "connector_sync_job_states",
    "connector_sync_job_versions",
  ]) {
    if (!hasTable(table)) return;
  }

  const hasColumns = (table: string, expected: string[]) => {
    if (!hasTable(table)) return false;
    const columns = new Set((sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
      .map(({ name }) => name));
    return expected.every((name) => columns.has(name));
  };
  if (!hasColumns("connector_accounts", ["display_name", "account_label", "credential_ref"])) return;
  if (!hasColumns("connector_sync_jobs", [
    "name", "prompt_profile_id", "prompt_override", "schedule_type", "timezone",
    "retry_policy", "priority", "status", "config_version",
  ])) return;
  if (!hasColumns("connector_sync_runs", [
    "job_version_id", "unchanged", "quarantined", "rendered_prompt_hash",
    "prompt_profile_version", "input_checkpoint", "output_checkpoint",
  ])) return;

  const migrationSql = readFileSync(join(migrationsDir, `${canonical.tag}.sql`), "utf8");
  const hash = createHash("sha256").update(migrationSql).digest("hex");
  sqlite.prepare("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)")
    .run(hash, canonical.when);
}

/**
 * The connector Markdown work briefly shipped as migrations 0017-0019 before
 * main claimed 0017. Those builds already have the complete schema, but their
 * later timestamps make Drizzle skip main's 0017 and replay canonical 0018.
 * Adopt both canonical migrations after verifying every legacy schema object.
 */
function adoptPreReleaseConnectorMarkdownMigrations(
  sqlite: Database.Database,
  migrationsDir: string,
): void {
  const hasObject = (type: "table" | "index", name: string) => Boolean(sqlite.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = ? AND name = ? LIMIT 1",
  ).get(type, name));
  if (!hasObject("table", "__drizzle_migrations")) return;

  const hasColumns = (table: string, expected: string[]) => {
    if (!hasObject("table", table)) return false;
    const columns = new Set((sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
      .map(({ name }) => name));
    return expected.every((name) => columns.has(name));
  };
  if (!hasColumns("connector_markdown_artifacts", [
    "id", "owner_id", "service", "connection_name", "resource_type", "source_record_id",
    "ingest_source_id", "active_path", "source_content_hash", "markdown_content_hash",
    "renderer_version", "version", "status", "ingest_status", "last_error", "parsed_id",
    "ingest_event_id", "created_at", "updated_at", "deleted_at",
  ])) return;
  if (!hasColumns("connector_markdown_outbox", [
    "id", "owner_id", "resource_type", "ingest_source_id", "operation", "source_content_hash",
    "status", "attempts", "available_at", "lease_owner", "lease_until", "last_error",
    "created_at", "updated_at",
  ])) return;
  // 该函数只服务「早期 pre-release 连接器分支 + 统一理解引擎」的库：那批库在
  // migrate 之前就存在 ingest_events（0084 才删），用它的列形态当形态哨兵。
  // 已修到 0084 之后的库不会走到这里（0017/0018 早已记录在案）。
  if (!hasColumns("ingest_events", ["deleted_at"])) return;
  for (const index of [
    "connector_markdown_artifacts_source_idx",
    "connector_markdown_artifacts_ingest_source_idx",
    "connector_markdown_artifacts_status_idx",
    "connector_markdown_outbox_due_idx",
    "connector_markdown_outbox_source_idx",
  ]) {
    if (!hasObject("index", index)) return;
  }

  const entries = readMigrationJournal(migrationsDir);
  const canonicalEntries = [
    entries.find((item) => item.tag === "0017_sour_madame_web"),
    entries.find((item) => item.tag === "0018_charming_vampiro"),
  ];
  if (canonicalEntries.some((entry) => typeof entry?.when !== "number" || !entry.tag)) return;

  const insertMigration = sqlite.prepare(
    "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)",
  );
  sqlite.transaction(() => {
    sqlite.exec("CREATE INDEX IF NOT EXISTS jobs_type_status_created_idx ON jobs (type, status, created_at)");
    for (const entry of canonicalEntries) {
      if (!entry?.tag || typeof entry.when !== "number") continue;
      const recorded = sqlite.prepare(
        "SELECT 1 FROM __drizzle_migrations WHERE created_at = ? LIMIT 1",
      ).get(entry.when);
      if (recorded) continue;
      const migrationSql = readFileSync(join(migrationsDir, `${entry.tag}.sql`), "utf8");
      const hash = createHash("sha256").update(migrationSql).digest("hex");
      insertMigration.run(hash, entry.when);
    }
  })();
}

/** Adopt late development migrations when their complete schema was already
 * applied under a discarded migration cursor. This prevents duplicate ALTER
 * statements while still allowing partially upgraded databases to migrate. */
function adoptAlreadyAppliedLateMigrations(sqlite: Database.Database, migrationsDir: string): void {
  const hasTable = (name: string) => Boolean(sqlite.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
  ).get(name));
  if (!hasTable("__drizzle_migrations")) return;
  const hasColumn = (table: string, column: string) => hasTable(table) && new Set(
    (sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name),
  ).has(column);
  const entries = readMigrationJournal(migrationsDir);
  const record = (tag: string) => {
    const entry = entries.find((item) => item.tag === tag);
    if (!entry?.tag || typeof entry.when !== "number") return;
    if (sqlite.prepare("SELECT 1 FROM __drizzle_migrations WHERE created_at = ? LIMIT 1").get(entry.when)) return;
    const migrationSql = readFileSync(join(migrationsDir, `${entry.tag}.sql`), "utf8");
    sqlite.prepare("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)")
      .run(createHash("sha256").update(migrationSql).digest("hex"), entry.when);
  };

  // 0036/0037/0038（clipper_*）与 0043（room_local_actions）的探测随 0084 一并退役：
  // 这些表已删，重放对应迁移只会把空表建回来。
  if (hasTable("agent_session_participants")
    && hasColumn("agent_sessions", "active_agent_id")
    && hasColumn("agent_runs", "agent_id")
    && hasColumn("agent_runs", "invocation_mode")
    && hasColumn("agent_messages", "author_agent_id")) {
    record("0039_multi_agent_conversations");
  }
}

/**
 * 修复「跑过 dev 分支又被本分支接续升级」的混合库。
 *
 * dev 分支曾把 slides 分批 checkpoints 迁移编为 0083（when=1792771200000），
 * 合并后在本分支重编号为 0092；而本分支自己的 0083–0087 时间戳比它更早
 * （1792742x–1792749x）。在跑过 dev 的库上，游标已被 dev 的 0083 推到
 * 1792771200000 之后，本分支的 0083–0087 会被 Drizzle 当作已应用而静默跳过，
 * 随后 0092（时间戳最新）又会重复执行 CREATE TABLE。症状：
 *   ① 启动即失败：`table slides_generation_checkpoints already exists`；
 *   ② document_operations.room_id 仍 NOT NULL —— 没有归属 Room 的文档操作
 *      （本分支已去掉 Room 维度）插入直接违反约束；
 *   ③ Room / 采集旧表残留、文件页 (deleted_at, updated_at) 索引缺失。
 *
 * 判据用 schema 效果而不是迁移记录：只有「room_id 仍 NOT NULL」的混合库才补跑
 * 0083–0087（健康库——含我们分支自己的库——完全不受影响），再把 0092 记为已应用。
 * 0083 是重建表的脚本，必须在事务内执行（脚本注释：事务内 PRAGMA foreign_keys
 * 为空操作，DROP 父表会级联删子表，脚本用临时表快照规避，依赖事务语义）。
 */
function repairMixedDevBranchMigrations(sqlite: Database.Database, migrationsDir: string): void {
  const hasTable = (name: string) => Boolean(sqlite.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
  ).get(name));
  if (!hasTable("__drizzle_migrations")) return;
  const entries = readMigrationJournal(migrationsDir);
  const entryFor = (tag: string) => entries.find((item) => item.tag === tag);
  const isRecorded = (tag: string) => {
    const when = entryFor(tag)?.when;
    return typeof when !== "number"
      || Boolean(sqlite.prepare("SELECT 1 FROM __drizzle_migrations WHERE created_at = ? LIMIT 1").get(when));
  };
  const roomIdColumn = hasTable("document_operations")
    ? (sqlite.prepare("PRAGMA table_info(document_operations)").all() as Array<{ name: string; notnull: number }>)
      .find((row) => row.name === "room_id")
    : undefined;

  // ① 混合库：本分支 0083–0087 被跳过（room_id 仍 NOT NULL 是可靠判据）。
  const skippedPhase2 = [
    "0083_document_operations_room_nullable",
    "0084_drop_memory_room_ingest_tables",
    "0085_drop_room_tables",
    "0086_drop_room_compat_tables",
    "0087_file_entries_deleted_updated_idx",
  ];
  if (roomIdColumn && roomIdColumn.notnull === 1) {
    // 0083 的脚本先快照四张子表再重建父表：子表缺一不可。
    const prerequisites = [
      "document_operation_items",
      "document_operation_commands",
      "document_operation_events",
      "external_document_patch_preparations",
    ].every(hasTable);
    const pending = skippedPhase2.filter((tag) => !isRecorded(tag) && existsSync(join(migrationsDir, `${tag}.sql`)));
    if (prerequisites && pending.length > 0) {
      sqlite.transaction(() => {
        for (const tag of pending) {
          if (tag === "0084_drop_memory_room_ingest_tables"
            || tag === "0085_drop_room_tables"
            || tag === "0086_drop_room_compat_tables"
            || tag === "0087_file_entries_deleted_updated_idx") {
            // 删表/建索引迁移本身幂等；用带对象存在性守卫的重放，避免索引已建时撞名。
            runAdditiveMigrationIdempotently(sqlite, migrationsDir, tag);
          } else {
            const sql = readFileSync(join(migrationsDir, `${tag}.sql`), "utf8");
            for (const raw of sql.split(/--> statement-breakpoint/g)) {
              const statement = raw.trim();
              if (statement) sqlite.exec(statement);
            }
          }
          recordMigration(sqlite, migrationsDir, entryFor(tag)!);
        }
      })();
    }
  }

  // ② 0092（dev 的 0083）：表已存在时直接补记录，避免 Drizzle 重复建表。
  if (hasTable("slides_generation_checkpoints")) {
    const checkpoints = entryFor("0092_slides_generation_checkpoints");
    if (checkpoints) recordMigration(sqlite, migrationsDir, checkpoints);
  }

  // ③ 0093：混合库可能已由 dev/预览构建加过 thinking_level 列（② 记下 0092 后
  // Drizzle 游标直接跳到 0093），按 schema 效果补记录，避免重复 ADD COLUMN。
  if (hasTable("agent_sessions")) {
    const columns = new Set(
      (sqlite.prepare("PRAGMA table_info(agent_sessions)").all() as Array<{ name: string }>)
        .map((row) => row.name),
    );
    if (columns.has("thinking_level")) {
      const thinkingLevel = entryFor("0093_agent_thinking_level");
      if (thinkingLevel) recordMigration(sqlite, migrationsDir, thinkingLevel);
    }
  }
}

/**
 * 修复「0092 快捷记录把游标推过 0088–0091」的库。
 *
 * dev 分支的 slides 迁移（0083_slides_generation_checkpoints，when=1792771200000）
 * 合并后被重编号为 0092（when=1793500000000）。为了绕开 dev 已建好的表，
 * repairMixedDevBranchMigrations 会在 migrate 之前直接把 0092 记为已应用；对
 * 「只跑过 dev、从未跑过本分支 0088–0091」的库，这会把游标一次性推到 0092，
 * Drizzle 于是把 0088–0091 当作已应用静默跳过。症状：
 *   ① 启动即崩：`table file_entries has no column named workspace_id`（0091 未跑）；
 *   ② 工作区接口报 `no such table: agent_workspaces`（0089 未跑）；
 *   ③ connector_tombstones 缺失，连接器「已断开」状态不可见（0088 未跑）。
 *
 * 判据是迁移记录 + 游标位置：窗口内仍有未记录的迁移、且游标已越过窗口起点
 * （0087）时才回放。直接从 0087 升级的健康库本来就会在原地跑这几支，提前
 * 幂等回放再补记，结果与 Drizzle 顺序执行一致；窗口已全部记录的库不受影响。
 */
function repairSkippedWorkspaceMigrations(sqlite: Database.Database, migrationsDir: string): void {
  const hasTable = (name: string) => Boolean(sqlite.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
  ).get(name));
  if (!hasTable("__drizzle_migrations") || !hasTable("file_entries") || !hasTable("agent_sessions")) return;

  const entries = readMigrationJournal(migrationsDir);
  const whenFor = (tag: string) => {
    const value = entries.find((item) => item.tag === tag)?.when;
    return typeof value === "number" ? value : null;
  };
  const windowStart = whenFor("0087_file_entries_deleted_updated_idx");
  if (windowStart === null) return;
  const appliedCursor = Number((sqlite.prepare(
    "SELECT created_at FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1",
  ).get() as { created_at?: number } | undefined)?.created_at ?? 0);
  if (appliedCursor < windowStart) return;

  const pending = [
    "0088_connector_agent_query",
    "0089_agent_workspaces",
    "0090_agent_workspace_meta",
    "0091_file_entries_workspace",
  ].filter((tag) => {
    const when = whenFor(tag);
    return when !== null
      && existsSync(join(migrationsDir, `${tag}.sql`))
      && !sqlite.prepare("SELECT 1 FROM __drizzle_migrations WHERE created_at = ? LIMIT 1").get(when);
  });
  if (pending.length === 0) return;

  sqlite.transaction(() => {
    for (const tag of pending) {
      runAdditiveMigrationIdempotently(sqlite, migrationsDir, tag);
      recordMigration(sqlite, migrationsDir, { tag, when: whenFor(tag)! });
    }
  })();
}

/**
 * 0094（论文格式卡从 Room 改按工作区）在本地预览构建里曾以旧编号 0093
 * （when=1793590000000）执行过：这些库的 thesis_format_cards 已经是
 * workspace_id 形态，但迁移记录里没有 0094 的时间戳。Drizzle 会把它当新迁移
 * 重放——脚本先 RENAME 再按 room_id 复制，直接以 `no such column: room_id` 失败。
 * 按 schema 效果（已是 workspace_id 且没有 room_id）补记录，健康库不受影响。
 */
function repairAppliedThesisCardsWorkspaceMigration(sqlite: Database.Database, migrationsDir: string): void {
  const hasTable = (name: string) => Boolean(sqlite.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
  ).get(name));
  if (!hasTable("__drizzle_migrations") || !hasTable("thesis_format_cards")) return;
  const columns = new Set((sqlite.prepare("PRAGMA table_info(thesis_format_cards)").all() as Array<{ name: string }>)
    .map((row) => row.name));
  if (!columns.has("workspace_id") || columns.has("room_id")) return;
  const entry = readMigrationJournal(migrationsDir)
    .find((item) => item.tag === "0094_thesis_format_cards_workspace");
  if (!entry) return;
  recordMigration(sqlite, migrationsDir, entry);
}

/** Repair installs whose migration cursor advanced across the diary/perception
 * branch without applying its schema (a transient merge produced this state). */
function repairIncompleteUnderstandingMigration(sqlite: Database.Database, migrationsDir: string): void {
  const hasObject = (type: "table" | "index", name: string) => Boolean(sqlite.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = ? AND name = ? LIMIT 1",
  ).get(type, name));
  const hasColumn = (table: string, column: string) => new Set(
    (sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name),
  ).has(column);
  if (!hasObject("table", "__drizzle_migrations")) return;
  const runMigrationStatements = (tag: string) => {
    const migrationPath = join(migrationsDir, `${tag}.sql`);
    if (!existsSync(migrationPath)) return;
    const sql = readFileSync(migrationPath, "utf8");
    for (const statement of sql.split(/--> statement-breakpoint/g).map((item) => item.trim()).filter(Boolean)) {
      const createObject = statement.match(/^CREATE(?: UNIQUE)? INDEX(?: IF NOT EXISTS)? [`"]([^`"]+)[`"]/) ?? statement.match(/^CREATE TABLE(?: IF NOT EXISTS)? [`"]([^`"]+)[`"]/);
      if (createObject && hasObject(statement.startsWith("CREATE TABLE") ? "table" : "index", createObject[1]!)) continue;
      const addColumn = statement.match(/^ALTER TABLE [`"]([^`"]+)[`"] ADD [`"]([^`"]+)[`"]+/);
      if (addColumn && (!hasObject("table", addColumn[1]!) || hasColumn(addColumn[1]!, addColumn[2]!))) continue;
      const dropIndex = statement.match(/^DROP INDEX [`"]([^`"]+)[`"]/);
      if (dropIndex && !hasObject("index", dropIndex[1]!)) continue;
      // 重放的历史迁移里可能引用已被后续迁移删掉的表（如 0084 删掉的 ingest_events）：
      // 目标表不存在时该语句无意义，跳过而不是让补丁路径炸掉。
      const indexTarget = statement.match(/^CREATE(?: UNIQUE)? INDEX(?: IF NOT EXISTS)? [`"][^`"]+[`"] ON [`"]([^`"]+)[`"]/);
      const tableTarget = statement.match(/^(?:ALTER TABLE|INSERT INTO|UPDATE|DELETE FROM) [`"]([^`"]+)[`"]/);
      const referenced = indexTarget?.[1] ?? tableTarget?.[1];
      if (referenced && !hasObject("table", referenced)) continue;
      sqlite.exec(statement);
    }
  };
  // 0018_living_secret_warriors 的日记/感知/视觉表已随 0084 删除，不能整条重放；
  // 这里只补它给 uploaded_files 加的四列。只在「游标已越过 0018 但列缺失」的库上
  // 补——否则会把列提前加到还没跑 0018 的旧库上，等 0018 真跑时 ADD COLUMN 撞车。
  const canonical0018 = readMigrationJournal(migrationsDir)
    .find((item) => item.tag === "0018_living_secret_warriors");
  const appliedCursor = Number((sqlite.prepare(
    "SELECT created_at FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1",
  ).get() as { created_at?: number } | undefined)?.created_at ?? 0);
  const cursorPassed0018 = typeof canonical0018?.when === "number" && appliedCursor >= canonical0018.when;
  if (cursorPassed0018 && hasObject("table", "uploaded_files")) {
    const uploadedFileColumns: Array<[string, string]> = [
      ["asset_kind", "text DEFAULT 'document' NOT NULL"],
      ["origin_channel", "text DEFAULT 'upload' NOT NULL"],
      ["visibility", "text DEFAULT 'private' NOT NULL"],
      ["captured_at", "integer"],
    ];
    for (const [column, definition] of uploadedFileColumns) {
      if (!hasColumn("uploaded_files", column)) {
        sqlite.exec(`ALTER TABLE \`uploaded_files\` ADD \`${column}\` ${definition}`);
      }
    }
  }
  if (!hasObject("table", "subagent_definitions")) runMigrationStatements("0019_sturdy_fantastic_four");
  if (!hasObject("table", "runtime_config_store")) runMigrationStatements("0023_runtime_config_store");
  if (!hasObject("table", "agent_schedules")) runMigrationStatements("0025_greedy_the_santerians");
}

export function createDatabase(databasePath: string, migrationsDir: string): DatabaseClient {
  mkdirSync(dirname(databasePath), { recursive: true });

  let isFreshDatabase = true;
  try {
    isFreshDatabase = !existsSync(databasePath) || statSync(databasePath).size === 0;
  } catch {
    isFreshDatabase = true;
  }

  const sqlite = new Database(databasePath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("secure_delete = ON");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  sqlite.pragma("synchronous = NORMAL");

  repairLegacyMigrationCursor(sqlite, migrationsDir);
  adoptPreReleaseConnectorConfigMigration(sqlite, migrationsDir);
  adoptPreReleaseConnectorMarkdownMigrations(sqlite, migrationsDir);
  adoptAlreadyAppliedLateMigrations(sqlite, migrationsDir);
  repairMixedDevBranchMigrations(sqlite, migrationsDir);
  // 0092 的快捷记录会越过 0088–0091：必须在 migrate 之前补齐，否则 Drizzle
  // 会把这些迁移当作已应用而永久跳过（file_entries.workspace_id 等列缺失）。
  repairSkippedWorkspaceMigrations(sqlite, migrationsDir);
  // 本地预览构建跑过旧编号 0093 的库：格式卡已是工作区形态，补记 0094 防重放。
  repairAppliedThesisCardsWorkspaceMigration(sqlite, migrationsDir);
  // Compatibility repairs may create file_entries from the current schema,
  // including source_path, before the canonical additive migration runs.
  // Apply/record it idempotently so Drizzle never repeats ADD COLUMN.
  const localReferenceEntry = readMigrationJournal(migrationsDir)
    .find((item) => item.tag === "0042_friendly_lake");
  const hasMigrationTable = Boolean(sqlite.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations' LIMIT 1",
  ).get());
  const hasFileEntries = Boolean(sqlite.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'file_entries' LIMIT 1",
  ).get());
  if (localReferenceEntry && hasMigrationTable && hasFileEntries) {
    runAdditiveMigrationIdempotently(sqlite, migrationsDir, localReferenceEntry.tag!);
    recordMigration(sqlite, migrationsDir, localReferenceEntry);
  }
  // 0064_document_import_batches_force_new 的手写时间戳早于同批 0064_document_origin
  // 与 0065+，游标已越过它的升级库会被 Drizzle 当作已应用而静默跳过 ALTER。
  const importBatchForceNewEntry = readMigrationJournal(migrationsDir)
    .find((item) => item.tag === "0064_document_import_batches_force_new");
  const hasImportBatches = Boolean(sqlite.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'document_import_batches' LIMIT 1",
  ).get());
  if (importBatchForceNewEntry && hasMigrationTable && hasImportBatches) {
    runAdditiveMigrationIdempotently(sqlite, migrationsDir, importBatchForceNewEntry.tag!);
    recordMigration(sqlite, migrationsDir, importBatchForceNewEntry);
  }
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: migrationsDir });
  sqlite.exec("CREATE INDEX IF NOT EXISTS jobs_type_status_created_idx ON jobs (type, status, created_at)");
  // Preserve canonical migration markers when a pre-release branch inserted
  // later timestamps before the main branch was adopted.
  const journalEntries = readMigrationJournal(migrationsDir);
  const insertMigration = sqlite.prepare("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)");
  for (const entry of journalEntries.filter((item) => typeof item.when === "number" && (item.tag?.startsWith("0017_") || item.tag?.startsWith("0018_") || item.tag?.startsWith("0019_")))) {
    if (!entry.tag || typeof entry.when !== "number") continue;
    if (sqlite.prepare("SELECT 1 FROM __drizzle_migrations WHERE created_at = ? LIMIT 1").get(entry.when)) continue;
    const migrationPath = join(migrationsDir, `${entry.tag}.sql`);
    if (!existsSync(migrationPath)) continue;
    insertMigration.run(createHash("sha256").update(readFileSync(migrationPath, "utf8")).digest("hex"), entry.when);
  }
  // Drizzle identifies migrations by timestamp; the merged branch contains
  // two 0018/0019 entries with overlapping timestamps. Re-run the idempotent
  // compatibility pass after migrate so fresh databases receive whichever
  // branch migration Drizzle skipped.
  repairIncompleteUnderstandingMigration(sqlite, migrationsDir);

  // 数据级迁移（JSON blob/行级格式变换）必须在全部 schema 修复与 drizzle
  // 迁移之后执行：迁移看到的是最终表结构。失败时框架会用备份恢复整库并抛
  // MigrationFailureError，由启动流程（bin/serve.ts）以退出码 78 结束进程。
  runSqliteMigrations({
    storeId: "gateway.sqlite",
    sqlite,
    databasePath,
    backupDir: join(dirname(databasePath), "..", "backups"),
    isFreshStore: isFreshDatabase,
    migrations: gatewayDataMigrations,
    close: () => sqlite.close(),
  });

  return { db, sqlite };
}

export type GatewayDatabase = ReturnType<typeof createDatabase>["db"];
