import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MemoryDistiller,
  parseFacts,
  type CapturedSegment,
  type DistillCursor,
  type DistillMessage,
} from "../src/modules/memory/distill.js";
import { MemoryModelUnavailableError } from "../src/modules/memory/model-errors.js";
import { MemoryService } from "../src/modules/memory/service.js";

let root: string;
let service: MemoryService;

/** 造消息：id 与时间都递增，便于游标比较。 */
function message(index: number, role: "user" | "assistant", content: string): DistillMessage {
  return {
    id: `m-${String(index).padStart(3, "0")}`,
    role,
    content,
    createdAt: new Date(Date.UTC(2026, 10, 2, 0, 0, index)),
  };
}

const CONVERSATION: DistillMessage[] = [
  message(1, "user", "帮我写一份周报，用简体中文，结论先行"),
  message(2, "assistant", "好的，我按三段式起草。"),
  message(3, "user", "记住：以后所有正式文档都用简体中文，引用必须标来源"),
  message(4, "assistant", "明白，已按这个规则处理。"),
];

/** 内存游标仓库（真实实现放在 gateway_metadata，这里只测引擎）。 */
function makeCursorStore() {
  const store = new Map<string, DistillCursor>();
  return {
    read: (sessionId: string): DistillCursor => store.get(sessionId) ?? { afterCreatedAt: null, afterId: null, attempts: 0 },
    write: (sessionId: string, cursor: DistillCursor) => { store.set(sessionId, cursor); },
  };
}

/** 内存抢救段仓库（真实实现放在 gateway_metadata，这里只测引擎）。 */
function makeCapturedStore() {
  const store = new Map<string, CapturedSegment>();
  return {
    save: (sessionId: string, payload: CapturedSegment) => { store.set(sessionId, payload); },
    load: (sessionId: string): CapturedSegment | null => store.get(sessionId) ?? null,
    list: () => [...store.keys()],
    clear: (sessionId: string) => { store.delete(sessionId); },
  };
}

function isAfterCursor(item: DistillMessage, cursor: DistillCursor): boolean {
  if (cursor.afterCreatedAt === null) return true;
  const stamp = item.createdAt.toISOString();
  return stamp > cursor.afterCreatedAt
    || (stamp === cursor.afterCreatedAt && item.id > (cursor.afterId ?? ""));
}

/** 游标之前的最近 N 轮用户消息（硬切段落时的上文）。 */
function takeOverlap(messages: DistillMessage[], cursor: DistillCursor, turns: number): DistillMessage[] {
  if (cursor.afterCreatedAt === null) return [];
  const cutIndex = messages.findIndex((item) => isAfterCursor(item, cursor));
  if (cutIndex <= 0) return [];
  let start = cutIndex;
  let seen = 0;
  while (start > 0 && seen < turns) {
    start -= 1;
    if (messages[start]?.role === "user") seen += 1;
  }
  return messages.slice(start, cutIndex);
}

function makeDistiller(overrides: Partial<ConstructorParameters<typeof MemoryDistiller>[0]> = {}) {
  const cursor = makeCursorStore();
  const captured = makeCapturedStore();
  const cleared: string[] = [];
  let messages = CONVERSATION;
  const distiller = new MemoryDistiller({
    service,
    generate: async () => "[]",
    loadMessages: (_sessionId, current: DistillCursor) => messages.filter((item) => isAfterCursor(item, current)),
    loadOverlap: (_sessionId, current: DistillCursor, turns: number) => takeOverlap(messages, current, turns),
    readCursor: cursor.read,
    writeCursor: cursor.write,
    clearCursor: (sessionId: string) => { cleared.push(sessionId); },
    saveCaptured: captured.save,
    loadCaptured: captured.load,
    listCaptured: captured.list,
    clearCaptured: captured.clear,
    maxTurnsPerSegment: 2,
    maxCharsPerSegment: 10_000,
    // 夹具对话很短，长度门槛单独由「too-short」语义覆盖
    minChars: 10,
    idleMs: 20,
    ...overrides,
  });
  return {
    distiller,
    cursor,
    captured,
    cleared,
    setMessages: (next: DistillMessage[]) => { messages = next; },
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nxcore-distill-"));
  service = new MemoryService({ root, enabled: true });
  service.start();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("parseFacts", () => {
  it("解析裸 JSON 数组", () => {
    expect(parseFacts('[{"content":"用户偏好简体中文","tags":["偏好"]}]'))
      .toEqual([{ content: "用户偏好简体中文", tags: ["偏好"], category: "fact", scope: "workspace" }]);
  });

  it("剥掉代码块围栏与前后噪声", () => {
    const raw = '好的：\n```json\n[{"content":"部署前先跑迁移","tags":["经验"]}]\n```\n完毕';
    expect(parseFacts(raw)).toHaveLength(1);
  });

  it("识别 lesson 类型并固定经验标签", () => {
    const facts = parseFacts('[{"type":"lesson","content":"导出乱码 → 先转 UTF-8","tags":["偏好"]}]');
    expect(facts[0]?.category).toBe("lesson");
  });

  it("过滤非法标签后按类别回退默认标签", () => {
    expect(parseFacts('[{"content":"某条事实","tags":["胡编"]}]')[0]?.tags).toEqual(["偏好"]);
    expect(parseFacts('[{"type":"lesson","content":"某条经验 → 某个解法","tags":["胡编"]}]')[0]?.tags).toEqual(["经验"]);
  });

  it("丢弃空内容与超长内容，去重", () => {
    const raw = JSON.stringify([
      { content: "", tags: ["偏好"] },
      { content: "长".repeat(200), tags: ["偏好"] },
      { content: "同一条", tags: ["偏好"] },
      { content: "同一条", tags: ["决策"] },
    ]);
    expect(parseFacts(raw)).toEqual([{ content: "同一条", tags: ["偏好"], category: "fact", scope: "workspace" }]);
  });

  it("非数组/坏 JSON 返回空", () => {
    expect(parseFacts("不是 JSON")).toEqual([]);
    expect(parseFacts('{"content":"x"}')).toEqual([]);
  });
});

describe("作用域与经验格式的硬护栏", () => {
  it("scope=global 才认全局，缺失/拼错一律按 workspace", () => {
    const facts = parseFacts(JSON.stringify([
      { content: "用户偏好简体中文", tags: ["偏好"], scope: "global" },
      { content: "本空间周报三段式", tags: ["决策"], scope: "workspace" },
      { content: "没说作用域的事实", tags: ["偏好"] },
      { content: "拼错作用域的事实", tags: ["偏好"], scope: "everywhere" },
    ]));
    expect(facts.map((fact) => fact.scope)).toEqual(["global", "workspace", "workspace", "workspace"]);
  });

  it("lesson 缺箭头或写成多句会被丢弃", () => {
    const facts = parseFacts(JSON.stringify([
      { type: "lesson", content: "导出乱码了", tags: ["经验"] },
      { type: "lesson", content: "导出乱码 → 先转 UTF-8 再导出。顺手清缓存。", tags: ["经验"] },
      { type: "lesson", content: "导出乱码 -> 先转 UTF-8", tags: ["经验"] },
      { content: "用户偏好简体中文", tags: ["偏好"] },
    ]));
    expect(facts.map((fact) => fact.content)).toEqual(["导出乱码 -> 先转 UTF-8", "用户偏好简体中文"]);
  });

  it("模型说了 global 就写全局作用域，说了 workspace 就写当前空间", async () => {
    const harness = makeDistiller({
      generate: async () => JSON.stringify([
        { type: "fact", scope: "global", content: "用户偏好用简体中文", tags: ["偏好"] },
        { type: "fact", scope: "workspace", content: "本空间周报固定三段式", tags: ["决策"] },
      ]),
    });

    harness.distiller.noteRun("s1", "ws-a");
    await harness.distiller.flushSession("s1");

    const inSpace = service.list({ workspaceId: "ws-a", limit: 50 });
    expect(inSpace.map((hit) => hit.content).sort()).toEqual(["本空间周报固定三段式", "用户偏好用简体中文"].sort());
    expect(inSpace.find((hit) => hit.content === "用户偏好用简体中文")?.scope).toBeNull();
    expect(inSpace.find((hit) => hit.content === "本空间周报固定三段式")?.scope).toBe("workspace:ws-a");

    // 换个空间只看得见全局那条
    expect(service.list({ workspaceId: "ws-b", limit: 50 }).map((hit) => hit.content))
      .toEqual(["用户偏好用简体中文"]);
    harness.distiller.dispose();
  });

  it("硬切段落时把上文一起送模型，并声明不要重复提炼", async () => {
    const prompts: string[] = [];
    const harness = makeDistiller({
      generate: async (prompt: string) => { prompts.push(prompt); return "[]"; },
      maxTurnsPerSegment: 1,
    });

    harness.distiller.noteRun("s1");
    // 等第一段真的跑完（游标推进）再追加，避免被判 inflight 走空闲兜底（那条路径不带上文）。
    await vi.waitFor(() => expect(harness.cursor.read("s1").afterId).toBe("m-004"));
    // 第一段没有上文可带
    expect(prompts[0]).not.toContain("已提炼过");

    // 追加一轮后再硬切：应把上一轮的问答作为上文带上
    harness.setMessages([...CONVERSATION, message(5, "user", "顺便记一下：部署前要跑迁移")]);
    harness.distiller.noteRun("s1");
    await vi.waitFor(() => expect(prompts.length).toBe(2), { timeout: 2000 });

    const second = prompts[1] ?? "";
    expect(second).toContain("已提炼过，仅供理解上下文，不要重复提炼");
    expect(second).toContain("以后所有正式文档都用简体中文");
    expect(second.indexOf("已提炼过")).toBeLessThan(second.indexOf("本次待提炼"));
    expect(second).toContain("部署前要跑迁移");
    harness.distiller.dispose();
  });
});

describe("坑信号与草稿态", () => {
  it("把工具失败/重试作为客观信号喂给提炼", async () => {
    const prompts: string[] = [];
    const harness = makeDistiller({
      generate: async (prompt: string) => { prompts.push(prompt); return "[]"; },
      maxTurnsPerSegment: 99,
    });

    harness.distiller.noteRun("s1", "ws-a", { toolFailures: 2, retriedAfterFailure: 1 });
    await harness.distiller.flushSession("s1");

    const prompt = prompts[0] ?? "";
    expect(prompt).toContain("【本段客观信号】");
    expect(prompt).toContain("工具失败 2 次");
    expect(prompt).toContain("重试成功 1 次");
    harness.distiller.dispose();
  });

  it("没有失败信号的段落不塞信号块", async () => {
    const prompts: string[] = [];
    const harness = makeDistiller({
      generate: async (prompt: string) => { prompts.push(prompt); return "[]"; },
      maxTurnsPerSegment: 99,
    });

    harness.distiller.noteRun("s1", "ws-a", { toolFailures: 0, retriedAfterFailure: 0 });
    await harness.distiller.flushSession("s1");

    expect(prompts[0] ?? "").not.toContain("【本段客观信号】");
    harness.distiller.dispose();
  });

  it("同段多次 run 的信号会累加", async () => {
    const prompts: string[] = [];
    const harness = makeDistiller({
      generate: async (prompt: string) => { prompts.push(prompt); return "[]"; },
      maxTurnsPerSegment: 99,
    });

    harness.distiller.noteRun("s1", "ws-a", { toolFailures: 1, retriedAfterFailure: 0 });
    harness.distiller.noteRun("s1", "ws-a", { toolFailures: 2, retriedAfterFailure: 1 });
    await harness.distiller.flushSession("s1");

    expect(prompts[0] ?? "").toContain("工具失败 3 次");
    harness.distiller.dispose();
  });

  it("自动提炼的经验落成草稿，事实落成机器观察，都不盖「已核实」的章", async () => {
    const harness = makeDistiller({
      generate: async () => JSON.stringify([
        { type: "lesson", scope: "workspace", content: "导出乱码 → 先转 UTF-8 再导出", tags: ["经验"] },
        { type: "fact", scope: "global", content: "用户偏好简体中文", tags: ["偏好"] },
      ]),
      maxTurnsPerSegment: 99,
    });

    harness.distiller.noteRun("s1", "ws-a");
    await harness.distiller.flushSession("s1");

    const entries = service.list({ workspaceId: "ws-a", limit: 20 });
    const lesson = entries.find((hit) => hit.category === "lesson");
    const fact = entries.find((hit) => hit.category === "fact");
    expect(lesson?.confidence).toBe("inferred");
    expect(fact?.confidence).toBe("observed");
    harness.distiller.dispose();
  });
});

describe("删除会话前的抢救", () => {
  it("删除前把未提炼段落落盘，提炼成功后清掉", async () => {
    const harness = makeDistiller({
      generate: async () => '[{"type":"fact","scope":"workspace","content":"用户偏好结论先行","tags":["偏好"]}]',
      maxTurnsPerSegment: 99,
    });

    harness.distiller.noteRun("s1", "ws-a");
    expect(harness.distiller.captureBeforeDelete("s1")).toBe(true);
    // 落盘内容含完整对话，且记下了工作空间
    expect(harness.captured.load("s1")?.workspaceId).toBe("ws-a");
    expect(harness.captured.load("s1")?.transcript).toContain("以后所有正式文档都用简体中文");
    // 会话删掉后游标行一并清理，不留孤儿键
    expect(harness.cleared).toContain("s1");

    const outcome = await harness.distiller.distillCaptured("s1");
    expect(outcome.written).toBe(1);
    expect(harness.captured.load("s1")).toBeNull();
    expect(service.list({ workspaceId: "ws-a" })[0]?.content).toBe("用户偏好结论先行");
    harness.distiller.dispose();
  });

  it("没有待提炼内容时不落盘", () => {
    const harness = makeDistiller({ minChars: 10 });
    harness.setMessages([]);
    expect(harness.distiller.captureBeforeDelete("s1")).toBe(false);
    expect(harness.captured.list()).toEqual([]);
    harness.distiller.dispose();
  });

  it("提炼失败时保留落盘记录，启动时可恢复重试", async () => {
    let fail = true;
    const harness = makeDistiller({
      generate: async () => {
        if (fail) throw new Error("boom");
        return '[{"type":"fact","scope":"workspace","content":"用户偏好结论先行","tags":["偏好"]}]';
      },
      maxTurnsPerSegment: 99,
    });

    harness.distiller.noteRun("s1", "ws-a");
    harness.distiller.captureBeforeDelete("s1");
    expect((await harness.distiller.distillCaptured("s1")).skipped).toBe("model-error");
    expect(harness.captured.load("s1")).not.toBeNull();

    // 模拟重启：同一份落盘记录被重新排队
    fail = false;
    expect(harness.distiller.resumeCaptured()).toBe(1);
    await vi.waitFor(() => expect(harness.captured.load("s1")).toBeNull(), { timeout: 2000 });
    expect(service.list({ workspaceId: "ws-a" })).toHaveLength(1);
    harness.distiller.dispose();
  });
});

describe("段式提炼（游标增量）", () => {
  it("段满轮次时立即提炼，并推进游标", async () => {
    const { distiller, cursor } = makeDistiller({
      generate: async () => '[{"type":"fact","content":"用户偏好简体中文写正式文档","tags":["偏好"]}]',
    });

    distiller.noteRun("s1");
    await vi.waitFor(() => expect(cursor.read("s1").afterId).toBe("m-004"));

    expect(service.recall({ query: "简体中文" })).toHaveLength(1);
    await distiller.flushSession("s1");
  });

  it("段未满时只等空闲，不立刻调用模型", async () => {
    const generate = vi.fn(async () => "[]");
    const { distiller } = makeDistiller({ generate, maxTurnsPerSegment: 99 });

    distiller.noteRun("s1");
    expect(generate).not.toHaveBeenCalled();

    // 空闲计时器到点后才提炼
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1), { timeout: 2000 });
    distiller.dispose();
  });

  it("两轮间隔很短不会互相丢弃：合并进同一段只提炼一次", async () => {
    const generate = vi.fn(async () => '[{"type":"fact","content":"用户偏好周报三段式","tags":["偏好"]}]');
    const { distiller } = makeDistiller({ generate, maxTurnsPerSegment: 99 });

    distiller.noteRun("s1");
    distiller.noteRun("s1");
    expect(generate).not.toHaveBeenCalled();

    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1), { timeout: 2000 });
    expect(service.list()).toHaveLength(1);
    distiller.dispose();
  });

  it("已提炼过的消息不会重复送模型（游标生效）", async () => {
    const generate = vi.fn(async () => '[{"type":"fact","content":"用户偏好简体中文","tags":["偏好"]}]');
    const harness = makeDistiller({ generate });

    harness.distiller.noteRun("s1");
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1));

    // 同样的消息再来一次：游标已到段尾，无新消息 → 不调用
    harness.distiller.noteRun("s1");
    await harness.distiller.flushSession("s1");
    expect(generate).toHaveBeenCalledTimes(1);
    harness.distiller.dispose();
  });

  it("新增消息后只送增量部分给模型", async () => {
    const prompts: string[] = [];
    const generate = vi.fn(async (prompt: string) => { prompts.push(prompt); return "[]"; });
    // 这里只验增量语义，所以关掉硬切上文（overlap 行为另有专门用例）。
    const harness = makeDistiller({ generate, maxTurnsPerSegment: 1, overlapTurns: 0 });

    harness.distiller.noteRun("s1");
    await vi.waitFor(() => expect(harness.cursor.read("s1").afterId).toBe("m-004"));

    harness.setMessages([
      ...CONVERSATION,
      message(5, "user", "顺便记一下：部署前要跑迁移"),
    ]);
    harness.distiller.noteRun("s1");
    await vi.waitFor(() => expect(harness.cursor.read("s1").afterId).toBe("m-005"), { timeout: 2000 });

    const second = prompts[1] ?? "";
    expect(second).toContain("部署前要跑迁移");
    // 早期消息不该再出现
    expect(second).not.toContain("帮我写一份周报");
    harness.distiller.dispose();
  });

  it("模型失败时不推进游标，下次重试", async () => {
    let fail = true;
    const generate = vi.fn(async () => {
      if (fail) throw new Error("boom");
      return '[{"type":"fact","content":"用户偏好简体中文","tags":["偏好"]}]';
    });
    const harness = makeDistiller({ generate, maxTurnsPerSegment: 1 });

    const first = await harness.distiller.distillSegment("s1");
    expect(first.skipped).toBe("model-error");
    expect(harness.cursor.read("s1").attempts).toBe(1);
    expect(harness.cursor.read("s1").afterId).toBeNull();

    fail = false;
    const second = await harness.distiller.distillSegment("s1");
    expect(second.written).toBe(1);
    expect(harness.cursor.read("s1").attempts).toBe(0);
    expect(harness.cursor.read("s1").afterId).toBe("m-004");
  });

  it("档位未就绪不消耗重试次数，档位就绪后整段补提炼", async () => {
    let slotReady = false;
    const generate = vi.fn(async () => {
      if (!slotReady) throw new MemoryModelUnavailableError();
      return '[{"type":"fact","content":"用户偏好简体中文","tags":["偏好"]}]';
    });
    const harness = makeDistiller({ generate, maxTurnsPerSegment: 1, maxAttempts: 2 });

    // 档位没就绪：跑几次都不该把 maxAttempts 烧掉
    for (let index = 0; index < 4; index += 1) {
      const outcome = await harness.distiller.distillSegment("s1");
      expect(outcome.skipped).toBe("model-unavailable");
    }
    expect(harness.cursor.read("s1").attempts).toBe(0);
    expect(harness.cursor.read("s1").afterId).toBeNull();

    // 档位就绪：同一段从头补提炼，一次成功
    slotReady = true;
    const recovered = await harness.distiller.distillSegment("s1");
    expect(recovered.written).toBe(1);
    expect(harness.cursor.read("s1").afterId).toBe("m-004");
    harness.distiller.dispose();
  });

  it("抢救段遇到档位未就绪时保留待重试", async () => {
    let slotReady = false;
    const generate = vi.fn(async () => {
      if (!slotReady) throw new MemoryModelUnavailableError();
      return '[{"type":"fact","content":"用户偏好简体中文","tags":["偏好"]}]';
    });
    // 段不满（不触发即时提炼），让抢救路径本身成为第一次尝试。
    const harness = makeDistiller({ generate, maxTurnsPerSegment: 99 });

    harness.distiller.noteRun("s1", "ws-a");
    expect(harness.distiller.captureBeforeDelete("s1")).toBe(true);

    const blocked = await harness.distiller.distillCaptured("s1");
    expect(blocked.skipped).toBe("model-unavailable");
    // 抢救段不能因为档位没就绪被清掉（否则会话删了就永久丢失）
    expect(harness.captured.load("s1")).not.toBeNull();

    slotReady = true;
    const recovered = await harness.distiller.distillCaptured("s1");
    expect(recovered.written).toBe(1);
    expect(harness.captured.load("s1")).toBeNull();
    harness.distiller.dispose();
  });

  it("连续失败达上限后停止重试", async () => {
    const generate = vi.fn(async () => { throw new Error("boom") });
    const harness = makeDistiller({ generate, maxTurnsPerSegment: 1, maxAttempts: 2 });

    await harness.distiller.distillSegment("s1");
    await harness.distiller.distillSegment("s1");
    const third = await harness.distiller.distillSegment("s1");

    expect(third.skipped).toBe("attempts-exceeded");
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it("flushAll 在退出前冲刷所有待提炼会话", async () => {
    const generate = vi.fn(async () => "[]");
    const harness = makeDistiller({ generate, maxTurnsPerSegment: 99 });

    harness.distiller.noteRun("s1");
    harness.distiller.noteRun("s2");
    await harness.distiller.flushAll();

    expect(generate).toHaveBeenCalledTimes(2);
    harness.distiller.dispose();
  });

  it("记忆关闭时完全不动作", async () => {
    const disabled = new MemoryService({ root: join(root, "off"), enabled: false });
    disabled.start();
    const cursor = makeCursorStore();
    const distiller = new MemoryDistiller({
      service: disabled,
      generate: async () => '[{"type":"fact","content":"不该写入","tags":["偏好"]}]',
      loadMessages: () => CONVERSATION,
      readCursor: cursor.read,
      writeCursor: cursor.write,
      minChars: 10,
    });

    expect((await distiller.distillSegment("s")).skipped).toBe("disabled");
    expect(disabled.list()).toHaveLength(0);
  });
});
