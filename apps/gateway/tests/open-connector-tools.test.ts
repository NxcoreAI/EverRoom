import { describe, expect, it } from 'vitest';
import { createOpenConnectorPiTools } from '../src/modules/agent/open-connector-tools.js';

type Runner = Parameters<typeof createOpenConnectorPiTools>[1];

function tools() {
  return createOpenConnectorPiTools({
    executable: 'oo',
    baseUrl: 'http://127.0.0.1:3000',
    runtimeToken: 'secret',
    configDirectory: '/tmp/everroom-oo-config',
    dataDirectory: '/tmp/everroom-oo-data',
  });
}

function toolsWithRunner(runner: Runner) {
  return createOpenConnectorPiTools({
    executable: 'oo',
    baseUrl: 'http://127.0.0.1:3000',
    runtimeToken: 'secret',
    configDirectory: '/tmp/everroom-oo-config',
    dataDirectory: '/tmp/everroom-oo-data',
  }, runner);
}

describe('OpenConnector Pi tools', () => {
  it('exposes discovery, schema, connection lookup, and execution as separate tools', () => {
    const connectorTools = tools();

    expect(connectorTools.map((tool) => tool.name)).toEqual([
      'connector_search',
      'connector_schema',
      'connector_apps',
      'connector_run',
    ]);
    expect(connectorTools[0]?.promptGuidelines?.join(' ')).toContain('prefer list_my_*');
    expect(connectorTools[0]?.promptGuidelines?.join(' ')).toContain('service and name fields exactly');
    expect(connectorTools[0]?.promptGuidelines?.join(' ')).toContain('immediately in the current response');
    expect(connectorTools[0]?.parameters).toMatchObject({
      properties: {
        service: { pattern: '^[A-Za-z0-9_-]+$' },
        query: { type: 'string' },
      },
      required: ['query'],
      additionalProperties: false,
    });
    expect(connectorTools[1]?.parameters).toMatchObject({
      properties: {
        service: { pattern: '^[A-Za-z0-9_-]+$' },
        name: { pattern: '^[A-Za-z0-9_-]+$' },
      },
      required: ['service', 'name'],
      additionalProperties: false,
    });
    expect(connectorTools[2]?.parameters).toMatchObject({
      required: ['service'],
      additionalProperties: false,
    });
    expect(connectorTools[2]?.promptGuidelines?.join(' ')).toContain('do not call connector_run');
    expect(connectorTools[3]?.parameters).toMatchObject({
      required: ['service', 'name', 'input'],
    });
    expect(connectorTools[3]?.promptGuidelines?.join(' ')).toContain('user request authorizes');
    expect(connectorTools[3]?.promptGuidelines?.join(' ')).toContain('Never guess a connection name');
    expect(connectorTools[3]?.promptGuidelines?.join(' ')).toContain('service and name exactly');
    expect(connectorTools[3]?.promptGuidelines?.join(' ')).toContain('retry in the same turn');
    expect(connectorTools[3]?.promptGuidelines?.join(' ')).toContain('never create_data_source');
    expect(connectorTools[3]?.promptGuidelines?.join(' ')).toContain('workspace-level private parent');
    expect(connectorTools[3]?.executionMode).toBe('sequential');
  });

  it('rejects unresolved example placeholders before spawning oo', async () => {
    const run = tools().find((tool) => tool.name === 'connector_run');
    expect(run).toBeDefined();

    await expect(run!.execute({} as never, {
      service: 'github',
      name: 'search_repositories',
      connectionName: 'default',
      input: { query: 'user:your_username' },
    })).rejects.toThrow('unresolved example placeholder at input.query');
  });

  it('rejects an unfilled Chinese link placeholder before spawning oo', async () => {
    const run = tools().find((tool) => tool.name === 'connector_run');
    expect(run).toBeDefined();

    await expect(run!.execute({} as never, {
      service: 'notion',
      name: 'create_page',
      connectionName: 'default',
      input: { parentPage: '<粘贴已授权的 Notion 页面链接>' },
    })).rejects.toThrow('unresolved example placeholder at input.parentPage');
  });

  it('normalizes a broad Chinese Gmail search into a precise catalog query', async () => {
    const calls: string[][] = [];
    const runner: Runner = async (_config, args) => {
      calls.push(args);
      return [{ service: 'gmail', name: 'fetch_emails' }];
    };
    const search = toolsWithRunner(runner).find((tool) => tool.name === 'connector_search');

    await search!.execute({
      originalPrompt: '查看 Gmail 中最近 5 封邮件',
      prompt: '包含 Notion 和 GitHub 示例的系统路由说明',
    } as never, { service: 'gmail', query: 'messages' });
    expect(calls).toEqual([['connector', 'search', '--json', '--', 'list recent Gmail messages']]);
  });

  it('uses the structured service and filters cross-provider search results', async () => {
    const calls: string[][] = [];
    const runner: Runner = async (_config, args) => {
      calls.push(args);
      return [
        { service: 'wordpress', name: 'create_page' },
        { service: 'notion', name: 'create_page' },
        { service: 'notion', name: 'create_data_source' },
      ];
    };
    const search = toolsWithRunner(runner).find((tool) => tool.name === 'connector_search');

    const result = await search!.execute({
      originalPrompt: '使用 Notion 创建一个测试页面',
      prompt: '外部服务路由规则包含 Gmail、GitHub 和 Notion 示例',
    } as never, { service: 'notion', query: 'create_page' });

    expect(calls).toEqual([['connector', 'search', '--json', '--', 'create page notion']]);
    expect(result.details).toEqual([{ service: 'notion', name: 'create_page' }]);
  });

  it('derives a precise Notion page action when the model searches only for the provider', async () => {
    const calls: string[][] = [];
    const runner: Runner = async (_config, args) => {
      calls.push(args);
      return [{ service: 'notion', name: 'create_page' }];
    };
    const search = toolsWithRunner(runner).find((tool) => tool.name === 'connector_search');

    await search!.execute({
      originalPrompt: '使用 Notion 帮我创建一个父页面',
      prompt: '路由说明包含 Gmail、GitHub、Notion 和邮件示例',
    } as never, { service: 'notion', query: 'Notion' });

    expect(calls).toEqual([['connector', 'search', '--json', '--', 'create page notion']]);
  });

  it('rejects a Notion resource action that conflicts with the original request', async () => {
    const calls: string[][] = [];
    const runner: Runner = async (_config, args) => {
      calls.push(args);
      return {};
    };
    const run = toolsWithRunner(runner).find((tool) => tool.name === 'connector_run');

    await expect(run!.execute({
      originalPrompt: '使用 Notion 帮我创建一个父页面',
      prompt: '包含外部服务路由说明',
    } as never, {
      service: 'notion',
      name: 'create_data_source',
      input: { parent: { database_id: '70281c6f-59e3-4b2a-9d8c-3c7d6a5e5f1a' }, properties: {} },
    })).rejects.toThrow('action mismatch');
    expect(calls).toEqual([]);
  });

  it('rejects an invented Notion parent ID before executing the connector', async () => {
    const calls: string[][] = [];
    const runner: Runner = async (_config, args) => {
      calls.push(args);
      return {};
    };
    const run = toolsWithRunner(runner).find((tool) => tool.name === 'connector_run');

    await expect(run!.execute({
      runId: 'notion-invented-id',
      originalPrompt: '使用 Notion 帮我创建一个父页面',
      prompt: '包含外部服务路由说明',
    } as never, {
      service: 'notion',
      name: 'create_page',
      input: { parent: { page_id: '70281c6f-59e3-4b2a-9d8c-3c7d6a5e5f1a' }, title: '父页面' },
    })).rejects.toThrow('was not provided by the user');
    expect(calls).toEqual([]);
  });

  it('rejects a guessed action before execution when schema preflight fails', async () => {
    const calls: string[][] = [];
    const runner: Runner = async (_config, args) => {
      calls.push(args);
      throw new Error('HTTP 404');
    };
    const run = toolsWithRunner(runner).find((tool) => tool.name === 'connector_run');

    await expect(run!.execute({} as never, {
      service: 'gmail',
      name: 'list_messages',
      connectionName: 'default',
      input: { maxResults: 5 },
    })).rejects.toThrow('gmail.list_messages" could not be verified and was not executed');
    expect(calls).toEqual([['connector', 'schema', 'gmail.list_messages']]);
  });

  it('caches and compacts an action schema within one run', async () => {
    const calls: string[][] = [];
    const runner: Runner = async (_config, args) => {
      calls.push(args);
      return {
        service: 'notion',
        name: 'create_page',
        description: 'Create a page.',
        inputSchema: {
          type: 'object',
          properties: { title: { type: 'string' } },
        },
        outputSchema: {
          type: 'object',
          properties: { content: { type: 'string', description: 'x'.repeat(20_000) } },
        },
      };
    };
    const schema = toolsWithRunner(runner).find((tool) => tool.name === 'connector_schema');
    const input = { runId: 'schema-cache-run', prompt: '创建 Notion 页面' } as never;

    const first = await schema!.execute(input, { service: 'notion', name: 'create_page' });
    const second = await schema!.execute(input, { service: 'notion', name: 'create_page' });

    expect(calls).toEqual([['connector', 'schema', 'notion.create_page']]);
    expect(first.content).toContain('inputSchema');
    expect(first.content).not.toContain('outputSchema');
    expect(first.content).toContain('EverRoom converts it');
    expect(second.details).toMatchObject({ status: 'already_inspected' });
    expect(second.content.length).toBeLessThan(300);
  });

  it('normalizes a simple Notion workspace title to the official property shape', async () => {
    const calls: string[][] = [];
    const runner: Runner = async (_config, args) => {
      calls.push(args);
      if (args[1] === 'schema') {
        return { service: 'notion', name: 'create_page', inputSchema: { type: 'object' } };
      }
      if (args[1] === 'apps') return [{ connectionName: 'default', status: 'active' }];
      return { id: '11fdc7b70354494eaea1574d264ca301' };
    };
    const connectorTools = toolsWithRunner(runner);
    const schema = connectorTools.find((tool) => tool.name === 'connector_schema');
    const run = connectorTools.find((tool) => tool.name === 'connector_run');
    const input = {
      runId: 'notion-workspace-page',
      originalPrompt: '使用 Notion 创建一个标题为“父页面”的私有工作区页面',
      prompt: '包含外部服务路由说明',
    } as never;

    await schema!.execute(input, { service: 'notion', name: 'create_page' });
    await run!.execute(input, {
      service: 'notion',
      name: 'create_page',
      connectionName: 'default',
      input: { parent: { workspace: true }, title: '父页面' },
    });

    expect(calls).toEqual([
      ['connector', 'schema', 'notion.create_page'],
      ['connector', 'apps', 'notion', '--json'],
      [
        'connector', 'run', 'notion',
        '--action', 'create_page',
        '--data', '{"parent":{"workspace":true},"properties":{"title":{"title":[{"type":"text","text":{"content":"父页面"}}]}}}',
        '--connection-name', 'default',
        '--json',
      ],
    ]);
  });

  it('caps oversized connector results before they enter model context', async () => {
    const runner: Runner = async () => [{
      service: 'notion',
      name: 'search',
      description: '"中文\n'.repeat(30_000),
    }];
    const search = toolsWithRunner(runner).find((tool) => tool.name === 'connector_search');

    const result = await search!.execute({ prompt: '搜索 Notion' } as never, {
      service: 'notion',
      query: 'search pages',
    });

    expect(Buffer.byteLength(result.content)).toBeLessThanOrEqual(64 * 1024);
    expect(result.details).toMatchObject({ truncated: true });
  });

  it('classifies connector failures into bounded recovery actions', () => {
    const connectorTools = tools();
    const run = connectorTools.find((tool) => tool.name === 'connector_run');
    const schema = connectorTools.find((tool) => tool.name === 'connector_schema');
    const input = { prompt: '查看 Gmail 最近邮件' } as never;
    const params = { service: 'gmail', name: 'list_messages', input: {} };

    expect(run?.classifyFailure?.(
      new Error('HTTP 404 action metadata not found'),
      input,
      params,
    )).toMatchObject({
      category: 'action_not_found',
      recoverable: true,
      recommendedTool: 'connector_search',
      maxAttempts: 1,
    });
    expect(run?.classifyFailure?.(
      new Error('HTTP 400 invalid_input: Validation Failed'),
      input,
      params,
    )).toMatchObject({
      category: 'invalid_input',
      recoverable: true,
      recommendedTool: 'connector_schema',
      maxAttempts: 1,
    });
    expect(run?.classifyFailure?.(
      new Error('The connector action input payload is invalid: data must NOT have additional properties'),
      input,
      params,
    )).toMatchObject({
      category: 'invalid_input',
      recoverable: true,
      recommendedTool: 'connector_schema',
    });
    expect(run?.classifyFailure?.(
      new Error('connection_not_found: default'),
      input,
      params,
    )).toMatchObject({
      category: 'connection_invalid',
      recoverable: true,
      recommendedTool: 'connector_apps',
      maxAttempts: 1,
    });
    expect(schema?.classifyFailure?.(
      new Error('UND_ERR_CONNECT_TIMEOUT'),
      input,
      params,
    )).toMatchObject({
      category: 'transient_network',
      recoverable: true,
      recommendedTool: 'connector_schema',
      maxAttempts: 1,
    });
  });

  it('keeps authentication and indeterminate execution failures terminal', () => {
    const run = tools().find((tool) => tool.name === 'connector_run');
    const input = { prompt: '发送 Gmail 邮件' } as never;
    const params = { service: 'gmail', name: 'send_email', input: {} };

    expect(run?.classifyFailure?.(
      new Error('HTTP 401 unauthorized: OAuth token expired'),
      input,
      params,
    )).toMatchObject({
      category: 'authentication_required',
      recoverable: false,
    });
    expect(run?.classifyFailure?.(
      new Error('connector action timed out'),
      input,
      params,
    )).toMatchObject({
      category: 'transient_network',
      recoverable: false,
      maxAttempts: 0,
    });
  });

  it('rejects execution when the service has no active connection', async () => {
    const calls: string[][] = [];
    const runner: Runner = async (_config, args) => {
      calls.push(args);
      if (args[1] === 'schema') return { service: 'gmail', name: 'fetch_emails' };
      return [];
    };
    const run = toolsWithRunner(runner).find((tool) => tool.name === 'connector_run');

    await expect(run!.execute({} as never, {
      service: 'gmail',
      name: 'fetch_emails',
      input: { maxResults: 5, detail: 'summary' },
    })).rejects.toThrow('has no active connection');
    expect(calls).toEqual([
      ['connector', 'schema', 'gmail.fetch_emails'],
      ['connector', 'apps', 'gmail', '--json'],
    ]);
  });

  it('rejects a connection name that was not returned by connector apps', async () => {
    const runner: Runner = async (_config, args) => {
      if (args[1] === 'schema') return { service: 'gmail', name: 'fetch_emails' };
      return [{ connectionName: 'personal', status: 'active' }];
    };
    const run = toolsWithRunner(runner).find((tool) => tool.name === 'connector_run');

    await expect(run!.execute({} as never, {
      service: 'gmail',
      name: 'fetch_emails',
      connectionName: 'default',
      input: { maxResults: 5, detail: 'summary' },
    })).rejects.toThrow('Use one of the exact connectionName values returned by connector_apps: personal');
  });

  it('runs a verified action with the exact default connection returned by connector apps', async () => {
    const calls: string[][] = [];
    const runner: Runner = async (_config, args) => {
      calls.push(args);
      if (args[1] === 'schema') return { service: 'gmail', name: 'fetch_emails' };
      if (args[1] === 'apps') {
        return [{
          connectionName: 'mail-account',
          isDefault: true,
          status: 'active',
        }];
      }
      return { data: { messages: [] } };
    };
    const run = toolsWithRunner(runner).find((tool) => tool.name === 'connector_run');

    await expect(run!.execute({} as never, {
      service: 'gmail',
      name: 'fetch_emails',
      input: { maxResults: 5, detail: 'summary' },
    })).resolves.toMatchObject({ details: { data: { messages: [] } } });
    expect(calls).toEqual([
      ['connector', 'schema', 'gmail.fetch_emails'],
      ['connector', 'apps', 'gmail', '--json'],
      [
        'connector', 'run', 'gmail',
        '--action', 'fetch_emails',
        '--data', '{"maxResults":5,"detail":"summary"}',
        '--connection-name', 'mail-account',
        '--json',
      ],
    ]);
  });

  it('preserves Gmail date and subject constraints and removes invented mailbox filters', async () => {
    const calls: string[][] = [];
    const runner: Runner = async (_config, args) => {
      calls.push(args);
      if (args[1] === 'schema') return { service: 'gmail', name: 'fetch_emails' };
      if (args[1] === 'apps') return [{ connectionName: 'default', status: 'active' }];
      return { data: { messages: [] } };
    };
    const run = toolsWithRunner(runner).find((tool) => tool.name === 'connector_run');

    await run!.execute({
      originalPrompt: '查找最近 7 天内标题包含“会议”的 Gmail 邮件，最多返回 10 封，不要标记为已读。',
      prompt: '路由说明提到了收件箱和未读邮件，但这些不是用户条件。',
    } as never, {
      service: 'gmail',
      name: 'fetch_emails',
      input: { query: 'in:inbox is:unread subject:"会议"', maxResults: 50, detail: 'summary' },
    });

    expect(calls[2]).toContain('{"query":"subject:\\"会议\\" newer_than:7d","maxResults":10,"detail":"summary"}');
  });
});
