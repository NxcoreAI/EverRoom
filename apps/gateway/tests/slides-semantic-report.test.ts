import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { semanticHash } from "../src/modules/subagents/slides-semantic-contract.js";

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })));

it("reports fallback and interrupted captures separately and never pools configuration cohorts", () => {
  const directory = mkdtempSync(join(tmpdir(), "slides-report-test-"));
  directories.push(directory);
  const compiler = semanticHash(readFileSync(resolve("src/modules/slides-layout/tree/v2/compile.ts"), "utf8"));
  for (const [name, generationHash, interrupted, result] of [
    ["fallback", "config-a", false, { status: "completed", failedPages: [0] }],
    ["interrupted", "config-a", true, { status: "failed" }],
    ["other-config", "config-b", false, { status: "failed" }],
    ["bad-encoding", "config-b", false, { status: "completed" }],
  ] as const) {
    const folder = join(directory, name);
    mkdirSync(folder);
    writeFileSync(join(folder, "capture.json"), JSON.stringify({
      suite: name === "bad-encoding" ? "decks" : "layouts", caseName: name, mode: "legacy-v2", repetition: 1,
      generationHash, generation: { implementation: { "tree/v2/compile": compiler } },
      interrupted, confirmedPages: [{ title: "必留标题", points: ["必留内容"] }],
      elapsedMs: 1000, modelCalls: 1, totalTokens: 10, result, pages: [],
    }));
  }
  execFileSync(process.execPath, ["--import", "tsx", "scripts/slides-semantic-report.ts", "--output", directory], { stdio: "pipe" });
  const report = JSON.parse(readFileSync(join(directory, "report.json"), "utf8"));
  const group = report.metrics.find((m: any) => m.generationHash === "config-a" && m.suite === "layouts" && m.mode === "legacy-v2");
  expect(group).toMatchObject({ captures: 2, interrupted: 1, attempts: 1, landed: 1, successful: 0, checksPassing: 0, tokens: 10 });
  expect(report.metrics.find((m: any) => m.generationHash === "config-b" && m.suite === "layouts" && m.mode === "legacy-v2")).toMatchObject({ captures: 1, attempts: 1, landed: 0 });
  expect(report.results.find((r: any) => r.directory === "fallback").errors.join(" ")).toContain("fell back");
  expect(report.results.find((r: any) => r.directory === "bad-encoding").errors.join(" ")).toContain("multiline data provenance is invalid");
  expect(report.defaultSwitchEligible).toBe(false);
  expect(report.pairedHumanReview.status).toBe("pending");
  expect(readFileSync(join(directory, "report.md"), "utf8")).toContain("暂缓默认启用");

  const review = join(directory, "votes.json");
  writeFileSync(review, JSON.stringify({ reviewerType: "human", votes: [{ id: "unknown", preference: "A" }] }));
  expect(() => execFileSync(process.execPath, ["--import", "tsx", "scripts/slides-semantic-report.ts", "--output", directory, "--review", review], { stdio: "pipe" })).toThrow();
}, 15_000);
