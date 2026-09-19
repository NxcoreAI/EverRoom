export interface LocalStorageMigration<T> {
  /** 源版本：from=1 的迁移把 v1 数据变换成 v2，依此类推。 */
  from: number;
  up: (previous: T) => T;
}

export interface MinimalStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface VersionedLocalStorageOptions<T> {
  /** 规范 key 为 `${keyBase}:v${N}`；裸 `${keyBase}` 视为旧版未版本化数据。 */
  keyBase: string;
  /** 当前格式版本 N（≥1）。 */
  version: number;
  /** 旧版值（v1 key、裸 key 或 legacyKeys 的 JSON）→ v1 数据；抛错视为损坏。 */
  adoptBaseline: (raw: unknown) => T;
  /** 无任何存储数据或迁移失败降级时的默认值。 */
  fallback: T;
  /** from=1..N-1 的升链。 */
  migrations: readonly LocalStorageMigration<T>[];
  /** 历史世代使用过、不符合 `${keyBase}:v${N}` 布局的旧 key（按新→旧排列）。
   *  找到即走 adoptBaseline 认领；认领后原样保留（布局未知，不做清理）。 */
  legacyKeys?: readonly string[];
  /** 注入用于测试；缺省用 window.localStorage。 */
  storage?: MinimalStorage;
}

export interface VersionedLocalStorageStore<T> {
  get(): T;
  set(value: T): void;
  clear(): void;
}

const LEGACY_VERSION = 1;

function defaultStorage(): MinimalStorage {
  // 优先 window.localStorage（与既有渲染层代码一致，测试里 window 可被整体打桩）。
  const scoped = globalThis as {
    localStorage?: MinimalStorage;
    window?: { localStorage?: MinimalStorage };
  };
  const storage = scoped.window?.localStorage ?? scoped.localStorage;
  if (storage === undefined) {
    throw new Error("localStorage unavailable");
  }
  return storage;
}

/**
 * 渲染进程 localStorage 的版本化存取（key 版本化，值不带版本标记）。
 *
 * - 迁移只写新 key：上一代 key 保留作旧二进制回滚归档，更老的 key 清理。
 * - 失败降级：原始串挪到 `${keyBase}:v${N}:failed:<时间戳>` 归档 key，
 *   返回 fallback（这里的数据是草稿/偏好级别，不值得让应用停机）。
 */
export function createVersionedLocalStorageStore<T>(
  options: VersionedLocalStorageOptions<T>,
): VersionedLocalStorageStore<T> {
  const { keyBase, version, fallback } = options;
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new Error(`[versioned-local-storage] ${keyBase}: version must be a positive integer`);
  }
  const storage = options.storage ?? defaultStorage();
  const canonicalKey = `${keyBase}:v${String(version)}`;
  const keyFor = (v: number): string => `${keyBase}:v${String(v)}`;
  const legacyKeys = options.legacyKeys ?? [];
  const orderedMigrations = [...options.migrations].sort((a, b) => a.from - b.from);

  const migrateFrom = (fromVersion: number, value: T): T => {
    let migrated = value;
    for (const migration of orderedMigrations) {
      if (migration.from >= fromVersion && migration.from < version) {
        migrated = migration.up(migrated);
      }
    }
    storage.setItem(canonicalKey, JSON.stringify(migrated));
    // 保留迁移来源那一代 key 作旧二进制回滚归档；更老的一律清理。
    for (let w = 1; w < fromVersion; w += 1) storage.removeItem(keyFor(w));
    if (fromVersion > LEGACY_VERSION) storage.removeItem(keyBase);
    return migrated;
  };

  return {
    get(): T {
      try {
        const canonical = storage.getItem(canonicalKey);
        if (canonical !== null) return JSON.parse(canonical) as T;
        for (let v = version - 1; v >= LEGACY_VERSION; v -= 1) {
          const raw = storage.getItem(keyFor(v));
          if (raw === null) continue;
          return migrateFrom(v, v === LEGACY_VERSION
            ? options.adoptBaseline(JSON.parse(raw))
            : (JSON.parse(raw) as T));
        }
        for (const legacyKey of legacyKeys) {
          const raw = storage.getItem(legacyKey);
          if (raw === null) continue;
          return migrateFrom(LEGACY_VERSION, options.adoptBaseline(JSON.parse(raw)));
        }
        const bare = storage.getItem(keyBase);
        if (bare !== null) {
          return migrateFrom(LEGACY_VERSION, options.adoptBaseline(JSON.parse(bare)));
        }
        return fallback;
      } catch (error) {
        try {
          const raw = storage.getItem(canonicalKey) ?? latestOlderRaw(storage, keyBase, version, legacyKeys);
          if (raw !== null) {
            storage.setItem(`${canonicalKey}:failed:${String(Date.now())}`, raw);
          }
        } catch {
          // 归档失败不影响降级。
        }
        console.error(`[versioned-local-storage] ${keyBase} unreadable; using fallback`, error);
        return fallback;
      }
    },
    set(value: T): void {
      storage.setItem(canonicalKey, JSON.stringify(value));
    },
    clear(): void {
      storage.removeItem(keyBase);
      for (let v = 1; v <= version; v += 1) storage.removeItem(keyFor(v));
      for (const legacyKey of legacyKeys) storage.removeItem(legacyKey);
    },
  };
}

function latestOlderRaw(
  storage: MinimalStorage,
  keyBase: string,
  version: number,
  legacyKeys: readonly string[],
): string | null {
  for (let v = version - 1; v >= LEGACY_VERSION; v -= 1) {
    const raw = storage.getItem(`${keyBase}:v${String(v)}`);
    if (raw !== null) return raw;
  }
  for (const legacyKey of legacyKeys) {
    const raw = storage.getItem(legacyKey);
    if (raw !== null) return raw;
  }
  return storage.getItem(keyBase);
}
