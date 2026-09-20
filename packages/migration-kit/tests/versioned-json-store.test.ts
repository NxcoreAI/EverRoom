import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { VersionedJsonReadError, VersionedJsonStore, type JsonDataMigration } from "../src/node/versioned-json-store.js";

interface State {
  items: string[];
}

let workspace: string;

beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), "migration-kit-json-"));
});

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});

const v2Migration: JsonDataMigration<State> = {
  version: 2,
  name: "prefix-items",
  up: (data) => ({ items: data.items.map((item) => `v2:${item}`) }),
};

describe("VersionedJsonStore", () => {
  it("文件缺失：返回 fallback，不落盘", () => {
    const store = new VersionedJsonStore<State>({
      filePath: join(workspace, "missing.json"),
      migrations: [v2Migration],
      adoptBaseline: (raw) => ({ items: Array.isArray(raw) ? (raw as string[]) : [] }),
      fallback: { items: [] },
    });
    expect(store.read()).toEqual({ items: [] });
  });

  it("裸 JSON：认领为 v1、迁移到最新、写回 envelope、生成备份", () => {
    const filePath = join(workspace, "bare.json");
    const backupDir = join(workspace, "backups");
    writeFileSync(filePath, JSON.stringify(["a", "b"]));
    const store = new VersionedJsonStore<State>({
      filePath,
      migrations: [v2Migration],
      adoptBaseline: (raw) => ({ items: Array.isArray(raw) ? (raw as string[]) : [] }),
      fallback: { items: [] },
      backupDir,
    });
    expect(store.read()).toEqual({ items: ["v2:a", "v2:b"] });
    const onDisk = JSON.parse(readFileSync(filePath, "utf8")) as { v: number; data: State };
    expect(onDisk).toEqual({ v: 2, data: { items: ["v2:a", "v2:b"] } });
    const backups = readdirSync(backupDir).filter((name) => name.startsWith("bare-"));
    expect(backups).toHaveLength(1);
    // 二次读取：已是 envelope v2，不再迁移、不再新增备份。
    expect(store.read()).toEqual({ items: ["v2:a", "v2:b"] });
    expect(readdirSync(backupDir).filter((name) => name.startsWith("bare-"))).toHaveLength(1);
  });

  it("降级模式：损坏内容归档并返回 fallback", () => {
    const filePath = join(workspace, "broken.json");
    writeFileSync(filePath, "{not json");
    const store = new VersionedJsonStore<State>({
      filePath,
      migrations: [v2Migration],
      adoptBaseline: () => { throw new Error("unparseable"); },
      fallback: { items: ["default"] },
    });
    expect(store.read()).toEqual({ items: ["default"] });
    const archived = readdirSync(workspace).filter((name) => name.startsWith("broken.json.broken-"));
    expect(archived).toHaveLength(1);
  });

  it("failHard 模式：损坏内容抛 VersionedJsonReadError", () => {
    const filePath = join(workspace, "hard.json");
    writeFileSync(filePath, "{not json");
    const store = new VersionedJsonStore<State>({
      filePath,
      migrations: [v2Migration],
      adoptBaseline: () => { throw new Error("unparseable"); },
      fallback: { items: [] },
      failHard: true,
    });
    expect(() => store.read()).toThrow(VersionedJsonReadError);
  });

  it("写回保留原文件权限（0600）", () => {
    const filePath = join(workspace, "secret.json");
    writeFileSync(filePath, JSON.stringify(["x"]), { mode: 0o600 });
    const store = new VersionedJsonStore<State>({
      filePath,
      migrations: [v2Migration],
      adoptBaseline: (raw) => ({ items: Array.isArray(raw) ? (raw as string[]) : [] }),
      fallback: { items: [] },
    });
    store.read();
    expect(statSync(filePath).mode & 0o777).toBe(0o600);
  });

  it("多级迁移链：v1 → v3 逐级应用", () => {
    const filePath = join(workspace, "chain.json");
    writeFileSync(filePath, JSON.stringify({ items: ["a"] }));
    const store = new VersionedJsonStore<State>({
      filePath,
      migrations: [
        v2Migration,
        { version: 3, name: "suffix-items", up: (data) => ({ items: data.items.map((i) => `${i}!`) }) },
      ],
      adoptBaseline: (raw) => {
        if (typeof raw === "object" && raw !== null && Array.isArray((raw as State).items)) return raw as State;
        throw new Error("bad shape");
      },
      fallback: { items: [] },
    });
    expect(store.read()).toEqual({ items: ["v2:a!"] });
    const onDisk = JSON.parse(readFileSync(filePath, "utf8")) as { v: number };
    expect(onDisk.v).toBe(3);
  });
});
