/**
 * office/pdf 文件导入 → 解析 → 记忆理解引擎 全链路 e2e。
 *
 * 真实链路（与 create-server 同款接线）：
 *   FilesService.importFile（桌面上传 /v1/file-imports 同一服务层）
 *   → file.ingest 任务 → document-understanding parseVersion
 *   → 统一理解引擎 ingest（U2 转换器：mammoth / unpdf / exceljs）
 *   → 三链路扇出 → MemoryCore 子进程（git 依赖安装的真实 fork）
 *   → mock OpenAI 兼容 LLM（把文档分块里的标记回放成 work_fact）。
 *
 * 验收：
 * ① docx：office-doc 类型，解析出正文标记与中文段落，memoryResult 带
 *    documentId/chunkCount，L1 原子内容含 docx 正文标记（证明解析文本
 *    真实到达记忆理解引擎，不是只写了台账）
 * ② pdf：document 类型，按页边界转 md，同样进记忆引擎出原子
 * ③ xlsx：spreadsheet 默认策略 memory=false → 不进记忆（策略默认行为）
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import pino from "pino";

import {
  type MemoryRuntimeConfig,
} from "@nxcore/agent-runtime-pi";
import { createDatabase, type DatabaseClient } from "../src/infrastructure/database/client.js";
import { FilesService } from "../src/modules/files/service.js";
import { DocumentUnderstandingService } from "../src/modules/document-understanding/service.js";
import { MemoryService } from "../src/modules/memory/service.js";
import { IngestService } from "../src/modules/ingest/service.js";
import { loadPolicyOverrides, loadProjectDefaults } from "../src/modules/ingest/policy.js";
import type { KnowledgeService } from "../src/modules/knowledge/service.js";

const STARTUP_TIMEOUT_MS = 180_000;
const EXTRACTION_TIMEOUT_MS = 45_000;
const POLL_INTERVAL_MS = 250;

const logger = pino({ level: "silent" });

const memoryPackageName = "@tencentdb-agent-memory/memory-tencentdb-v2";
const here = fileURLToPath(new URL(".", import.meta.url));

const DOCX_TITLE = "季度部署报告";
const DOCX_MARKER = "officefact-e2e-q7m";
const PDF_MARKER = "pdffact-e2e-w3k";

async function until(label: string, timeoutMs: number, probe: () => Promise<unknown>, diagnostics?: () => string): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) {
      throw new Error(`等待 ${label} 超时（${timeoutMs}ms）${diagnostics ? `\n${diagnostics()}` : ""}`);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, POLL_INTERVAL_MS));
  }
}

/** JSZip 造最小 OOXML docx：Heading1 标题 + 含标记的中文段落。 */
async function buildDocx(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  );
  const paragraphs = [
    `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>${DOCX_TITLE}</w:t></w:r></w:p>`,
    `<w:p><w:r><w:t>镜像来自内部仓库 nexcore/everroom。</w:t></w:r></w:p>`,
    `<w:p><w:r><w:t>回滚预案标记 ${DOCX_MARKER} 只出现在文档正文里。</w:t></w:r></w:p>`,
  ].join("");
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs}</w:body></w:document>`,
  );
  return Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
}

/** 带 Helv 字体文本层的最小 PDF（ASCII 文本，unpdf 可提取）。 */
function minimalPdf(text: string): Buffer {
  const escaped = text.replace(/([\\()])/g, "\\$1");
  const stream = `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, "ascii");
}

interface E2E {
  rootDir: string;
  gatewayDataDir: string;
  core: ChildProcess;
  coreLogs: string[];
  mockLlm: Server;
  files: FilesService;
  service: MemoryService;
  database: DatabaseClient;
}

let e2e: E2E | null = null;

/** mock OpenAI 兼容 LLM：文档分块提示词里的标记回放成 work_fact（证明分块来自解析正文）。 */
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
        const markers = [...new Set(prompt.match(/(?:officefact|pdffact)-e2e-[a-z0-9]+/g) ?? [])];
        const fact = markers.length > 0
          ? `文档事实：导入文件正文标记 ${markers.join("、")} 已入记忆。`
          : "文档事实：导入文件已入记忆（无标记兜底）。";
        content = JSON.stringify([{
          scene_name: "文档导入",
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
            content: "用户提到导入文件链路（office-pdf e2e 对照）。",
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
  const override = process.env.NXCORE_MEMORY_CORE_DIR?.trim();
  if (override) {
    const packageRequire = createRequire(join(override, "package.json"));
    return { packageDirectory: override, tsxEntryUrl: pathToFileURL(packageRequire.resolve("tsx")).href };
  }
  const desktopRequire = createRequire(resolve(here, "../../desktop/package.json"));
  const binPath = desktopRequire.resolve(`${memoryPackageName}/bin/memory-gateway.mjs`);
  const packageDirectory = resolve(binPath, "../..");
  const packageRequire = createRequire(binPath);
  return { packageDirectory, tsxEntryUrl: pathToFileURL(packageRequire.resolve("tsx")).href };
}

beforeAll(async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "nxcore-officepdf-e2e-"));
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
  let files: FilesService;
  let service: MemoryService;
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
      timeoutMs: 30_000,
    };
    service = new MemoryService(runtime, logger, { db: database.db, dataDir: gatewayDataDir });
    files = new FilesService(database.db, gatewayDataDir);
    const documentUnderstanding = new DocumentUnderstandingService(database.db, files, null, gatewayDataDir);
    const knowledge = {
      enabled: true,
      routerEnabled: true,
      submitEnvelope: () => ({ queued: true, jobId: "route-job-office-e2e" }),
      submitCommittedDocument: () => ({ queued: true, jobId: "route-job-office-e2e" }),
    } as unknown as KnowledgeService;
    const policyWarn = () => {};
    const ingest = new IngestService(
      database.db,
      files,
      knowledge,
      service,
      logger,
      {
        project: await loadProjectDefaults(policyWarn),
        deploy: await loadPolicyOverrides(gatewayDataDir, policyWarn),
      },
    );
    // create-server 同款接线：上传任务 → 结构化解析 → 统一理解引擎
    files.setVersionIngestor(async (input) => {
      await documentUnderstanding.parseVersion(input.fileEntryId, input.fileVersionId);
      const result = await ingest.ingest({
        source: {
          ref: {
            sourceKind: "file",
            sourceId: input.fileEntryId,
            sourceVersionId: input.fileVersionId,
          },
        },
        ...(input.pipelines ? { pipelines: input.pipelines } : {}),
        ...(input.roomId ? { roomId: input.roomId } : {}),
      });
      return { eventId: result.eventId, parsedId: result.parsedId, dataType: result.dataType };
    });
  } catch (error) {
    mockLlm.close();
    core.kill("SIGKILL");
    throw error;
  }
  e2e = { rootDir, gatewayDataDir, core, coreLogs, mockLlm, files, service, database };
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
  await rm(fixture.rootDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function requireE2E(): E2E {
  if (!e2e) throw new Error("e2e fixture missing");
  return e2e;
}

interface LedgerRow {
  id: string;
  data_type: string;
  parsed_id: string;
  memory_result: { documentId?: string; chunkCount?: number; error?: string } | null;
  route_job_id: string | null;
}

/** 上传后轮询台账：扇出完成 = memoryResult 已写（或 routeJobId 已写即 memory 关闭）。 */
async function importAndWait(
  originalName: string,
  buffer: Buffer,
): Promise<LedgerRow> {
  const { files, database } = requireE2E();
  const imported = await files.importFile({
    sourceKind: "manual-upload",
    sourceKey: `e2e:${originalName}`,
    originalName,
    buffer,
  });
  return await until(`ingest ledger of ${originalName}`, EXTRACTION_TIMEOUT_MS, async () => {
    const row = database.sqlite
      .prepare("SELECT * FROM ingest_events WHERE source_kind = 'file' AND source_id = ?")
      .get(imported.fileEntryId) as LedgerRow | undefined;
    if (!row) return null;
    if (row.memory_result === null && row.route_job_id === null) return null;
    if (typeof row.memory_result === "string") row.memory_result = JSON.parse(row.memory_result);
    return row;
  });
}

async function parsedMarkdownOf(parsedId: string): Promise<string> {
  const { database } = requireE2E();
  const row = database.sqlite
    .prepare("SELECT markdown FROM parsed_contents WHERE id = ?")
    .get(parsedId) as { markdown: string } | undefined;
  return row?.markdown ?? "";
}

describe("office/pdf 导入 → 解析 → 记忆理解引擎 全链路", { timeout: 600_000 }, () => {
  it(
    "① docx：office-doc 类型，正文标记解析成功并派生 L1 记忆原子",
    async () => {
      const { service } = requireE2E();
      const buffer = await buildDocx();
      const row = await importAndWait("季度部署报告.docx", buffer);

      expect(row.data_type).toBe("office-doc");
      expect(row.memory_result).toMatchObject({
        documentId: expect.any(String),
        chunkCount: expect.any(Number),
      });
      expect((row.memory_result as { chunkCount: number }).chunkCount).toBeGreaterThanOrEqual(1);

      const markdown = await parsedMarkdownOf(row.parsed_id);
      expect(markdown).toContain(DOCX_TITLE);
      expect(markdown).toContain("nexcore/everroom");
      expect(markdown).toContain(DOCX_MARKER);

      const { coreLogs } = requireE2E();
      const atom = await until("docx-derived work_fact", EXTRACTION_TIMEOUT_MS, async () => {
        const page = await service.listAtomic({ limit: 100, offset: 0 });
        return page.items.find((item) => item.type === "work_fact" && item.content.includes(DOCX_MARKER)) ?? null;
      }, () => coreLogs.slice(-40).join("\n"));
      expect(atom.content).toContain(DOCX_MARKER);

      const provenance = await service.atomicProvenance(atom.id);
      expect(provenance.kind).toBe("document");
      expect(provenance.document).toMatchObject({ title: DOCX_TITLE });
    },
    120_000,
  );

  it(
    "② pdf：document 类型，按页转 md，同样进记忆引擎出原子",
    async () => {
      const { service } = requireE2E();
      const buffer = minimalPdf(`Rollback playbook marker ${PDF_MARKER} inside body.`);
      const row = await importAndWait("季度报告.pdf", buffer);

      expect(row.data_type).toBe("document");
      expect(row.memory_result).toMatchObject({
        documentId: expect.any(String),
        chunkCount: expect.any(Number),
      });
      expect((row.memory_result as { chunkCount: number }).chunkCount).toBeGreaterThanOrEqual(1);

      const markdown = await parsedMarkdownOf(row.parsed_id);
      expect(markdown).toContain("## 第 1 页");
      expect(markdown).toContain(PDF_MARKER);

      const { coreLogs } = requireE2E();
      const atom = await until("pdf-derived work_fact", EXTRACTION_TIMEOUT_MS, async () => {
        const page = await service.listAtomic({ limit: 100, offset: 0 });
        return page.items.find((item) => item.type === "work_fact" && item.content.includes(PDF_MARKER)) ?? null;
      }, () => coreLogs.slice(-40).join("\n"));
      expect(atom.content).toContain(PDF_MARKER);

      const provenance = await service.atomicProvenance(atom.id);
      expect(provenance.kind).toBe("document");
    },
    120_000,
  );

  it(
    "③ xlsx：spreadsheet 默认策略 memory=false，解析照常但不进记忆",
    async () => {
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet("目标");
      sheet.addRow(["指标", "数值"]);
      sheet.addRow(["留存", "78%"]);
      const buffer = Buffer.from(await workbook.xlsx.writeBuffer() as ArrayBuffer);

      const row = await importAndWait("指标.xlsx", buffer);

      expect(row.data_type).toBe("spreadsheet");
      expect(row.memory_result).toBeNull();
      expect(row.route_job_id).toBe("route-job-office-e2e");

      const markdown = await parsedMarkdownOf(row.parsed_id);
      expect(markdown).toContain("## 目标");
      expect(markdown).toContain("| 留存 | 78% |");
    },
    60_000,
  );
});
