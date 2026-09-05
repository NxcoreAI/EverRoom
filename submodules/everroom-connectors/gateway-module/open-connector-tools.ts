import { spawn } from 'node:child_process';
import type {
  PiAgentRuntimeTool,
  PiAgentRuntimeToolFailurePolicy,
} from '@nxcore/agent-runtime-pi';
import type { StartRuntimeRunInput } from '@nxcore/agent-runtime';
import type { OpenConnectorCliConfig } from "./host-types.js";
import { OpenConnectorHttpClient } from "./open-connector-http-client.js";
import {
  ExternalCallBudgetExceededError,
  type ExternalCallBudgetService,
} from "./ports.js";

const OUTPUT_LIMIT = 4 * 1024 * 1024;
const MODEL_CONTEXT_OUTPUT_LIMIT = 64 * 1024;
const PLACEHOLDER_PATTERN = /(?:\byour_username\b|\busername_here\b|\breplace_me\b|<\s*(?:username|paste\b|insert\b|粘贴|填写|替换)[^>]*>|\{\{\s*[^}]+\s*\}\})/i;
const NOTION_ID_PATTERN = /(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;

function redactText(value: string, secret?: string): string {
  return secret ? value.split(secret).join('<redacted>') : value;
}

function redactValue(value: unknown, secret?: string): unknown {
  if (!secret) return value;
  if (typeof value === 'string') return redactText(value, secret);
  if (Array.isArray(value)) return value.map(item => redactValue(item, secret));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      redactValue(item, secret),
    ]));
  }
  return value;
}

function unresolvedPlaceholderPath(value: unknown, path = 'input'): string | null {
  if (typeof value === 'string') return PLACEHOLDER_PATTERN.test(value) ? path : null;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const match = unresolvedPlaceholderPath(value[index], `${path}[${String(index)}]`);
      if (match) return match;
    }
    return null;
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      const match = unresolvedPlaceholderPath(item, `${path}.${key}`);
      if (match) return match;
    }
  }
  return null;
}

function requestedNotionAction(prompt: string): string | null {
  const creates = /(?:创建|新建|create|add)/i.test(prompt);
  const mentionsPage = /(?:页面|page)/i.test(prompt);
  const mentionsDatabase = /(?:数据库|数据源|database|data[ _-]?source)/i.test(prompt);
  if (creates && mentionsPage && !mentionsDatabase) return 'create_page';
  return null;
}

function notionIds(value: unknown): Set<string> {
  const ids = new Set<string>();
  const visit = (item: unknown): void => {
    if (typeof item === 'string') {
      for (const match of item.matchAll(NOTION_ID_PATTERN)) {
        ids.add(match[0].replaceAll('-', '').toLowerCase());
      }
      return;
    }
    if (Array.isArray(item)) {
      item.forEach(visit);
      return;
    }
    if (item && typeof item === 'object') Object.values(item).forEach(visit);
  };
  visit(value);
  return ids;
}

function notionParentIds(value: unknown): Set<string> {
  const input = objectValue(value);
  const parent = objectValue(input.parent);
  return notionIds([
    input.parentId,
    parent.page_id,
    parent.database_id,
    parent.data_source_id,
  ]);
}

function connectorSearchQuery(
  prompt: string,
  requestedQuery: string,
  requestedService: string | null,
): string {
  const query = requestedQuery.trim();
  const lowerPrompt = prompt.toLowerCase();
  const service = requestedService?.trim().toLowerCase() || null;
  const notionAction = service === 'notion' ? requestedNotionAction(prompt) : null;
  if (notionAction === 'create_page') return 'create page notion';
  const isGmail = service === 'gmail' || (service === null && /gmail|邮件|邮箱/.test(lowerPrompt));
  if (isGmail && /(?:最近|最新|查看|列出|读取|收件箱)/.test(prompt)
    && !/(?:草稿|draft)/i.test(prompt)) {
    return 'list recent Gmail messages';
  }
  if (isGmail && /(?:搜索|查找|标题|主题|subject)/i.test(prompt)) {
    return 'search Gmail messages';
  }
  if ((service === 'github' || (service === null && /github/i.test(lowerPrompt)))
    && /(?:仓库|repository|repo)/i.test(lowerPrompt)) {
    return 'search GitHub repositories';
  }
  if (service && !query.toLowerCase().includes(service)) {
    return `${query.replaceAll('_', ' ')} ${service.replaceAll('_', ' ')}`;
  }
  return query;
}

function connectorSearchResults(
  value: unknown,
  service: string | null,
  exactAction: string | null = null,
): unknown {
  if (!service || !Array.isArray(value)) return value;
  const normalizedService = service.toLowerCase();
  return value.filter((item) => {
    const result = objectValue(item);
    return textValue(result.service)?.toLowerCase() === normalizedService
      && (!exactAction || textValue(result.name) === exactAction);
  });
}

function normalizedGmailReadInput(
  prompt: string,
  service: string,
  name: string,
  value: unknown,
): unknown {
  if (service !== 'gmail' || (name !== 'fetch_emails' && name !== 'search_threads')) return value;
  const original = objectValue(value);
  const normalized: Record<string, unknown> = { ...original };
  let query = textValue(original.query) ?? '';

  if (!/(?:收件箱|inbox)/i.test(prompt)) query = query.replace(/(?:^|\s)in:inbox(?=\s|$)/gi, ' ');
  if (!/(?:未读邮件|只看未读|仅看未读|筛选未读)/i.test(prompt)) {
    query = query.replace(/(?:^|\s)is:unread(?=\s|$)/gi, ' ');
  }

  const days = /(?:最近|过去)\s*(\d{1,3})\s*天/u.exec(prompt)?.[1];
  if (days && !/(?:^|\s)(?:newer_than:|after:)/i.test(query)) query += ` newer_than:${days}d`;

  const subject = /(?:标题|主题)(?:中)?(?:包含|含有)\s*[“"']([^”"']+)[”"']/u.exec(prompt)?.[1]?.trim();
  if (subject && !/(?:^|\s)subject:/i.test(query)) query += ` subject:"${subject}"`;

  query = query.trim().replace(/\s+/g, ' ');
  if (query) normalized.query = query;
  else delete normalized.query;

  const maxResults = /最多(?:返回)?\s*(\d{1,3})\s*封/u.exec(prompt)?.[1]
    ?? /最近\s*(\d{1,3})\s*封/u.exec(prompt)?.[1];
  if (maxResults) normalized.maxResults = Number(maxResults);
  return normalized;
}

export function connectorEnvironment(config: OpenConnectorCliConfig): NodeJS.ProcessEnv {
  return {
    ...process.env,
    OO_CONNECTOR_URL: config.baseUrl,
    ...(config.runtimeToken ? { OO_CONNECTOR_TOKEN: config.runtimeToken } : {}),
    OO_CONFIG_DIR: config.configDirectory,
    OO_DATA_DIR: config.dataDirectory,
    NO_COLOR: '1',
  };
}

/**
 * Seam 3 传输缝：oo CLI 子进程 → OpenConnectorHttpClient。
 * 契约：输入语义化调用（不再是 CLI args 数组），返回封套 data。
 */
export type OoHttpRunner = (
  config: OpenConnectorCliConfig,
  call:
    | { kind: 'apps'; service?: string }
    | { kind: 'search'; query: string }
    | { kind: 'schema'; service: string; action: string }
    | { kind: 'run'; service: string; action: string; input: Record<string, unknown>; connectionName?: string | undefined },
  signal?: AbortSignal,
) => Promise<unknown>;

export const runOoHttp: OoHttpRunner = (config, call, signal) => {
  const client = new OpenConnectorHttpClient(config);
  switch (call.kind) {
    case 'apps':
      return call.service ? client.listAppsByService(call.service, { signal }) : client.listApps({ signal });
    case 'search':
      return client.searchActions(call.query, { signal });
    case 'schema':
      return client.getAction(call.service, call.action, { signal });
    case 'run':
      return client.runAction(call.service, call.action, call.input, { ...(call.connectionName ? { connectionName: call.connectionName } : {}), signal });
  }
};

/** @deprecated 仅测试注入兼容；生产链路已走 runOoHttp。 */
export function runOo(
  config: OpenConnectorCliConfig,
  arguments_: string[],
  signal?: AbortSignal,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(config.executable, arguments_, {
      env: connectorEnvironment(config),
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else {
        try {
          resolve(redactValue(stdout.trim() ? JSON.parse(stdout) : null, config.runtimeToken));
        } catch {
          reject(new Error('oo CLI returned invalid JSON'));
        }
      }
    };
    const abort = (): void => {
      child.kill('SIGTERM');
      finish(new Error('OpenConnector tool call was cancelled'));
    };
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      finish(new Error('OpenConnector tool call timed out'));
    }, 120_000);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) {
      abort();
      return;
    }
    child.stdout.on('data', (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > OUTPUT_LIMIT) abort();
      else stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > OUTPUT_LIMIT) abort();
      else stderr += chunk;
    });
    child.once('error', finish);
    child.once('close', (code) => finish(code === 0
      ? undefined
      : new Error(
          redactText(stderr.trim(), config.runtimeToken)
            || `oo CLI exited with code ${String(code)}`,
        )));
  });
}

function textResult(data: unknown): { content: string; details: unknown } {
  const serialized = JSON.stringify(data);
  if (Buffer.byteLength(serialized) <= MODEL_CONTEXT_OUTPUT_LIMIT) {
    return { content: serialized, details: data };
  }
  let preview = serialized.slice(0, Math.floor(MODEL_CONTEXT_OUTPUT_LIMIT / 2));
  let limited = {
    truncated: true,
    originalBytes: Buffer.byteLength(serialized),
    preview,
    instruction: 'The connector result exceeded the model context limit. Narrow the query or request fewer records before continuing.',
  };
  let content = JSON.stringify(limited);
  while (Buffer.byteLength(content) > MODEL_CONTEXT_OUTPUT_LIMIT && preview.length > 1024) {
    preview = preview.slice(0, Math.floor(preview.length * 0.75));
    limited = { ...limited, preview };
    content = JSON.stringify(limited);
  }
  return { content, details: limited };
}

export type OoRunner = OoHttpRunner;

interface ConnectorApp {
  connectionName: string;
  isDefault: boolean;
  status: string | null;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function textValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function compactActionSchema(value: unknown, service: string, name: string): unknown {
  const schema = objectValue(value);
  const rawInputSchema = objectValue(schema.inputSchema);
  let inputSchema: unknown = schema.inputSchema ?? {};

  if (service === 'notion' && name === 'create_page') {
    const properties = objectValue(rawInputSchema.properties);
    inputSchema = {
      ...rawInputSchema,
      properties: {
        ...properties,
        title: {
          ...objectValue(properties.title),
          type: 'string',
          description: 'Simple page title. It may be used with parent or parentId; EverRoom converts it to the official Notion title property.',
        },
      },
    };
  }

  return {
    service: textValue(schema.service) ?? service,
    name: textValue(schema.name) ?? name,
    ...(textValue(schema.description) ? { description: textValue(schema.description) } : {}),
    inputSchema,
  };
}

function normalizedNotionInput(service: string, name: string, value: unknown): unknown {
  if (service !== 'notion' || name !== 'create_page') return value;
  const original = objectValue(value);
  const parent = objectValue(original.parent);
  if (parent.workspace !== true && !textValue(parent.page_id)) return value;

  const normalized: Record<string, unknown> = { ...original };
  const properties: Record<string, unknown> = { ...objectValue(original.properties) };
  const simpleTitle = textValue(original.title) ?? textValue(properties.title);
  if (!simpleTitle) return value;

  delete normalized.title;
  properties.title = {
    title: [{
      type: 'text',
      text: { content: simpleTitle },
    }],
  };
  normalized.properties = properties;
  return normalized;
}

type ConnectorOperation = 'search' | 'schema' | 'apps' | 'run';

function connectorFailurePolicy(
  operation: ConnectorOperation,
  error: unknown,
  params: Record<string, unknown>,
): PiAgentRuntimeToolFailurePolicy {
  const message = error instanceof Error ? error.message : String(error);
  const service = textValue(params.service) ?? 'unknown';
  const name = textValue(params.name) ?? 'unknown';
  const target = `${service}.${name}`;

  if (/oauth|unauthori[sz]ed|forbidden|missing scope|insufficient scope|token.*expired|HTTP 401|HTTP 403|no active connection/i.test(message)) {
    return {
      category: 'authentication_required',
      recoverable: false,
      instruction: 'Stop automatic retries and ask the user to connect or re-authorize this service in the Connector Web Console.',
      retryKey: service,
    };
  }
  if (operation === 'run' && /connection_not_found|connection.*not available|connection_ambiguous|multiple active connections/i.test(message)) {
    return {
      category: 'connection_invalid',
      recoverable: true,
      recommendedTool: 'connector_apps',
      instruction: `List the real connections for service "${service}", select an exact active connectionName, then retry the original action once.`,
      retryKey: service,
      maxAttempts: 1,
    };
  }
  if ((operation === 'schema' || operation === 'run')
    && /HTTP 404|action.*(?:not found|could not be verified)|action metadata/i.test(message)) {
    return {
      category: 'action_not_found',
      recoverable: true,
      recommendedTool: 'connector_search',
      instruction: `Search again from the user's original goal, copy an exact service and name from the results, inspect its schema, and retry. Do not reconstruct "${target}".`,
      retryKey: target,
      maxAttempts: 1,
    };
  }
  if (operation === 'run' && /action mismatch/i.test(message)) {
    return {
      category: 'action_mismatch',
      recoverable: true,
      recommendedTool: 'connector_search',
      instruction: `Search from the user's original action and object, then use the exact matching service and name. Do not execute "${target}" for a different resource type.`,
      retryKey: service,
      maxAttempts: 1,
    };
  }
  if (operation === 'run'
    && /invalid_input|Validation Failed|input payload is invalid|additional properties|must NOT have|HTTP 400/i.test(message)) {
    return {
      category: 'invalid_input',
      recoverable: true,
      recommendedTool: 'connector_schema',
      instruction: `Inspect the exact schema for "${target}", remove undeclared fields, restore all user constraints, and retry with schema-valid input.`,
      retryKey: target,
      maxAttempts: 1,
    };
  }
  if (/timed? out|ECONN|ENOTFOUND|network|socket|fetch failed|UND_ERR|HTTP 429|rate.?limit/i.test(message)) {
    const safeToRetry = operation !== 'run';
    return {
      category: /429|rate.?limit/i.test(message) ? 'rate_limited' : 'transient_network',
      recoverable: safeToRetry,
      ...(safeToRetry ? { recommendedTool: `connector_${operation}` } : {}),
      instruction: safeToRetry
        ? `Retry connector_${operation} once with the same validated request. If it fails again, stop and report the network blocker.`
        : 'Do not automatically retry an action execution because its external side effect may be indeterminate. Report the network blocker.',
      retryKey: operation === 'run' ? target : service,
      maxAttempts: safeToRetry ? 1 : 0,
    };
  }
  if (/placeholder|missing|required|must provide/i.test(message)) {
    return {
      category: 'missing_input',
      recoverable: false,
      instruction: 'Stop and ask the user for the missing concrete input. Never invent a placeholder value.',
      retryKey: target,
    };
  }
  return {
    category: 'connector_failure',
    recoverable: false,
    instruction: 'Stop automatic retries and report the exact connector error without claiming success.',
    retryKey: target,
  };
}

function connectorApps(value: unknown): ConnectorApp[] {
  const root = objectValue(value);
  const items = Array.isArray(value)
    ? value
    : Array.isArray(root.connections) ? root.connections
      : Array.isArray(root.apps) ? root.apps
        : [];

  return items.flatMap((item) => {
    const app = objectValue(item);
    const connectionName = textValue(app.connectionName) ?? textValue(app.name);
    if (!connectionName) return [];
    return [{
      connectionName,
      isDefault: app.isDefault === true,
      status: textValue(app.status),
    }];
  });
}

function usableConnectorApps(apps: ConnectorApp[]): ConnectorApp[] {
  const unusableStatuses = new Set(['disconnected', 'error', 'expired', 'inactive', 'revoked', 'unauthorized']);
  return apps.filter((app) => !app.status || !unusableStatuses.has(app.status.toLowerCase()));
}

function chooseConnectionName(
  service: string,
  requestedName: string | null,
  appsResult: unknown,
): string {
  const apps = usableConnectorApps(connectorApps(appsResult));
  if (apps.length === 0) {
    throw new Error(`Connector service "${service}" has no active connection. Ask the user to connect it in the Connector Web Console before retrying.`);
  }
  if (requestedName) {
    if (!apps.some((app) => app.connectionName === requestedName)) {
      const available = apps.map((app) => app.connectionName).join(', ');
      throw new Error(`Connector connection "${requestedName}" is not available for service "${service}". Use one of the exact connectionName values returned by connector_apps: ${available}.`);
    }
    return requestedName;
  }
  const defaultApp = apps.find((app) => app.isDefault);
  if (defaultApp) return defaultApp.connectionName;
  if (apps.length === 1) return apps[0]!.connectionName;
  throw new Error(`Connector service "${service}" has multiple active connections. Call connector_apps and retry with one exact connectionName.`);
}

export function createOpenConnectorPiTools(
  config: OpenConnectorCliConfig,
  runner: OoRunner = runOoHttp,
  budget?: ExternalCallBudgetService,
): PiAgentRuntimeTool[] {
  const observedNotionIds = new Map<string, Set<string>>();
  const schemaCache = new Map<string, Map<string, unknown>>();
  const exposedSchemas = new Map<string, Set<string>>();
  const external = <T>(input: StartRuntimeRunInput, tool: string, invoke: () => Promise<T>): Promise<T> => budget
    ? budget.execute('CONNECTOR', tool, {
        source: 'agent',
        runId: input.runId,
        correlationId: input.sessionId,
      }, async (markDispatched) => {
        markDispatched();
        return invoke();
      })
    : invoke();
  const classify = (
    operation: ConnectorOperation,
    error: unknown,
    params: Record<string, unknown>,
  ): PiAgentRuntimeToolFailurePolicy | null => error instanceof ExternalCallBudgetExceededError ? {
    category: 'external_call_budget_exceeded',
    recoverable: true,
    instruction: `Skip connector_${operation} and continue with another available path.`,
  } : connectorFailurePolicy(operation, error, params);
  const runCacheKey = (input: { runId?: string; sessionId?: string }): string => (
    textValue(input.runId) ?? textValue(input.sessionId) ?? 'unknown-run'
  );
  const cachedSchema = async (
    input: { runId?: string; sessionId?: string },
    service: string,
    name: string,
    signal?: AbortSignal,
  ): Promise<unknown> => {
    const runKey = runCacheKey(input);
    const actionKey = `${service}.${name}`;
    const runSchemas = schemaCache.get(runKey) ?? new Map<string, unknown>();
    if (runSchemas.has(actionKey)) return runSchemas.get(actionKey);
    const [schemaService, schemaName] = actionKey.split('.');
    const schema = compactActionSchema(
      await runner(config, { kind: 'schema', service: schemaService ?? service, action: schemaName ?? name }, signal),
      service,
      name,
    );
    runSchemas.set(actionKey, schema);
    schemaCache.set(runKey, runSchemas);
    if (schemaCache.size > 128) {
      const oldestRunKey = schemaCache.keys().next().value as string | undefined;
      if (oldestRunKey) {
        schemaCache.delete(oldestRunKey);
        exposedSchemas.delete(oldestRunKey);
      }
    }
    return schema;
  };
  const rememberNotionIds = (runId: string, value: unknown): void => {
    const observed = observedNotionIds.get(runId) ?? new Set<string>();
    notionIds(value).forEach(id => observed.add(id));
    observedNotionIds.set(runId, observed);
    if (observedNotionIds.size > 128) {
      const oldestRunId = observedNotionIds.keys().next().value as string | undefined;
      if (oldestRunId) observedNotionIds.delete(oldestRunId);
    }
  };
  return [
    {
      name: 'connector_search',
      label: 'Search connected app actions',
      description: 'Search OpenConnector actions. Results contain exact service and name fields for schema and run calls.',
      parameters: {
        type: 'object',
        properties: {
          service: { type: 'string', pattern: '^[A-Za-z0-9_-]+$' },
          query: { type: 'string', minLength: 1, maxLength: 200 },
        },
        required: ['query'],
        additionalProperties: false,
      },
      promptGuidelines: [
        'When the user requests data or an action from a connected service, call the connector tools immediately in the current response. Do not stop after saying what you will do.',
        'Search first when the exact provider action is unknown. Pass the exact service when the user names one, and use a concise English action + object query such as "create page", not only a provider name.',
        'Copy the returned service and name fields exactly; do not rewrite casing, hyphens, or prefixes.',
        'Choose the action whose description most precisely matches the request. For the authenticated current account, prefer list_my_* or get_current_* over generic search, user, or organization actions.',
      ],
      execute: async (input, params, signal) => {
        const service = textValue(params.service);
        const originalPrompt = input.originalPrompt ?? input.prompt;
        const exactAction = service === 'notion'
          ? requestedNotionAction(originalPrompt)
          : null;
        const result = await external(input, 'connector_search', () => runner(
          config,
          { kind: 'search', query: connectorSearchQuery(originalPrompt, String(params.query), service ?? '') },
          signal,
        ));
        return textResult(connectorSearchResults(result, service, exactAction));
      },
      classifyFailure: (error: unknown, _input: StartRuntimeRunInput, params: Record<string, unknown>) => classify('search', error, params),
    },
    {
      name: 'connector_schema',
      label: 'Inspect a connected app action',
      description: 'Read one OpenConnector action schema using exact service and name values returned by connector_search.',
      parameters: {
        type: 'object',
        properties: {
          service: { type: 'string', pattern: '^[A-Za-z0-9_-]+$' },
          name: { type: 'string', pattern: '^[A-Za-z0-9_-]+$' },
        },
        required: ['service', 'name'],
        additionalProperties: false,
      },
      promptGuidelines: [
        'Continue the connector workflow in the current response: inspect the schema now, then proceed to connection lookup and execution when the request is ready.',
        'Inspect the action schema before execution.',
        'Copy service and name exactly from connector_search; never shorten or reconstruct the action name.',
        'Every required input must come from the user or a previous tool result. Examples and placeholders are not real input values.',
      ],
      execute: async (input, params, signal) => {
        const service = String(params.service);
        const name = String(params.name);
        const runKey = runCacheKey(input);
        const actionKey = `${service}.${name}`;
        const exposed = exposedSchemas.get(runKey) ?? new Set<string>();
        if (exposed.has(actionKey)) {
          return textResult({
            status: 'already_inspected',
            service,
            name,
            instruction: 'Reuse the inputSchema from the earlier connector_schema result in this run. Calling schema again cannot provide new evidence.',
          });
        }
        const schema = await external(input, 'connector_schema', () => cachedSchema(input, service, name, signal));
        exposed.add(actionKey);
        exposedSchemas.set(runKey, exposed);
        return textResult(schema);
      },
      classifyFailure: (error: unknown, _input: StartRuntimeRunInput, params: Record<string, unknown>) => classify('schema', error, params),
    },
    {
      name: 'connector_apps',
      label: 'List connected app accounts',
      description: 'List configured OpenConnector account connections for one exact service. An empty list means the user must connect that service before actions can run.',
      parameters: {
        type: 'object',
        properties: {
          service: { type: 'string', pattern: '^[A-Za-z0-9_-]+$' },
        },
        required: ['service'],
        additionalProperties: false,
      },
      promptGuidelines: [
        'Continue the connector workflow in the current response after listing connections; do not stop at a progress announcement.',
        'Call this before connector_run and use only a connectionName returned by this tool.',
        'If the result is empty, do not call connector_run; tell the user to connect the service in the Connector Web Console.',
      ],
      execute: async (input, params, signal) => textResult(await external(input, 'connector_apps', () => {
        const service = textValue(params.service);
        return runner(config, { kind: 'apps', ...(service ? { service } : {}) }, signal);
      })),
      classifyFailure: (error: unknown, _input: StartRuntimeRunInput, params: Record<string, unknown>) => classify('apps', error, params),
    },
    {
      name: 'connector_run',
      label: 'Run a connected app action',
      description: 'Execute one OpenConnector action. The tool verifies the exact action schema and active account connection before execution.',
      parameters: {
        type: 'object',
        properties: {
          service: { type: 'string', pattern: '^[A-Za-z0-9_-]+$' },
          name: { type: 'string', pattern: '^[A-Za-z0-9_-]+$' },
          input: { type: 'object', additionalProperties: true },
          connectionName: { type: 'string', minLength: 1, maxLength: 128 },
        },
        required: ['service', 'name', 'input'],
        additionalProperties: false,
      },
      promptGuidelines: [
        'When the schema, connection, inputs, and user authorization are ready, execute in the current response instead of describing a future action.',
        'Use only after inspecting the schema and when the user request authorizes the external side effect.',
        'Call connector_apps first. Never guess a connection name or use the service name as a connection name.',
        'If connector_apps returns no connections, stop and ask the user to connect the service in the Connector Web Console.',
        'Copy service and name exactly from connector_search; never rewrite casing, hyphens, or prefixes.',
        'If preflight says the action cannot be verified, call connector_search and connector_schema, then retry in the same turn with their exact service and name. Do not claim the provider feature is unavailable from a guessed action name.',
        'For Notion, create a normal page with create_page, never create_data_source. If the user does not specify a parent, use the workspace-level private parent supported by the create_page schema; never invent a page, database, or data source ID.',
        'For Gmail reads, "do not mark as read" is a no-side-effect constraint, not an unread-only filter. Never add is:unread unless the user explicitly asks to filter unread mail, and preserve requested time ranges in the Gmail query.',
        'Never submit example placeholders such as your_username. If a required value is unknown, ask the user or obtain it from a read-only connector action.',
      ],
      executionMode: 'sequential',
      execute: async (input, params, signal) => {
        const service = String(params.service);
        const name = String(params.name);
        const originalPrompt = input.originalPrompt ?? input.prompt ?? '';
        const expectedNotionAction = service === 'notion'
          ? requestedNotionAction(originalPrompt)
          : null;
        if (expectedNotionAction && name !== expectedNotionAction) {
          throw new Error(`Connector action mismatch: the user's original request requires notion.${expectedNotionAction}, not notion.${name}.`);
        }
        const connectorInput = normalizedNotionInput(service, name, normalizedGmailReadInput(
          originalPrompt,
          service,
          name,
          params.input,
        ));
        const placeholderPath = unresolvedPlaceholderPath(connectorInput);
        if (placeholderPath) {
          throw new Error(`Connector input contains an unresolved example placeholder at ${placeholderPath}. Use a real value from the user or a previous tool result.`);
        }
        if (service === 'notion') {
          const suppliedParentIds = notionParentIds(connectorInput);
          const allowedIds = notionIds(originalPrompt);
          observedNotionIds.get(input.runId)?.forEach(id => allowedIds.add(id));
          const inventedId = [...suppliedParentIds].find(id => !allowedIds.has(id));
          if (inventedId) {
            throw new Error('Connector input contains a Notion parent ID that was not provided by the user or returned by an earlier connector call. Never invent page, database, or data source IDs.');
          }
        }
        const data = JSON.stringify(connectorInput);
        if (Buffer.byteLength(data) > 256 * 1024) throw new Error('Connector input exceeds 256 KiB');
        const result = await external(input, 'connector_run', async () => {
          try {
            await cachedSchema(input, service, name, signal);
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            throw new Error(`Connector action "${service}.${name}" could not be verified and was not executed: ${reason}. Call connector_search, copy its exact service and name, inspect connector_schema, and retry in this turn.`);
          }
          const apps = await runner(config, { kind: 'apps', service }, signal);
          const connectionName = chooseConnectionName(
            service,
            textValue(params.connectionName),
            apps,
          );
          void data;
          return runner(config, { kind: 'run', service, action: name, input: JSON.parse(data) as Record<string, unknown>, connectionName }, signal);
        });
        if (service === 'notion') rememberNotionIds(input.runId, result);
        return textResult(result);
      },
      classifyFailure: (error: unknown, _input: StartRuntimeRunInput, params: Record<string, unknown>) => classify('run', error, params),
    },
  ];
}
