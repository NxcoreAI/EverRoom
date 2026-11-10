#!/usr/bin/env node
/**
 * 模型并发阶梯实测：找出 provider 的吞吐拐点，用它来定 slides 池与页级窗口。
 *
 * 为什么需要这个脚本：本地模拟只能算「并发-吞吐」的几何关系（N 件活分给 L 个
 * worker 要多久），不能回答「provider 在 24/32 并发下会不会排队或直接 429」。
 * 2026-10-21 实测结论：吞吐在 **16 见顶**，24 回落，32 触发 429（13/64 失败）。
 * 因此 slides 池与 slidesDeckConcurrency 都取 16（见 config.ts 的常量注释）。
 *
 * 用 micro-payload（max_tokens=16）压测，成本可忽略。默认 6 档 × 2 轮 ≈ 170 次请求。
 *
 * 用法：
 *   node scripts/concurrency-ladder.mjs \
 *     --base-url https://your-relay/v1 --api-key "$KEY" --model glm-5.3
 *
 * 可选：--levels 1,4,8,16,24,32  --rounds 2  --max-tokens 16  --timeout 180
 *
 * 判读：看「吞吐(req/s)」列。它见顶的那一档就是拐点；超过拐点的档位如果同时
 * 出现 HTTP 429，说明再往上开只会更慢且丢请求。
 */

const DEFAULTS = {
  levels: "1,4,8,16,24,32",
  rounds: "2",
  "max-tokens": "16",
  timeout: "180",
};

function parseArgs(argv) {
  const out = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[key] = "true";
      continue;
    }
    out[key] = next;
    i += 1;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const baseUrl = (args["base-url"] ?? "").replace(/\/$/, "");
const apiKey = args["api-key"] ?? "";
const model = args.model ?? "";
if (!baseUrl || !apiKey || !model) {
  console.error("缺少参数：--base-url / --api-key / --model 都是必填");
  process.exit(2);
}

const levels = args.levels.split(",").map((v) => Number(v.trim())).filter((v) => Number.isFinite(v) && v > 0);
const rounds = Math.max(1, Number(args.rounds) || 1);
const maxTokens = Number(args["max-tokens"]) || 16;
const timeout = Number(args.timeout) || 180;

/** 单次请求：返回 [毫秒, 错误标签|null]。 */
async function probe() {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout * 1000);
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "Reply with the single word: ok" }],
        max_tokens: maxTokens,
      }),
      signal: controller.signal,
    });
    await response.arrayBuffer();
    if (!response.ok) return [Date.now() - started, `HTTP ${response.status}`];
    return [Date.now() - started, null];
  } catch (error) {
    return [Date.now() - started, controller.signal.aborted ? "timeout" : String(error?.name ?? error)];
  } finally {
    clearTimeout(timer);
  }
}

function quantile(sorted, q) {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
}

/** 以 `level` 个并发跑 `level` 个请求（一轮）。 */
async function runLevel(level) {
  const latencies = [];
  const errors = [];
  let wallMs = 0;
  for (let round = 0; round < rounds; round += 1) {
    const started = Date.now();
    const batch = await Promise.all(Array.from({ length: level }, () => probe()));
    wallMs += Date.now() - started;
    for (const [latency, error] of batch) {
      latencies.push(latency);
      if (error) errors.push(error);
    }
  }
  return { latencies, errors, wallMs };
}

console.log(`provider=${baseUrl} model=${model} levels=[${levels}] rounds=${rounds} max_tokens=${maxTokens}\n`);
console.log("  并发   成功/总数       P50       P90      最慢   吞吐(req/s)  错误");
let best = { level: 0, throughput: 0 };
for (const level of levels) {
  const { latencies, errors, wallMs } = await runLevel(level);
  const sorted = [...latencies].sort((a, b) => a - b);
  const throughput = latencies.length / (wallMs / 1000);
  if (throughput > best.throughput) best = { level, throughput };
  const errKinds = [...new Set(errors)].slice(0, 3).join(",") || "-";
  console.log(
    `${String(level).padStart(6)}${String(latencies.length - errors.length).padStart(8)}/${String(latencies.length).padEnd(5)}`
    + `${(quantile(sorted, 0.5) / 1000).toFixed(2).padStart(9)}s${(quantile(sorted, 0.9) / 1000).toFixed(2).padStart(9)}s`
    + `${(sorted[sorted.length - 1] / 1000).toFixed(2).padStart(8)}s${throughput.toFixed(2).padStart(12)}  ${errKinds}`,
  );
}
console.log(`\n拐点：并发 ${best.level} 吞吐最高（${best.throughput.toFixed(2)} req/s）。池子与页级窗口按此取值。`);
