import type { FastifyBaseLogger } from "fastify";
import {
  MemoryCoreClient,
  MemoryCoreError,
  type MemoryAtomicQuery,
  type MemoryConversationQuery,
  type MemoryPipelineStatus,
  type MemoryRuntimeConfig,
} from "@nxcore/agent-runtime-pi";
import { MemoryGatewayError } from "./errors.js";

/** UI 浏览场景的超时：比 agent 注入流程（3s）宽松，但仍在交互可接受范围。 */
const BROWSE_TIMEOUT_MS = 10_000;

/** 渲染层 DTO：L1 原子记忆。 */
export interface MemoryAtomicDto {
  id: string;
  type: string;
  content: string;
  background: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 渲染层 DTO：L0 对话消息。 */
export interface MemoryConversationMessageDto {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string | null;
  sessionId: string | null;
}

/** 渲染层 DTO：L2 场景目录项。 */
export interface MemoryScenarioEntryDto {
  path: string;
  summary: string | null;
  isDirectory: boolean;
  createdAt: string;
  updatedAt: string;
}

/** 渲染层 DTO：单个提炼层的运行状态（省略 session 明细）。 */
export interface MemoryPipelineStageDto {
  queued: number;
  running: number;
  idle: boolean;
}

/** 渲染层 DTO：总览。 */
export interface MemoryOverviewDto {
  l1: { total: number; byType: { episodic: number; persona: number; instruction: number } } | null;
  l0: { total: number } | null;
  l2: { total: number } | null;
  l3: { exists: boolean; updatedAt: string | null } | null;
  pipeline: { l1: MemoryPipelineStageDto; l2: MemoryPipelineStageDto; l3: MemoryPipelineStageDto } | null;
}

function toStageDto(stage: MemoryPipelineStatus["l1"]): MemoryPipelineStageDto {
  return {
    queued: stage.queued,
    running: stage.running,
    idle: stage.idle,
  };
}

export interface MemoryListOptions {
  type?: MemoryAtomicQuery["type"] | undefined;
  limit: number;
  offset: number;
  timeStart?: string | undefined;
  timeEnd?: string | undefined;
}

export interface MemoryConversationListOptions {
  sessionId?: string | undefined;
  limit: number;
  offset: number;
  timeStart?: string | undefined;
  timeEnd?: string | undefined;
}

/**
 * MemoryCore 的 gateway 侧门面：注入隔离三元组，把 snake_case 的 v3 响应
 * 映射为稳定的 camelCase DTO；未配置记忆时所有方法抛 memory_disabled。
 */
export class MemoryService {
  private readonly client: MemoryCoreClient | null;

  constructor(config: MemoryRuntimeConfig | null, private readonly logger: FastifyBaseLogger) {
    this.client = config ? new MemoryClientWithTimeout(config) : null;
  }

  get enabled(): boolean {
    return this.client !== null;
  }

  async overview(): Promise<MemoryOverviewDto> {
    const client = this.require();
    const [l1All, l1Episodic, l1Persona, l1Instruction, l0, l2, l3, pipeline] = await Promise.allSettled([
      client.countAtomic(),
      client.countAtomic("episodic"),
      client.countAtomic("persona"),
      client.countAtomic("instruction"),
      client.countConversation(),
      client.countScenario(),
      client.readCoreFile(),
      client.pipelineStatus(),
    ]);
    // 总览页允许单路失败：失败的层置 null，前端按"未知"渲染，而不是整页 502。
    const counted = (result: PromiseSettledResult<number>) =>
      result.status === "fulfilled" ? result.value : null;
    const l1Total = counted(l1All);
    const episodic = counted(l1Episodic);
    const persona = counted(l1Persona);
    const instruction = counted(l1Instruction);
    if (l1Total === null && episodic === null && persona === null && instruction === null) {
      // L1 全部探测失败说明 MemoryCore 整体不可用，总览不应假装"未知"。
      this.mapFailure((l1All as PromiseRejectedResult).reason);
    }
    return {
      l1: {
        total: l1Total ?? (episodic ?? 0) + (persona ?? 0) + (instruction ?? 0),
        byType: {
          episodic: episodic ?? 0,
          persona: persona ?? 0,
          instruction: instruction ?? 0,
        },
      },
      l0: l0.status === "fulfilled" ? { total: l0.value } : null,
      l2: l2.status === "fulfilled" ? { total: l2.value } : null,
      l3: l3.status === "fulfilled"
        ? { exists: l3.value.content != null, updatedAt: l3.value.updated_at || null }
        : null,
      pipeline: pipeline.status === "fulfilled"
        ? {
            l1: toStageDto(pipeline.value.l1),
            l2: toStageDto(pipeline.value.l2),
            l3: toStageDto(pipeline.value.l3),
          }
        : null,
    };
  }

  async listAtomic(options: MemoryListOptions): Promise<{ items: MemoryAtomicDto[]; total: number }> {
    const client = this.require();
    const page = await this.call(() => client.queryAtomic({
      type: options.type,
      limit: options.limit,
      offset: options.offset,
      timeStart: options.timeStart,
      timeEnd: options.timeEnd,
    }));
    return {
      items: page.items.map((item) => ({
        id: item.id,
        type: item.type,
        content: item.content,
        background: item.background ?? null,
        createdAt: item.created_at,
        updatedAt: item.updated_at,
      })),
      total: page.total,
    };
  }

  async searchAtomic(query: string, limit: number): Promise<{ items: (MemoryAtomicDto & { score: number })[] }> {
    const client = this.require();
    const items = await this.call(() => client.searchAtomic(query, limit));
    return {
      items: items.map((item) => ({
        id: item.id,
        type: item.type,
        content: item.content,
        background: item.background ?? null,
        createdAt: item.created_at,
        updatedAt: item.updated_at,
        score: item.score ?? 0,
      })),
    };
  }

  async updateAtomic(
    id: string,
    content: string,
    background?: string,
  ): Promise<{ id: string; version: number; updatedAt: string }> {
    const client = this.require();
    const result = await this.call(() => client.updateAtomic(id, content, background));
    return { id: result.id, version: result.version, updatedAt: result.updated_at };
  }

  async deleteAtomic(ids: string[]): Promise<{ deletedCount: number }> {
    const client = this.require();
    const result = await this.call(() => client.deleteAtomic(ids));
    return { deletedCount: result.deleted_count };
  }

  async listScenarios(pathPrefix?: string): Promise<{ entries: MemoryScenarioEntryDto[]; total: number }> {
    const client = this.require();
    const entries = await this.call(() => client.listScenarios());
    const filtered = pathPrefix
      ? entries.filter((entry) => entry.path.startsWith(pathPrefix))
      : entries;
    return {
      entries: filtered.map((entry) => ({
        path: entry.path,
        summary: entry.summary ?? null,
        isDirectory: entry.path.endsWith("/"),
        createdAt: entry.created_at,
        updatedAt: entry.updated_at,
      })),
      total: filtered.length,
    };
  }

  async readScenario(path: string): Promise<{
    path: string;
    content: string | null;
    version: number;
    updatedAt: string;
  }> {
    const client = this.require();
    const file = await this.call(() => client.readScenario(path));
    return {
      path: file.path,
      content: file.content,
      version: file.version,
      updatedAt: file.updated_at,
    };
  }

  async readCore(): Promise<{ content: string | null; version: number; updatedAt: string }> {
    const client = this.require();
    const file = await this.call(() => client.readCoreFile());
    return { content: file.content, version: file.version, updatedAt: file.updated_at };
  }

  async writeCore(content: string): Promise<{ version: number; updatedAt: string }> {
    const client = this.require();
    const result = await this.call(() => client.writeCore(content));
    return { version: result.version, updatedAt: result.updated_at };
  }

  async listConversations(
    options: MemoryConversationListOptions,
  ): Promise<{ messages: MemoryConversationMessageDto[]; total: number }> {
    const client = this.require();
    const page = await this.call(() => client.queryConversation({
      sessionId: options.sessionId,
      limit: options.limit,
      offset: options.offset,
      timeStart: options.timeStart,
      timeEnd: options.timeEnd,
    }));
    return {
      messages: page.messages.map((message) => ({
        id: message.id,
        role: message.role,
        content: message.content,
        timestamp: message.timestamp ?? null,
        sessionId: message.session_id ?? null,
      })),
      total: page.total,
    };
  }

  async searchConversations(
    query: string,
    limit: number,
    sessionId?: string,
  ): Promise<{ messages: (MemoryConversationMessageDto & { score: number })[] }> {
    const client = this.require();
    const messages = await this.call(() => client.searchConversation(query, limit, sessionId));
    return {
      messages: messages.map((message) => ({
        id: message.id ?? "",
        role: message.role === "assistant" ? "assistant" : "user",
        content: message.content,
        timestamp: message.timestamp ?? null,
        sessionId: null,
        score: message.score ?? 0,
      })),
    };
  }

  async deleteConversations(target: {
    sessionIds?: string[] | undefined;
    messageIds?: string[] | undefined;
  }): Promise<{ deletedCount: number }> {
    const client = this.require();
    const result = await this.call(() => client.deleteConversation(target));
    return { deletedCount: result.deleted_count };
  }

  private require(): MemoryCoreClient {
    if (!this.client) {
      throw new MemoryGatewayError(
        "memory_disabled",
        "MemoryCore is not enabled on this gateway (NXCORE_MEMORY_ENABLED)",
        503,
      );
    }
    return this.client;
  }

  private async call<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof MemoryGatewayError) throw error;
      if (error instanceof MemoryCoreError) {
        this.logger.warn({ err: error }, "memory core request failed");
        if (error.kind === "unreachable") {
          throw new MemoryGatewayError(
            "memory_unreachable",
            `MemoryCore is unreachable: ${error.message}`,
            502,
          );
        }
        throw new MemoryGatewayError("memory_error", error.message, 502);
      }
      throw error;
    }
  }

  private mapFailure(reason: unknown): never {
    if (reason instanceof MemoryCoreError) {
      if (reason.kind === "unreachable") {
        throw new MemoryGatewayError("memory_unreachable", `MemoryCore is unreachable: ${reason.message}`, 502);
      }
      throw new MemoryGatewayError("memory_error", reason.message, 502);
    }
    throw reason instanceof Error ? reason : new Error(String(reason));
  }
}

/** 仅为注入浏览超时的构造包装。 */
class MemoryClientWithTimeout extends MemoryCoreClient {
  constructor(config: MemoryRuntimeConfig) {
    super({ ...config, timeoutMs: BROWSE_TIMEOUT_MS });
  }
}
