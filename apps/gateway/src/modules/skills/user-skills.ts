import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

import JSZip from "jszip";

import { parseSkillMarkdown } from "./skill-markdown.js";

/**
 * 用户自己加的技能（「技能」页的「新增 / 删除」）。
 *
 * 为什么不写进 `agents/<agent>/skills`：那是随应用发布的只读资源（打包后在
 * asar / 安装目录内，写不进去也不该写）。用户技能落在网关数据目录下
 * `<dataDir>/agent/skills/<目录名>/`，磁盘形态与内置技能一致（一个目录 +
 * SKILL.md + 可选附属文件），因此目录读取、正文展示、启停记录三处都能复用。
 *
 * 用同步 fs：与内置 bundle 的加载方式一致（见 agent/builtin-bundles.ts），
 * 这样运行时装配（每次新建 runtime 都要问「用户技能有哪些」）保持同步、
 * 没有「缓存还没热」的空窗期；读写量是几个小文件，用户操作时才发生。
 *
 * 写盘约束（全部在服务端校验，不依赖 UI）：
 * - 目录名只允许单段（不含路径分隔符、`..`、控制字符），长度 ≤ 64；
 * - SKILL.md 必须存在、是普通文件、不是符号链接；
 * - 单文件 ≤ 256KB、总字节 ≤ 2MB、文件数 ≤ 64（技能是给模型读的说明，不是仓库）；
 * - 导入只从用户显式选择的绝对路径复制，复制过程中拒绝符号链接。
 */

/** 用户技能在 catalog 里的 ownerId（ownerKind = "user"）。 */
export const USER_SKILL_OWNER_ID = "local";

const MAX_FILE_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 64;
const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 500;

export interface UserSkillFile {
  /** 目录名（= 技能在用户技能根下的稳定标识）。 */
  directoryName: string;
  /** SKILL.md frontmatter 的 name（注入系统提示词的键）。 */
  name: string;
  description: string;
  /** SKILL.md 全文。 */
  prompt: string;
  bytes: number;
  /** 目录内文件数（含 SKILL.md）。 */
  fileCount: number;
  /** 磁盘上的目录（排障用，不对外展示）。 */
  directory: string;
}

export interface CreateUserSkillInput {
  name: string;
  description: string;
  /** SKILL.md 的正文（frontmatter 由服务端生成）。 */
  body: string;
}

export type SkillInputErrorCode =
  | "skill_name_invalid"
  | "skill_name_taken"
  | "skill_description_required"
  | "skill_body_required"
  | "skill_source_invalid"
  | "skill_source_missing_manifest"
  | "skill_source_too_large"
  | "skill_archive_invalid"
  | "skill_not_found"
  | "skill_not_removable";

/** 可预期的用户输入错误（路由层翻成 4xx，不当作 500）。 */
export class SkillInputError extends Error {
  constructor(readonly code: SkillInputErrorCode, message?: string) {
    super(message ?? code);
  }
}

/** 目录名合法：单段、可读、能在 URL 里原样出现。 */
export function assertSkillDirectoryName(raw: string): string {
  const name = raw.trim();
  if (!name || name.length > MAX_NAME_LENGTH) throw new SkillInputError("skill_name_invalid");
  if (name === "." || name === ".." || name.startsWith(".")) throw new SkillInputError("skill_name_invalid");
  if (name.includes("/") || name.includes("\\")) throw new SkillInputError("skill_name_invalid");
  // 控制字符（含换行/制表）会让目录名在日志与 URL 里都不可读。
  if ([...name].some((char) => char.codePointAt(0)! < 0x20 || char.codePointAt(0) === 0x7f)) {
    throw new SkillInputError("skill_name_invalid");
  }
  return name;
}

function singleLine(value: string, limit: number): string {
  return value.replace(/\s+/g, " ").trim().slice(0, limit);
}

/** 组装 SKILL.md：frontmatter 只有 name / description 两个平面键。 */
export function buildSkillMarkdown(input: CreateUserSkillInput): string {
  const name = singleLine(input.name, MAX_NAME_LENGTH);
  const description = singleLine(input.description, MAX_DESCRIPTION_LENGTH);
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${input.body.trim()}\n`;
}

interface CollectedFile {
  relativePath: string;
  bytes: number;
}

export class UserSkillStore {
  constructor(private readonly rootDir: string) {}

  /** 用户技能根目录（首次写入时才创建）。 */
  get root(): string {
    return this.rootDir;
  }

  list(): UserSkillFile[] {
    let entries: string[];
    try {
      entries = readdirSync(this.rootDir);
    } catch {
      return [];
    }
    return entries
      .filter((entry) => !entry.startsWith("."))
      .sort((left, right) => left.localeCompare(right))
      .flatMap((directoryName): UserSkillFile[] => {
        const skill = this.readOrNull(directoryName);
        return skill ? [skill] : [];
      });
  }

  read(directoryName: string): UserSkillFile | null {
    return this.readOrNull(directoryName);
  }

  /** 手写一个技能：生成 SKILL.md 并落盘。 */
  create(input: CreateUserSkillInput): UserSkillFile {
    const directoryName = assertSkillDirectoryName(input.name);
    if (!singleLine(input.description, MAX_DESCRIPTION_LENGTH)) {
      throw new SkillInputError("skill_description_required");
    }
    if (!input.body.trim()) throw new SkillInputError("skill_body_required");
    this.assertAvailable(directoryName);

    const markdown = buildSkillMarkdown(input);
    if (Buffer.byteLength(markdown, "utf8") > MAX_FILE_BYTES) {
      throw new SkillInputError("skill_source_too_large");
    }
    const directory = this.directoryOf(directoryName);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "SKILL.md"), markdown, "utf8");
    const created = this.readOrNull(directoryName);
    if (!created) throw new SkillInputError("skill_source_invalid");
    return created;
  }

  /**
   * 从本地文件夹或 zip 导入：只读复制（拒绝符号链接），目录名取 SKILL.md 的
   * name，缺失时退回来源文件夹名（zip 时退回压缩包名去扩展名）。
   *
   * zip 的解析规则：条目路径拒绝绝对路径与 `..` 穿越；SKILL.md 允许在压缩包
   * 根，也允许在唯一的一层子目录里（`my-skill.zip → my-skill/SKILL.md` 是
   * 系统右键压缩的常见形态），导入时把该子目录当技能根。
   */
  importDirectory(source: string): Promise<UserSkillFile> {
    // 只接受绝对路径（桌面端从系统选择器拿到的就是绝对路径）。
    if (!source.trim() || !isAbsolute(source)) {
      throw new SkillInputError("skill_source_invalid");
    }
    const resolvedSource = resolve(source);
    const stats = statSync(resolvedSource, { throwIfNoEntry: false });
    if (!stats) throw new SkillInputError("skill_source_invalid");

    if (stats.isFile()) {
      // zip 压缩包：先解到临时目录，再走与文件夹完全相同的校验/复制路径。
      if (!resolvedSource.toLowerCase().endsWith(".zip")) {
        throw new SkillInputError("skill_source_invalid");
      }
      return this.extractZipToTemp(resolvedSource)
        .then((extracted) => Promise.resolve()
          .then(() => this.importFromDirectoryTree(extracted, basename(resolvedSource, ".zip")))
          .finally(() => { rmSync(extracted, { recursive: true, force: true }) }));
    }
    if (!stats.isDirectory()) throw new SkillInputError("skill_source_invalid");
    return Promise.resolve(this.importFromDirectoryTree(resolvedSource, basename(resolvedSource)));
  }

  /** 文件夹导入的共用路径：source 是已就位的目录树，fallbackName 用于目录名兜底。 */
  private importFromDirectoryTree(source: string, fallbackName: string): UserSkillFile {
    const skillRoot = resolveSingleWrapper(source);
    const files = collectFiles(skillRoot);
    if (!files.some((file) => file.relativePath === "SKILL.md")) {
      throw new SkillInputError("skill_source_missing_manifest");
    }
    const markdown = readFileSync(join(skillRoot, "SKILL.md"), "utf8");
    const meta = parseSkillMarkdown(markdown);
    const directoryName = assertSkillDirectoryName(meta.name.trim() || fallbackName);
    this.assertAvailable(directoryName);

    // 先写进同级临时目录再改名：中途失败不会留下半个技能。
    mkdirSync(this.rootDir, { recursive: true });
    const staging = mkdtempSync(join(this.rootDir, ".import-"));
    try {
      for (const file of files) {
        const target = join(staging, file.relativePath);
        if (!target.startsWith(`${staging}${sep}`)) throw new SkillInputError("skill_source_invalid");
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, readFileSync(join(skillRoot, file.relativePath)));
      }
      renameSync(staging, this.directoryOf(directoryName));
    } catch (error) {
      rmSync(staging, { recursive: true, force: true });
      if (error instanceof SkillInputError) throw error;
      throw new SkillInputError("skill_source_invalid", errorMessage(error));
    }
    const imported = this.readOrNull(directoryName);
    if (!imported) throw new SkillInputError("skill_source_invalid");
    return imported;
  }

  /**
   * 解压 zip 到临时目录并返回该目录：
   * - 条目路径先做安全校验（拒绝绝对路径、盘符、`..`、反斜杠归一后越界）；
   * - 目录条目（以 / 结尾）跳过（mkdirSync 递归创建即可）；
   * - 解压后若根下只有一个目录且没有散文件，返回那个子目录（单层包裹）；
   *   否则返回解压根（SKILL.md 应在根下）。
   */
  private async extractZipToTemp(zipPath: string): Promise<string> {
    let zip: JSZip;
    try {
      zip = await JSZip.loadAsync(readFileSync(zipPath));
    } catch {
      throw new SkillInputError("skill_archive_invalid", "zip is unreadable or corrupted");
    }
    const outRoot = mkdtempSync(join(tmpdir(), "everroom-skill-zip-"));
    try {
      const entries = Object.values(zip.files);
      for (const entry of entries) {
        if (entry.dir) continue;
        const entryName = entry.name.replace(/\\/g, "/");
        if (!entryName || entryName.startsWith("/") || /^[a-zA-Z]:/.test(entryName)) {
          throw new SkillInputError("skill_archive_invalid", `unsafe entry name: ${entry.name}`);
        }
        if (entryName.split("/").some((segment) => segment === ".." || segment === "")) {
          throw new SkillInputError("skill_archive_invalid", `unsafe entry name: ${entry.name}`);
        }
        const target = join(outRoot, entryName);
        if (!target.startsWith(`${outRoot}${sep}`)) {
          throw new SkillInputError("skill_archive_invalid", `entry escapes archive root: ${entry.name}`);
        }
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, await entry.async("nodebuffer"));
      }
    } catch (error) {
      rmSync(outRoot, { recursive: true, force: true });
      if (error instanceof SkillInputError) throw error;
      throw new SkillInputError("skill_archive_invalid", errorMessage(error));
    }
    return outRoot;
  }

  /** 删除一个用户技能目录。 */
  remove(directoryName: string): void {
    const directory = this.directoryOf(directoryName);
    const stats = lstatSync(directory, { throwIfNoEntry: false });
    if (!stats) throw new SkillInputError("skill_not_found");
    // directoryOf 已保证在根目录内；这里再挡一层符号链接目录（删链接不删目标）。
    if (stats.isSymbolicLink() || !stats.isDirectory()) throw new SkillInputError("skill_not_found");
    rmSync(directory, { recursive: true, force: true });
  }

  private readOrNull(directoryName: string): UserSkillFile | null {
    let directory: string;
    try {
      directory = this.directoryOf(directoryName);
    } catch {
      return null;
    }
    const skillFile = join(directory, "SKILL.md");
    const stats = lstatSync(skillFile, { throwIfNoEntry: false });
    if (!stats?.isFile() || stats.isSymbolicLink()) return null;
    const prompt = readFileSync(skillFile, "utf8").trim();
    const meta = parseSkillMarkdown(prompt);
    return {
      directoryName,
      name: meta.name || directoryName,
      description: meta.description,
      prompt,
      bytes: Buffer.byteLength(prompt, "utf8"),
      fileCount: countFiles(directory),
      directory,
    };
  }

  /** 目录名 → 绝对路径；任何越界（`..`、分隔符）都在这里被拒。 */
  private directoryOf(directoryName: string): string {
    const name = assertSkillDirectoryName(directoryName);
    const root = resolve(this.rootDir);
    const target = resolve(root, name);
    if (target !== join(root, name) || !target.startsWith(`${root}${sep}`)) {
      throw new SkillInputError("skill_name_invalid");
    }
    return target;
  }

  private assertAvailable(directoryName: string): void {
    if (lstatSync(this.directoryOf(directoryName), { throwIfNoEntry: false })) {
      throw new SkillInputError("skill_name_taken");
    }
  }
}

/** 递归收集待复制文件（拒绝符号链接与非普通文件，并卡住总量）。 */
function collectFiles(root: string, relativeRoot = ""): CollectedFile[] {
  const directory = relativeRoot ? join(root, relativeRoot) : root;
  const files: CollectedFile[] = [];
  let totalBytes = 0;
  for (const entry of readdirSync(directory)) {
    const relativePath = relativeRoot ? join(relativeRoot, entry) : entry;
    const absolutePath = join(root, relativePath);
    const stats = lstatSync(absolutePath, { throwIfNoEntry: false });
    if (!stats) throw new SkillInputError("skill_source_invalid");
    if (stats.isSymbolicLink()) {
      throw new SkillInputError("skill_source_invalid", "symbolic link is not allowed");
    }
    if (stats.isDirectory()) {
      files.push(...collectFiles(root, relativePath));
      continue;
    }
    if (!stats.isFile()) throw new SkillInputError("skill_source_invalid");
    if (stats.size > MAX_FILE_BYTES) throw new SkillInputError("skill_source_too_large");
    totalBytes += stats.size;
    if (totalBytes > MAX_TOTAL_BYTES) throw new SkillInputError("skill_source_too_large");
    if (files.length >= MAX_FILES) throw new SkillInputError("skill_source_too_large");
    files.push({ relativePath, bytes: stats.size });
  }
  return files;
}

function countFiles(directory: string): number {
  let total = 0;
  for (const entry of readdirSync(directory)) {
    const stats = lstatSync(join(directory, entry), { throwIfNoEntry: false });
    if (!stats) continue;
    if (stats.isDirectory()) total += countFiles(join(directory, entry));
    else total += 1;
  }
  return total;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 单层包裹归一：macOS 右键压缩文件夹得到 `my-skill.zip → my-skill/…`，
 * 解压后根下只有一个目录且没有散文件时，把那个目录当技能根。
 * 其余形态（SKILL.md 在根下、多个顶层条目）原样返回。
 */
function resolveSingleWrapper(root: string): string {
  const entries = readdirSync(root).filter((entry) => !entry.startsWith("."));
  if (entries.length !== 1) return root;
  const only = join(root, entries[0]!);
  const stats = lstatSync(only, { throwIfNoEntry: false });
  return stats?.isDirectory() ? only : root;
}
