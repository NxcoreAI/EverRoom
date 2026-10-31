/**
 * `insert_image_base64` 的取图入口：宿主（网关）负责把「图片从哪来」变成字节。
 *
 * - `path`：本地绝对路径（agent 自己生成/用户给的图片文件），网关直接读盘；
 * - `url`：公网 http(s) 图片，逐跳 SSRF 校验后下载（AI 工具入参可被网页内容
 *   诱导，必须挡住环回/内网/云元数据地址）；
 * - `base64`：兼容旧契约，仅转发宿主已拿到的字节。
 *
 * 模型只需要给路径或链接，永远不需要把图片字节抄进工具参数——第一版契约要求
 * inline base64，实测 agent 会把 100~260KB 的 base64 先写进 bash 输出再试图
 * 抄进 tool call，上下文被撑爆且从未成功发起插入（word agent 测试 5.3）。
 */

import { lookup } from "node:dns/promises";
import { readFile } from "node:fs/promises";
import { BlockList, isIP } from "node:net";

import { proxyFetch } from "../../../infrastructure/network/proxy-fetch.js";

/** 渲染端只支持这三种（webp/svg 会被 docx 图片节点拒绝）。 */
export type AgentImageMime = "image/png" | "image/jpeg" | "image/gif";

/** 单张图片来源上限：base64 后约 13.3MB，仍在 office-bridge 的 16MB 请求体内。 */
export const MAX_AGENT_IMAGE_BYTES = 10 * 1024 * 1024;

const MIN_IMAGE_WIDTH_PX = 16;
const MAX_IMAGE_WIDTH_PX = 1200;
const DEFAULT_IMAGE_WIDTH_PX = 480;
const DEFAULT_IMAGE_LABEL = "Illustration";
const MAX_IMAGE_LABEL_LENGTH = 80;
const FETCH_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;

/** 测试注入点（生产走真实 fs / dns / 带代理的 fetch）。 */
export interface AgentImageDeps {
  readFileImpl?: (path: string) => Promise<Buffer>;
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
  lookupImpl?: (host: string) => Promise<Array<{ address: string }>>;
  maxBytes?: number;
  /**
   * EverRoom 文件库图片：模型说“刚上传的 logo / 之前生成的那张图”时只拿得到
   * fileId，宿主按 fileId 取当前版本字节（非图片/不存在返回 null）。
   */
  readLibraryFile?: (fileId: string) => Promise<Buffer | null>;
}

export interface ResolvedAgentImageInput {
  base64: string;
  mime: AgentImageMime;
  afterIndex: number;
  maxWidthPx: number;
  label: string;
}

function formatMegabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function tooLargeError(bytes: number, maxBytes: number): Error {
  return new Error(
    `INVALID_REQUEST: 图片 ${formatMegabytes(bytes)} 超过上限 ${formatMegabytes(maxBytes)}，请先压缩或缩小尺寸`,
  );
}

/** 按魔数识别图片类型；只认渲染端能落盘的三类。 */
export function sniffImageMime(buffer: Buffer): AgentImageMime | null {
  if (buffer.length >= 8
    && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47
    && buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a) {
    return "image/png";
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  const head = buffer.length >= 6 ? buffer.toString("latin1", 0, 6) : "";
  if (head === "GIF87a" || head === "GIF89a") return "image/gif";
  return null;
}

/** 非公网地址段（与 genoffice packages/electron-utils/src/safe-remote-url.ts 同口径）。 */
const blockedAddresses = (() => {
  const list = new BlockList();
  list.addSubnet("0.0.0.0", 8); // "this network"
  list.addSubnet("10.0.0.0", 8); // private
  list.addSubnet("100.64.0.0", 10); // carrier NAT
  list.addSubnet("127.0.0.0", 8); // loopback
  list.addSubnet("169.254.0.0", 16); // link-local（云元数据）
  list.addSubnet("172.16.0.0", 12); // private
  list.addSubnet("192.0.0.0", 24); // IETF protocol assignments
  list.addSubnet("192.168.0.0", 16); // private
  list.addSubnet("198.18.0.0", 15); // benchmarking
  list.addSubnet("224.0.0.0", 4); // multicast
  list.addSubnet("240.0.0.0", 4); // reserved + broadcast
  list.addAddress("::", "ipv6");
  list.addAddress("::1", "ipv6");
  list.addSubnet("::", 96, "ipv6"); // deprecated IPv4-compatible
  list.addSubnet("64:ff9b::", 96, "ipv6"); // NAT64
  list.addSubnet("fc00::", 7, "ipv6"); // unique local
  list.addSubnet("fe80::", 10, "ipv6"); // link-local
  list.addSubnet("ff00::", 8, "ipv6"); // multicast
  return list;
})();

const BLOCKED_HOST_SUFFIXES: readonly string[] = [".localhost", ".local", ".internal"];

function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return true;
  return blockedAddresses.check(address, family === 4 ? "ipv4" : "ipv6");
}

/** http(s) 且主机在公网：字面 IP 直接判；域名解析后每个地址都必须通过。 */
export async function isPublicImageUrl(
  raw: string,
  lookupImpl: AgentImageDeps["lookupImpl"] = (host) => lookup(host, { all: true }),
): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.username || url.password) return false;
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host) return false;
  if (isIP(host)) return !isBlockedAddress(host);
  if (host === "localhost" || BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) return false;
  try {
    const addresses = await (lookupImpl ?? ((target: string) => lookup(target, { all: true })))(host);
    return addresses.length > 0 && addresses.every((entry) => !isBlockedAddress(entry.address));
  } catch {
    return false;
  }
}

async function downloadRemoteImage(
  rawUrl: string,
  deps: AgentImageDeps,
  maxBytes: number,
): Promise<Buffer> {
  const fetchImpl = deps.fetchImpl ?? proxyFetch;
  let current = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!(await isPublicImageUrl(current, deps.lookupImpl))) {
      throw new Error("INVALID_REQUEST: 图片 URL 只允许公网 http(s) 地址（内网/环回/本机地址已拒绝）");
    }
    const response = await fetchImpl(current, {
      redirect: "manual",
      headers: {
        "user-agent": "Mozilla/5.0",
        accept: "image/png,image/jpeg,image/gif,image/*;q=0.8,*/*;q=0.5",
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error("IMAGE_DOWNLOAD_FAILED: 图片 URL 重定向缺少 Location");
      try {
        current = new URL(location, current).toString();
      } catch {
        throw new Error("IMAGE_DOWNLOAD_FAILED: 图片 URL 重定向地址不合法");
      }
      continue;
    }
    if (!response.ok) {
      throw new Error(`IMAGE_DOWNLOAD_FAILED: 下载图片失败（HTTP ${response.status}）`);
    }
    const declared = Number(response.headers.get("content-length") ?? Number.NaN);
    if (Number.isFinite(declared) && declared > maxBytes) throw tooLargeError(declared, maxBytes);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) throw tooLargeError(buffer.byteLength, maxBytes);
    return buffer;
  }
  throw new Error("IMAGE_DOWNLOAD_FAILED: 图片 URL 重定向次数过多");
}

async function readLocalImage(path: string, deps: AgentImageDeps, maxBytes: number): Promise<Buffer> {
  const readFileImpl = deps.readFileImpl ?? ((target: string) => readFile(target));
  let buffer: Buffer;
  try {
    buffer = await readFileImpl(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "";
    if (code === "ENOENT") {
      throw new Error(`INVALID_REQUEST: 找不到图片文件 ${path}（path 必须是 agent/用户本机可读的绝对路径）`);
    }
    if (code === "EISDIR") throw new Error(`INVALID_REQUEST: ${path} 是目录，不是图片文件`);
    if (code === "EACCES" || code === "EPERM") throw new Error(`INVALID_REQUEST: 没有权限读取图片文件 ${path}`);
    throw new Error(`INVALID_REQUEST: 读取图片文件失败：${error instanceof Error ? error.message : String(error)}`);
  }
  if (buffer.byteLength > maxBytes) throw tooLargeError(buffer.byteLength, maxBytes);
  return buffer;
}

/** data URL 前缀（模型有时会连前缀一起抄）：只接受 base64 形式。 */
function stripDataUrlPrefix(value: string): string {
  const comma = value.indexOf(",");
  if (!value.startsWith("data:") || comma < 0) return value;
  return value.slice(comma + 1);
}

function normalizeInteger(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

/**
 * 把 insert_image_base64 的入参归一化成渲染端契约：{base64, mime, afterIndex, maxWidthPx, label}。
 * 来源优先级 path > url > base64；解析失败抛 INVALID_REQUEST/IMAGE_DOWNLOAD_FAILED。
 */
export async function resolveAgentImageInput(
  raw: Record<string, unknown>,
  deps: AgentImageDeps = {},
): Promise<ResolvedAgentImageInput> {
  const maxBytes = deps.maxBytes ?? MAX_AGENT_IMAGE_BYTES;
  const afterIndex = normalizeInteger(raw.afterIndex, -1);
  const maxWidthPx = Math.min(
    MAX_IMAGE_WIDTH_PX,
    Math.max(MIN_IMAGE_WIDTH_PX, normalizeInteger(raw.maxWidthPx, DEFAULT_IMAGE_WIDTH_PX)),
  );
  const rawLabel = typeof raw.label === "string" ? raw.label.trim() : "";
  const label = (rawLabel || DEFAULT_IMAGE_LABEL).slice(0, MAX_IMAGE_LABEL_LENGTH);
  const path = typeof raw.path === "string" ? raw.path.trim() : "";
  const url = typeof raw.url === "string" ? raw.url.trim() : "";
  const fileId = typeof raw.fileId === "string" ? raw.fileId.trim() : "";
  const base64Input = typeof raw.base64 === "string" ? raw.base64 : "";

  let buffer: Buffer;
  if (path) {
    if (!path.startsWith("/")) {
      throw new Error("INVALID_REQUEST: path 必须是绝对路径（例如 /tmp/scene.png）");
    }
    buffer = await readLocalImage(path, deps, maxBytes);
  } else if (url) {
    buffer = await downloadRemoteImage(url, deps, maxBytes);
  } else if (fileId) {
    if (!deps.readLibraryFile) {
      throw new Error("INVALID_REQUEST: 当前环境不支持 fileId 图片；请改用 path（本地图片绝对路径）或 url");
    }
    const bytes = await deps.readLibraryFile(fileId).catch(() => null);
    if (!bytes || bytes.byteLength === 0) {
      throw new Error(`FILE_NOT_FOUND: 文件库里没有 ${fileId} 的图片字节（可能不是图片或已删除）`);
    }
    buffer = bytes;
  } else if (base64Input.trim()) {
    const compact = stripDataUrlPrefix(base64Input).replace(/\s+/g, "");
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact) || compact.length % 4 !== 0) {
      throw new Error("INVALID_REQUEST: base64 不是合法的标准 base64；请改用 path（本地图片路径）或 url");
    }
    buffer = Buffer.from(compact, "base64");
  } else {
    throw new Error(
      "INVALID_REQUEST: 需要图片来源之一：fileId（文件库图片）、path（本地图片绝对路径）、url（公网图片地址）或 base64",
    );
  }

  if (buffer.byteLength === 0) throw new Error("INVALID_REQUEST: 图片字节为空");
  if (buffer.byteLength > maxBytes) throw tooLargeError(buffer.byteLength, maxBytes);
  const mime = sniffImageMime(buffer);
  if (!mime) {
    throw new Error("INVALID_REQUEST: 不支持的图片格式（只支持 PNG/JPEG/GIF，webp/svg 请先转换）");
  }
  return { base64: buffer.toString("base64"), mime, afterIndex, maxWidthPx, label };
}