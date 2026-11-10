/** Export the frozen corpus, or validate captured real runs without treating layout counts as visual quality. */
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { semanticCases, semanticDrafts } from "../tests/fixtures/slides-semantic.js";
import { checkSemanticStoryboard, semanticHash, type SemanticPage } from "../src/modules/subagents/slides-semantic-contract.js";
import { checkSemanticBindings, checkSemanticRendered } from "../src/modules/subagents/slides-semantic-bindings.js";
import { normalizeTree } from "../src/modules/slides-layout/tree/schema.js";
import { compileTree } from "../src/modules/slides-layout/tree/compile.js";
import { measureDefects } from "../src/modules/slides-layout/tree/measure.js";
import { contractFromStyleParams } from "../src/modules/slides-layout/tree/layout-contract.js";

const corpus = { schemaVersion: "semantic-evaluation/v1", sampleData: "synthetic benchmark data, not business claims", cases: semanticCases, drafts: semanticDrafts };
const file = process.argv[process.argv.indexOf("--results") + 1];
if (!process.argv.includes("--results")) {
  console.log(JSON.stringify({ ...corpus, corpusHash: semanticHash(corpus) }, null, 2));
} else {
  const path = resolve(file!);
  const input = JSON.parse(readFileSync(path, "utf8")) as { runs: Array<{
    caseName: string; mode: "legacy-v2" | "semantic-v3"; repetition: number;
    sourceHash: string; styleParams: Record<string, unknown> | null;
    assetHash: string; model: string; elapsedMs: number; modelCalls: number; totalTokens: number;
    scene?: string; result: Record<string, unknown>; content?: SemanticPage;
    screenshot: string; finalTreeHash: string; screenshotTreeHash: string;
  }> };
  const results = input.runs.map(run => {
    const fixture = semanticCases.find(c => c.name === run.caseName);
    const errors: string[] = [];
    if (!fixture || run.sourceHash !== semanticHash(fixture.sources)) errors.push("source mismatch");
    if (!run.model || !run.assetHash || !Number.isFinite(run.elapsedMs) || !Number.isFinite(run.modelCalls) || !Number.isFinite(run.totalTokens)) errors.push("missing model/config/cost evidence");
    if (!run.screenshot || !existsSync(resolve(dirname(path), run.screenshot))) errors.push("missing actual screenshot");
    if (!run.finalTreeHash || run.screenshotTreeHash !== run.finalTreeHash || run.finalTreeHash !== semanticHash(run.result.tree)) errors.push("screenshot does not identify final tree");
    try {
      const tree = normalizeTree(run.result.tree);
      const contract = contractFromStyleParams(run.styleParams as never, run.scene);
      const compiled = compileTree(tree, contract);
      errors.push(...measureDefects(compiled, contract).map(d => `${d.type}: ${d.detail}`));
      if (run.mode === "semantic-v3" && fixture) {
        if (!run.content) errors.push("missing actual Planner content");
        else {
          errors.push(...checkSemanticStoryboard([run.content], fixture.sources).errors);
          errors.push(...checkSemanticBindings(run.content, tree.v2, run.result));
          errors.push(...checkSemanticRendered(run.content, compiled.spec));
        }
      }
    } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
    return { ...run, result: undefined, content: undefined, errors, passed: errors.length === 0 };
  });
  const missing = semanticCases.flatMap(c => ["legacy-v2", "semantic-v3"].flatMap(mode => [1, 2, 3].filter(n => !input.runs.some(r => r.caseName === c.name && r.mode === mode && r.repetition === n)).map(repetition => ({ caseName: c.name, mode, repetition }))));
  const pairMismatches = semanticCases.flatMap(c => [1, 2, 3].flatMap(repetition => {
    const pair = input.runs.filter(r => r.caseName === c.name && r.repetition === repetition);
    return pair.length > 1 && new Set(pair.map(r => semanticHash({ style: r.styleParams, assets: r.assetHash, source: r.sourceHash, model: r.model, scene: r.scene }))).size > 1 ? [`${c.name}/${repetition}: comparison conditions differ`] : [];
  }));
  const metrics = ["legacy-v2", "semantic-v3"].map(mode => {
    const runs = results.filter(r => r.mode === mode);
    const sorted = runs.map(r => r.elapsedMs).sort((a, b) => a - b);
    const percentile = (q: number) => sorted[Math.max(0, Math.ceil(sorted.length * q) - 1)] ?? null;
    return { mode, runs: runs.length, passing: runs.filter(r => r.passed).length, p50Ms: percentile(.5), p95Ms: percentile(.95), calls: runs.reduce((n, r) => n + r.modelCalls, 0), tokens: runs.reduce((n, r) => n + r.totalTokens, 0) };
  });
  console.log(JSON.stringify({ corpusHash: semanticHash(corpus), missing, pairMismatches, metrics, results, visualPreferenceReview: "pending human paired review", defaultSwitchEligible: false }, null, 2));
  if (missing.length || pairMismatches.length || results.some(r => !r.passed)) process.exitCode = 1;
}
