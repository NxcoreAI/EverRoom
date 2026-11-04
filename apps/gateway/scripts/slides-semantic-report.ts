/** Recheck captured production outputs and build an anonymous, local paired-review sheet. */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { semanticCases, semanticDrafts } from "../tests/fixtures/slides-semantic.js";
import { checkSemanticStoryboard, semanticHash } from "../src/modules/subagents/slides-semantic-contract.js";
import { checkSemanticBindings, checkSemanticRendered } from "../src/modules/subagents/slides-semantic-bindings.js";
import { normalizeTree } from "../src/modules/slides-layout/tree/schema.js";
import { compileTree } from "../src/modules/slides-layout/tree/compile.js";
import { measureDefects } from "../src/modules/slides-layout/tree/measure.js";
import { treeSignature } from "../src/modules/slides-layout/tree/similarity.js";
import { contractFromStyleParams } from "../src/modules/slides-layout/tree/layout-contract.js";

const args = process.argv.slice(2);
const option = (name: string, fallback: string) => args.includes(name) ? args[args.indexOf(name) + 1]! : fallback;
const directory = resolve(option("--output", "../../.local/slides-semantic-evaluation"));
const repetitions = Number(option("--repetitions", "3"));
if (!Number.isInteger(repetitions) || repetitions < 1) throw new Error("invalid repetitions");
const captured = readdirSync(directory).filter(n => existsSync(join(directory, n, "capture.json"))).map(n => ({ ...JSON.parse(readFileSync(join(directory, n, "capture.json"), "utf8")), directory: n }));
const flattenText = (value: unknown): string => {
  if (!value || typeof value !== "object") return "";
  if (Array.isArray(value)) return value.map(flattenText).join(" ");
  return Object.entries(value).filter(([key]) => !["notes", "speakerNotes"].includes(key)).map(([key, v]) => ["text", "title", "label", "value", "content", "name"].includes(key) && (typeof v === "string" || typeof v === "number") ? String(v) : flattenText(v)).join(" ");
};
const compact = (s: string) => s.replace(/[\s，。；、：:|%％]/gu, "");
const results = captured.map(run => {
  const errors: string[] = [];
  const warnings: string[] = [];
  const compilerHash = semanticHash(readFileSync(resolve("src/modules/slides-layout/tree/v2/compile.ts"), "utf8"));
  const compilerComparable = run.generation.implementation?.["tree/v2/compile"] === compilerHash;
  if (!compilerComparable) warnings.push("capture compiler is not pinned to the current compiler; current recompile differences are diagnostic only");
  const dispatchPath = join(directory, run.directory, "dispatches.json");
  const dispatches = existsSync(dispatchPath) ? JSON.parse(readFileSync(dispatchPath, "utf8")) as any[] : [];
  const interrupted = run.interrupted ?? dispatches.some(d => ["cancelled", "interrupted"].includes(d.invocation.status));
  const transportErrors = dispatches.flatMap(d => d.events.filter((e: any) => e.type === "run.failed")
    .map((e: any) => ({ agent: d.agentId, message: String(e.payload?.message ?? "").slice(0, 600) })));
  const sources = run.storyboard?.storyboard?.sources;
  const contentPages = run.storyboard?.storyboard?.pages;
  if (run.result?.status !== "completed") errors.push(run.result?.contentError ?? run.result?.errorCode ?? run.error ?? "generation incomplete");
  if (run.error) errors.push(run.error);
  if (interrupted) errors.push("evaluation interrupted; excluded from completed-trial metrics");
  if (run.result?.failedPages?.length) errors.push(`layout failed or fell back on pages: ${run.result.failedPages.map((n: number) => n + 1).join(", ")}`);
  if (run.suite !== "layouts" && run.generation.draftEncoding !== "renderDraftMarkdown/v1") {
    errors.push("evaluation draft encoding was not pinned to the product serializer; multiline data provenance is invalid");
  }
  if (run.pages.some((p: any) => p.spec?.elements?.some((e: any) => e.type === "image" && /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/)/.test(e.url ?? "")))) {
    errors.push("evaluation used loopback image URLs rejected by the production image downloader; image rendering is invalid");
  }
  if (run.mode === "semantic-v3" && sources) errors.push(...checkSemanticStoryboard(contentPages, sources).errors);
  if (run.pages.length !== run.confirmedPages?.length) errors.push("final page count mismatch");
  const signatures: string[] = [];
  const literalMissing: Array<{ page: number; text: string }> = [];
  for (const page of run.pages) {
    if (!existsSync(join(directory, run.directory, page.screenshot))) errors.push(`page ${page.index + 1}: missing screenshot`);
    if (page.specHash !== semanticHash(page.spec)) errors.push(`page ${page.index + 1}: spec hash mismatch`);
    const confirmed = run.confirmedPages?.[page.index];
    const visible = compact(flattenText(page.spec.elements));
    if (confirmed) for (const text of [confirmed.title, ...confirmed.points]) if (!visible.includes(compact(text))) literalMissing.push({ page: page.index + 1, text });
    const content = contentPages?.[page.index];
    if (run.mode === "semantic-v3" && content) errors.push(...checkSemanticRendered(content, page.spec).map(e => `page ${page.index + 1}: ${e}`));
    if (page.result?.tree) {
      try {
        const tree = normalizeTree(page.result.tree);
        signatures.push(treeSignature(tree));
        const contract = contractFromStyleParams(run.styleParams);
        const compiled = compileTree(tree, contract, undefined, { pageIndex: page.index + 1, pageCount: run.confirmedPages.length });
        if (semanticHash(compiled.spec) !== page.specHash) (compilerComparable ? errors : warnings).push(`page ${page.index + 1}: current compiler differs from captured rendered spec`);
        (compilerComparable ? errors : warnings).push(...measureDefects(compiled, contract).map(d => `page ${page.index + 1}: ${d.type}: ${d.detail}`));
        if (run.mode === "semantic-v3" && content) errors.push(...checkSemanticBindings(content, tree.v2, page.result));
      } catch (e) { errors.push(String(e)); }
    } else errors.push(`page ${page.index + 1}: final spec cannot be attributed to a submitted tree (possible legacy fallback or shrink)`);
  }
  const visuals = run.result?.visualValidation;
  const visualVerified = !run.generation.skipSelfReview && run.pages.length > 0 && (run.mode === "semantic-v3"
    ? Array.isArray(visuals) && visuals.length === run.pages.length && visuals.every((v: string) => v !== "unverified")
    : run.pages.every((p: any) => p.reviewed ?? dispatches.some(d => {
      if (d.agentId !== "slides-layouter" || d.input.pageIndex !== p.index || !d.input.currentTree || d.invocation.status !== "completed") return false;
      try {
        const compiled = compileTree(normalizeTree(d.invocation.result.structuredOutput.tree), contractFromStyleParams(run.styleParams), undefined, { pageIndex: p.index + 1, pageCount: run.confirmedPages.length });
        return semanticHash(compiled.spec) === p.specHash;
      } catch { return false; }
    })));
  if (!visualVerified) warnings.push("production visual review not verified");
  return { ...run, compilerComparable, interrupted, transportErrors, pageCount: run.pages.length, pages: undefined, storyboard: undefined, errors, warnings, passed: errors.length === 0, literalMissing, literalCheckMeaning: "Exact string coverage only; paraphrases require review, and matches do not prove visibility.", signatures, visualVerified };
});
const missing = [
  ...semanticCases.flatMap(c => Array.from({ length: repetitions }, (_, i) => i + 1).flatMap(repetition => ["legacy-v2", "semantic-v3"].filter(mode => !results.some(r => r.suite === "layouts" && r.caseName === c.name && r.mode === mode && r.repetition === repetition)).map(mode => ({ suite: "layouts", caseName: c.name, mode, repetition })))),
  ...semanticDrafts.flatMap(c => ["legacy-v2", "semantic-v3"].filter(mode => !results.some(r => r.suite === "decks" && r.caseName === c.name && r.mode === mode && r.repetition === 1)).map(mode => ({ suite: "decks", caseName: c.name, mode, repetition: 1 }))),
];
const pairs: any[] = [];
for (const run of results.filter(r => r.mode === "legacy-v2")) {
  const other = results.find(r => r.mode === "semantic-v3" && r.suite === run.suite && r.caseName === run.caseName && r.repetition === run.repetition);
  if (!other) continue;
  const comparable = run.generationHash === other.generationHash && run.inputHash === other.inputHash && run.assetHash === other.assetHash;
  const id = semanticHash([run.suite, run.caseName, run.repetition]).slice(0, 12);
  const swapped = parseInt(id.slice(0, 2), 16) % 2 === 1;
  pairs.push({ id, suite: run.suite, name: run.caseName, repetition: run.repetition, comparable, A: swapped ? other : run, B: swapped ? run : other });
}
const cohorts = [...new Set(results.map(r => r.generationHash))];
const metrics = cohorts.flatMap(generationHash => ["layouts", "pages", "decks"].flatMap(suite => ["legacy-v2", "semantic-v3"].map(mode => {
  const captures = results.filter(r => r.generationHash === generationHash && r.suite === suite && r.mode === mode);
  const group = captures.filter(r => !r.interrupted);
  const times = group.map(r => r.elapsedMs).sort((a, b) => a - b);
  const percentile = (q: number) => times[Math.max(0, Math.ceil(times.length * q) - 1)] ?? null;
  const verifiedSuccesses = group.filter(r => r.passed && r.visualVerified);
  const successTimes = verifiedSuccesses.map(r => r.elapsedMs).sort((a, b) => a - b);
  const successPercentile = (q: number) => successTimes[Math.max(0, Math.ceil(successTimes.length * q) - 1)] ?? null;
  return { generationHash, suite, mode, captures: captures.length, interrupted: captures.length - group.length, attempts: group.length, landed: group.filter(r => r.result?.status === "completed").length, successful: group.filter(r => r.result?.status === "completed" && r.pageCount > 0 && r.pageCount === r.confirmedPages?.length && !r.result?.failedPages?.length && !r.error).length, checksPassing: group.filter(r => r.passed).length, verified: group.filter(r => r.visualVerified).length, p50Ms: percentile(.5), p95Ms: percentile(.95), successfulP50Ms: successPercentile(.5), successfulP95Ms: successPercentile(.95), successfulMeanTokens: verifiedSuccesses.length && verifiedSuccesses.every(r => Number.isFinite(r.totalTokens)) ? verifiedSuccesses.reduce((n, r) => n + r.totalTokens, 0) / verifiedSuccesses.length : null, modelCalls: group.length && group.every(r => Number.isFinite(r.modelCalls)) ? group.reduce((n, r) => n + r.modelCalls, 0) : null, tokens: group.length && group.every(r => Number.isFinite(r.totalTokens)) ? group.reduce((n, r) => n + r.totalTokens, 0) : null, metricScope: "Attempt latency and usage include failed attempts; successful metrics require code checks and visual review. Generation through final landing, including production visual review unless skipSelfReview=true; final artifact export excluded. Layout isolation excludes content planning. Operator-interrupted trials excluded. No fallback pages counted as successful designs." };
})));
let pairedHumanReview: Record<string, unknown> = { status: "pending" };
if (args.includes("--review")) {
  const review = JSON.parse(readFileSync(resolve(option("--review", "")), "utf8"));
  if (review.reviewerType !== "human" || !Array.isArray(review.votes)) throw new Error("expected exported human review");
  const ids = new Set<string>();
  let semanticPreferred = 0, legacyPreferred = 0, ties = 0, neither = 0, eligibleVotes = 0;
  for (const vote of review.votes) {
    const pair = pairs.find(p => p.id === vote.id);
    if (!pair || ids.has(vote.id) || ![null, "A", "B", "tie", "neither"].includes(vote.preference)) throw new Error("invalid or duplicate review vote");
    ids.add(vote.id);
    if (!vote.preference || !pair.comparable || ![pair.A, pair.B].every(r => r.passed && r.visualVerified && r.compilerComparable)) continue;
    eligibleVotes++;
    if (vote.preference === "tie") ties++;
    else if (vote.preference === "neither") neither++;
    else if (pair[vote.preference].mode === "semantic-v3") semanticPreferred++;
    else legacyPreferred++;
  }
  pairedHumanReview = { status: "imported", reviewedAt: review.reviewedAt, eligibleVotes, semanticPreferred, legacyPreferred, ties, neither, semanticPreferenceShare: eligibleVotes ? semanticPreferred / eligibleVotes : null, scope: "Only matched, complete, verified pairs with pinned current compiler; exported reviewerType is a declaration, not identity verification." };
}
const report = { capturedAt: new Date().toISOString(), metrics, missing, interrupted: results.filter(r => r.interrupted).map(r => r.directory), comparisonConditionMismatches: pairs.filter(p => !p.comparable).map(p => p.id), results, pairedHumanReview, defaultSwitchEligible: false, decision: "defer: complete production outputs, verified rendering, cost comparison and independent paired preference gates remain required" };
writeFileSync(join(directory, "report.json"), JSON.stringify(report, null, 2));
const seconds = (ms: number | null) => ms === null ? "—" : (ms / 1000).toFixed(1);
writeFileSync(join(directory, "report.md"), [
  "# 语义页面设计实测报告", "",
  `生成时间：${report.capturedAt}。结论：暂缓默认启用，保留 legacy-v2。`, "",
  `已采集 ${results.length} 条记录；计划矩阵尚缺 ${missing.length} 条；已采集记录中 ${report.interrupted.length} 条被主动中断，需要补跑。缺口与失败不视为完成验收。`, "",
  "| 配置摘要 | 套件 | 模式 | 有效尝试 | 中断 | 设计成功 | 代码校验通过 | 自审核实 | 尝试 P50 秒 | 尝试 P95 秒 | token 合计 |",
  "|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|",
  ...metrics.filter(m => m.captures).map(m => `| ${m.generationHash.slice(0, 8)} | ${m.suite} | ${m.mode} | ${m.attempts} | ${m.interrupted} | ${m.successful} | ${m.checksPassing} | ${m.verified} | ${seconds(m.p50Ms)} | ${seconds(m.p95Ms)} | ${m.tokens ?? "未知"} |`),
  "", "设计成功排除兜底页与缺页；时延包含失败尝试，不能用它证明成功交付更快。不同配置分组，不跨配置合并成本或视觉偏好。", "",
  "layouts 使用人工固定契约隔离版式，不评价 Planner 理解能力；decks 和 pages 经过真实内容编排。主模型承担视觉自审，自审通过不等于人工偏好或视觉质量合格。", "",
  "已匹配对照见 [匿名评审表](review.html)，明细见 [机器报告](report.json)。人工偏好尚未收集；完整内容保留、整册视觉效果和成本门槛尚未全部验证。", "",
  "原始尝试：", "",
  ...results.map(r => `- [${r.directory}](${r.directory}/capture.json)：${r.interrupted ? "中断" : r.passed && r.visualVerified ? "代码与自审通过，待人工审阅" : "未通过"}。${r.transportErrors.length ? `记录到 ${r.transportErrors.length} 次上游调用错误。` : ""}`), "",
].join("\n"));
writeFileSync(join(directory, "review-key.json"), JSON.stringify(pairs.map(p => ({ id: p.id, A: p.A.mode, B: p.B.mode })), null, 2));
const html = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const sourceFor = (r: any) => {
  const candidate = r.suite === "decks" ? "overview.png" : "page-1.png";
  const status = r.interrupted ? "采集中断" : r.result?.failedPages?.length ? "含布局失败或兜底页" : r.result?.status !== "completed" ? "生成失败" : !r.passed || !r.visualVerified ? "校验或自审未通过" : "已生成并校验";
  const image = existsSync(join(directory, r.directory, candidate)) ? `<a href="${r.directory}/deck.pptx"><img src="${r.directory}/${candidate}"></a>` : "<p>未产出页面</p>";
  return `<p>${status}</p>${image}`;
};
const confirmedFor = (r: any) => `<details><summary>确认的内容</summary>${r.confirmedPages.map((p: any) => `<h3>${html(p.title)}</h3><ul>${p.points.map((s: string) => `<li>${html(s)}</li>`).join("")}</ul>${p.data ? `<p>${html(p.data)}</p>` : ""}`).join("")}</details>`;
writeFileSync(join(directory, "review.html"), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>页面对照评审</title>
<style>body{font:16px system-ui;margin:24px;color:#18181b;background:#f4f4f5}section{border-top:1px solid #bbb;padding:20px 0}.pair{display:grid;grid-template-columns:1fr 1fr;gap:16px}img{width:100%;height:auto}label{margin-right:20px}h2{font-size:20px}button{padding:8px 16px}@media(max-width:700px){.pair{grid-template-columns:1fr}}</style>
<h1>页面对照评审</h1><p>按关系表达、重点清晰、阅读顺序与整册一致性评价。未产出的页面也计入失败。请勿查看评审映射文件后再投票。</p><button id="export">导出评审结果</button>
${pairs.map(p => `<section data-id="${p.id}"><h2>${html(p.name)} · ${p.repetition}</h2>${confirmedFor(p.A)}${!p.comparable ? "<p>生成条件不匹配，此对照不纳入偏好统计。</p>" : ""}<div class="pair"><div><h3>A</h3>${sourceFor(p.A)}</div><div><h3>B</h3>${sourceFor(p.B)}</div></div><p>${["A", "B", "tie", "neither"].map(v => `<label><input type="radio" name="${p.id}" value="${v}">${({ A: "A 更好", B: "B 更好", tie: "相当", neither: "均不合格" } as any)[v]}</label>`).join("")}</p><input aria-label="评审备注" placeholder="原因" style="width:95%"></section>`).join("")}
<script>document.querySelector('#export').onclick=()=>{const votes=[...document.querySelectorAll('section')].map(s=>({id:s.dataset.id,preference:s.querySelector('input:checked')?.value??null,note:s.querySelector('input[aria-label]').value}));const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify({reviewerType:'human',reviewedAt:new Date().toISOString(),votes},null,2)],{type:'application/json'}));a.download='paired-review.json';a.click()};</script></html>`);
console.log(JSON.stringify({ metrics, missing: missing.length, mismatchedPairs: report.comparisonConditionMismatches, defaultSwitchEligible: false }, null, 2));
