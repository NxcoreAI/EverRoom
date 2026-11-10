import { describe, expect, it } from "vitest";
import { createVersionedLocalStorageStore, type MinimalStorage } from "../src/local/versioned-local-storage.js";

class MemoryStorage implements MinimalStorage {
  private readonly map = new Map<string, string>();

  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }

  keys(): string[] {
    return [...this.map.keys()];
  }

  raw(key: string, value: string): void {
    this.map.set(key, value);
  }
}

interface Draft {
  text: string;
}

function makeStore(storage: MemoryStorage, version = 2) {
  return createVersionedLocalStorageStore<Draft>({
    keyBase: "nxcore:test:draft",
    version,
    adoptBaseline: (raw) => {
      if (typeof raw === "object" && raw !== null && typeof (raw as Draft).text === "string") return raw as Draft;
      throw new Error("bad shape");
    },
    fallback: { text: "" },
    migrations: [
      { from: 1, up: (prev) => ({ text: `${prev.text}|migrated-to-v2` }) },
    ],
    storage,
  });
}

describe("createVersionedLocalStorageStore", () => {
  it("裸 key → 认领 v1 → 迁移到 v2，写新 key、保留裸 key 供旧二进制回滚", () => {
    const storage = new MemoryStorage();
    storage.raw("nxcore:test:draft", JSON.stringify({ text: "hello" }));
    const store = makeStore(storage);
    expect(store.get()).toEqual({ text: "hello|migrated-to-v2" });
    expect(storage.getItem("nxcore:test:draft:v2")).toBe(JSON.stringify({ text: "hello|migrated-to-v2" }));
    expect(storage.getItem("nxcore:test:draft")).toBe(JSON.stringify({ text: "hello" }));
  });

  it("v1 key → 迁移到 v3；v1 作为来源代保留（供旧二进制回滚）", () => {
    const storage = new MemoryStorage();
    storage.raw("nxcore:test:draft:v1", JSON.stringify({ text: "old" }));
    const store = makeStore(storage, 3);
    // version=3 但迁移链只有 from=1；v1 数据应用 from=1 后落 v3 key。
    expect(store.get()).toEqual({ text: "old|migrated-to-v2" });
    expect(storage.getItem("nxcore:test:draft:v3")).toBe(JSON.stringify({ text: "old|migrated-to-v2" }));
    expect(storage.getItem("nxcore:test:draft:v1")).toBe(JSON.stringify({ text: "old" }));
  });

  it("规范 key 直接命中：不再迁移", () => {
    const storage = new MemoryStorage();
    storage.raw("nxcore:test:draft:v2", JSON.stringify({ text: "current" }));
    const store = makeStore(storage);
    expect(store.get()).toEqual({ text: "current" });
  });

  it("无任何数据：返回 fallback", () => {
    const storage = new MemoryStorage();
    expect(makeStore(storage).get()).toEqual({ text: "" });
  });

  it("迁移失败：原始串归档到 failed key，返回 fallback", () => {
    const storage = new MemoryStorage();
    storage.raw("nxcore:test:draft:v1", "{broken json");
    const store = makeStore(storage);
    expect(store.get()).toEqual({ text: "" });
    const failedKeys = storage.keys().filter((key) => key.includes(":failed:"));
    expect(failedKeys).toHaveLength(1);
    expect(storage.getItem(failedKeys[0]!)).toBe("{broken json");
  });

  it("set 写规范 key；clear 清掉全部版本 key", () => {
    const storage = new MemoryStorage();
    const store = makeStore(storage);
    store.set({ text: "saved" });
    expect(storage.getItem("nxcore:test:draft:v2")).toBe(JSON.stringify({ text: "saved" }));
    store.clear();
    expect(storage.keys().filter((key) => key.startsWith("nxcore:test:draft"))).toEqual([]);
  });
});

describe("createVersionedLocalStorageStore legacyKeys", () => {
  it("任意布局的旧 key → 认领 → 迁移落规范 key，旧 key 原样保留", () => {
    const storage = new MemoryStorage();
    storage.raw("nxcore:test:draft:v1:doc-42", JSON.stringify({ text: "legacy layout" }));
    const store = createVersionedLocalStorageStore<Draft>({
      keyBase: "nxcore:test:draft:doc-42",
      version: 2,
      adoptBaseline: (raw) => {
        if (typeof raw === "object" && raw !== null && typeof (raw as Draft).text === "string") return raw as Draft;
        throw new Error("bad shape");
      },
      fallback: { text: "" },
      migrations: [{ from: 1, up: (prev) => ({ text: `${prev.text}|migrated-to-v2` }) }],
      legacyKeys: ["nxcore:test:draft:v1:doc-42"],
      storage,
    });
    expect(store.get()).toEqual({ text: "legacy layout|migrated-to-v2" });
    expect(storage.getItem("nxcore:test:draft:doc-42:v2")).toBe(JSON.stringify({ text: "legacy layout|migrated-to-v2" }));
    expect(storage.getItem("nxcore:test:draft:v1:doc-42")).toBe(JSON.stringify({ text: "legacy layout" }));
  });

  it("clear 连同 legacyKeys 一并清掉", () => {
    const storage = new MemoryStorage();
    storage.raw("nxcore:test:draft:v1:doc-42", JSON.stringify({ text: "legacy" }));
    const store = createVersionedLocalStorageStore<Draft>({
      keyBase: "nxcore:test:draft:doc-42",
      version: 2,
      adoptBaseline: (raw) => raw as Draft,
      fallback: { text: "" },
      migrations: [],
      legacyKeys: ["nxcore:test:draft:v1:doc-42"],
      storage,
    });
    store.set({ text: "current" });
    store.clear();
    expect(storage.keys()).toEqual([]);
  });
});
