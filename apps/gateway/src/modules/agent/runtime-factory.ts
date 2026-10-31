import { join } from "node:path";
import { FakeAgentRuntime } from "@nxcore/agent-runtime/testing";
import {
  PiAgentRuntime,
  type PiAgentRuntimeTool,
} from "@nxcore/agent-runtime-pi";
import { UnconfiguredAgentRuntime, type AgentRuntime } from "@nxcore/agent-runtime";
import { bundledAgentDefinitionsDir, type GatewayConfig } from "../../config.js";
import type { DocumentMcpHost } from "../documents/mcp-host.js";
import { createDocumentPiTools } from "../documents/pi-tools.js";
import { SLIDES_TOOL_NAMES } from "../documents/capabilities/office-plugin.js";
import { createWebSearchPiTools } from "./web-search-tools.js";
import { createLiteDelegatePiTools } from "./lite-delegate-tools.js";
import { createWorkspaceFilesPiTools, type WorkspaceFileCatalog } from "./workspace-files-tools.js";
import { OpenAiCompletionAgentRuntime } from "./openai-completion-runtime.js";
import { AgentResolver, BUILTIN_AGENT_IDS, type AgentDefinition } from "./resolver.js";
import type { AgentDebugTraceStore } from "../agent-debug/trace-store.js";
import { loadBuiltinAgentBundle } from "./builtin-bundles.js";
import type { ExternalCallBudgetService } from "../external-calls/service.js";

export interface AgentRuntimeIntegrationOptions {
  tools?: readonly PiAgentRuntimeTool[];
  agentResolver?: AgentResolver;
  externalCalls?: ExternalCallBudgetService;
  /** 工作区文件目录（晚绑定 getter）：filesService 在 runtime 装配之后才创建。 */
  workspaceFiles?: () => WorkspaceFileCatalog | null;
  /** 连接器 MCP 中转地址（loopback）；只在用户档 runtime 注入。 */
  connectorMcp?: { url: string };
}

function agentDirectories(config: GatewayConfig, agentId: string) {
  const root = join(config.dataDir, "agent", "runtimes", agentId);
  return {
    root,
    sessionsDir: join(root, "sessions"),
    workingDirectory: join(root, "workspace"),
    agentDirectory: join(root, "config"),
  };
}

function definition(config: GatewayConfig, input: Omit<AgentDefinition, "configDirectory" | "kind">): AgentDefinition {
  return {
    ...input,
    configDirectory: agentDirectories(config, input.id).agentDirectory,
    kind: "builtin",
  };
}

function builtin(id: (typeof BUILTIN_AGENT_IDS)[keyof typeof BUILTIN_AGENT_IDS]) {
  return loadBuiltinAgentBundle(bundledAgentDefinitionsDir(), id);
}

/**
 * pi 配置四要素齐全才算可用（与 runtime-config 的 isPrimaryConfigured 同判据）。
 * 未配置（pi 模式 + env 全空 + runtime config 尚未保存）返回占位 runtime，
 * 见各工厂的降级分支。
 */
export function isPiRuntimeConfigured(
  pi: { provider: string; model: string; baseUrl: string; apiKey: string } | null | undefined,
): boolean {
  return Boolean(pi && pi.provider && pi.model && pi.baseUrl && pi.apiKey);
}

function withAgentDirectories(
  config: GatewayConfig,
  agentId: string,
  pi: NonNullable<GatewayConfig["pi"]>,
): NonNullable<GatewayConfig["pi"]> {
  const directories = agentDirectories(config, agentId);
  return {
    ...pi,
    runtimeId: `pi:${agentId}`,
    sessionsDir: directories.sessionsDir,
    workingDirectory: directories.workingDirectory,
    agentDirectory: directories.agentDirectory,
  };
}


/**
 * 把连接器 MCP 中转合并进 pi 的 mcpServers。
 * URL/token 都是进程内动态值，不写 .mcp.json；会话变更不需要重建 runtime。
 */
function withConnectorMcp(
  pi: NonNullable<GatewayConfig["pi"]>,
  connectorMcp: { url: string } | undefined,
): NonNullable<GatewayConfig["pi"]> {
  if (!connectorMcp) return pi;
  return {
    ...pi,
    mcp: {
      ...pi.mcp,
      mcpServers: {
        ...(pi.mcp?.mcpServers ?? {}),
        "everroom-connectors": {
          type: "http",
          name: "everroom-connectors",
          url: connectorMcp.url,
          headers: [],
        },
      },
    },
  };
}

export function createAgentRuntime(
  config: GatewayConfig,
  mcpHost: DocumentMcpHost,
  integrations?: AgentRuntimeIntegrationOptions,
): AgentRuntime {
  return createUserFacingRuntime(config, mcpHost, integrations, BUILTIN_AGENT_IDS.primary, config.pi, true)
    ?? new UnconfiguredAgentRuntime(BUILTIN_AGENT_IDS.primary);
}

/**
 * 用户档不暴露 document_list（文稿库清单）：文件查找一律走 workspace_files_list，
 * 不再把「读导入文件」的请求绕去文稿库空转；改稿目标由 activeDocument 上下文
 * 或直接问用户确定。子代理（doc-writer / slides 系）各自的 documentTools
 * 不经此过滤，仍保留 document_list。
 */
const USER_FACING_EXCLUDED_DOCUMENT_TOOLS = ["document_list"] as const;

/**
 * 用户档 runtime 统一装配（main / main-direct / main-lite 共用）：
 * 同一 primary 人设 bundle、同套工具（文档/连接器/联网搜索/外部 MCP），
 * 差异仅在 pi 配置与 lite 委派工具。返回 null＝该 pi 未配置（调用方
 * 决定占位或跳过注册）。
 */
function createUserFacingRuntime(
  config: GatewayConfig,
  mcpHost: DocumentMcpHost,
  integrations: AgentRuntimeIntegrationOptions | undefined,
  agentId: string,
  pi: GatewayConfig["pi"],
  liteDelegate: boolean,
): AgentRuntime | null {
  if (config.agentRuntime === "fake") return new FakeAgentRuntime();
  if (!pi || !isPiRuntimeConfigured(pi)) return null;
  const bundle = builtin(BUILTIN_AGENT_IDS.primary);
  return new PiAgentRuntime({
    ...withConnectorMcp(withAgentDirectories(config, agentId, pi), integrations?.connectorMcp),
    // 用户档护栏：单轮工具预算 + 同一调用重复上限，超限即停并如实反馈。
    maxToolCallsPerRun: 60,
    maxRepeatedToolCalls: 3,
    // bash 仅在白名单根目录内沙箱执行（历史事故：无沙箱 bash 直读应用数据库「找图」）。
    bashSandbox: {
      allowedRoots: [agentDirectories(config, agentId).workingDirectory],
      timeoutMs: 30_000,
    },
    runtimeRole: "user-facing",
    skillsEnabled: true,
    skillPrompts: bundle.skillPrompts,
    systemPrompt: bundle.systemPrompt,
  }, {
    tools: [
      ...(integrations?.tools ?? []),
      // 工作区文件（含用户上传图片）的一等入口：只读清单 + 可引用句柄。
      ...(integrations?.workspaceFiles
        ? createWorkspaceFilesPiTools(integrations.workspaceFiles)
        : []),
      // PPT 四件套归 slides 子代理独占（create：slides-planner 方案 → slides-builder 落页；
      // edit：slides-builder 直改）：用户档（main/main-direct/main-lite）
      // 剔除，改走 slides_draft 调度；doc-writer 消费点另有 allowlist 不受影响。
      // document_list（文稿库清单）同样剔除，见 USER_FACING_EXCLUDED_DOCUMENT_TOOLS。
      ...createDocumentPiTools(mcpHost)
        .filter((tool) => ![...(SLIDES_TOOL_NAMES as readonly string[]), ...USER_FACING_EXCLUDED_DOCUMENT_TOOLS].includes(tool.name)),
      ...(config.webSearch && integrations?.agentResolver
        ? createWebSearchPiTools(integrations.agentResolver, integrations.externalCalls)
        : []),
      // Smart 档专属：轻量模型可用时才暴露委派工具（primary/lite 档不挂）。
      ...(liteDelegate && integrations?.agentResolver && isPiRuntimeConfigured(config.litePi)
        ? createLiteDelegatePiTools(integrations.agentResolver)
        : []),
    ],
    promptGuidelines: mcpHost.capabilities.promptGuidelines(),
    onRunFinished: async (input, outcome) => {
      await mcpHost.finishAgentRun(input.sessionId, outcome, input.runId);
    },
    ...(integrations?.externalCalls
      ? {
          executeMcpCall: (input, tool, invoke) => {
            // 连接器 MCP 计入 CONNECTOR 预算（与普通外部 MCP 分开配额/审计）。
            const service = tool.startsWith("everroom-connectors.") ? "CONNECTOR" : "MCP";
            return integrations.externalCalls!.execute(service, tool, {
              source: "agent",
              runId: input.runId,
              correlationId: input.sessionId,
            }, async (markDispatched) => {
              markDispatched();
              return invoke();
            });
          },
        }
      : {}),
  });
}

/** 文稿版本摘要的隔离内部 runtime（无工具、单次调用）。
 *  原为写作风格定性层 runtime；风格提炼退役后由版本摘要接手（Phase 2d）。 */
export function createVersionSummaryRuntime(config: GatewayConfig): AgentRuntime | null {
  if (config.agentRuntime === "fake" || !isPiRuntimeConfigured(config.backgroundPi)) return null;
  const { mcp: _mcp, ...pi } = config.backgroundPi!;
  return new PiAgentRuntime({
    ...pi,
    includeBashTool: false,
    builtinTools: [],
    maxToolCallsPerRun: 1,
    runtimeRole: "internal",
    sessionsDir: join(pi.sessionsDir, "version-summary"),
    workingDirectory: join(pi.workingDirectory, "version-summary"),
    agentDirectory: join(pi.agentDirectory, "version-summary"),
  });
}

/** 文档索引回溯（blockIndexMark）的 LLM 兜底：writing-style 同款隔离内部 runtime。 */
export function createIndexBackfillRuntime(config: GatewayConfig): AgentRuntime | null {
  if (config.agentRuntime === "fake" || !isPiRuntimeConfigured(config.backgroundPi)) return null;
  const { mcp: _mcp, ...pi } = config.backgroundPi!;
  return new PiAgentRuntime({
    ...pi,
    includeBashTool: false,
    builtinTools: [],
    maxToolCallsPerRun: 1,
    runtimeRole: "internal",
    sessionsDir: join(pi.sessionsDir, "index-backfill"),
    workingDirectory: join(pi.workingDirectory, "index-backfill"),
    agentDirectory: join(pi.agentDirectory, "index-backfill"),
  });
}

/** 会话标题生成：index-backfill 同款隔离内部 runtime（无工具、单次调用）。 */
export function createSessionTitleRuntime(config: GatewayConfig): AgentRuntime | null {
  if (config.agentRuntime === "fake" || !isPiRuntimeConfigured(config.backgroundPi)) return null;
  const { mcp: _mcp, ...pi } = config.backgroundPi!;
  return new PiAgentRuntime({
    ...pi,
    includeBashTool: false,
    builtinTools: [],
    maxToolCallsPerRun: 1,
    runtimeRole: "internal",
    // 标题是单行机器输出：与 background runtime 同理不继承 primary reasoning。
    reasoning: "off",
    sessionsDir: join(pi.sessionsDir, "session-title"),
    workingDirectory: join(pi.workingDirectory, "session-title"),
    agentDirectory: join(pi.agentDirectory, "session-title"),
  });
}

/** 文档速览（文章级 AI 摘要）：index-backfill 同款隔离内部 runtime（无工具、单次调用）。 */
export function createDocumentOverviewRuntime(config: GatewayConfig): AgentRuntime | null {
  if (config.agentRuntime === "fake" || !isPiRuntimeConfigured(config.backgroundPi)) return null;
  const { mcp: _mcp, ...pi } = config.backgroundPi!;
  return new PiAgentRuntime({
    ...pi,
    includeBashTool: false,
    builtinTools: [],
    maxToolCallsPerRun: 1,
    runtimeRole: "internal",
    sessionsDir: join(pi.sessionsDir, "document-overview"),
    workingDirectory: join(pi.workingDirectory, "document-overview"),
    agentDirectory: join(pi.agentDirectory, "document-overview"),
  });
}

export function createCursorCompletionRuntime(config: GatewayConfig): AgentRuntime {
  const bundle = builtin(BUILTIN_AGENT_IDS.cursorCompletion);
  if (config.agentRuntime === "fake") return new FakeAgentRuntime();
  if (!isPiRuntimeConfigured(config.cursorCompletionPi)) {
    return new UnconfiguredAgentRuntime(BUILTIN_AGENT_IDS.cursorCompletion);
  }
  return new PiAgentRuntime({
    ...withAgentDirectories(config, BUILTIN_AGENT_IDS.cursorCompletion, config.cursorCompletionPi!),
    runtimeRole: "internal",
    skillsEnabled: true,
    skillPrompts: bundle.skillPrompts,
    systemPrompt: bundle.systemPrompt,
  });
}

/**
 * 对话侧建议（输入框空态补全 + 新对话推荐提问）的隔离内部 runtime：
 * 无工具/记忆，单次调用。档位优先 cursorCompletionPi（qwen-flash 低延迟档），
 * 未配置时回退 background——两者都是机器对机器短输出，reasoning 一律关闭。
 */
export function createConversationSuggestionRuntime(config: GatewayConfig): AgentRuntime | null {
  if (config.agentRuntime === "fake") return null;
  const tier = isPiRuntimeConfigured(config.cursorCompletionPi)
    ? config.cursorCompletionPi!
    : config.backgroundPi;
  if (!isPiRuntimeConfigured(tier)) return null;
  const { mcp: _mcp, ...pi } = tier!;
  return new PiAgentRuntime({
    ...pi,
    includeBashTool: false,
    builtinTools: [],
    maxToolCallsPerRun: 1,
    runtimeRole: "internal",
    reasoning: "off",
    sessionsDir: join(pi.sessionsDir, "conversation-suggestion"),
    workingDirectory: join(pi.workingDirectory, "conversation-suggestion"),
    agentDirectory: join(pi.agentDirectory, "conversation-suggestion"),
  });
}

export function createAgentResolver(config: GatewayConfig, agentDebugStore?: AgentDebugTraceStore): AgentResolver {
  const resolver = new AgentResolver(agentDebugStore);
  // 工厂闭包读「活」config（applyRuntimeConfig 原地 patch 的同一对象），
  // 而不是捕获启动时快照——AgentResolver.reload 重跑工厂时才能拿到
  // runtime config 热应用后的 webSearch。
  if (config.webSearch) {
    const bundle = builtin(BUILTIN_AGENT_IDS.webSearch);
    const directories = agentDirectories(config, BUILTIN_AGENT_IDS.webSearch);
    resolver.register(definition(config, {
      id: BUILTIN_AGENT_IDS.webSearch,
      name: bundle.name,
      description: bundle.description,
    }), () => {
      const webSearch = config.webSearch;
      if (!webSearch) return new UnconfiguredAgentRuntime(BUILTIN_AGENT_IDS.webSearch);
      return new OpenAiCompletionAgentRuntime({
        runtimeId: BUILTIN_AGENT_IDS.webSearch,
        ...webSearch,
        systemPrompt: bundle.systemPrompt,
        requestOptions: { enable_search: true },
        includeProviderErrorBody: false,
        ...directories,
      });
    });
  }
  return resolver;
}

/**
 * 动态注册 webSearch agent（boot 时 env 未配、runtime config 保存后才生效）。
 * 与 createAgentResolver 的注册体一致；已注册时跳过。
 */
export function registerWebSearchAgentIfMissing(resolver: AgentResolver, config: GatewayConfig): boolean {
  if (!config.webSearch || resolver.has(BUILTIN_AGENT_IDS.webSearch)) return false;
  const bundle = builtin(BUILTIN_AGENT_IDS.webSearch);
  const directories = agentDirectories(config, BUILTIN_AGENT_IDS.webSearch);
  resolver.register(definition(config, {
    id: BUILTIN_AGENT_IDS.webSearch,
    name: bundle.name,
    description: bundle.description,
  }), () => {
    const webSearch = config.webSearch;
    if (!webSearch) return new UnconfiguredAgentRuntime(BUILTIN_AGENT_IDS.webSearch);
    return new OpenAiCompletionAgentRuntime({
      runtimeId: BUILTIN_AGENT_IDS.webSearch,
      ...webSearch,
      systemPrompt: bundle.systemPrompt,
      requestOptions: { enable_search: true },
      includeProviderErrorBody: false,
      ...directories,
    });
  });
  return true;
}

export function registerPrimaryAgent(
  resolver: AgentResolver,
  config: GatewayConfig,
  mcpHost: DocumentMcpHost,
  integrations: AgentRuntimeIntegrationOptions,
): void {
  const bundle = builtin(BUILTIN_AGENT_IDS.primary);
  resolver.register(definition(config, {
    id: BUILTIN_AGENT_IDS.primary,
    name: bundle.name,
    description: bundle.description,
  }), () => createAgentRuntime(
    config,
    mcpHost,
    { ...integrations, agentResolver: resolver },
  ));
}

/**
 * 会话档位的两个衍生 runtime：
 * - main-direct（primary 档）：与 main 同装配，仅无 lite 委派工具；
 * - main-lite（lite 档）：litePi 配置齐全才注册（未配置＝lite 档隐藏）。
 * 人设复用 primary bundle（同人格，不同引擎）。
 */
export function registerModelTierAgents(
  resolver: AgentResolver,
  config: GatewayConfig,
  mcpHost: DocumentMcpHost,
  integrations: AgentRuntimeIntegrationOptions,
): void {
  const bundle = builtin(BUILTIN_AGENT_IDS.primary);
  resolver.register(definition(config, {
    id: BUILTIN_AGENT_IDS.primaryDirect,
    name: `${bundle.name}（直连）`,
    description: `${bundle.description} 强模型直连档：不委派轻量模型。`,
  }), () => createUserFacingRuntime(
    config,
    mcpHost,
    { ...integrations, agentResolver: resolver },
    BUILTIN_AGENT_IDS.primaryDirect,
    config.pi,
    false,
  ) ?? new UnconfiguredAgentRuntime(BUILTIN_AGENT_IDS.primaryDirect));
  registerLiteAgentIfMissing(resolver, config, mcpHost, integrations);
}

/** 动态注册 main-lite（boot 时未配置 litePi、runtime config 保存后生效）。 */
export function registerLiteAgentIfMissing(
  resolver: AgentResolver,
  config: GatewayConfig,
  mcpHost: DocumentMcpHost,
  integrations: AgentRuntimeIntegrationOptions,
): boolean {
  if (!isPiRuntimeConfigured(config.litePi) || resolver.has(BUILTIN_AGENT_IDS.lite)) return false;
  const bundle = builtin(BUILTIN_AGENT_IDS.primary);
  resolver.register(definition(config, {
    id: BUILTIN_AGENT_IDS.lite,
    name: `${bundle.name}（轻量）`,
    description: `${bundle.description} 轻量模型档：简单对话直答。`,
  }), () => createUserFacingRuntime(
    config,
    mcpHost,
    { ...integrations, agentResolver: resolver },
    BUILTIN_AGENT_IDS.lite,
    config.litePi,
    false,
  ) ?? new UnconfiguredAgentRuntime(BUILTIN_AGENT_IDS.lite));
  return true;
}

export function registerCursorCompletionAgent(resolver: AgentResolver, config: GatewayConfig): void {
  const bundle = builtin(BUILTIN_AGENT_IDS.cursorCompletion);
  resolver.register(definition(config, {
    id: BUILTIN_AGENT_IDS.cursorCompletion,
    name: bundle.name,
    description: bundle.description,
  }), () => createCursorCompletionRuntime(config));
}
