import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { MemoryCoreClient } from "./client.js";
import { formatRecallResult } from "./format.js";
import type { MemoryCaptureMessage, MemoryRuntimeConfig } from "./types.js";

const TAG = "[pi-memory]";

/** 当前回合的记忆上下文，由 PiAgentRuntime 在 prompt() 前填充。 */
export interface MemoryRunContext {
  /** 网关 agent_sessions.id，作为 MemoryCore 的 session_id。 */
  sessionId: string;
  /** 用户原始请求（未加"当前工作区"包装）。 */
  originalPrompt: string;
  /** 当前工作区标签。 */
  pageLabel: string;
  /** 回合被取消时置位，agent_end 不再回写。 */
  cancelled: boolean;
  /** 临时预览类运行关闭自动沉淀，由用户确认后的领域事件负责写入。 */
  captureEnabled: boolean;
}

export interface MemoryLogger {
  warn: (message: string) => void;
  info?: (message: string) => void;
}

export interface MemoryExtensionOptions {
  client: MemoryCoreClient;
  config: MemoryRuntimeConfig;
  getRunContext: () => MemoryRunContext | null;
  logger?: MemoryLogger;
}

const RECALL_QUERY_MAX_CHARS = 500;
const MIN_ASSISTANT_CAPTURE_CHARS = 8;

/**
 * pi 内联扩展：每轮自动召回（before_agent_start 注入 memory-recall 自定义消息）
 * 与沉淀（agent_end 将本轮 user/assistant 消息写入 MemoryCore L0）。
 *
 * 所有记忆调用失败都静默降级，不影响 agent 主流程。
 */
export function createMemoryExtension(options: MemoryExtensionOptions): InlineExtension {
  const { client, config, getRunContext, logger } = options;
  const log = logger ?? { warn: () => undefined };

  return {
    name: "memory",
    factory: (pi) => {
      pi.on("before_agent_start", async () => {
        const run = getRunContext();
        if (!run || run.cancelled) return;

        const query = run.originalPrompt.slice(0, RECALL_QUERY_MAX_CHARS);
        const [atomic, core, scenarios, conversations] = await Promise.allSettled([
          client.searchAtomic(query, config.recallLimit),
          client.readCore(),
          client.listScenarios(),
          client.searchConversation(query, config.recallLimit),
        ]);
        if (atomic.status === "rejected") {
          log.warn(`${TAG} L1 recall failed: ${String(atomic.reason)}`);
        }
        if (core.status === "rejected") {
          log.warn(`${TAG} L3 recall failed: ${String(core.reason)}`);
        }
        if (scenarios.status === "rejected") {
          log.warn(`${TAG} L2 scenario list failed: ${String(scenarios.reason)}`);
        }
        if (conversations.status === "rejected") {
          log.warn(`${TAG} L0 conversation recall failed: ${String(conversations.reason)}`);
        }

        const content = formatRecallResult(
          {
            atomicItems: atomic.status === "fulfilled" ? atomic.value : [],
            coreContent: core.status === "fulfilled" ? core.value?.content ?? null : null,
            scenarios: scenarios.status === "fulfilled" ? scenarios.value : [],
            conversationHits: conversations.status === "fulfilled" ? conversations.value : [],
          },
          config.charBudget,
        );
        if (!content) return;

        return {
          message: {
            customType: "memory-recall",
            content,
            display: false,
          },
        };
      });

      pi.on("agent_end", async (event) => {
        const run = getRunContext();
        if (!run || run.cancelled || !run.captureEnabled) return;

        const messages = extractCapturableMessages(event.messages, run);
        if (messages.length === 0) return;

        // fire-and-forget：失败重试一次，仍失败仅记日志，不阻塞回合收尾。
        void writeWithRetry(client, run.sessionId, messages, log);
      });
    },
  };
}

async function writeWithRetry(
  client: MemoryCoreClient,
  sessionId: string,
  messages: MemoryCaptureMessage[],
  log: MemoryLogger,
): Promise<void> {
  try {
    await client.addConversation(sessionId, messages);
  } catch (error) {
    log.warn(`${TAG} L0 capture failed, retrying once: ${String(error)}`);
    try {
      await client.addConversation(sessionId, messages);
    } catch (retryError) {
      log.warn(`${TAG} L0 capture retry failed: ${String(retryError)}`);
    }
  }
}

interface ExtractedMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * 从 agent_end 的消息数组中提取可回写的 user/assistant 文本：
 * - 排除 custom（含 memory-recall 注入块）、toolResult、thinking 等非对话内容
 * - user 消息替换为原始请求（带工作区前缀），去除"当前工作区…"包装反复入库
 * - assistant 过滤超短回复
 */
export function extractCapturableMessages(
  messages: unknown[],
  run: Pick<MemoryRunContext, "originalPrompt" | "pageLabel">,
): MemoryCaptureMessage[] {
  const extracted: ExtractedMessage[] = [];
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const role = (message as { role?: unknown }).role;
    if (role !== "user" && role !== "assistant") continue;
    const content = extractTextContent((message as { content?: unknown }).content);
    if (!content) continue;
    extracted.push({ role, content });
  }
  if (extracted.length === 0) return [];

  // 首条 user 消息是本轮输入（可能带"当前工作区"包装），替换为原始请求。
  const first = extracted[0];
  if (first && first.role === "user") {
    extracted[0] = {
      role: "user",
      content: `[workspace: ${run.pageLabel}] ${run.originalPrompt}`,
    };
  }

  const now = new Date().toISOString();
  return extracted
    .filter((message) => message.role === "user" || message.content.trim().length >= MIN_ASSISTANT_CAPTURE_CHARS)
    .map((message) => ({ role: message.role, content: message.content.trim(), timestamp: now }));
}

function extractTextContent(content: unknown): string | null {
  if (typeof content === "string") return content.trim() || null;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object" && (block as { type?: unknown }).type === "text") {
      const text = (block as { text?: unknown }).text;
      if (typeof text === "string") parts.push(text);
    }
  }
  const joined = parts.join("\n").trim();
  return joined || null;
}
