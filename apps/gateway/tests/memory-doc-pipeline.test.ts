/**
 * md 一等记忆来源全链路 e2e（docs/memory-md-source-plan.md §9/§10）。
 *
 * 真实链路：renderer 同款调用面（MemoryService + MemoryCoreClient）
 *   → MemoryCore 子进程（git 依赖安装的真实 fork，tsx 直跑 src/gateway/server.ts）
 *   → mock OpenAI 兼容 LLM（本地 http 服务，按提示词标记回放提炼 JSON）。
 *
 * 验收：
 *   ① 多级标题 md 导入 → 资产化（对象库 + uploaded_files/parsed_contents，不触发 wiki 路由）
 *   ② L1 文档派生原子（work_fact）→ 溯源（kind=document + 标题路径/行区间锚点）
 *   ③ 新会话召回（atomic/search 命中文档派生原子）
 *   ④ L0 文档会话标注可过滤（sourceKind 过滤）+ conversation/search 默认不混入文档块
 *   ⑤ 重导判重 / 同名升版级联（旧原子与旧块清除）/ 删除无残留（资产层保留）
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  MemoryCoreClient,
  type MemoryRuntimeConfig,
} from "@nxcore/agent-runtime-pi";
import type { FastifyBaseLogger } from "fastify";
import { createDatabase, type DatabaseClient } from "../src/infrastructure/database/client.js";
import {
  contentHashOf,
  fileIdOf,
  storageRelPath,
} from "../src/modules/knowledge/file-storage.js";
import { MemoryService } from "../src/modules/memory/service.js";

/** 起子进程 + 冷编译 tsx 的宽限（MemoryCoreSupervisor 实测可超一分钟）。 */
const STARTUP_TIMEOUT_MS = 180_000;
/** 异步提炼轮询窗口：一次本地 mock LLM 调用 + 管线调度，远用不了这么久。 */
const EXTRACTION_TIMEOUT_MS = 45_000;
const POLL_INTERVAL_MS = 250;

const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as unknown as FastifyBaseLogger;

const memoryPackageName = "@tencentdb-agent-memory/memory-tencentdb-v2";
const here = fileURLToPath(new URL(".", import.meta.url));

// ── 文档夹具：多级标题 + 只出现在文档里的检索标记 ──
const DOC_FILENAME = "部署手册.md";
const DOC_TITLE = "部署手册";
const MD_V1 = [
  "# 部署手册",
  "",
  "## 环境准备",
  "准备依赖与镜像，镜像来自内部仓库 nexcore/everroom。",
  "",
  "### 镜像来源",
  "镜像标记 qx-phoenix-2026 只出现在文档正文里。",
  "",
  "## 上线步骤",
  "执行健康检查后灰度发布。",
  "",
].join("\n");
const MD_V2 = [
  "# 部署手册",
  "",
  "## 环境准备",
  "准备依赖与镜像，镜像来自内部仓库 nexcore/everroom。",
  "",
  "### 镜像来源",
  "镜像标记 docmark-v2 只出现在第二版正文里。",
  "",
  "## 上线步骤",
  "执行健康检查后灰度发布。",
  "",
  "## 回滚预案",
  "灰度异常时按预案回滚到上一稳定版本。",
  "",
].join("\n");

const CHAT_SESSION = "chat-e2e-session-1";

/** 轮询直到 probe 返回非 null；超时抛错并附 MemoryCore 子进程日志尾部。 */
async function until<T>(
  what: string,
  timeoutMs: number,
  probe: () => Promise<T | null>,
  detail: () => string = () => "",
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== null && value !== undefined) return value;
    if (Date.now() > deadline) {
      const extra = detail();
      throw new Error(`timed out waiting for ${what}${extra ? `\n${extra}` : ""}`);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, POLL_INTERVAL_MS));
  }
}

interface E2E {
  rootDir: string;
  gatewayDataDir: string;
  core: ChildProcess;
  coreLogs: string[];
  mockLlm: Server;
  service: MemoryService;
  client: MemoryCoreClient;
  database: DatabaseClient;
}

let e2e: E2E | null = null;

/** mock OpenAI 兼容 LLM：按用户提示词里的管线标记回放对应的提炼 JSON。 */
function startMockLlm(): Promise<Server> {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      let prompt = "";
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { messages?: Array<{ role: string; content: string }> };
        prompt = (body.messages ?? []).map((message) => message.content ?? "").join("\n");
      } catch {
        prompt = "";
      }
      const ids = [...prompt.matchAll(/\[([^\]\s]+)\] \[(?:user|assistant)\]/g)].map((match) => match[1]!);
      let content = "[]";
      if (prompt.includes("【待提取的文档分块】")) {
        // 文档模式：一个以文档标题命名的场景 + 一条 work_fact（按版本标记区分内容）
        const fact = prompt.includes("docmark-v2")
          ? "文档事实：灰度异常时按部署手册预案回滚（docfact-v2）。"
          : "文档事实：镜像来自内部仓库 nexcore/everroom（docfact-v1）。";
        content = JSON.stringify([{
          scene_name: DOC_TITLE,
          message_ids: ids,
          memories: [{
            content: fact,
            type: "work_fact",
            priority: 85,
            source_message_ids: ids,
            metadata: {},
          }],
        }]);
      } else if (prompt.includes("【待提取的新消息】")) {
        content = JSON.stringify([{
          scene_name: "闲聊",
          message_ids: ids,
          memories: [{
            content: "用户提到凤凰木联络暗号（chatfact-e2e）。",
            type: "episodic",
            priority: 60,
            source_message_ids: ids,
            metadata: {},
          }],
        }]);
      }
      const payload = JSON.stringify({
        id: "chatcmpl-mock",
        object: "chat.completion",
        created: 0,
        model: "test-model",
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(payload);
    });
  });
  return new Promise((resolveServer) => server.listen(0, "127.0.0.1", () => resolveServer(server)));
}

function freePort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address == null || typeof address === "string") {
        rejectPort(new Error("no port"));
        return;
      }
      const { port } = address;
      probe.close(() => resolvePort(port));
    });
  });
}

function resolveCorePackage(): { packageDirectory: string; tsxEntryUrl: string } {
  // 与 MemoryCoreSupervisor 同款解析：NXCORE_MEMORY_CORE_DIR 优先（本地开发指向
  // fork 工作区），缺省从 apps/desktop 的依赖树定位 git 安装的包
  const override = process.env.NXCORE_MEMORY_CORE_DIR?.trim();
  if (override) {
    const packageRequire = createRequire(join(override, "package.json"));
    return { packageDirectory: override, tsxEntryUrl: pathToFileURL(packageRequire.resolve("tsx")).href };
  }
  const desktopRequire = createRequire(resolve(here, "../../desktop/package.json"));
  const binPath = desktopRequire.resolve(`${memoryPackageName}/bin/memory-gateway.mjs`);
  const packageDirectory = resolve(binPath, "../..");
  const packageRequire = createRequire(binPath);
  // Windows + Node 22：--import 必须是 file:// URL（裸盘符路径会被判为 URL scheme）
  return { packageDirectory, tsxEntryUrl: pathToFileURL(packageRequire.resolve("tsx")).href };
}

beforeAll(async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "nxcore-memdoc-e2e-"));
  const coreDataDir = join(rootDir, "memory-core");
  const gatewayDataDir = join(rootDir, "gateway");
  await mkdir(coreDataDir, { recursive: true });
  await mkdir(gatewayDataDir, { recursive: true });
  const mockLlm = await startMockLlm();
  const mockPort = (mockLlm.address() as { port: number }).port;
  const port = await freePort();
  const apiKey = randomBytes(24).toString("base64url");

  const { packageDirectory, tsxEntryUrl } = resolveCorePackage();
  const serverEntry = join(packageDirectory, "src", "gateway", "server.ts").replace(/\\/g, "/");
  const core = spawn(
    process.execPath,
    ["--import", tsxEntryUrl, serverEntry],
    {
      cwd: coreDataDir,
      env: {
        ...process.env,
        TDAI_GATEWAY_HOST: "127.0.0.1",
        TDAI_GATEWAY_PORT: String(port),
        TDAI_GATEWAY_API_KEY: apiKey,
        TDAI_DATA_DIR: coreDataDir,
        TDAI_LLM_BASE_URL: `http://127.0.0.1:${mockPort}/v1`,
        TDAI_LLM_API_KEY: "test-key",
        TDAI_LLM_MODEL: "test-model",
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  const coreLogs: string[] = [];
  const collect = (stream: NodeJS.ReadableStream) => {
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      coreLogs.push(...chunk.split("\n").filter(Boolean).slice(-400));
    });
  };
  collect(core.stdout!);
  collect(core.stderr!);

  // 等 /health 就绪（冷启动含 tsx 编译）
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await until("MemoryCore /health", STARTUP_TIMEOUT_MS, async () => {
      if (core.exitCode !== null || core.signalCode !== null) {
        throw new Error(`MemoryCore exited during startup (code=${String(core.exitCode)}):\n${coreLogs.slice(-40).join("\n")}`);
      }
      try {
        const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1_000) });
        return response.ok ? true : null;
      } catch {
        return null;
      }
    });
  } catch (error) {
    mockLlm.close();
    core.kill("SIGKILL");
    throw error;
  }

  const database = createDatabase(join(gatewayDataDir, "gateway.sqlite"), resolve("drizzle"));
  let service: MemoryService;
  let client: MemoryCoreClient;
  try {
    const runtime: MemoryRuntimeConfig = {
      baseUrl,
      apiKey,
      serviceId: "everroom",
      teamId: "everroom",
      agentId: "pi-agent",
      userId: "local-user",
      recallLimit: 5,
      charBudget: 2000,
    };
    service = new MemoryService(runtime, logger, { db: database.db, dataDir: gatewayDataDir });
    client = new MemoryCoreClient(runtime);
  } catch (error) {
    mockLlm.close();
    core.kill("SIGKILL");
    throw error;
  }
  e2e = { rootDir, gatewayDataDir, core, coreLogs, mockLlm, service, client, database };
}, STARTUP_TIMEOUT_MS + 60_000);

afterAll(async () => {
  const fixture = e2e;
  e2e = null;
  if (!fixture) return;
  await new Promise<void>((resolveShutdown) => {
    const child = fixture.core;
    const finish = (): void => resolveShutdown();
    const killTimer = setTimeout(() => {
      child.kill("SIGKILL");
      finish();
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(killTimer);
      finish();
    });
    if (!child.kill("SIGTERM")) {
      clearTimeout(killTimer);
      finish();
    }
  });
  await new Promise<void>((resolveClose) => fixture.mockLlm.close(() => resolveClose()));
  try {
    fixture.database.sqlite.close();
  } catch {
    // 已关闭则忽略
  }
  // Windows：sqlite -shm 释放有延迟，EBUSY 时让 fs.rm 自带的重试兜底
  await rm(fixture.rootDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function requireE2E(): E2E {
  if (!e2e) throw new Error("e2e fixture missing");
  return e2e;
}

/** 列出当前全部 L1 原子（跨类型翻页取全）。 */
async function allAtomic(): Promise<Array<{ id: string; type: string; content: string }>> {
  const { service } = requireE2E();
  const page = await service.listAtomic({ limit: 100, offset: 0 });
  return page.items;
}

describe("md 一等记忆来源全链路（M4）", { timeout: 600_000 }, () => {
  it(
    "① 多级标题导入：登记 v1 + 资产化落对象库且不触发 wiki 路由",
    async () => {
      const { service } = requireE2E();
      const result = await service.importMarkdown({ title: DOC_TITLE, markdown: MD_V1, filename: DOC_FILENAME });

      expect(result.deduplicated).toBe(false);
      expect(result.version).toBe("v1");
      expect(result.replacedVersions).toBe(0);
      expect(result.chunkCount).toBeGreaterThanOrEqual(3);
      expect(result.acceptedChunks).toBe(result.chunkCount);
      expect(result.sessionId.startsWith("memdoc:")).toBe(true);
      expect(result.fileId).toBe(fileIdOf(DOC_FILENAME));
      expect(result.document).toMatchObject({
        title: DOC_TITLE,
        callerRef: result.fileId,
        version: 1,
        sessionId: result.sessionId,
      });

      // 资产层：uploaded_files 一行 + 对象库字节 + 解析行；不产生 knowledge.route 任务
      const { database, gatewayDataDir } = requireE2E();
      const rows = database.sqlite.prepare("SELECT * FROM uploaded_files").all() as unknown[];
      expect(rows).toHaveLength(1);
      const parsed = database.sqlite.prepare("SELECT * FROM parsed_contents").all() as unknown[];
      expect(parsed).toHaveLength(1);
      const routed = database.sqlite.prepare("SELECT * FROM jobs WHERE type = 'knowledge.route'").all() as unknown[];
      expect(routed).toHaveLength(0);
      const hash = contentHashOf(Buffer.from(MD_V1, "utf8"));
      expect(await readFile(join(gatewayDataDir, storageRelPath(hash)), "utf8")).toBe(MD_V1);
    },
    60_000,
  );

  it(
    "② L0 文档会话标注可过滤，conversation/search 不混入文档块",
    async () => {
      const { client, service } = requireE2E();

      // 一条真实对话作为对照（同时触发会话模式提炼）
      await client.addConversation(CHAT_SESSION, [
        { role: "user", content: "记住凤凰木联络暗号。", timestamp: new Date().toISOString() },
        { role: "assistant", content: "好的，已记下。", timestamp: new Date().toISOString() },
      ]);
      await until("chat L0 visible", EXTRACTION_TIMEOUT_MS, async () => {
        const page = await service.listConversations({ limit: 100, offset: 0 });
        return page.messages.some((message) => message.sessionId === CHAT_SESSION) ? true : null;
      });

      // 全量列表：文档会话块带 sourceKind=document；对话消息不带
      const all = await service.listConversations({ limit: 100, offset: 0 });
      const docMessages = all.messages.filter((message) => message.sessionId?.startsWith("memdoc:"));
      expect(docMessages.length).toBeGreaterThanOrEqual(3);
      for (const message of docMessages) expect(message.sourceKind).toBe("document");
      const chatMessages = all.messages.filter((message) => message.sessionId === CHAT_SESSION);
      expect(chatMessages.length).toBe(2);
      for (const message of chatMessages) expect(message.sourceKind !== "document").toBe(true);

      // sourceKind=conversation 过滤后看不到文档块
      const conversationsOnly = await service.listConversations({ limit: 100, offset: 0, sourceKind: "conversation" });
      expect(conversationsOnly.messages.some((message) => message.sessionId?.startsWith("memdoc:"))).toBe(false);
      expect(conversationsOnly.messages.some((message) => message.sessionId === CHAT_SESSION)).toBe(true);

      // 只存在于文档正文里的词：会话搜索默认排除文档块
      const hits = await client.searchConversation("qx-phoenix-2026", 20);
      expect(hits.filter((hit) => hit.source_kind === "document")).toHaveLength(0);
      expect(hits.filter((hit) => hit.content.includes("qx-phoenix-2026"))).toHaveLength(0);
    },
    60_000,
  );

  it(
    "③ L1 文档派生原子 + 双向溯源 + 新会话召回",
    async () => {
      const { service } = requireE2E();

      // 异步提炼：等 work_fact（docfact-v1）出现
      const { coreLogs } = requireE2E();
      const atom = await until("document-derived work_fact", EXTRACTION_TIMEOUT_MS, async () => {
        const items = await allAtomic();
        return items.find((item) => item.type === "work_fact" && item.content.includes("docfact-v1")) ?? null;
      }, () => coreLogs.slice(-40).join("\n"));
      expect(atom.content).toContain("nexcore/everroom");

      // 反向溯源：kind=document + 标题路径/行区间锚点
      const provenance = await service.atomicProvenance(atom.id);
      expect(provenance.kind).toBe("document");
      expect(provenance.document).toMatchObject({ title: DOC_TITLE, version: 1 });
      expect(provenance.anchors.length).toBeGreaterThanOrEqual(1);
      for (const anchor of provenance.anchors) {
        expect(anchor.sourceKind).toBe("document");
        expect(anchor.headingPath ?? "").not.toBe("");
        expect(anchor.lineStart ?? 0).toBeGreaterThanOrEqual(1);
        expect(anchor.lineEnd ?? 0).toBeGreaterThanOrEqual(anchor.lineStart ?? 0);
      }

      // 正向溯源：文档详情的分块锚点覆盖溯源命中的 message id
      const documentId = provenance.document!.documentId;
      const detail = await service.getDocument(documentId);
      expect(detail.document.version).toBe(1);
      expect(detail.document.derivedMemoryCount ?? 0).toBeGreaterThanOrEqual(1);
      const chunkIds = new Set(detail.chunks.map((chunk) => chunk.messageId));
      expect(detail.chunks.length).toBeGreaterThanOrEqual(3);
      expect(detail.chunks.some((chunk) => chunk.content.includes("镜像标记"))).toBe(true);
      expect(detail.chunks.some((chunk) => chunk.headingPath.includes("镜像来源"))).toBe(true);
      for (const anchorMessageId of provenance.anchorMessageIds) {
        expect(chunkIds.has(anchorMessageId)).toBe(true);
      }
      expect(detail.memories.some((memory) => memory.id === atom.id)).toBe(true);

      // 新会话召回：atomic/search 命中文档派生原子
      const search = await service.searchAtomic("镜像 内部仓库", 20);
      expect(search.items.some((item) => item.id === atom.id)).toBe(true);
    },
    90_000,
  );

  it(
    "④ 同内容重导：deduplicated，资产与登记均不新增",
    async () => {
      const { service, database } = requireE2E();
      const again = await service.importMarkdown({ title: DOC_TITLE, markdown: MD_V1, filename: DOC_FILENAME });

      expect(again.deduplicated).toBe(true);
      expect(again.version).toBe("v1");
      expect(again.replacedVersions).toBe(0);
      const documents = await service.listDocuments(50, 0);
      expect(documents.total).toBe(1);
      expect(database.sqlite.prepare("SELECT * FROM uploaded_files").all()).toHaveLength(1);
      expect(database.sqlite.prepare("SELECT * FROM parsed_contents").all()).toHaveLength(1);
    },
    60_000,
  );

  it(
    "⑤ 同名新内容：升版 v2 + 旧原子/旧块级联清除 + 新派生就位 + 资产指针前移",
    async () => {
      const { service, database, gatewayDataDir, coreLogs } = requireE2E();
      const before = await allAtomic();
      const oldAtom = before.find((item) => item.content.includes("docfact-v1"));
      expect(oldAtom).toBeDefined();

      const upgraded = await service.importMarkdown({ title: DOC_TITLE, markdown: MD_V2, filename: DOC_FILENAME });
      expect(upgraded.deduplicated).toBe(false);
      expect(upgraded.version).toBe("v2");
      expect(upgraded.replacedVersions).toBe(1);

      // 登记唯一，版本前移；新块来自第二版正文
      const documents = await service.listDocuments(50, 0);
      expect(documents.total).toBe(1);
      expect(documents.documents[0]!.version).toBe(2);
      const detail = await service.getDocument(upgraded.document.id);
      expect(detail.chunks.some((chunk) => chunk.content.includes("docmark-v2"))).toBe(true);

      // 旧原子级联清除（溯源随即 404），新派生原子出现
      await until("v2 document-derived work_fact", EXTRACTION_TIMEOUT_MS, async () => {
        const items = await allAtomic();
        return items.some((item) => item.content.includes("docfact-v2")) ? true : null;
      }, () => coreLogs.slice(-40).join("\n"));
      const after = await allAtomic();
      expect(after.some((item) => item.content.includes("docfact-v1"))).toBe(false);
      await expect(service.atomicProvenance(oldAtom!.id)).rejects.toThrow();

      // 资产身份不变、指针前移：uploaded_files 仍 1 行指向 v2 hash，解析行 2 条
      expect(database.sqlite.prepare("SELECT * FROM uploaded_files").all()).toHaveLength(1);
      expect(database.sqlite.prepare("SELECT * FROM parsed_contents").all()).toHaveLength(2);
      const file = database.sqlite.prepare(
        "SELECT content_hash FROM uploaded_files WHERE id = ?",
      ).get(fileIdOf(DOC_FILENAME)) as { content_hash: string };
      expect(file.content_hash).toBe(contentHashOf(Buffer.from(MD_V2, "utf8")));
      const hash = contentHashOf(Buffer.from(MD_V2, "utf8"));
      expect(await readFile(join(gatewayDataDir, storageRelPath(hash)), "utf8")).toBe(MD_V2);
    },
    90_000,
  );

  it(
    "⑥ 删除文档：MemoryCore 无残留，资产层原文保留",
    async () => {
      const { service, database, gatewayDataDir, client } = requireE2E();
      const documents = await service.listDocuments(50, 0);
      expect(documents.total).toBe(1);
      const documentId = documents.documents[0]!.id;

      const removed = await service.deleteDocument(documentId);
      expect(removed).toMatchObject({ documentId, deleted: true });

      // 登记清空；L0 文档会话块清除；L1 派生原子清除
      const after = await service.listDocuments(50, 0);
      expect(after.total).toBe(0);
      await until("memdoc L0 purged", EXTRACTION_TIMEOUT_MS, async () => {
        const page = await service.listConversations({ limit: 100, offset: 0 });
        return page.messages.some((message) => message.sessionId?.startsWith("memdoc:")) ? null : true;
      });
      await until("docfact atoms purged", EXTRACTION_TIMEOUT_MS, async () => {
        const items = await allAtomic();
        return items.some((item) => item.content.includes("docfact-v2")) ? null : true;
      });
      // 对照：会话消息与会话派生原子不受文档删除影响
      const conversations = await service.listConversations({ limit: 100, offset: 0 });
      expect(conversations.messages.some((message) => message.sessionId === CHAT_SESSION)).toBe(true);
      const atoms = await allAtomic();
      expect(atoms.some((item) => item.content.includes("chatfact-e2e"))).toBe(true);
      expect(await client.searchConversation("qx-phoenix-2026", 20)).toHaveLength(0);

      // 资产层独立保留：uploaded_files 与对象库字节不动（原文归属 EverRoom 知识资产）
      expect(database.sqlite.prepare("SELECT * FROM uploaded_files").all()).toHaveLength(1);
      const hash = contentHashOf(Buffer.from(MD_V2, "utf8"));
      expect(await readFile(join(gatewayDataDir, storageRelPath(hash)), "utf8")).toBe(MD_V2);
    },
    90_000,
  );
});
