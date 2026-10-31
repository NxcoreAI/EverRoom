import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { OfficeBridgeClient } from "../src/modules/documents/capabilities/office-bridge-client.js";

interface Recorded {
  url?: string | undefined;
  authorization?: string | undefined;
  body?: Record<string, unknown> | undefined;
}

/** 本地 stub：记录请求并按状态回 JSON（桌面 office-bridge 端点契约的最小替身）。 */
async function startStub(
  status = 200,
  data: Record<string, unknown> = {},
  rawBody?: Record<string, unknown>,
) {
  const recorded: Recorded[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    request.on("end", () => {
      recorded.push({
        url: request.url,
        authorization: String(request.headers.authorization ?? ""),
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
      });
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(rawBody ?? (status === 200 ? { data } : { message: "boom" })));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const client = new OfficeBridgeClient({ baseUrl: `http://127.0.0.1:${port}`, token: "test-token" });
  return {
    recorded,
    client,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe("OfficeBridgeClient", () => {
  it("generate 透传 deferDone（pptx 骨架入库阶段不广播 done）", async () => {
    const stub = await startStub(200, { fileEntryId: "file-1", originalName: "deck.pptx" });
    try {
      const result = await stub.client.generate({
        title: "季度汇报",
        format: "pptx",
        pages: ["{}"],
        roomId: "room-1",
        fileName: null,
        idempotencyKey: "idem-1",
        deferDone: true,
      });
      expect(result.fileEntryId).toBe("file-1");
      expect(stub.recorded[0]?.url).toBe("/v1/office-generate");
      expect(stub.recorded[0]?.authorization).toBe("Bearer test-token");
      expect(stub.recorded[0]?.body).toMatchObject({ format: "pptx", deferDone: true });
    } finally {
      await stub.close();
    }
  });

  it("completeDeck 调 /v1/office-complete 并带上真完成载荷", async () => {
    const stub = await startStub(200, { ok: true });
    try {
      const result = await stub.client.completeDeck({
        fileId: "file-1",
        title: "季度汇报",
        originalName: "季度汇报.pptx",
        roomId: "room-1",
        completed: false,
        appliedPages: 2,
        totalPages: 3,
        failedPages: [2],
      });
      expect(result).toEqual({ ok: true });
      expect(stub.recorded[0]?.url).toBe("/v1/office-complete");
      expect(stub.recorded[0]?.authorization).toBe("Bearer test-token");
      expect(stub.recorded[0]?.body).toMatchObject({
        fileId: "file-1",
        completed: false,
        appliedPages: 2,
        totalPages: 3,
        failedPages: [2],
      });
    } finally {
      await stub.close();
    }
  });

  it("completeDeck 非 200 抛错（调用方 try/catch 不阻塞产物）", async () => {
    const stub = await startStub(502);
    try {
      await expect(stub.client.completeDeck({
        fileId: "file-1",
        title: "季度汇报",
        completed: true,
        appliedPages: 3,
        totalPages: 3,
      })).rejects.toThrow("boom");
    } finally {
      await stub.close();
    }
  });

  it("describeAgentArtifact 透传 roomId/workspaceId，并带回 operationsGuide/documentState", async () => {
    const stub = await startStub(200, {
      describe: {
        context: "doc-context",
        operationsGuide: "table.insertRow {blockIndex, afterRow}",
        documentState: { tables: 2, sections: 1, revisions: 0 },
      },
    });
    try {
      const result = await stub.client.describeAgentArtifact({
        kind: "docx",
        fileId: "file-1",
        roomId: "room-9",
        workspaceId: "ws-7",
      });
      expect(stub.recorded[0]?.url).toBe("/v1/office-agent-tools");
      expect(stub.recorded[0]?.body).toMatchObject({
        kind: "docx",
        mode: "read",
        fileId: "file-1",
        roomId: "room-9",
        workspaceId: "ws-7",
      });
      expect(result.context).toBe("doc-context");
      expect(result.operationsGuide).toBe("table.insertRow {blockIndex, afterRow}");
      expect(result.documentState).toEqual({ tables: 2, sections: 1, revisions: 0 });
    } finally {
      await stub.close();
    }
  });

  it("applyAgentArtifactTools 透传 roomId/workspaceId（headless 编辑补齐实例归属）", async () => {
    const stub = await startStub(200, {
      results: [{ id: "ops-1", name: "apply_operations", output: "ok", mutated: true }],
    });
    try {
      const result = await stub.client.applyAgentArtifactTools({
        kind: "docx",
        fileId: "file-1",
        calls: [{ id: "ops-1", name: "apply_operations", input: { ops: [{ op: "table.autoFit" }] } }],
        roomId: "room-9",
        workspaceId: "ws-7",
      });
      expect(stub.recorded[0]?.url).toBe("/v1/office-agent-tools");
      expect(stub.recorded[0]?.body).toMatchObject({
        kind: "docx",
        mode: "apply",
        fileId: "file-1",
        roomId: "room-9",
        workspaceId: "ws-7",
      });
      expect(result.results?.[0]).toMatchObject({ id: "ops-1", output: "ok", mutated: true });
    } finally {
      await stub.close();
    }
  });

  it("未传 roomId/workspaceId 时请求体不带这两个字段（旧桌面端不受影响）", async () => {
    const stub = await startStub(200, { describe: { context: "c" } });
    try {
      await stub.client.describeAgentArtifact({ kind: "docx", fileId: "file-1", roomId: null, workspaceId: null });
      expect(stub.recorded[0]?.body).not.toHaveProperty("roomId");
      expect(stub.recorded[0]?.body).not.toHaveProperty("workspaceId");
    } finally {
      await stub.close();
    }
  });

  it("exportPdf 调 /v1/office-export-pdf 并透传 fileId/文件名/Room/工作区", async () => {
    const stub = await startStub(200, {
      ok: true,
      fileId: "fe-pdf",
      originalName: "智能家居行业调研报告.pdf",
      contentHash: "c".repeat(64),
    });
    try {
      const result = await stub.client.exportPdf({
        fileId: "fe-1",
        fileName: "最终版.pdf",
        roomId: "room-9",
        workspaceId: "ws-7",
      });
      expect(stub.recorded[0]?.url).toBe("/v1/office-export-pdf");
      expect(stub.recorded[0]?.authorization).toBe("Bearer test-token");
      expect(stub.recorded[0]?.body).toEqual({
        fileId: "fe-1",
        fileName: "最终版.pdf",
        roomId: "room-9",
        workspaceId: "ws-7",
      });
      expect(result).toEqual({
        ok: true,
        fileId: "fe-pdf",
        originalName: "智能家居行业调研报告.pdf",
        contentHash: "c".repeat(64),
      });
    } finally {
      await stub.close();
    }
  });

  it("exportPdf 非 2xx 时抛桌面端给出的可读 message", async () => {
    const stub = await startStub(502);
    try {
      await expect(stub.client.exportPdf({ fileId: "fe-1" })).rejects.toThrow("boom");
    } finally {
      await stub.close();
    }
  });

  it("exportPdf 遇到扁平 { ok:false, message }（HTTP 200）也当失败处理", async () => {
    const stub = await startStub(200, {}, { ok: false, message: "LibreOffice 未安装，无法转换为 PDF" });
    try {
      await expect(stub.client.exportPdf({ fileId: "fe-1" }))
        .rejects.toThrow("LibreOffice 未安装，无法转换为 PDF");
    } finally {
      await stub.close();
    }
  });

  it("exportPdf 成功但缺 fileId 时报错（不返回空条目）", async () => {
    const stub = await startStub(200, { ok: true, originalName: "x.pdf" });
    try {
      await expect(stub.client.exportPdf({ fileId: "fe-1" }))
        .rejects.toThrow(/OFFICE_EXPORT_FAILED/);
    } finally {
      await stub.close();
    }
  });
});
