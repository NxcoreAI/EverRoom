import type Database from "better-sqlite3";

function tableExists(sqlite: Database.Database, table: string): boolean {
  return Boolean(sqlite.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
  ).get(table));
}

function columnsOf(sqlite: Database.Database, table: string): Set<string> {
  if (!tableExists(sqlite, table)) return new Set();
  return new Set(
    (sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
      .map(({ name }) => name),
  );
}

/**
 * Development builds created room_overviews before base_projection was added.
 * Since the canonical migration uses CREATE TABLE IF NOT EXISTS, those installs
 * keep the old shape even after their migration cursor advances. Rebuild the
 * cache table so its constraints match the canonical schema and seed the base
 * projection from the previously materialized projection without losing data.
 */
function repairLegacyRoomOverviews(sqlite: Database.Database): void {
  const columns = columnsOf(sqlite, "room_overviews");
  if (columns.size === 0 || columns.has("base_projection")) return;

  const requiredLegacyColumns = [
    "room_id",
    "revision",
    "projection",
    "generated_at",
    "updated_at",
  ];
  if (!requiredLegacyColumns.every((column) => columns.has(column))) return;

  sqlite.transaction(() => {
    sqlite.exec("ALTER TABLE `room_overviews` RENAME TO `room_overviews_legacy`");
    sqlite.exec(`
      CREATE TABLE \`room_overviews\` (
        \`room_id\` text PRIMARY KEY NOT NULL,
        \`revision\` integer DEFAULT 1 NOT NULL,
        \`base_projection\` text NOT NULL,
        \`projection\` text NOT NULL,
        \`generated_at\` integer NOT NULL,
        \`updated_at\` integer NOT NULL,
        FOREIGN KEY (\`room_id\`) REFERENCES \`context_rooms\`(\`id\`) ON UPDATE no action ON DELETE cascade
      )
    `);
    sqlite.exec(`
      INSERT INTO \`room_overviews\`
        (\`room_id\`, \`revision\`, \`base_projection\`, \`projection\`, \`generated_at\`, \`updated_at\`)
      SELECT \`room_id\`, \`revision\`, \`projection\`, \`projection\`, \`generated_at\`, \`updated_at\`
      FROM \`room_overviews_legacy\`
    `);
    sqlite.exec("DROP TABLE `room_overviews_legacy`");
    sqlite.exec("CREATE INDEX IF NOT EXISTS `room_overviews_updated_idx` ON `room_overviews` (`updated_at`)");
  })();
}

/** A pre-release correction table omitted the nullable Agent run attribution. */
function repairLegacyRoomContextCorrections(sqlite: Database.Database): void {
  const columns = columnsOf(sqlite, "room_context_corrections");
  if (columns.size === 0 || columns.has("proposed_by_run_id")) return;
  sqlite.exec("ALTER TABLE `room_context_corrections` ADD `proposed_by_run_id` text");
}

/** Reconcile Context Room tables produced by pre-release overview builds. */
export function repairContextRoomSchema(sqlite: Database.Database): void {
  repairLegacyRoomOverviews(sqlite);
  repairLegacyRoomContextCorrections(sqlite);
}
