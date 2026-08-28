import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRuntime, RuntimeRun } from "@nxcore/agent-runtime";
import { AgentResolver, BUILTIN_AGENT_IDS } from "../src/modules/agent/resolver.js";
import { createDatabase } from "../src/infrastructure/database/client.js";
import { contentHashOf, fileIdOf } from "../src/modules/files/storage.js";
import { FilesService } from "../src/modules/files/service.js";
import { EntityRegistry } from "../src/modules/knowledge/entity-registry.js";
import { KnowledgeService } from "../src/modules/knowledge/service.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  // Windows：sqlite -shm 释放有延迟，EBUSY 时让 fs.rm 自带的重试兜底
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  ));
});

/** 无头 Knowledge Agent 桩：按调用次序回放 message.completed，并捕获每次 prompt。 */
function knowledgeAgentStub(contents: string[]) {
  const prompts: string[] = [];
  const start = vi.fn(async (input: { prompt: string }) => {
    prompts.push(input.prompt);
    const content = contents[Math.min(prompts.length - 1, contents.length - 1)] ?? "";
    const events = (async function* () {
      yield { type: "message.completed", payload: { content } };
      yield { type: "run.completed", payload: {} };
    })();
    return { runId: "run-1", runtimeSessionRef: "session-1", events } as RuntimeRun;
  });
  const runtime = {
    id: BUILTIN_AGENT_IDS.knowledge,
    start,
    resume: start,
    cancel: vi.fn(async () => undefined),
    deleteSession: vi.fn(async () => undefined),
  } as unknown as AgentRuntime;
  const resolver = new AgentResolver();
  resolver.register(
    {
      id: BUILTIN_AGENT_IDS.knowledge,
      name: "Knowledge",
      description: "stub",
      configDirectory: "/tmp",
      kind: "builtin",
    },
    () => runtime,
  );
  return { resolver, prompts, deleteSession: runtime.deleteSession };
}

/** 真实 sqlite（临时目录）；resolver 传入时配置 llm，走注入的桩 Agent。 */
async function serviceForTest(resolver: AgentResolver | null) {
  const dataDir = await mkdtemp(join(tmpdir(), "nxcore-room-proposals-"));
  temporaryDirectories.push(dataDir);
  const { db, sqlite } = createDatabase(join(dataDir, "gateway.sqlite"), resolve("drizzle"));
  const service = new KnowledgeService(
    db,
    {
      baseUrl: "http://127.0.0.1:9", // 不可达即可：测试不触 KS
      serviceId: "everroom",
      teamId: "everroom",
      dataDir,
      roomWikisEnabled: false,
      ingestDebounceMs: 600_000,
      routerEnabled: true,
      entityPromoteScore: 2.0,
      entityPromoteSources: 2,
      mergeAutoDice: 0.75,
      mergeJudgeDice: 0.6,
      llm: resolver ? { baseUrl: "http://127.0.0.1:9", apiKey: "test", model: "test" } : null,
      embeddingLlm: null,
      embeddingModel: "",
    },
    { info: () => {}, warn: () => {}, error: () => {} },
    resolver ?? undefined,
  );
  return { service, files: new FilesService(db, dataDir), sqlite, registry: new EntityRegistry(db, { promoteScore: 2.0, promoteSources: 2 }) };
}

/** 上传一份已解析的 markdown，并挂一个 weak 实体锚点（primary resolution 链接）。 */
async function seedAnchoredFile(
  test: Awaited<ReturnType<typeof serviceForTest>>,
  filename: string,
  markdown: string,
  anchorName: string,
) {
  const fileId = fileIdOf(filename);
  const parsedId = test.files.ensureParsed(contentHashOf(Buffer.from(markdown, "utf8")), markdown);
  await test.files.upload({ filename, buffer: Buffer.from(markdown, "utf8") });
  test.files.touchParsed(fileId, parsedId);
  const entity = test.registry.createEntity({ name: anchorName, kind: "主题" });
  test.registry.replaceResolutionLinks("file", fileId, [{
    entityId: entity.id,
    sourceVersion: 1,
    role: "primary",
    salience: 0.9,
    evidence: `${anchorName} 为资料主题`,
  }]);
  return { fileId, entity };
}

const proposalsPayload = JSON.stringify({
  proposals: [
    {
      anchorName: "汇编语言",
      name: "汇编语言",
      kind: "主题",
      description: "围绕汇编语言课程设计收集讲义、实验与笔记。",
      reason: "资料以汇编语言为主要主题",
      sourceNames: ["讲义.md"],
    },
    {
      anchorName: "并不存在的实体",
      name: "独立新议题",
      kind: "议题",
      description: "",
      reason: "用户描述里提到",
      sourceNames: [],
    },
  ],
});

describe("Room 推荐（描述 + 资料 → 锚点实体匹配）", () => {
  it("锚点命中返回 entityId 与实体名，未命中为 null；prompt 带描述、资料与候选实体", async () => {
    const stub = knowledgeAgentStub([proposalsPayload]);
    const test = await serviceForTest(stub.resolver);
    const { fileId, entity } = await seedAnchoredFile(test, "讲义.md", "# 汇编语言课程设计\n\n围绕 8086 汇编展开。", "汇编语言");

    const result = await test.service.proposeRooms({ description: "汇编语言课程设计", fileEntryIds: [fileId] });
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.items).toHaveLength(2);

    const anchored = result.items[0]!;
    expect(anchored.entityId).toBe(entity.id);
    expect(anchored.name).toBe("汇编语言");
    expect(anchored.fileCount).toBe(1);
    expect(anchored.evidenceScore).not.toBeNull();
    expect(anchored.sourceCount).toBe(1);

    const unanchored = result.items[1]!;
    expect(unanchored.entityId).toBeNull();
    expect(unanchored.name).toBe("独立新议题");

    // prompt 组装：用户描述 + 资料标题与正文 + 候选实体行
    const prompt = stub.prompts[0]!;
    expect(prompt).toContain("汇编语言课程设计");
    expect(prompt).toContain("《讲义.md》");
    expect(prompt).toContain("汇编语言（类型：主题");
    // 一次性会话：完成后 deleteSession
    expect(stub.deleteSession).toHaveBeenCalledWith("session-1");
    test.sqlite.close();
  });

  it("首次输出不可解析时带错误反馈重试，第二次成功", async () => {
    const stub = knowledgeAgentStub(["我觉得没有推荐", proposalsPayload]);
    const test = await serviceForTest(stub.resolver);
    const { fileId } = await seedAnchoredFile(test, "讲义.md", "# 汇编", "汇编语言");

    const result = await test.service.proposeRooms({ description: "", fileEntryIds: [fileId] });
    expect(result).toMatchObject({ ok: true });
    expect(stub.prompts).toHaveLength(2);
    expect(stub.prompts[1]).toContain("上一次输出无法解析");
    test.sqlite.close();
  });

  it("llm 未配置与空输入的失败路径", async () => {
    const bare = await serviceForTest(null);
    await expect(bare.service.proposeRooms({ description: "x", fileEntryIds: [] })).resolves.toMatchObject({
      ok: false,
      error: "llm_not_configured",
    });
    bare.sqlite.close();

    const stub = knowledgeAgentStub([proposalsPayload]);
    const test = await serviceForTest(stub.resolver);
    await expect(test.service.proposeRooms({ description: "  ", fileEntryIds: [] })).resolves.toMatchObject({
      ok: false,
      error: "proposal_input_empty",
    });
    expect(stub.prompts).toHaveLength(0);
    test.sqlite.close();
  });
});
