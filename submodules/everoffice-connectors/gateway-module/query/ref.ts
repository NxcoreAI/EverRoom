import type { HitKind } from "./types.js";

/**
 * ref 是无状态、可跨进程重启的引用：
 *   base64url(JSON.stringify({v:1,s,c,k,id}))
 * 不落库、不进缓存；read 时按 s/k 找档案，再把 id 映射回详情 action。
 * 值本身可被模型伪造，但只能读到该 token 本来就有权限的数据。
 */
export interface QueryRef {
  v: 1;
  /** service（oo service id） */
  s: string;
  /** connectionName */
  c: string;
  /** 命中类型 */
  k: HitKind;
  /** provider 内的资源 id */
  id: string;
}

const KINDS: readonly HitKind[] = ["mail", "document", "event", "message", "record"];
const SERVICE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const ID_PATTERN = /^[^\u0000-\u001f]{1,512}$/;

export function encodeRef(ref: QueryRef): string {
  return Buffer.from(JSON.stringify(ref), "utf8").toString("base64url");
}

export function decodeRef(value: unknown): QueryRef | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (record.v !== 1) return null;
    const service = record.s;
    const connection = record.c;
    const kind = record.k;
    const id = record.id;
    if (typeof service !== "string" || !SERVICE_PATTERN.test(service)) return null;
    if (typeof connection !== "string" || !SERVICE_PATTERN.test(connection)) return null;
    if (typeof kind !== "string" || !KINDS.includes(kind as HitKind)) return null;
    if (typeof id !== "string" || !ID_PATTERN.test(id)) return null;
    return { v: 1, s: service, c: connection, k: kind as HitKind, id };
  } catch {
    return null;
  }
}
