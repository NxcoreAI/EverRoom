import { describe, expect, it } from "vitest";
import { InMemoryRegistry } from "../src/core/registry.js";
import { runMigrations } from "../src/core/runner.js";
import type { DataMigration } from "../src/core/types.js";
import { MigrationFailureError } from "../src/core/types.js";
import { validateMigrations } from "../src/core/validate.js";

function makeMigration(version: number, name = `test-${String(version)}`, up?: (state: string[]) => void): DataMigration<string[]> {
  return { version, name, up: up ?? ((state) => { state.push(`v${String(version)}`); }) };
}

describe("validateMigrations", () => {
  it("拒绝空 name 与非法 name", () => {
    expect(() => validateMigrations([{ version: 2, name: "Bad Name", up: () => {} }], 1, "s")).toThrow();
    expect(() => validateMigrations([{ version: 2, name: "", up: () => {} }], 1, "s")).toThrow();
  });

  it("拒绝重复或递减版本", () => {
    expect(() => validateMigrations([makeMigration(2), makeMigration(2, "other")], 1, "s")).toThrow();
    expect(() => validateMigrations([makeMigration(3), makeMigration(2, "other")], 1, "s")).toThrow();
  });

  it("拒绝不大于基线的首版本", () => {
    expect(() => validateMigrations([makeMigration(1)], 1, "s")).toThrow();
    expect(() => validateMigrations([makeMigration(0)], 1, "s")).toThrow();
  });

  it("空链合法", () => {
    expect(() => validateMigrations([], 1, "s")).not.toThrow();
  });
});

describe("runMigrations", () => {
  const baseOptions = {
    storeId: "test",
    baselineVersion: 1,
    withTransaction: (fn: () => void) => fn(),
  } as const;

  it("全新存储：只记录版本，不执行任何迁移", () => {
    const registry = new InMemoryRegistry();
    const result = runMigrations({
      ...baseOptions,
      isFreshStore: true,
      registry,
      migrations: [makeMigration(2), makeMigration(3)],
      makeContext: () => [],
      backup: () => { throw new Error("fresh store must not back up"); },
    });
    expect(result.claimed).toBe("fresh");
    expect(result.applied).toEqual([]);
    expect(result.toVersion).toBe(3);
    expect(registry.getCurrentVersion()).toBe(3);
    expect(registry.list().map((entry) => entry.via)).toEqual(["fresh-claim", "fresh-claim", "fresh-claim"]);
  });

  it("存量存储：认领基线后执行待办迁移", () => {
    const registry = new InMemoryRegistry();
    const state: string[] = [];
    const result = runMigrations({
      ...baseOptions,
      isFreshStore: false,
      registry,
      migrations: [makeMigration(2), makeMigration(3)],
      makeContext: () => state,
      backup: () => "/tmp/backup.sqlite",
      restore: () => { throw new Error("must not restore on success"); },
    });
    expect(result.claimed).toBe("existing");
    expect(result.applied.map((item) => item.version)).toEqual([2, 3]);
    expect(state).toEqual(["v2", "v3"]);
  });

  it("已认领存储：只执行更大版本（幂等）", () => {
    const registry = new InMemoryRegistry();
    registry.recordApplied(1, "baseline", "baseline-claim");
    registry.recordApplied(2, "test-2", "migration");
    let backupCalls = 0;
    const result = runMigrations({
      ...baseOptions,
      isFreshStore: false,
      registry,
      migrations: [makeMigration(2), makeMigration(3), makeMigration(4)],
      makeContext: () => [] as string[],
      backup: () => { backupCalls += 1; return `/tmp/b-${String(backupCalls)}.sqlite`; },
    });
    expect(result.applied.map((item) => item.version)).toEqual([3, 4]);
    expect(backupCalls).toBe(1);
  });

  it("无待办迁移时不备份、不再执行", () => {
    const registry = new InMemoryRegistry();
    registry.recordApplied(1, "baseline", "baseline-claim");
    registry.recordApplied(2, "test-2", "migration");
    const result = runMigrations({
      ...baseOptions,
      isFreshStore: false,
      registry,
      migrations: [makeMigration(2)],
      makeContext: () => [] as string[],
      backup: () => { throw new Error("no pending migrations must not back up"); },
    });
    expect(result.applied).toEqual([]);
    expect(result.toVersion).toBe(2);
  });

  it("迁移失败：记录回滚并抛 MigrationFailureError，restore 被调用", () => {
    const registry = new InMemoryRegistry();
    registry.recordApplied(1, "baseline", "baseline-claim");
    const state: string[] = [];
    const restored: string[] = [];
    const failing: DataMigration<string[]> = {
      version: 3,
      name: "boom",
      up: () => { throw new Error("transform failed"); },
    };
    try {
      runMigrations({
        ...baseOptions,
        isFreshStore: false,
        registry,
        migrations: [makeMigration(2), failing],
        makeContext: () => state,
        backup: () => "/tmp/backup.sqlite",
        restore: (path) => { restored.push(path); },
      });
      expect.unreachable("must throw");
    } catch (error) {
      expect(error).toBeInstanceOf(MigrationFailureError);
      const failure = error as MigrationFailureError;
      expect(failure.failedVersion).toBe(3);
      expect(failure.failedName).toBe("boom");
      expect(failure.backupPath).toBe("/tmp/backup.sqlite");
      expect(failure.message).toContain("[data-migration-failed]");
      expect(failure.message).toContain("store=test");
    }
    expect(restored).toEqual(["/tmp/backup.sqlite"]);
  });

  it("恢复自身失败：抛原始 MigrationFailureError 且不吞掉回滚错误", () => {
    const registry = new InMemoryRegistry();
    registry.recordApplied(1, "baseline", "baseline-claim");
    const rollbackErrors: unknown[] = [];
    expect(() => runMigrations({
      ...baseOptions,
      isFreshStore: false,
      registry,
      migrations: [{ version: 2, name: "boom", up: () => { throw new Error("x"); } }],
      makeContext: () => [] as string[],
      backup: () => "/tmp/backup.sqlite",
      restore: () => { throw new Error("restore failed"); },
      onRollbackError: (error) => { rollbackErrors.push(error); },
    })).toThrow(MigrationFailureError);
    expect(rollbackErrors).toHaveLength(1);
  });
});
