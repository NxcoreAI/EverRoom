import { describe, expect, it } from "vitest";
import type {
  ConnectorActionRuntime,
  QueryInput,
} from "./types.js";
import { decodeRef } from "./ref.js";
import { ConnectorQueryService, ConnectorQueryError } from "./service.js";

type ActionHandler = (
  input: Record<string, unknown>,
  signal: AbortSignal,
) => unknown | Promise<unknown>;

class FakeRuntime implements ConnectorActionRuntime {
  connections: Array<{ service: string; connectionName: string; status?: string }> = [];
  readonly handlers = new Map<string, ActionHandler>();
  readonly calls: Array<{
    service: string;
    action: string;
    input: Record<string, unknown>;
    connectionName: string;
  }> = [];

  async listConnections(): Promise<Array<{ service: string; connectionName: string; status?: string }>> {
    return this.connections;
  }

  async runAction(
    service: string,
    action: string,
    input: Record<string, unknown>,
    options: { connectionName: string; signal?: AbortSignal },
  ): Promise<unknown> {
    this.calls.push({ service, action, input, connectionName: options.connectionName });
    const handler = this.handlers.get(`${service}.${action}`);
    if (!handler) throw new Error(`unexpected_action:${service}.${action}`);
    return handler(input, options.signal ?? new AbortController().signal);
  }
}

function gmailData(): Record<string, unknown> {
  return {
    messages: [
      {
        messageId: "m1",
        threadId: "t1",
        subject: "预算复核",
        sender: "finance@example.com",
        messageTimestamp: "2026-10-01T08:00:00.000Z",
      },
      {
        messageId: "m2",
        threadId: "t2",
        subject: "Q4 预算讨论",
        sender: "cfo@example.com",
        messageTimestamp: "2026-10-05T09:30:00.000Z",
      },
    ],
  };
}

function notionData(): Record<string, unknown> {
  return {
    object: "list",
    results: [
      {
        object: "page",
        id: "page-1",
        url: "https://www.notion.so/page-1",
        last_edited_time: "2026-10-02T10:00:00.000Z",
        properties: {
          Name: {
            type: "title",
            title: [{ plain_text: "A 客户需求文档" }],
          },
        },
      },
    ],
  };
}

function serviceWith(runtime: FakeRuntime, timeoutMs = 8_000): ConnectorQueryService {
  return new ConnectorQueryService(runtime, { timeoutMs });
}

describe("ConnectorQueryService.query", () => {
  it("merges gmail hits, sorts by time and reports searched coverage", async () => {
    const runtime = new FakeRuntime();
    runtime.connections = [{ service: "gmail", connectionName: "default", status: "active" }];
    runtime.handlers.set("gmail.fetch_emails", () => gmailData());
    const query: QueryInput = {
      concept: "预算",
      terms: ["预算", "budget"],
      services: ["gmail"],
      since: "2026-09-01",
    };

    const result = await serviceWith(runtime).query(query);

    expect(result.hits).toHaveLength(2);
    expect(result.hits.map((hit) => decodeRef(hit.ref)?.id)).toEqual(["m2", "m1"]);
    expect(result.hits[0]?.title).toBe("Q4 预算讨论");
    expect(result.coverage.searched).toEqual([
      { service: "gmail", connection: "default", action: "fetch_emails" },
    ]);
    expect(result.coverage.failed).toEqual([]);
    expect(result.coverage.partial).toBe(false);
    expect(runtime.calls[0]?.input.query).toContain("预算 OR budget");
    expect(runtime.calls[0]?.input.query).toContain("after:2026/09/01");
  });

  it("parses notion pages into document hits", async () => {
    const runtime = new FakeRuntime();
    runtime.connections = [{ service: "notion", connectionName: "default" }];
    runtime.handlers.set("notion.search", () => notionData());

    const result = await serviceWith(runtime).query({ concept: "客户需求", services: ["notion"] });

    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]).toMatchObject({
      service: "notion",
      kind: "document",
      title: "A 客户需求文档",
      url: "https://www.notion.so/page-1",
    });
  });

  it("skips services without a query profile", async () => {
    const runtime = new FakeRuntime();
    runtime.connections = [{ service: "feishu", connectionName: "default" }];

    const result = await serviceWith(runtime).query({ concept: "预算", services: ["feishu"] });

    expect(result.hits).toEqual([]);
    expect(result.coverage.skipped).toEqual([{ service: "feishu", reason: "no_profile" }]);
    expect(result.coverage.partial).toBe(true);
    expect(runtime.calls).toEqual([]);
  });

  it("skips services without a connection instead of failing", async () => {
    const runtime = new FakeRuntime();

    const result = await serviceWith(runtime).query({ concept: "预算", services: ["gmail"] });

    expect(result.hits).toEqual([]);
    expect(result.coverage.skipped).toEqual([{ service: "gmail", reason: "no_connection" }]);
  });

  it("keeps partial results when one service fails", async () => {
    const runtime = new FakeRuntime();
    runtime.connections = [
      { service: "gmail", connectionName: "default" },
      { service: "notion", connectionName: "default" },
    ];
    runtime.handlers.set("gmail.fetch_emails", () => gmailData());
    runtime.handlers.set("notion.search", () => {
      throw new Error("notion_down");
    });

    const result = await serviceWith(runtime).query({ concept: "预算" });

    expect(result.hits).toHaveLength(2);
    expect(result.coverage.failed).toEqual([
      { service: "notion", connection: "default", message: "notion_down" },
    ]);
    expect(result.coverage.partial).toBe(true);
  });

  it("reports timeout as a failed source after the per-action budget", async () => {
    const runtime = new FakeRuntime();
    runtime.connections = [{ service: "gmail", connectionName: "default" }];
    runtime.handlers.set(
      "gmail.fetch_emails",
      (_input, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              const error = new Error("aborted");
              error.name = "AbortError";
              reject(error);
            },
            { once: true },
          );
        }),
    );

    const result = await serviceWith(runtime, 10).query({ concept: "预算", services: ["gmail"] });

    expect(result.hits).toEqual([]);
    expect(result.coverage.failed).toHaveLength(1);
    expect(result.coverage.failed[0]).toMatchObject({ service: "gmail", message: "timeout" });
    expect(result.coverage.partial).toBe(true);
  });

  it("rejects empty concepts", async () => {
    const runtime = new FakeRuntime();
    await expect(serviceWith(runtime).query({ concept: "   " })).rejects.toMatchObject({
      code: "invalid_query",
    });
  });
});

describe("ConnectorQueryService.read", () => {
  it("reads a mail hit into markdown", async () => {
    const runtime = new FakeRuntime();
    runtime.connections = [{ service: "gmail", connectionName: "default" }];
    runtime.handlers.set("gmail.fetch_emails", () => gmailData());
    runtime.handlers.set("gmail.get_message", () => ({
      messageId: "m2",
      threadId: "t2",
      subject: "Q4 预算讨论",
      from: "cfo@example.com",
      to: "me@example.com",
      date: "2026-10-05T09:30:00.000Z",
      body: "预算已经确认，按新版本执行。",
    }));

    const service = serviceWith(runtime);
    const result = await service.query({ concept: "预算", services: ["gmail"] });
    const first = result.hits[0];
    expect(first).toBeDefined();
    const read = await service.read(first!.ref);

    expect(read.markdown).toContain("# Q4 预算讨论");
    expect(read.markdown).toContain("预算已经确认");
    expect(read.truncated).toBe(false);
    expect(decodeRef(read.ref)?.id).toBe("m2");
  });

  it("rejects malformed refs", async () => {
    const runtime = new FakeRuntime();
    await expect(serviceWith(runtime).read("not-a-ref")).rejects.toBeInstanceOf(ConnectorQueryError);
    await expect(serviceWith(runtime).read("not-a-ref")).rejects.toMatchObject({
      code: "invalid_ref",
    });
  });
});
