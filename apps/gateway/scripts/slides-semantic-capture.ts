/** Real, resumable evaluation through production generation; only the document sink is isolated. */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { loadConfig } from "../src/config.js";
import { isPiRuntimeConfigured } from "../src/modules/agent/runtime-factory.js";
import { createDatabase } from "../src/infrastructure/database/client.js";
import { SubagentRegistry } from "../src/modules/subagents/registry.js";
import { SubagentRuntimeManager } from "../src/modules/subagents/runtime-manager.js";
import { SubagentOrchestrator } from "../src/modules/subagents/orchestrator.js";
import { createSlidesLayouterAgentTools, createSlidesTreeResultValidator } from "../src/modules/subagents/slides-agent-tools.js";
import { createSubagentPiTools } from "../src/modules/subagents/tools.js";
import { OfficeBridgeClient } from "../src/modules/documents/capabilities/office-bridge-client.js";
import { pptxToPng } from "../src/modules/slides-style/render.js";
import { semanticCases, semanticDrafts } from "../tests/fixtures/slides-semantic.js";
import { semanticHash } from "../src/modules/subagents/slides-semantic-contract.js";
import { normalizeTree } from "../src/modules/slides-layout/tree/schema.js";
import { compileTree } from "../src/modules/slides-layout/tree/compile.js";
import { contractFromStyleParams } from "../src/modules/slides-layout/tree/layout-contract.js";
import { runLayouterTail } from "../src/modules/subagents/slides-layout-tail.js";
import { renderDraftMarkdown } from "../src/modules/subagents/slides-draft-doc.js";

const args = process.argv.slice(2);
const option = (name: string, fallback: string) => args.includes(name) ? args[args.indexOf(name) + 1]! : fallback;
const output = resolve(option("--output", "../../.local/slides-semantic-evaluation"));
const suite = option("--suite", "pages");
const repetitions = Number(option("--repetitions", "3"));
const limit = Number(option("--limit", "999"));
const parallel = Number(option("--concurrency", "4"));
const deckConcurrency = Number(option("--deck-concurrency", "4"));
const skipSelfReview = args.includes("--skip-self-review");
if (!["pages", "layouts", "decks"].includes(suite) || ![repetitions, limit, parallel].every(n => Number.isInteger(n) && n > 0)) throw new Error("invalid evaluation options");
mkdirSync(output, { recursive: true });

const connectionPath = option("--connection", join(homedir(), "Library/Application Support/EverRoom/runtime/gateway.json"));
const connection = JSON.parse(readFileSync(connectionPath, "utf8"));
const response = await fetch(`${connection.baseUrl}/v1/runtime-config/secrets`, {
  headers: { Authorization: `Bearer ${connection.token}` }, signal: AbortSignal.timeout(10_000),
});
if (!response.ok) throw new Error(`runtime config HTTP ${response.status}`);
const runtime = (await response.json() as any).config;
// Read only the bridge credentials from the known gateway process; never log or persist process env.
const command = execFileSync("ps", ["eww", "-p", String(connection.pid), "-o", "command="], { encoding: "utf8" });
const processValue = (name: string) => command.match(new RegExp(`(?:^| )${name}=([^ ]*)`))?.[1];
const bridgeUrl = processValue("NXCORE_OFFICE_BRIDGE_URL");
const bridgeToken = processValue("NXCORE_OFFICE_BRIDGE_TOKEN");
if (!bridgeUrl || !bridgeToken) throw new Error("live Office render bridge unavailable");
let bridgePid = connection.pid;
let currentBridge = new OfficeBridgeClient({ baseUrl: bridgeUrl, token: bridgeToken });
const bridge = {
  async renderPptx(input: Parameters<OfficeBridgeClient["renderPptx"]>[0]) {
    const live = JSON.parse(readFileSync(connectionPath, "utf8"));
    if (live.pid !== bridgePid) {
      const liveEnv = execFileSync("ps", ["eww", "-p", String(live.pid), "-o", "command="], { encoding: "utf8" });
      const field = (name: string) => liveEnv.match(new RegExp(`(?:^| )${name}=([^ ]*)`))?.[1];
      const baseUrl = field("NXCORE_OFFICE_BRIDGE_URL"), token = field("NXCORE_OFFICE_BRIDGE_TOKEN");
      if (!baseUrl || !token) throw new Error("live Office render bridge unavailable after restart");
      currentBridge = new OfficeBridgeClient({ baseUrl, token });
      bridgePid = live.pid;
    }
    if (input.pages.length > 4) {
      // The preview bridge accepts at most four pages. Use the desktop's own homogeneous-slide merge.
      const { openPptx, mergeSlideFromPptx, promoteSlideBackground, savePptx } = await import("../../desktop/vendor/genoffice/packages/pptx-engine/src/index.js");
      const first = await currentBridge.renderPptx({ title: input.title, pages: [input.pages[0]!] });
      const deck = await openPptx(first);
      for (const page of input.pages.slice(1)) {
        const one = await currentBridge.renderPptx({ title: input.title, pages: [page] });
        if (!await mergeSlideFromPptx(deck, one)) throw new Error("evaluation deck merge failed");
      }
      for (const slide of deck.deck.slides) promoteSlideBackground(slide, deck.deck.size);
      return Buffer.from(await savePptx(deck));
    }
    return currentBridge.renderPptx(input);
  },
};
const runDir = mkdtempSync(join(tmpdir(), "slides-semantic-evaluation-"));
process.once("exit", () => rmSync(runDir, { recursive: true, force: true }));
const config = loadConfig([], { ...process.env, NXCORE_AGENT_RUNTIME: "pi", NXCORE_GATEWAY_DATA_DIR: runDir });
if (!config.pi || !config.subagents) throw new Error("runtime not configured");
Object.assign(config.pi, runtime.primary);
// 布局代理现在直接跑主模型（config.pi），不再构造独立视觉档；--model / --max-tokens
// 同时作用于 planner(background) 与 layouter(主模型)，保证两段同口径 A/B。
const background = { ...config.pi, ...runtime.background };
if (args.includes("--model")) {
  const model = option("--model", "");
  background.model = model;
  config.pi.model = model;
}
if (args.includes("--max-tokens")) {
  const maxTokens = Number(option("--max-tokens", "8192"));
  if (!Number.isInteger(maxTokens) || maxTokens < 1024 || maxTokens > 131072) throw new Error("invalid max tokens");
  background.maxTokens = maxTokens;
  config.pi.maxTokens = maxTokens;
}
config.backgroundPi = background;
const vision = config.pi;
if (!args.includes("--render-only") && (!isPiRuntimeConfigured(background) || !isPiRuntimeConfigured(vision))) {
  throw new Error("evaluation runtime_config_not_ready: configure the current model endpoint and key in application settings");
}
const models = { planner: background.model, layouter: vision.model };
const { db, sqlite } = createDatabase(config.databasePath, config.migrationsDir);
const logger = { info() {}, warn(data: unknown, message: string) { console.error(message, JSON.stringify(data)); }, error() {} };
const registry = new SubagentRegistry(db, config.subagents, {}, logger);
await registry.initialize();
const manager = new SubagentRuntimeManager(config, config.subagents);
manager.registerAgentTools("slides-layouter", createSlidesLayouterAgentTools);
manager.registerAgentResultValidator("slides-layouter", createSlidesTreeResultValidator());
const orchestrator = new SubagentOrchestrator(db, config.subagents, registry, manager, logger);
let interrupted = false;
const interrupt = () => { interrupted = true; void orchestrator.dispose(); };
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
const dispatchQueues = new Map<string, { active: number; waiters: Array<() => void> }>();
async function dispatchQueued(input: any) {
  if (interrupted) throw new Error("evaluation interrupted");
  const queue = dispatchQueues.get(input.agentId) ?? { active: 0, waiters: [] };
  dispatchQueues.set(input.agentId, queue);
  const cap = registry.get(input.agentId)!.revision.policy.maxConcurrency;
  if (queue.active >= cap) await new Promise<void>(resolve => queue.waiters.push(resolve));
  queue.active++;
  try {
    if (interrupted) throw new Error("evaluation interrupted");
    if (!await orchestrator.awaitCapacity(30 * 60_000, 250, input.agentId)) throw new Error("evaluation capacity wait expired");
    return await orchestrator.dispatch(input);
  } finally {
    queue.active--;
    queue.waiters.shift()?.();
  }
}
const revisions = Object.fromEntries(["slides-planner", "slides-editor", "slides-layouter"].map(id => [id, registry.get(id)?.revision.digest]));
const implementation = Object.fromEntries(["tools", "orchestrator", "runtime-manager", "slides-semantic-stage", "slides-semantic-contract", "slides-semantic-bindings", "slides-layout-tail", "slides-agent-tools"].map(name => [name, semanticHash(readFileSync(resolve("src/modules/subagents", `${name}.ts`), "utf8"))]));
implementation["tree/v2/compile"] = semanticHash(readFileSync(resolve("src/modules/slides-layout/tree/v2/compile.ts"), "utf8"));
const evaluationSourceHash = semanticHash([readFileSync(resolve("scripts/slides-semantic-capture.ts"), "utf8"), readFileSync(resolve("tests/fixtures/slides-semantic.ts"), "utf8")]);
const generation = { models, revisions, implementation, evaluationSourceHash, layouterBase: "primary", providerHash: semanticHash([background.provider, background.baseUrl, vision.provider, vision.baseUrl]), primaryApi: background.api, visionApi: vision.api, reasoning: background.reasoning, slidesReasoning: config.subagents.slidesReasoning, primaryMaxTokens: background.maxTokens, visionMaxTokens: vision.maxTokens };
Object.assign(generation, { skipSelfReview, ...(suite === "layouts" ? {} : { draftEncoding: "renderDraftMarkdown/v1" }) });
const generationHash = semanticHash(generation);
if (!args.includes("--render-only")) writeFileSync(join(output, "generation.json"), JSON.stringify(generation, null, 2));
const productSource = "https://upload.wikimedia.org/wikipedia/commons/d/d4/Raspberry-Pi-2-Bare-BR.jpg";
const productPath = join(output, "raspberry-pi-2.jpg");
if (suite !== "decks" && limit >= 9 && !existsSync(productPath)) {
  execFileSync("curl", ["--fail", "--location", "--silent", "--show-error", "--max-time", "45", "--output", productPath, productSource]);
}
const productBytes = existsSync(productPath) ? readFileSync(productPath) : null;
const productUrl = productSource;

// Serialize final exports within this capture process; production self-review retains its own render limit.
let renderQueue: Promise<unknown> = Promise.resolve();
function renderPng(bytes: Buffer): Promise<Buffer> {
  const pending = renderQueue.then(() => pptxToPng(bytes));
  renderQueue = pending.catch(() => undefined);
  return pending;
}
function sessionMetrics(ref: string | null | undefined) {
  if (!ref || !existsSync(ref)) return { calls: null, tokens: null };
  let calls = 0;
  let tokens = 0;
  for (const line of readFileSync(ref, "utf8").split("\n").filter(Boolean)) {
    const entry = JSON.parse(line);
    const message = entry.message;
    if (message?.role !== "assistant") continue;
    calls++;
    if (message.usage) tokens += (message.usage.input ?? 0) + (message.usage.output ?? 0) + (message.usage.cacheRead ?? 0) + (message.usage.cacheWrite ?? 0);
  }
  return { calls, tokens };
}
async function contactSheet(paths: string[], target: string) {
  if (!paths.length) return;
  const w = 480, h = 292, columns = Math.min(3, paths.length);
  const canvas = createCanvas(columns * w, Math.ceil(paths.length / columns) * h);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#e5e7eb"; ctx.fillRect(0, 0, canvas.width, canvas.height);
  for (let i = 0; i < paths.length; i++) {
    const img = await loadImage(paths[i]!);
    const x = i % columns * w, y = Math.floor(i / columns) * h;
    ctx.drawImage(img, x + 5, y + 5, w - 10, 264);
    ctx.fillStyle = "#111111"; ctx.font = "14px sans-serif"; ctx.fillText(String(i + 1), x + 8, y + 285);
  }
  writeFileSync(target, canvas.toBuffer("image/png"));
}

const fixtures = suite !== "decks"
  ? semanticCases.map((c, index) => ({ name: c.name, pages: [c.draft], role: c.page.role, index }))
  : semanticDrafts.map((d, index) => ({ ...d, role: undefined, index }));
const selectedFixtures = fixtures.slice(0, limit).filter(f => !args.includes("--case") || f.name === option("--case", ""));
if (!selectedFixtures.length) throw new Error("no matching evaluation fixtures");
const jobs = Array.from({ length: repetitions }, (_, n) => selectedFixtures.flatMap(f =>
  [{ ...f, repetition: n + 1, mode: "semantic-v3" }])).flat();
let cursor = 0;
async function execute(job: typeof jobs[number]) {
  const label = `${suite}-${job.index + 1}-${job.repetition}-${job.mode}`;
  const directory = join(output, label);
  const recordPath = join(directory, "capture.json");
  if (args.includes("--render-only")) {
    if (!existsSync(recordPath)) return;
    const record = JSON.parse(readFileSync(recordPath, "utf8"));
    const paths: string[] = [];
    for (const page of record.pages) {
      const bytes = await bridge.renderPptx({ title: label, pages: [JSON.stringify(page.spec)] });
      writeFileSync(join(directory, `page-${page.index + 1}.pptx`), bytes);
      const path = join(directory, page.screenshot);
      writeFileSync(path, await renderPng(bytes));
      paths.push(path);
    }
    if (record.pages.length) {
      writeFileSync(join(directory, "deck.pptx"), await bridge.renderPptx({ title: label, pages: record.pages.map((p: any) => JSON.stringify(p.spec)) }));
      await contactSheet(paths, join(directory, "overview.png"));
      if (/^(final render:|deck render:)/.test(record.error ?? "")) delete record.error;
      record.renderRecoveredAt = new Date().toISOString();
      writeFileSync(recordPath, JSON.stringify(record, null, 2));
    }
    console.log(`${label}: recovered ${record.pages.length} rendered pages; review state preserved`);
    return;
  }
  if (existsSync(recordPath) && !args.includes("--retry")) {
    const prior = JSON.parse(readFileSync(recordPath, "utf8"));
    const unsuccessful = prior.result?.status !== "completed" || prior.result?.failedPages?.length || prior.interrupted;
    if (prior.generationHash === generationHash && !(args.includes("--retry-failed") && unsuccessful)) { console.log(`${label}: already captured`); return; }
  }
  mkdirSync(directory, { recursive: true });
  if (existsSync(recordPath)) {
    const history = join(directory, "history", randomUUID());
    mkdirSync(history, { recursive: true });
    for (const name of readdirSync(directory).filter(name => name !== "history")) {
      cpSync(join(directory, name), join(history, name), { recursive: true });
    }
  }
  const runId = randomUUID();
  const hasProduct = job.name === "产品实物";
  const dispatches: any[] = [];
  const landed = new Map<number, string>();
  let storyboard: unknown;
  const started = Date.now();
  console.log(`${label}: start ${job.name}`);
  const dispatch = async (input: any) => {
    const invocation = await dispatchQueued(input);
    const row = sqlite.prepare("SELECT runtime_session_ref FROM subagent_invocations WHERE id = ?").get(invocation.id) as { runtime_session_ref: string | null };
    const metrics = sessionMetrics(row.runtime_session_ref);
    const events = orchestrator.listInvocationEvents(invocation.id).filter(e => e.type === "tool.completed" || e.type === "run.failed" || e.type === "message.completed");
    dispatches.push({ agentId: input.agentId, input: input.input, invocation, metrics, events });
    writeFileSync(join(directory, "dispatches.json"), JSON.stringify(dispatches, null, 2));
    console.log(`${label}: ${input.agentId} ${invocation.status}`);
    return invocation;
  };
  const markdown = renderDraftMarkdown({ title: job.name, pages: job.pages });
  const instruction = `依据已确认草稿生成${job.pages.length}页，不增加封面或额外页面，保留页序。使用给定内容，不检索外部资料、不生成配图。${job.role ? `唯一一页的用途为 ${job.role}，请保留该用途。` : ""}${hasProduct ? `本页的产品为 Raspberry Pi 2，已提供产品实物原图：${productUrl}。直接将该 URL 写入 materials 与 image block；完整展示主体，fit=contain。图片出处：${productSource}。` : ""}这是合成评估材料，数据不代表真实经营情况。`;
  const office = {
      deckConcurrency,
      bridge: {
        generate: async () => ({ fileEntryId: label, originalName: `${label}.pptx` }),
        fillPage: async ({ slideIndex, specJson }: any) => { landed.set(slideIndex, specJson); return { ok: true, applied: true }; },
        renderPage: async ({ slideIndex }: any) => (await renderPng(await bridge.renderPptx({ title: label, pages: [landed.get(slideIndex)!] }))).toString("base64"),
        ...(skipSelfReview ? {} : { renderPptx: (input: { title: string; pages: string[] }) => bridge.renderPptx(input) }),
      } as any,
      readMaterialBlob: async () => null,
      fetchImageHead: async (url: string) => hasProduct && url === productUrl ? productBytes : null,
    };
  const tool = createSubagentPiTools(registry, { dispatch, awaitCapacity: (...a: any[]) => (orchestrator.awaitCapacity as any)(...a) } as any, {
    slidesEditor: { active: true, generationConfig: () => generation, store: { save(value: unknown) { storyboard = value; } } as any },
    resolveDocumentForDraft: () => ({ document: { id: `evaluation-${job.index}`, title: job.name }, markdown }) as any,
    slidesLayoutOffice: office,
  }).find(t => t.name === "slides_draft")!;
  let result: unknown;
  let error: string | undefined;
  try {
    if (suite === "layouts") {
      const fixture = structuredClone(semanticCases[job.index]!);
      const rawPlan = { title: job.name, pages: [{ ...fixture.draft, role: fixture.page.role, ...(hasProduct ? { materials: [{ url: productUrl, desc: "Raspberry Pi 2 原图" }] } : {}) }] };
      let plan: Record<string, unknown>;
      for (const b of fixture.page.blocks) if (b.type === "image") b.assetRef = productUrl;
      plan = { ...rawPlan, pages: rawPlan.pages.map(p => ({ ...p, content: fixture.page })) };
      storyboard = { storyboard: { schemaVersion: "storyboard/v3", pages: [fixture.page], sources: fixture.sources } };
      result = JSON.parse((await runLayouterTail({
        ...office, progress: null, makeKey: (_runId, agent, task, input) => semanticHash({ runId, agent, task, input }),
        dispatchPage: (input, idempotencyKey, _parentRunId, attachments) => dispatch({ agentId: "slides-layouter", task: "单页布局", input, idempotencyKey, source: "primary_agent", parentSessionId: runId, parentRunId: runId, ...(attachments ? { attachments } : {}) }),
      }, {
        roomId: "semantic-evaluation", sessionId: runId, runId, parentRunId: null, instruction, plan,
        armPlan: rawPlan, styleParams: null, draftDocumentId: "", settle: {}, styleSessions: null, pageImagesStore: null, trashDraft: async () => {},
      })).content);
    } else result = JSON.parse((await tool.execute({ runId, sessionId: runId, roomId: "semantic-evaluation" } as any, { task: "generate", instruction, draftDocumentId: `evaluation-${job.index}` })).content);
  } catch (e) { error = e instanceof Error ? e.message : String(e); }
  const elapsedMs = Date.now() - started;
  const pages: any[] = [];
  const imagePaths: string[] = [];
  for (const [index, specJson] of [...landed].sort((a, b) => a[0] - b[0])) {
    const pngName = `page-${index + 1}.png`;
    try {
      const pptx = await bridge.renderPptx({ title: label, pages: [specJson] });
      writeFileSync(join(directory, `page-${index + 1}.pptx`), pptx);
      const png = await renderPng(pptx);
      writeFileSync(join(directory, pngName), png);
      imagePaths.push(join(directory, pngName));
    } catch (e) { error = `final render: ${e instanceof Error ? e.message : String(e)}`; }
    const candidates = dispatches.filter(d => d.agentId === "slides-layouter" && d.input.pageIndex === index).reverse();
    const match = candidates.find(d => {
      try {
        return semanticHash(compileTree(normalizeTree(d.invocation.result.structuredOutput.tree), contractFromStyleParams(null), undefined, { pageIndex: index + 1, pageCount: job.pages.length }).spec) === semanticHash(JSON.parse(specJson));
      } catch { return false; }
    });
    const formal = match?.invocation.result?.structuredOutput;
    pages.push({ index, spec: JSON.parse(specJson), screenshot: pngName, specHash: semanticHash(JSON.parse(specJson)), result: formal ?? null, finalTreeHash: formal ? semanticHash(formal.tree) : null, screenshotTreeHash: formal ? semanticHash(formal.tree) : null, reviewed: Boolean(match?.input.currentTree), content: match?.input.content });
  }
  if (landed.size) {
    try { writeFileSync(join(directory, "deck.pptx"), await bridge.renderPptx({ title: label, pages: [...landed].sort((a, b) => a[0] - b[0]).map(([, spec]) => spec) })); }
    catch (e) { error = `deck render: ${e instanceof Error ? e.message : String(e)}`; }
    await contactSheet(imagePaths, join(directory, "overview.png"));
  }
  const metrics = dispatches.map(d => d.metrics);
  const record = { suite, caseName: job.name, mode: job.mode, repetition: job.repetition, generationHash, generation, interrupted, confirmedPages: job.pages, inputHash: semanticHash({ pages: job.pages, instruction: instruction.replaceAll(productUrl, "asset:product") }), styleParams: null, assetHash: hasProduct ? semanticHash(productBytes?.toString("base64")) : semanticHash([]), elapsedMs, invocations: dispatches.length, modelCalls: metrics.some(m => m.calls === null) ? null : metrics.reduce((n, m) => n + m.calls, 0), totalTokens: metrics.some(m => m.tokens === null) ? null : metrics.reduce((n, m) => n + m.tokens, 0), result, error, storyboard, pages, limitations: ["Legacy control arm removed: semantic-v3 is the only content path; baseline comparisons live in the archived evaluation records.", suite === "layouts" ? "Layout isolation uses frozen, manually authored content contracts and the real layout tail; Planner understanding and legacy content-report gating are outside this suite." : "Includes real Planner arrange; content planning differences must be reported separately."], ...(hasProduct ? { productSource } : {}) };
  writeFileSync(recordPath, JSON.stringify(record, null, 2));
  console.log(`${label}: ${JSON.stringify(result)} elapsed=${elapsedMs}ms pages=${landed.size}`);
}
try {
  await Promise.all(Array.from({ length: Math.min(parallel, jobs.length) }, async () => {
    while (!interrupted && cursor < jobs.length) await execute(jobs[cursor++]!);
  }));
  const files = readdirSync(output).filter(n => n.startsWith(`${suite}-`) && existsSync(join(output, n, "capture.json")));
  writeFileSync(join(output, `${suite}-index.json`), JSON.stringify({ generationHash, captures: files.map(n => `${n}/capture.json`) }, null, 2));
} finally {
  await orchestrator.dispose();
  sqlite.close();
  rmSync(runDir, { recursive: true, force: true });
}
