import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PiAgentRuntimeTool } from "@nxcore/agent-runtime-pi";
import { createMemoryPiTools, MEMORY_PROMPT_GUIDELINES, MEMORY_TOOL_NAMES } from "../src/modules/memory/pi-tools.js";
import { MemoryService } from "../src/modules/memory/service.js";

type ToolRunInput = Parameters<PiAgentRuntimeTool["execute"]>[0];
const runInput = { sessionId: "session-test", runId: "run-test" } as unknown as ToolRunInput;

let root: string;
let service: MemoryService;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nxcore-memory-tools-"));
  service = new MemoryService({ root, enabled: true });
  service.start();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("memory pi tools", () => {
  it("把触发指引放在 integration 级，而不是工具级", () => {
    // 本运行时的系统提示词走自定义分支，pi 不渲染工具级 guideline；
    // 因此指引必须由 create-server 通过 integration.promptGuidelines 注入。
    expect(MEMORY_PROMPT_GUIDELINES.length).toBeGreaterThan(0);
    expect(MEMORY_PROMPT_GUIDELINES.join("\n")).toContain("memory_remember");
    for (const tool of createMemoryPiTools(service)) {
      expect(tool.promptGuidelines ?? []).toHaveLength(0);
    }
  })

  it("exposes exactly the declared tool names", () => {
    const tools = createMemoryPiTools(service);

    expect(tools.map((tool) => tool.name)).toEqual([...MEMORY_TOOL_NAMES]);
  });

  it("remembers through the tool and finds the entry through search", async () => {
    const tools = createMemoryPiTools(service);
    const remember = tools.find((tool) => tool.name === "memory_remember");
    const search = tools.find((tool) => tool.name === "memory_search");
    if (!remember || !search) throw new Error("tools missing");

    const writeResult = await remember.execute(runInput, {
      content: "用户偏好用简体中文撰写正式文档",
      tags: ["偏好"],
    });
    expect(writeResult.content).toContain("已记住");

    const readResult = await search.execute(runInput, { query: "简体中文" });
    expect(readResult.content).toContain("用户偏好用简体中文撰写正式文档");
    expect(readResult.details).toMatchObject({ count: 1 });
  });

  it("returns an honest empty answer when nothing matches", async () => {
    const tools = createMemoryPiTools(service);
    const search = tools.find((tool) => tool.name === "memory_search");
    if (!search) throw new Error("tool missing");

    const result = await search.execute(runInput, { query: "从未记录过的主题" });
    expect(result.content).toBe("没有检索到相关长期记忆。");
    expect(result.details).toMatchObject({ count: 0 });
  });

  it("rejects empty query and empty content", async () => {
    const tools = createMemoryPiTools(service);
    const search = tools.find((tool) => tool.name === "memory_search");
    const remember = tools.find((tool) => tool.name === "memory_remember");
    if (!search || !remember) throw new Error("tools missing");

    await expect(search.execute(runInput, { query: "  " })).rejects.toThrow("query 不能为空");
    await expect(remember.execute(runInput, { content: "  " })).rejects.toThrow("content 不能为空");
  });

  it("marks retrieved entries so they decay slower", async () => {
    const tools = createMemoryPiTools(service);
    const remember = tools.find((tool) => tool.name === "memory_remember");
    const search = tools.find((tool) => tool.name === "memory_search");
    if (!remember || !search) throw new Error("tools missing");

    await remember.execute(runInput, { content: "用户偏好用简体中文撰写正式文档", tags: ["偏好"] });
    const before = service.list()[0];
    if (!before) throw new Error("entry missing");

    await search.execute(runInput, { query: "简体中文" });

    const after = service.list()[0];
    expect(after?.retrievalCount).toBe((before.retrievalCount ?? 0) + 1);
    expect(after?.halfLifeDays ?? 0).toBeGreaterThan(before.halfLifeDays);
  });

  it("records usefulness feedback and refuses unknown ids without throwing", async () => {
    const tools = createMemoryPiTools(service);
    const remember = tools.find((tool) => tool.name === "memory_remember");
    const feedback = tools.find((tool) => tool.name === "memory_feedback");
    if (!remember || !feedback) throw new Error("tools missing");

    const written = await remember.execute(runInput, { content: "不要在生产库直接跑迁移", category: "lesson" });
    const id = (written.details as { id?: string } | undefined)?.id;
    if (!id) throw new Error("id missing");

    const good = await feedback.execute(runInput, { id, useful: true });
    expect(good.content).toContain("有用");
    expect(good.details).toMatchObject({ applied: true, useful: true });

    // 记错/过期：标不可信同样要落库
    const bad = await feedback.execute(runInput, { id, useful: false });
    expect(bad.content).toContain("不可信");

    const missing = await feedback.execute(runInput, { id: "mem_nope", useful: true });
    expect(missing.details).toMatchObject({ applied: false });
    expect(missing.content).toContain("没有找到");
  });

  it("registers recalled ids for the end-of-run settlement", async () => {
    const tools = createMemoryPiTools(service);
    const remember = tools.find((tool) => tool.name === "memory_remember");
    const search = tools.find((tool) => tool.name === "memory_search");
    if (!remember || !search) throw new Error("tools missing");

    const written = await remember.execute(runInput, { content: "部署之前必须先跑数据库迁移" });
    const id = (written.details as { id?: string } | undefined)?.id;
    if (!id) throw new Error("id missing");

    await search.execute(runInput, { query: "数据库迁移" });

    // 检索只登记，不立刻记分；run 跑完后由 settleRun 判定是否确认
    const settled = service.settleRun("run-test", { failed: false });
    expect(settled.checked).toBeGreaterThan(0);
    expect(settled.confirmed).toBeGreaterThan(0);
  });

  it("caps feedback calls per run so the model cannot farm scores", async () => {
    const tools = createMemoryPiTools(service);
    const remember = tools.find((tool) => tool.name === "memory_remember");
    const feedback = tools.find((tool) => tool.name === "memory_feedback");
    if (!remember || !feedback) throw new Error("tools missing");

    const written = await remember.execute(runInput, { content: "用户偏好结论先行" });
    const id = (written.details as { id?: string } | undefined)?.id;
    if (!id) throw new Error("id missing");

    const results = [];
    for (let index = 0; index < 8; index += 1) {
      results.push(await feedback.execute(runInput, { id, useful: true }));
    }
    const limited = results.filter((result) => (result.details as { reason?: string })?.reason === "rate_limited");
    expect(limited.length).toBeGreaterThan(0);
  });

  it("does not read or write anything when the service is disabled", () => {
    const disabled = new MemoryService({ root: join(root, "off"), enabled: false });
    disabled.start();

    expect(disabled.remember({ content: "不应写入" })).toBeNull();
    expect(disabled.recall({ query: "不应写入" })).toEqual([]);
    expect(disabled.stats().total).toBe(0);
  });
});
