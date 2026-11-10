import { readFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { tokenizeJoined } from "./tokenizer.js";

/** 直接执行 0078 迁移 SQL，验证建表语句与 FTS5 roundtrip（不依赖完整 nxcore.db）。 */
function applyMigration(): Database.Database {
  const db = new Database(":memory:");
  const sql = readFileSync(join(__dirname, "../../../drizzle/0078_search_index.sql"), "utf8");
  for (const statement of sql.split("--> statement-breakpoint")) {
    const trimmed = statement.trim();
    if (trimmed) db.exec(trimmed);
  }
  return db;
}

function insertIndexRow(db: Database.Database, id: string, title: string, body: string): void {
  db.prepare("INSERT INTO search_index (id, item_type, ref_id, title, body_preview, ingested_at, time_basis, status, updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(id, "file", id, title, body.slice(0, 128), Date.now(), "ingested", "indexed", Date.now());
  const rowid = (db.prepare("SELECT rowid AS rowid FROM search_index WHERE id=?").get(id) as { rowid: number }).rowid;
  db.prepare("INSERT INTO search_index_fts (rowid, tokens) VALUES (?,?)").run(rowid, tokenizeJoined(`${title}\n${body}`));
}

describe("search FTS 集成", () => {
  it("0078 迁移可执行且检索三表齐备", () => {
    const db = applyMigration();
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'search_index%'").all() as Array<{ name: string }>).map((r) => r.name);
    expect(tables).toContain("search_index");
    expect(tables).toContain("search_index_fts");
    db.close();
  });

  it("中文 bigram 查询命中且排序相关", () => {
    const db = applyMigration();
    insertIndexRow(db, "a", "定价方案", "本季度定价方案采用阶梯制");
    insertIndexRow(db, "b", "会议纪要", "周会讨论了发布时间");
    const tokens = tokenizeJoined("定价方案");
    const rows = db.prepare(
      "SELECT si.id FROM search_index_fts f JOIN search_index si ON si.rowid=f.rowid WHERE search_index_fts MATCH ? ORDER BY bm25(search_index_fts)",
    ).all(tokens) as Array<{ id: string }>;
    expect(rows.map((r) => r.id)).toEqual(["a"]);
    db.close();
  });

  it("重索引幂等：DELETE+INSERT 不产生重复命中", () => {
    const db = applyMigration();
    insertIndexRow(db, "a", "定价方案", "定价基准");
    // 模拟 reindexItem 的 DELETE+INSERT 路径
    const rowid = (db.prepare("SELECT rowid AS rowid FROM search_index WHERE id='a'").get() as { rowid: number }).rowid;
    db.prepare("DELETE FROM search_index_fts WHERE rowid=?").run(rowid);
    db.prepare("INSERT INTO search_index_fts (rowid, tokens) VALUES (?,?)").run(rowid, tokenizeJoined("定价方案\n定价基准"));
    const rows = db.prepare(
      "SELECT COUNT(*) AS count FROM search_index_fts f JOIN search_index si ON si.rowid=f.rowid WHERE search_index_fts MATCH ?",
    ).get(tokenizeJoined("定价")) as { count: number };
    expect(rows.count).toBe(1);
    db.close();
  });
});
