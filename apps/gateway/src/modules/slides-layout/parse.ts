/**
 * 预设输入的宽松解析助手：工具层 schema 只保证是对象，字段校验集中在这里，
 * 报错文案面向模型可自行修正（PRESET_INVALID 前缀会被 set_page 原样回传）。
 */

export function asObject(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`PRESET_INVALID: ${what} 必须是对象`);
  }
  return value as Record<string, unknown>;
}

export function str(source: Record<string, unknown>, key: string, options: { required?: boolean; max?: number } = {}): string {
  const raw = source[key];
  if (typeof raw !== "string" || !raw.trim()) {
    if (options.required) throw new Error(`PRESET_INVALID: 缺少必填字段 ${key}（字符串）`);
    return "";
  }
  return raw.trim().slice(0, options.max ?? 400);
}

export function num(source: Record<string, unknown>, key: string, fallback?: number): number {
  const raw = source[key];
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    if (fallback === undefined) throw new Error(`PRESET_INVALID: 字段 ${key} 必须是数字`);
    return fallback;
  }
  return raw;
}

export function enumValue<T extends string>(source: Record<string, unknown>, key: string, allowed: readonly T[], fallback: T): T {
  const raw = source[key];
  if (typeof raw !== "string" || !allowed.includes(raw as T)) return fallback;
  return raw as T;
}

export function list(source: Record<string, unknown>, key: string, options: { required?: boolean; min?: number; max?: number } = {}): unknown[] {
  const raw = source[key];
  if (!Array.isArray(raw) || raw.length === 0) {
    if (options.required) throw new Error(`PRESET_INVALID: 缺少必填字段 ${key}（数组）`);
    return [];
  }
  if (options.min !== undefined && raw.length < options.min) {
    throw new Error(`PRESET_INVALID: ${key} 至少 ${options.min} 项，收到 ${raw.length}`);
  }
  if (options.max !== undefined && raw.length > options.max) {
    throw new Error(`PRESET_INVALID: ${key} 最多 ${options.max} 项，收到 ${raw.length}——内容放不下就精简或拆两页`);
  }
  return raw;
}

export function objects(rawList: unknown[], what: string): Record<string, unknown>[] {
  return rawList.map((item, index) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error(`PRESET_INVALID: ${what} 第 ${index + 1} 项必须是对象`);
    }
    return item as Record<string, unknown>;
  });
}

export function strings(rawList: unknown[], what: string, max: number): string[] {
  return rawList.map((item, index) => {
    if (typeof item !== "string" || !item.trim()) {
      throw new Error(`PRESET_INVALID: ${what} 第 ${index + 1} 项必须是非空字符串`);
    }
    return item.trim().slice(0, max);
  });
}
