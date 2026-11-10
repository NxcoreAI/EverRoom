import type { MigrationRegistry, MigrationVia } from "./types.js";

interface RegistryEntry {
  version: number;
  name: string;
  via: MigrationVia;
}

/** 内存版版本寄存器，单测与临时存储用。语义与 SQL 版一致：同版本重复记录被忽略。 */
export class InMemoryRegistry implements MigrationRegistry {
  private readonly entries: RegistryEntry[] = [];

  getCurrentVersion(): number | null {
    let max: number | null = null;
    for (const entry of this.entries) {
      if (max === null || entry.version > max) max = entry.version;
    }
    return max;
  }

  recordApplied(version: number, name: string, via: MigrationVia): void {
    if (this.entries.some((entry) => entry.version === version)) return;
    this.entries.push({ version, name, via });
  }

  /** 测试断言用：按应用顺序列出记录。 */
  list(): readonly RegistryEntry[] {
    return [...this.entries];
  }
}
