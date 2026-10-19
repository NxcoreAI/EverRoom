import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createDatabase, type DatabaseClient } from "../src/infrastructure/database/client.js";
import { contextRooms, roomOverviews } from "../src/infrastructure/database/schema.js";
import { AgentAccessMcpHost } from "../src/modules/agent-access/mcp-host.js";
import { AgentAccessService } from "../src/modules/agent-access/service.js";
import { createAgentAccessTools } from "../src/modules/agent-access/tools.js";
import type { AgentAccessToolDeps } from "../src/modules/agent-access/tools-read.js";

/**
 * 外部 Agent 访问（PRD 第 7 章）阶段 1 覆盖：
 * 连接生命周期、范围过滤（工具可见性 + 数据行过滤）、MCP 交换（含重启自愈）、
 * 提交幂等与状态语义。服务依赖全部为窄接口假件（开发规范 §5：不依赖外部服务）。
 */

interface ArtifactCall {
  filename: string;
  roomId: string | null;
  sourceKey: string;
  byteSize: number;
}

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), "agent-access-test-"));
  const client: DatabaseClient = createDatabase(join(dataDir, "gateway.sqlite"), resolve("drizzle"));

  client.db.insert(contextRooms).values([
    { id: "room-a", title: "Room A", kind: "topic", data: {} },
    { id: "room-b", title: "Room B", kind: "topic", data: {} },
  ]).run();
  client.db.insert(roomOverviews).values([
    { roomId: "room-a", baseProjection: {}, projection: {}, generatedAt: new Date(), updatedAt: new Date(), revision: 3 },
    { roomId: "room-b", baseProjection: {}, projection: {}, generatedAt: new Date(), updatedAt: new Date(), revision: 1 },
  ]).run();

  const artifactCalls: ArtifactCall[] = [];
  const importArtifact = async (input: {
    filename: string;
    buffer: Buffer;
    roomId: string | null;
    sourceKey: string;
  }) => {
    artifactCalls.push({
      filename: input.filename,
      roomId: input.roomId,
      sourceKey: input.sourceKey,
      byteSize: input.buffer.byteLength,
    });
    const seq = artifactCalls.length;
    return { fileEntryId: `file-${seq}`, contentHash: `sha-${seq}`, filename: input.filename };
  };

  const service = new AgentAccessService(client.db, { importArtifact });

  // 搜索假件：room-b 过滤时有一条会话命中，其他范围返回空（验证 roomIds 透传）。
  const deps: AgentAccessToolDeps = {
    db: client.db,
    search: {
      search: (query, filters, _limit, _offset) => {
        const allowed = !filters.roomIds || filters.roomIds.includes("room-b");
        if (!allowed || query !== "讨论") {
          return { items: [], total: 0 };
        }
        return {
          items: [{
            itemType: "message",
            refId: "m-1",
            title: "旧讨论",
            snippet: "关于上线的讨论",
            roomIds: ["room-b"],
            versionLabel: null,
            ingestedAt: "2026-10-01T00:00:00.000Z",
            sessionId: "s-1",
            status: "indexed",
          }, {
            itemType: "room",
            refId: "room-b",
            title: "Room B",
            snippet: "Room B",
            roomIds: ["room-b"],
            versionLabel: "rev1",
            ingestedAt: "2026-10-01T00:00:00.000Z",
            sessionId: null,
            status: "indexed",
          }],
          total: 2,
        };
      },
      status: () => ({ indexed: 1 }),
    },
    memory: null,
    documents: {
      get: (id) => id === "doc-1"
        ? { id: "doc-1", roomId: "room-b", title: "文档一", version: 2, deletedAt: null }
        : null,
      readDocumentForAgent: (id) => ({
        document: { id, roomId: "room-b", title: "文档一", version: 2 },
        blocks: [],
        markdown: "# 文档一\n正文",
      }),
    },
    files: {
      markdownOf: (id) => (id === "f-1" ? "# 文件一" : null),
      contentOf: async (id) => (id === "f-1"
        ? { buffer: Buffer.from("# 文件一"), mime: "text/markdown", filename: "one.md" }
        : null),
    },
    agent: {
      getSnapshot: (id) => (id === "s-1"
        ? {
            session: { id: "s-1", roomId: "room-b", title: "旧会话" },
            messages: [{ id: "m-1", role: "user", content: "上线时间定了吗", createdAt: "2026-10-01T00:00:00.000Z" }],
          }
        : null),
    },
  };

  const makeHost = () => new AgentAccessMcpHost(
    service,
    (connection) => createAgentAccessTools(deps, connection, service, importArtifact),
  );

  return { client, service, deps, makeHost, artifactCalls, dataDir };
}

const ALL_CAPS = [
  "read_metadata", "search", "read_documents", "read_conversations", "read_files",
  "read_rules", "write_session", "write_candidates", "register_files",
] as const;
const READ_ONLY_CAPS = ALL_CAPS.filter((cap) => cap.startsWith("read") || cap === "search");

let nextRpcId = 0;

async function rpc(host: AgentAccessMcpHost, token: string, method: string, params: Record<string, unknown> = {}) {
  const id = ++nextRpcId;
  return await host.exchangeTrusted(`Bearer ${token}`, { jsonrpc: "2.0", id, method, params });
}

function resultOf(messages: Array<Record<string, unknown>>): Record<string, unknown> {
  const first = messages[0] as { result?: Record<string, unknown> } | undefined;
  if (!first?.result) throw new Error("missing result");
  return first.result;
}

describe("AgentAccessService 连接生命周期", () => {
  it("签发/暂停/恢复/轮换/吊销，列表脱敏", () => {
    const { client, service, dataDir } = setup();
    try {
      const created = service.createConnection({
        name: "Claude Code 笔记本",
        tool: "claude-code",
        scopes: { roomIds: ["room-a"], capabilities: [...ALL_CAPS], writebackRoomId: "room-a" },
      });
      expect(created.token).toMatch(/^evr_[A-Za-z0-9_-]{20,}$/);
      expect(created.connection.status).toBe("active");
      expect(JSON.stringify(service.listConnections())).not.toContain(created.token);

      expect(service.verifyBearer(created.token)?.id).toBe(created.connection.id);
      expect(service.verifyBearer("evr_not-a-real-token")).toBeNull();

      service.updateConnection(created.connection.id, { status: "paused" });
      expect(service.verifyBearer(created.token)).toBeNull();

      service.updateConnection(created.connection.id, { status: "active" });
      expect(service.verifyBearer(created.token)?.id).toBe(created.connection.id);

      const rotated = service.rotateToken(created.connection.id)!;
      expect(service.verifyBearer(created.token)).toBeNull();
      expect(service.verifyBearer(rotated.token)?.id).toBe(created.connection.id);
      expect(service.verifyTokenMatch(created.connection.id, rotated.token)).toBe(true);

      const revoked = service.revokeConnection(created.connection.id)!;
      expect(revoked.status).toBe("revoked");
      expect(service.verifyBearer(rotated.token)).toBeNull();
      expect(service.updateConnection(created.connection.id, { status: "active" })).toBeNull();
    } finally {
      client.sqlite.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe("AgentAccessMcpHost 范围与状态语义", () => {
  it("initialize → tools/list 按能力过滤；无写能力看不到 everroom_submit", async () => {
    const { client, service, makeHost, dataDir } = setup();
    const host = makeHost();
    try {
      const scoped = service.createConnection({
        name: "只读",
        tool: "cursor",
        scopes: { roomIds: ["room-a"], capabilities: [...READ_ONLY_CAPS], writebackRoomId: null },
      });
      const init = await rpc(host, scoped.token, "initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "cursor", version: "1" },
      });
      expect(resultOf(init)).toMatchObject({ serverInfo: { name: "everroom-agent-access" } });

      const listed = resultOf(await rpc(host, scoped.token, "tools/list")) as {
        tools: Array<{ name: string }>;
      };
      const names = listed.tools.map((tool) => tool.name);
      expect(names).toContain("everroom_search");
      expect(names).toContain("everroom_fetch");
      expect(names).not.toContain("everroom_submit");
      expect(names).not.toContain("everroom_register_file");

      const full = service.createConnection({
        name: "全权",
        tool: "codex",
        scopes: { roomIds: "all", capabilities: [...ALL_CAPS], writebackRoomId: "room-a" },
      });
      const fullNames = (resultOf(await rpc(host, full.token, "tools/list")) as {
        tools: Array<{ name: string }>;
      }).tools.map((tool) => tool.name);
      expect(fullNames).toContain("everroom_submit");
      await host.close();
    } finally {
      client.sqlite.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("数据行过滤：list_rooms 只见授权 Room；越权 fetch 返回 no_permission", async () => {
    const { client, service, makeHost, dataDir } = setup();
    const host = makeHost();
    try {
      const scoped = service.createConnection({
        name: "A 房间",
        tool: "claude-code",
        scopes: { roomIds: ["room-a"], capabilities: [...ALL_CAPS], writebackRoomId: "room-a" },
      });
      await rpc(host, scoped.token, "initialize", {});

      const rooms = resultOf(await rpc(host, scoped.token, "tools/call", {
        name: "everroom_list_rooms",
        arguments: {},
      })) as { structuredContent: { status: string; data: { rooms: Array<{ roomId: string; revision: number }> } } };
      expect(rooms.structuredContent.status).toBe("ok");
      expect(rooms.structuredContent.data.rooms.map((room) => room.roomId)).toEqual(["room-a"]);
      expect(rooms.structuredContent.data.rooms[0]!.revision).toBe(3);

      const deniedDoc = resultOf(await rpc(host, scoped.token, "tools/call", {
        name: "everroom_fetch",
        arguments: { uri: "everroom://documents/doc-1" },
      })) as { structuredContent: { status: string } };
      expect(deniedDoc.structuredContent.status).toBe("no_permission");

      const deniedSearch = resultOf(await rpc(host, scoped.token, "tools/call", {
        name: "everroom_search",
        arguments: { query: "讨论" },
      })) as { structuredContent: { status: string } };
      expect(deniedSearch.structuredContent.status).toBe("empty");
      await host.close();
    } finally {
      client.sqlite.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("搜索命中带会话/消息 ID；精读支持 basedOnVersion 的 stale 语义", async () => {
    const { client, service, makeHost, dataDir } = setup();
    const host = makeHost();
    try {
      const full = service.createConnection({
        name: "全库",
        tool: "generic",
        scopes: { roomIds: "all", capabilities: [...ALL_CAPS], writebackRoomId: null },
      });
      await rpc(host, full.token, "initialize", {});

      const search = resultOf(await rpc(host, full.token, "tools/call", {
        name: "everroom_search",
        arguments: { query: "讨论" },
      })) as { structuredContent: { data: { hits: Array<Record<string, unknown>> } } };
      const hit = search.structuredContent.data.hits.find((item) => item.kind === "conversation");
      expect(hit).toMatchObject({ conversationId: "s-1", messageId: "m-1" });
      // 搜索命中的 uri 必须能被 everroom_fetch 解析（rooms/documents/files 复数段）。
      const roomHit = search.structuredContent.data.hits.find((item) => item.kind === "room");
      expect(roomHit?.uri).toBe("everroom://rooms/room-b");

      const fresh = resultOf(await rpc(host, full.token, "tools/call", {
        name: "everroom_fetch",
        arguments: { uri: "everroom://conversations/s-1", basedOnVersion: "2026-10-01T00:00:00.000Z" },
      })) as { structuredContent: { status: string } };
      expect(fresh.structuredContent.status).toBe("ok");

      const stale = resultOf(await rpc(host, full.token, "tools/call", {
        name: "everroom_fetch",
        arguments: { uri: "everroom://conversations/s-1", basedOnVersion: "1999-01-01T00:00:00.000Z" },
      })) as { structuredContent: { status: string; latestVersion: string } };
      expect(stale.structuredContent.status).toBe("stale");
      expect(stale.structuredContent.latestVersion).toBe("2026-10-01T00:00:00.000Z");

      const lost = resultOf(await rpc(host, full.token, "tools/call", {
        name: "everroom_fetch",
        arguments: { uri: "everroom://conversations/s-nope" },
      })) as { structuredContent: { status: string } };
      expect(lost.structuredContent.status).toBe("source_lost");

      const fileRead = resultOf(await rpc(host, full.token, "tools/call", {
        name: "everroom_read_file",
        arguments: { fileId: "f-1" },
      })) as { structuredContent: { status: string; data: { version: string; markdown: string } } };
      expect(fileRead.structuredContent.status).toBe("ok");
      expect(fileRead.structuredContent.data.version).toMatch(/^[a-f0-9]{64}$/);
      expect(fileRead.structuredContent.data.markdown).toContain("文件一");
      await host.close();
    } finally {
      client.sqlite.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("无效 token 拒绝；重启自愈（新 host 实例无需重新 initialize）", async () => {
    const { client, service, makeHost, dataDir } = setup();
    try {
      const full = service.createConnection({
        name: "重启",
        tool: "claude-code",
        scopes: { roomIds: "all", capabilities: [...ALL_CAPS], writebackRoomId: null },
      });
      await expect(rpc(makeHost(), "evr_broken", "tools/list"))
        .rejects.toThrow("MCP_CONNECTION_INVALID");
      await expect(rpc(makeHost(), "evr_broken", "tools/call", {
        name: "everroom_get_status",
        arguments: {},
      })).rejects.toThrow("MCP_CONNECTION_INVALID");

      const firstHost = makeHost();
      await rpc(firstHost, full.token, "initialize", {});
      await firstHost.close();

      const restarted = makeHost();
      const listed = resultOf(await rpc(restarted, full.token, "tools/list")) as {
        tools: Array<{ name: string }>;
      };
      expect(listed.tools.length).toBeGreaterThan(0);
      await restarted.close();
    } finally {
      client.sqlite.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe("提交幂等（PRD 7.4 重试复用同一提交标识）", () => {
  it("五类条目各自落位；重放返回 duplicate 且不再入库", async () => {
    const { client, service, dataDir, artifactCalls } = setup();
    try {
      const created = service.createConnection({
        name: "回写",
        tool: "codex",
        scopes: { roomIds: ["room-a"], capabilities: [...ALL_CAPS], writebackRoomId: "room-a" },
      });
      const connection = service.verifyBearer(created.token)!;
      const outcome = await service.submit(connection, "task-42-run-1", [
        { kind: "session_increment", platform: "codex", threadId: "t-1", messages: [{ messageId: "m-1", role: "user", content: "做了调研" }] },
        { kind: "result_text", title: "调研结论", content: "# 结论\n……" },
        { kind: "artifact_file", filename: "report.md", contentBase64: Buffer.from("# 报告").toString("base64") },
        { kind: "citation", targetUri: "everroom://documents/doc-1", quote: "上线时间" },
        { kind: "candidate", candidateType: "memory", content: "用户偏好结论先行" },
      ]);
      expect(outcome.status).toBe("accepted");
      expect(outcome.results.map((item) => item.status)).toEqual([
        "recorded", "saved", "saved", "recorded", "pending_review",
      ]);
      expect(artifactCalls).toHaveLength(2); // result_text + artifact_file

      const replay = await service.submit(connection, "task-42-run-1", [
        { kind: "citation", targetUri: "everroom://self" },
      ]);
      expect(replay.status).toBe("duplicate");
      expect(replay.results.map((item) => item.status)).toEqual([
        "recorded", "saved", "saved", "recorded", "pending_review",
      ]);
      expect(artifactCalls).toHaveLength(2);

      const record = service.getSubmission(created.connection.id, "task-42-run-1")!;
      expect(record.duplicateCount).toBe(1);
      expect(record.status).toBe("completed");

      await expect(service.submit(connection, "bad id!", [])).rejects.toThrow("agent_access_submission");
      await expect(
        service.submit(connection, "ok-id", [{ kind: "candidate", candidateType: "memory", content: "  " }]),
      ).resolves.toMatchObject({ status: "accepted", results: [{ status: "rejected" }] });
    } finally {
      client.sqlite.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("MCP 端 everroom_submit 幂等 + submit_status 可查；事件落 agent_access_events", async () => {
    const { client, service, makeHost, dataDir } = setup();
    const host = makeHost();
    try {
      const full = service.createConnection({
        name: "提交",
        tool: "claude-code",
        scopes: { roomIds: "all", capabilities: [...ALL_CAPS], writebackRoomId: "room-a" },
      });
      await rpc(host, full.token, "initialize", {});

      const call = async (args: Record<string, unknown>) => resultOf(await rpc(host, full.token, "tools/call", {
        name: "everroom_submit",
        arguments: args,
      })) as { structuredContent: { status: string; data: { results: Array<{ status: string }> } } };

      const first = await call({
        submissionId: "sub-1",
        items: [{ kind: "candidate", candidateType: "preference", content: "PPT 浅色少字" }],
      });
      expect(first.structuredContent.status).toBe("ok");
      expect(first.structuredContent.data.results[0]!.status).toBe("pending_review");

      const replay = await call({
        submissionId: "sub-1",
        items: [{ kind: "candidate", candidateType: "preference", content: "PPT 浅色少字" }],
      });
      expect(replay.structuredContent.status).toBe("duplicate");

      const status = resultOf(await rpc(host, full.token, "tools/call", {
        name: "everroom_submit_status",
        arguments: { submissionId: "sub-1" },
      })) as { structuredContent: { status: string } };
      expect(status.structuredContent.status).toBe("ok");

      const events = service.listEvents(full.connection.id);
      expect(events.some((event) => event.kind === "connect")).toBe(true);
      expect(events.filter((event) => event.kind === "call" && event.tool === "everroom_submit").length).toBe(2);
      await host.close();
    } finally {
      client.sqlite.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
