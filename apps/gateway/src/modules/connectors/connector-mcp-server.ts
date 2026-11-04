import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { ConnectorMcpHost } from "./connector-mcp-host.js";

/**
 * 连接器 MCP 的 loopback HTTP listener。
 *
 * 独立于 Fastify：网关可能以 --port 0 启动，而 agent runtime 在 listen 之前
 * 就要拿到 MCP URL；先 await 这个 listener，再创建 runtime。
 *
 * 鉴权：token-in-path（高熵、进程内生成、不落盘）。只绑定 127.0.0.1。
 */
export class ConnectorMcpServer {
  private server: Server | null = null;
  private token: string | null = null;
  private baseUrl: string | null = null;

  constructor(
    private readonly host: ConnectorMcpHost,
    private readonly options: {
      hostname?: string;
      maxBodyBytes?: number;
      logger?: { warn(bindings: Record<string, unknown>, message: string): void };
    } = {},
  ) {}

  async start(): Promise<{ url: string; token: string }> {
    if (this.server && this.token && this.baseUrl) return { url: this.baseUrl, token: this.token };
    const token = randomBytes(24).toString("base64url");
    const hostname = this.options.hostname ?? "127.0.0.1";
    const server = createServer((request, response) => {
      void this.handle(request, response).catch((error: unknown) => {
        this.options.logger?.warn(
          { error: error instanceof Error ? error.message : String(error) },
          "connector mcp request failed",
        );
        if (!response.headersSent) {
          response.writeHead(500, { "content-type": "application/json" });
          response.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32603, message: "Internal error" } }));
        } else {
          response.end();
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, hostname, () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address() as AddressInfo;
    this.server = server;
    this.token = token;
    this.baseUrl = `http://${hostname}:${address.port}/mcp/connectors/${token}`;
    return { url: this.baseUrl, token };
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.token = null;
    this.baseUrl = null;
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      // MCP 客户端可能保持 keep-alive 连接；不主动断开会让 gateway 关闭挂住。
      server.closeAllConnections?.();
    });
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const expected = this.token ? `/mcp/connectors/${this.token}` : "";
    if (!expected || url.pathname !== expected) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not_found" }));
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(405, { "content-type": "application/json", allow: "POST" });
      response.end(JSON.stringify({ error: "method_not_allowed" }));
      return;
    }
    const body = await this.readBody(request);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }));
      return;
    }
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    const replies = [];
    for (const message of messages) {
      if (!message || typeof message !== "object") {
        replies.push({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });
        continue;
      }
      const reply = await this.host.handle(message as Parameters<ConnectorMcpHost["handle"]>[0]);
      if (reply) replies.push(reply);
    }
    if (replies.length === 0) {
      response.writeHead(202);
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(Array.isArray(parsed) ? replies : replies[0]));
  }

  private readBody(request: IncomingMessage): Promise<string> {
    const max = this.options.maxBodyBytes ?? 1_048_576;
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > max) {
          reject(new Error("request_too_large"));
          request.destroy();
          return;
        }
        chunks.push(chunk);
      });
      request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      request.on("error", reject);
    });
  }
}
