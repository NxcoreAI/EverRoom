import { access, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DATA_TYPES, dataTypeDef, IngestError, type Pipelines } from "./types.js";

/**
 * 链路策略（unified-ingest-plan §6，2026-08-19 修订）：策略不是用户数据，分两层文件——
 *
 *   ① 工程默认层：`apps/gateway/ingest-policy-defaults.json`（随代码进 git，
 *      工程师改默认策略在这里，无需动 TS 代码）；
 *   ② 部署覆盖层：`<dataDir>/ingest-policies.json`（运行环境改，不动代码仓库）。
 *
 * 读取顺序：请求覆盖 > ②部署覆盖 > ①工程默认 > 代码注册表兜底 defaults。
 * 两层文件同格式同校验：缺文件 = 该层不存在；坏 JSON / 未知类型 / 非法组合
 * 只告警跳过，绝不阻塞启动。
 *
 * 组合语义（U2）：wiki 无 Room 不存在——room=false && wiki=true 非法；
 * 三链路全关非法（至少进一条链路才有"进入"的意义）。
 */

/** 部署覆盖层文件名（dataDir 下）。 */
export const POLICY_FILE_NAME = "ingest-policies.json";
/** 工程默认层文件名（gateway 包根，随仓库走）。 */
export const PROJECT_POLICY_DEFAULTS_FILE = "ingest-policy-defaults.json";

/** 校验开关组合；返回错误码或 null（合法）。 */
export function validatePipelines(
  pipelines: Pipelines,
): "invalid_pipelines" | "no_pipelines" | null {
  if (!pipelines.room && pipelines.wiki) return "invalid_pipelines";
  if (!pipelines.room && !pipelines.wiki && !pipelines.memory) return "no_pipelines";
  return null;
}

/** 单层文件加载结果（<dataType> → 开关组合）。 */
export type PolicyOverrides = ReadonlyMap<string, Pipelines>;

/** IngestService 持有的两层策略（project=工程默认层，deploy=部署覆盖层）。 */
export interface PolicyLayers {
  project: PolicyOverrides;
  deploy: PolicyOverrides;
}

export function emptyPolicyLayers(): PolicyLayers {
  return { project: new Map(), deploy: new Map() };
}

function pipelinesOf(value: unknown): Pipelines | null {
  if (typeof value !== "object" || value === null) return null;
  const { room, wiki, memory } = value as Record<string, unknown>;
  if (typeof room !== "boolean" || typeof wiki !== "boolean" || typeof memory !== "boolean") {
    return null;
  }
  return { room, wiki, memory };
}

/** 解析一层策略文件文本（两层共用：同格式同校验，坏条目告警跳过）。 */
function parsePolicyFile(
  raw: string,
  where: string,
  warn: (message: string) => void,
): Map<string, Pipelines> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    warn(`${where}JSON 解析失败（${error instanceof Error ? error.message : String(error)}），忽略该层全部条目`);
    return new Map();
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    warn(`${where}顶层必须是 { "<dataType>": {room,wiki,memory} } 对象，忽略该层全部条目`);
    return new Map();
  }
  const map = new Map<string, Pipelines>();
  for (const [key, value] of Object.entries(parsed)) {
    if (key.startsWith("$")) continue; // $comment 等元信息键
    if (!dataTypeDef(key)) {
      warn(`${where}未知数据类型 "${key}"，跳过`);
      continue;
    }
    const pipelines = pipelinesOf(value);
    if (!pipelines) {
      warn(`${where}"${key}" 需要 {room,wiki,memory} 全布尔字段，跳过`);
      continue;
    }
    const invalid = validatePipelines(pipelines);
    if (invalid) {
      warn(
        `${where}"${key}" 组合非法（${
          pipelines.room === false && pipelines.wiki
            ? "wiki 依赖 Room：room=false 时 wiki 必须为 false"
            : "至少需要开启一条链路（room/wiki/memory）"
        }），跳过`,
      );
      continue;
    }
    map.set(key, pipelines);
  }
  return map;
}

async function loadLayer(
  path: string,
  where: string,
  warn: (message: string) => void,
): Promise<Map<string, Pipelines>> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return new Map(); // 缺文件：该层不存在
  }
  return parsePolicyFile(raw, where, warn);
}

/** 读部署覆盖层 <dataDir>/ingest-policies.json。 */
export function loadPolicyOverrides(
  dataDir: string,
  warn: (message: string) => void,
): Promise<PolicyOverrides> {
  return loadLayer(join(dataDir, POLICY_FILE_NAME), `${POLICY_FILE_NAME}：`, warn);
}

/**
 * 工程默认层文件位置：从本模块目录逐级上溯找 ingest-policy-defaults.json。
 * dev/vitest：src/modules/ingest 上溯 3 级到包根；tsup 打包后 bundle 在 dist/
 * （build 脚本会拷一份进 dist）上溯 1 级即包根。找不到返回 null（走代码兜底）。
 */
export async function projectPolicyDefaultsPath(): Promise<string | null> {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  let directory = moduleDirectory;
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = join(directory, PROJECT_POLICY_DEFAULTS_FILE);
    try {
      await access(candidate);
      return candidate;
    } catch {
      // 继续上溯
    }
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
  return null;
}

/** 读工程默认层（缺文件 = 空 = 全走代码兜底）。测试可传显式路径。 */
export async function loadProjectDefaults(
  warn: (message: string) => void,
  path?: string,
): Promise<PolicyOverrides> {
  const file = path ?? (await projectPolicyDefaultsPath());
  if (!file) return new Map();
  return loadLayer(file, `${PROJECT_POLICY_DEFAULTS_FILE}：`, warn);
}

/**
 * 解析某类型的生效策略：请求级覆盖 > 部署覆盖 > 工程默认 > 注册表兜底 defaults。
 * 覆盖会整体替换（不做逐字段合并——语义是"这套组合"而非补丁）。
 */
export function resolvePipelines(
  dataType: string,
  override: Pipelines | undefined,
  layers: PolicyLayers,
): Pipelines {
  const source = override
    ?? layers.deploy.get(dataType)
    ?? layers.project.get(dataType)
    ?? dataTypeDef(dataType)?.defaults;
  if (!source) throw new IngestError(`未知数据类型：${dataType}`, "unknown_data_type");
  return { room: source.room, wiki: source.wiki, memory: source.memory };
}

/** 只读展示数据源：注册表全量 ⨝ 两层文件，标注生效策略来源。 */
export interface PolicyView {
  key: string;
  label: string;
  matchExtensions: string[];
  jsonType: string | null;
  /** 代码注册表兜底 defaults。 */
  defaults: Pipelines;
  /** 工程默认层条目（无则 null）。 */
  projectDefaults: Pipelines | null;
  /** 部署覆盖层条目（无则 null）。 */
  fileOverride: Pipelines | null;
  effective: Pipelines;
  /** 生效策略来自哪层：code | project | deploy。 */
  source: "code" | "project" | "deploy";
}

export function listPolicyViews(layers: PolicyLayers): PolicyView[] {
  return DATA_TYPES.map((def) => {
    const projectDefaults = layers.project.get(def.key) ?? null;
    const fileOverride = layers.deploy.get(def.key) ?? null;
    const effective = fileOverride ?? projectDefaults ?? def.defaults;
    const source = fileOverride ? "deploy" : projectDefaults ? "project" : "code";
    return {
      key: def.key,
      label: def.label,
      matchExtensions: def.matchExtensions,
      jsonType: def.jsonType ?? null,
      defaults: def.defaults,
      projectDefaults,
      fileOverride,
      effective,
      source,
    };
  });
}
