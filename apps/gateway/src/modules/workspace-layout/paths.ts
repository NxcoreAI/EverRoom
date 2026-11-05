import { createHash, randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * 项目空间目录原语：容器根解析、目录名（slug）生成、跨平台安全校验。
 *
 * 这里只做纯计算与只读探测，**不创建任何目录**——创建/修复统一在 service.ts，
 * 保证"单写者"约束（见 docs/project-space-layout-plan.zh-CN.md §2 P3）。
 */

/** 容器目录名：默认空间根落在 `<dataDir>/Workspace`。 */
export const WORKSPACE_CONTAINER_DIRNAME = "Workspace";

/** 项目空间默认容器根。 */
export function workspaceContainer(dataDir: string): string {
  return join(dataDir, WORKSPACE_CONTAINER_DIRNAME);
}

/** slug 上限：给 `<container>/` 前缀 + Windows 260 路径留余量。 */
const SLUG_MAX_LENGTH = 48;

/** Windows 保留设备名（大小写不敏感）。 */
const RESERVED_SEGMENTS = new Set([
  "con", "prn", "aux", "nul",
  "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
  "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
]);

/**
 * 空间名 → 目录名。
 *
 * 规则：去变音符 → 小写 → 非 `[a-z0-9]` 折叠成 `-` → 截断 48 字符。
 * 纯中文/emoji 名称拿不到任何 ASCII 词，退化成 `space-<sha1 前 6 位>`（稳定、可复现）；
 * 界面上始终展示解析后的完整路径，用户能看见自己拿到什么名字。
 */
export function slugifySpaceName(name: string): string {
  const ascii = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/-{2,}/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, SLUG_MAX_LENGTH)
    .replace(/-+$/gu, "");
  if (ascii && !RESERVED_SEGMENTS.has(ascii)) return ascii;
  return `space-${createHash("sha1").update(name, "utf8").digest("hex").slice(0, 6)}`;
}

/** 已存在目录名（小写）集合；容器不存在时视为空。 */
function takenDirectoryNames(container: string): Set<string> {
  const taken = new Set<string>();
  try {
    for (const entry of readdirSync(container, { withFileTypes: true })) {
      if (entry.isDirectory()) taken.add(entry.name.toLowerCase());
    }
  } catch {
    // 容器还不存在：没有占用。
  }
  return taken;
}

/**
 * 去重的目录名：大小写不敏感比较（APFS/HFS+ 默认与 Windows 都不区分大小写），
 * 占用时追加 `-2`、`-3`……，极端情况下回落随机后缀。
 */
export function uniqueSpaceSlug(container: string, base: string): string {
  const taken = takenDirectoryNames(container);
  if (!taken.has(base.toLowerCase())) return base;
  for (let index = 2; index < 1_000; index += 1) {
    const candidate = `${base}-${index}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return `${base}-${randomUUID().slice(0, 8)}`;
}

/** 目录名是否是本应用自己写出的合法 slug（外部目录的 basename 不要求满足）。 */
export function isSafeSlug(value: string): boolean {
  if (!value || value.length > SLUG_MAX_LENGTH) return false;
  if (RESERVED_SEGMENTS.has(value.toLowerCase())) return false;
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value);
}
