/**
 * 统一理解引擎三链路 e2e（docs/unified-ingest-plan.md §10 验收）。
 *
 * 真实链路：/v1/files 上传（唯一字节入口）→ IngestService（真引擎）→
 *   ① 记忆链路：MemoryCore 子进程（真实 fork，tsx 直跑，mock LLM 做提炼）
 *   ② Room 链路：真路由（KnowledgeLlm 抽取）→ 弱实体孵化 → 手动晋升 → Room
 *   ③ wiki 链路：KS 子进程（真实 fork）rawWrite + ingest（mock LLM 出 FILE 块）
 *
 * 验收：
 *   ① 台账/资产/记忆三件套：ingest_events + 对象库 + parsed_contents + MemoryCore 登记 + L1 派生
 *   ② 晋升后 Room wiki 真沉淀（KS ready，页面可读）
 *   ③ 闸1：同内容重进 deduped，扇出零重复
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type MemoryRuntimeConfig } from "@nxcore/agent-runtime-pi";
import type { FastifyBaseLogger } from "fastify";
import type { Logger } from "pino";
import { createDatabase, type DatabaseClient } from "../src/infrastructure/database/client.js";
import { FilesService } from "../src/modules/files/service.js";
import { storageRelPath } from "../src/modules/files/storage.js";
import { IngestService } from "../src/modules/ingest/service.js";
import { KnowledgeService } from "../src/modules/knowledge/service.js";
import { MemoryService } from "../src/modules/memory/service.js";

/** 起两个子进程 + 冷编译 tsx 的宽限（照 memory-doc-pipeline 实测放宽）。 */
const STARTUP_TIMEOUT_MS = 240_000;
/** 异步链路（路由 job/晋升 job/提炼轮询/KS ingest）的等待窗口。 */
const PIPELINE_TIMEOUT_MS = 90_000;
const POLL_INTERVAL_MS = 250;

const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as unknown as FastifyBaseLogger;
const pinoLogger = logger as unknown as Logger;

const memoryPackageName = "@tencentdb-agent-memory/memory-tencentdb-v2";
const knowledgePackageName = "@tencentdb-agent-memory/knowledge-service";
const here = fileURLToPath(new URL(".", import.meta.url));

const ENTITY_NAME = "凤凰项目";
const DOC_FILENAME = "凤凰项目立项.md";
/** 只出现在源文档正文的检索标记 / 派生事实标记 / mock wiki 页标记。 */
const SOURCE_MARKER = "e2e-source-marker-fenghuang";
const FACT_MARKER = "e2e-fact-fenghuang";
const WIKI_PAGE_MARKER = "e2e-wiki-page-fenghuang";
const DOC_MD = [
  `# ${ENTITY_NAME}立项`,
  "",
  "## 背景",
  `项目代号${ENTITY_NAME}，本页是统一理解引擎 e2e 的源文档（${SOURCE_MARKER}）。`,
  "",
  "## 目标",
  "- 打通文件 → Room / Wiki / 记忆三条链路",
  "- 全程确定性归一化，零 LLM 判型",
  "",
  "## 里程碑",
  "1. 引擎核心；2. 格式扩展；3. 桌面端。",
  "",
].join("\n");

interface Fixture {
  rootDir: string;
  gatewayDataDir: string;
  core: ChildProcess;
  coreLogs: string[];
  ks: ChildProcess;
  ksLogs: string[];
  mockLlm: Server;
  files: FilesService;
  knowledge: KnowledgeService;
  memory: MemoryService;
  engine: IngestService;
  database: DatabaseClient;
}

let fixture: Fixture | null = null;

async function until<T>(
  what: string,
  timeoutMs: number,
  probe: () => Promise<T | null> | T | null,
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

function readBody(request: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolveBody) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
  });
}

/**
 * mock OpenAI 兼容 LLM：一个端口喂三类消费者——
 *   ① gateway KnowledgeLlm（实体抽取/登记/同一性，system 提示词中文标记）
 *   ② MemoryCore 提炼（用户提示词含【待提取的文档分块】）
 *   ③ KS wiki ingest-v2（analysis=knowledge base analyst；generate=wiki maintainer，回 FILE 块）
 */
function startMockLlm(): Promise<Server> {
  const server = createServer((request, response) => {
    void (async () => {
      const raw = await readBody(request);
      let system = "";
      let user = "";
      try {
        const body = JSON.parse(raw) as { messages?: Array<{ role: string; content: string }> };
        for (const message of body.messages ?? []) {
          if (message.role === "system") system += `${message.content}\n`;
          else user += `${message.content}\n`;
        }
      } catch {
        // 保底：无法解析的请求按未知协议处理
      }
      const ids = [...user.matchAll(/\[([^\]\s]+)\] \[(?:user|assistant)\]/g)].map((match) => match[1]!);
      let content = "[]";
      if (system.includes("资料实体抽取器")) {
        content = JSON.stringify({
          summary: `${ENTITY_NAME}的立项资料：打通文件到三条理解链路。`,
          entities: [{
            name: ENTITY_NAME,
            kind: "项目",
            salience: 0.9,
            evidence: `项目代号${ENTITY_NAME}，本页是统一理解引擎 e2e 的源文档`,
          }],
        });
      } else if (system.includes("实体登记员")) {
        content = JSON.stringify({
          name: ENTITY_NAME,
          summary: `${ENTITY_NAME}：统一理解引擎 e2e 孵化出的实体。`,
          aliases: [],
        });
      } else if (system.includes("实体同一性判定员")) {
        content = JSON.stringify({ same: false, reason: "e2e 默认分立" });
      } else if (system.includes("knowledge base analyst")) {
        content = `Source Summary: ${ENTITY_NAME}立项资料。Entities: ${ENTITY_NAME}（项目核心）。Concepts: 无。`;
      } else if (system.includes("wiki) maintainer")) {
        content = [
          `<<<FILE path="wiki/entities/fenghuang.md">>>`,
          "---",
          "type: entity",
          `title: ${ENTITY_NAME}`,
          "description: e2e 晋升沉淀页",
          "---",
          "",
          `[[${ENTITY_NAME}]] 的 wiki 页（${WIKI_PAGE_MARKER}）。`,
          "",
          "<<<END>>>",
        ].join("\n");
      } else if (user.includes("【待提取的文档分块】")) {
        content = JSON.stringify([{
          scene_name: ENTITY_NAME,
          message_ids: ids,
          memories: [{
            content: `${ENTITY_NAME}要打通三条理解链路（${FACT_MARKER}）。`,
            type: "work_fact",
            priority: 85,
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
    })();
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

function spawnService(
  command: string,
  serverEntry: string,
  tsxEntryUrl: string,
  cwd: string,
  env: Record<string, string>,
): { child: ChildProcess; logs: string[] } {
  const child = spawn(command, ["--import", tsxEntryUrl, serverEntry], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const logs: string[] = [];
  const collect = (stream: NodeJS.ReadableStream) => {
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      logs.push(...chunk.split("\n").filter(Boolean).slice(-400));
    });
  };
  collect(child.stdout!);
  collect(child.stderr!);
  return { child, logs };
}

async function waitHealthy(baseUrl: string, what: string, child: ChildProcess, logs: string[]): Promise<void> {
  await until(what, STARTUP_TIMEOUT_MS, async () => {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`${what} exited during startup (code=${String(child.exitCode)}):\n${logs.slice(-40).join("\n")}`);
    }
    try {
      const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1_000) });
      return response.ok ? true : null;
    } catch {
      return null;
    }
  });
}

function resolveMemoryCorePackage(): { packageDirectory: string; tsxEntryUrl: string } {
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

function resolveKnowledgePackage(): { packageDirectory: string; tsxEntryUrl: string } {
  const override = process.env.NXCORE_KNOWLEDGE_SERVICE_DIR?.trim();
  if (override) {
    const packageRequire = createRequire(join(override, "package.json"));
    return { packageDirectory: override, tsxEntryUrl: pathToFileURL(packageRequire.resolve("tsx")).href };
  }
  const desktopRequire = createRequire(resolve(here, "../../desktop/package.json"));
  const manifestPath = desktopRequire.resolve(`${knowledgePackageName}/package.json`);
  const packageDirectory = resolve(manifestPath, "..");
  const packageRequire = createRequire(manifestPath);
  return { packageDirectory, tsxEntryUrl: pathToFileURL(packageRequire.resolve("tsx")).href };
}

beforeAll(async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "nxcore-ingest-e2e-"));
  const coreDataDir = join(rootDir, "memory-core");
  const ksDataDir = join(rootDir, "knowledge");
  const gatewayDataDir = join(rootDir, "gateway");
  await mkdir(coreDataDir, { recursive: true });
  await mkdir(ksDataDir, { recursive: true });
  await mkdir(gatewayDataDir, { recursive: true });

  const mockLlm = await startMockLlm();
  const mockPort = (mockLlm.address() as { port: number }).port;
  const mockV1 = `http://127.0.0.1:${mockPort}/v1`;

  // ── MemoryCore 子进程 ──
  const corePort = await freePort();
  const coreApiKey = randomBytes(24).toString("base64url");
  const corePackage = resolveMemoryCorePackage();
  const coreEntry = join(corePackage.packageDirectory, "src", "gateway", "server.ts").replace(/\\/g, "/");
  const coreSpawned = spawnService(process.execPath, coreEntry, corePackage.tsxEntryUrl, coreDataDir, {
    TDAI_GATEWAY_HOST: "127.0.0.1",
    TDAI_GATEWAY_PORT: String(corePort),
    TDAI_GATEWAY_API_KEY: coreApiKey,
    TDAI_DATA_DIR: coreDataDir,
    TDAI_LLM_BASE_URL: mockV1,
    TDAI_LLM_API_KEY: "test-key",
    TDAI_LLM_MODEL: "test-model",
  });
  try {
    await waitHealthy(`http://127.0.0.1:${corePort}`, "MemoryCore /health", coreSpawned.child, coreSpawned.logs);
  } catch (error) {
    mockLlm.close();
    coreSpawned.child.kill("SIGKILL");
    throw error;
  }

  // ── KS（knowledge-service）子进程 ──
  const ksPort = await freePort();
  const ksBaseUrl = `http://127.0.0.1:${ksPort}`;
  const ksPackage = resolveKnowledgePackage();
  const ksEntryFile = join(ksPackage.packageDirectory, "src", "server.ts").replace(/\\/g, "/");
  const ksSpawned = spawnService(process.execPath, ksEntryFile, ksPackage.tsxEntryUrl, ksDataDir, {
    PORT: String(ksPort),
    API_PREFIX: "/v3",
    KNOWLEDGE_DATA_DIR: ksDataDir,
    KNOWLEDGE_DB_PATH: join(ksDataDir, "knowledge.db"),
    KNOWLEDGE_PUBLIC_BASE_URL: `${ksBaseUrl}/v3`,
    LOG_LEVEL: "info",
    LLM_MODE: "custom",
    LLM_BASE_URL: mockV1,
    LLM_API_KEY: "test-key",
    LLM_MODEL: "test-model",
  });
  try {
    await waitHealthy(ksBaseUrl, "KnowledgeService /health", ksSpawned.child, ksSpawned.logs);
  } catch (error) {
    mockLlm.close();
    coreSpawned.child.kill("SIGKILL");
    ksSpawned.child.kill("SIGKILL");
    throw error;
  }

  // ── gateway 侧真实服务 ──
  const database = createDatabase(join(gatewayDataDir, "gateway.sqlite"), resolve("drizzle"));
  try {
    const memoryRuntime: MemoryRuntimeConfig = {
      baseUrl: `http://127.0.0.1:${corePort}`,
      apiKey: coreApiKey,
      serviceId: "everroom",
      teamId: "everroom",
      agentId: "pi-agent",
      userId: "local-user",
      recallLimit: 5,
      charBudget: 2000,
    };
    const memory = new MemoryService(memoryRuntime, logger, { db: database.db, dataDir: gatewayDataDir });
    const knowledge = new KnowledgeService(database.db, {
      baseUrl: ksBaseUrl,
      serviceId: "everroom",
      teamId: "everroom",
      dataDir: gatewayDataDir,
      roomWikisEnabled: true,
      ingestDebounceMs: 200,
      routerEnabled: true,
      entityPromoteScore: 2.0,
      entityPromoteSources: 2,
      mergeAutoDice: 0.75,
      mergeJudgeDice: 0.6,
      llm: { baseUrl: mockV1, apiKey: "test-key", model: "test-model" },
      embeddingLlm: null,
      embeddingModel: "",
    }, logger);
    const files = new FilesService(database.db, gatewayDataDir);
    const engine = new IngestService(database.db, files, knowledge, memory, pinoLogger);
    knowledge.start();
    fixture = {
      rootDir,
      gatewayDataDir,
      core: coreSpawned.child,
      coreLogs: coreSpawned.logs,
      ks: ksSpawned.child,
      ksLogs: ksSpawned.logs,
      mockLlm,
      files,
      knowledge,
      memory,
      engine,
      database,
    };
  } catch (error) {
    mockLlm.close();
    coreSpawned.child.kill("SIGKILL");
    ksSpawned.child.kill("SIGKILL");
    throw error;
  }
}, STARTUP_TIMEOUT_MS + 60_000);

function stopChild(child: ChildProcess): Promise<void> {
  return new Promise((resolveShutdown) => {
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
}

afterAll(async () => {
  const current = fixture;
  fixture = null;
  if (!current) return;
  current.knowledge.dispose();
  await stopChild(current.core);
  await stopChild(current.ks);
  await new Promise<void>((resolveClose) => current.mockLlm.close(() => resolveClose()));
  try {
    current.database.sqlite.close();
  } catch {
    // 已关闭则忽略
  }
  // Windows：sqlite -shm 释放有延迟，EBUSY 时让 fs.rm 自带的重试兜底
  await rm(current.rootDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function requireFixture(): Fixture {
  if (!fixture) throw new Error("e2e fixture missing");
  return fixture;
}

describe("统一理解引擎三链路 e2e", { timeout: 600_000 }, () => {
  it(
    "① 统一导入：台账 + 资产 + MemoryCore 登记 + L1 派生",
    async () => {
      const { files, engine, memory, database, gatewayDataDir } = requireFixture();

      const uploaded = await files.upload({ filename: DOC_FILENAME, buffer: Buffer.from(DOC_MD, "utf8") });
      expect(uploaded.deduped).toBe(false);
      const result = await engine.ingest({
        source: { ref: { sourceKind: "file", sourceId: uploaded.fileId } },
      });

      // 台账 + 扇出结果
      expect(result.deduped).toBe(false);
      expect(result.source).toMatchObject({ sourceKind: "file", sourceId: uploaded.fileId, sourceVersion: 1 });
      expect(result.dataType).toBe("document");
      expect(result.pipelines).toEqual({ room: true, wiki: true, memory: true });
      expect(result.routeJobId).toBeTruthy();
      expect(result.memoryResult).not.toBeNull();
      expect("error" in (result.memoryResult!) ? "memory errored" : "ok").toBe("ok");
      const memoryOk = result.memoryResult as { documentId: string; chunkCount: number; deduplicated: boolean };
      expect(memoryOk.deduplicated).toBe(false);
      expect(memoryOk.chunkCount).toBeGreaterThanOrEqual(3);

      // 资产层：uploaded_files 一行 + 对象库字节 + parsed_contents（引擎唯一持久化产物）
      const event = database.sqlite.prepare(
        "SELECT * FROM ingest_events WHERE source_kind = 'file' AND source_id = ?",
      ).get(uploaded.fileId) as Record<string, unknown>;
      expect(event).toBeDefined();
      expect(event.data_type).toBe("document");
      expect(event.origin_channel).toBe("upload");
      expect(JSON.parse(String(event.pipelines))).toEqual({ room: true, wiki: true, memory: true });
      const fileRow = database.sqlite.prepare("SELECT * FROM uploaded_files WHERE id = ?").get(uploaded.fileId) as Record<string, unknown>;
      expect(fileRow.current_parsed_id).toBeTruthy();
      const parsed = database.sqlite.prepare(
        "SELECT parsed_contents.* FROM parsed_contents JOIN uploaded_files ON uploaded_files.current_parsed_id = parsed_contents.id WHERE uploaded_files.id = ?",
      ).all(uploaded.fileId) as unknown[];
      expect(parsed).toHaveLength(1);
      const { readFile } = await import("node:fs/promises");
      const blob = await readFile(join(gatewayDataDir, storageRelPath(uploaded.contentHash)), "utf8");
      expect(blob).toBe(DOC_MD);

      // 记忆链路：MemoryCore 登记（caller_ref = sourceId，只存引用与内容，原文归资产层）
      const documents = await memory.listDocuments(50, 0);
      expect(documents.total).toBe(1);
      expect(documents.documents[0]).toMatchObject({
        title: DOC_FILENAME.replace(/\.md$/, ""),
        callerRef: uploaded.fileId,
        version: 1,
      });
      const detail = await memory.getDocument(documents.documents[0]!.id);
      expect(detail.chunks.some((chunk) => chunk.content.includes(SOURCE_MARKER))).toBe(true);

      // L1 派生（异步提炼）
      const atom = await until("document-derived work_fact", PIPELINE_TIMEOUT_MS, async () => {
        const page = await memory.listAtomic({ limit: 100, offset: 0 });
        return page.items.find((item) => item.content.includes(FACT_MARKER)) ?? null;
      });
      expect(atom.content).toContain(ENTITY_NAME);
    },
    180_000,
  );

  it(
    "② Room 链路：路由孵化弱实体 → 手动晋升 → KS wiki 真沉淀",
    async () => {
      const { knowledge, database } = requireFixture();

      // 路由 job 落定：弱实体 + 决策审计
      const entity = await until("weak entity from route job", PIPELINE_TIMEOUT_MS, () => {
        const items = knowledge.listCandidateEntities("weak");
        return items.find((item) => item.name === ENTITY_NAME) ?? null;
      });
      expect(entity.sourceCount).toBe(1);
      expect(entity.evidenceScore).toBeGreaterThan(0);
      const decision = await until("route decision recorded", PIPELINE_TIMEOUT_MS, () => {
        const row = database.sqlite.prepare(
          "SELECT * FROM route_decisions WHERE source_kind = 'file' ORDER BY created_at DESC LIMIT 1",
        ).get() as Record<string, unknown> | undefined;
        return row ?? null;
      });
      const fileId = (database.sqlite.prepare("SELECT id FROM uploaded_files LIMIT 1").get() as { id: string }).id;
      expect(decision.source_id).toBe(fileId);

      // 手动晋升（推荐确认制：唯一建 Room 路径）
      const promoted = knowledge.promoteEntity(entity.id);
      expect(promoted).toEqual({ ok: true });
      const room = await until("auto room created", PIPELINE_TIMEOUT_MS, () => {
        const rooms = knowledge.listRooms("auto");
        return rooms.length > 0 ? rooms[0]! : null;
      });
      expect(room.title).toContain(ENTITY_NAME);

      // wiki 链路：KS ingest 落定 ready，页面可读且含 mock 沉淀标记
      let lastWikiStatus = "unknown";
      const pages = await until("room wiki ready", PIPELINE_TIMEOUT_MS, async () => {
        const status = await knowledge.listRoomWikiPages(room.id);
        lastWikiStatus = `${status.status}/pages=${status.items.length}`;
        return status.status === "ready" && status.items.length > 0 ? status : null;
      }, () => `lastWikiStatus=${lastWikiStatus}\n${requireFixture().ksLogs.filter((line) => !line.includes("/v3/wiki/get") && !line.includes("/v3/wiki/page/ls")).slice(-40).join("\n")}`);
      const page = pages.items[0]!;
      const markdown = await knowledge.readRoomWikiPage(room.id, page.path);
      expect(markdown ?? "").toContain(WIKI_PAGE_MARKER);

      // 决策合并写入 rooms 台账（多对多沉淀账本）
      await until("decision confirmed with room ledger", PIPELINE_TIMEOUT_MS, () => {
        const row = database.sqlite.prepare(
          "SELECT * FROM route_decisions WHERE source_kind = 'file' ORDER BY created_at DESC LIMIT 1",
        ).get() as Record<string, unknown> | undefined;
        if (!row || row.status !== "confirmed") return null;
        return String(row.evidence).includes(room.id) ? row : null;
      });
    },
    240_000,
  );

  it(
    "③ 闸1：同内容重进 deduped，三链路零重复",
    async () => {
      const { files, engine, memory, database } = requireFixture();
      const fileId = (database.sqlite.prepare("SELECT id FROM uploaded_files LIMIT 1").get() as { id: string }).id;

      // 文件层闸1：同身份同内容 → deduped，不写对象
      const uploaded = await files.upload({ filename: DOC_FILENAME, buffer: Buffer.from(DOC_MD, "utf8") });
      expect(uploaded.deduped).toBe(true);
      expect(uploaded.fileId).toBe(fileId);

      // 引擎闸1：直接返回既有事件，不重复扇出
      const again = await engine.ingest({ source: { ref: { sourceKind: "file", sourceId: fileId } } });
      expect(again.deduped).toBe(true);
      expect(again.eventId).toBeTruthy();

      const events = database.sqlite.prepare("SELECT * FROM ingest_events WHERE source_id = ?").all(fileId) as unknown[];
      expect(events).toHaveLength(1);
      const routeJobs = database.sqlite.prepare("SELECT * FROM jobs WHERE type = 'knowledge.route'").all() as unknown[];
      expect(routeJobs).toHaveLength(1);
      const documents = await memory.listDocuments(50, 0);
      expect(documents.total).toBe(1);
    },
    60_000,
  );
});
