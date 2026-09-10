// 临时入口：纯浏览器挂载 SettingsPage，mock 已登录账号态与各设置 API（验证后删除）。
import { createRoot } from 'react-dom/client'

import { AccountProvider } from './state/AccountContext'
import { SettingsPage } from './components/pages/SettingsPage'
import { LocaleProvider } from './i18n/LocaleContext'
import '@/styles/tokens.css'
import './styles.css'

const params = new URLSearchParams(window.location.search)
const authed = params.get('authed') !== '0'

const now = Date.now()
const iso = (offsetMs: number) => new Date(now - offsetMs).toISOString()

const devices = [
  { id: 'dev-1', name: '小王的 MacBook Pro', platform: 'darwin', appVersion: '1.4.0', status: 'online', lastSeenAt: iso(0) },
  { id: 'dev-2', name: 'iPhone 16 Pro', platform: 'ios', appVersion: '1.3.2', status: 'offline', lastSeenAt: iso(3600_000 * 26) },
]

const usagePoints = Array.from({ length: 7 }, (_, i) => ({
  startAt: iso((6 - i) * 3600_000 * 24),
  inputTokens: 1200 + i * 900 + (i % 3) * 400,
  outputTokens: 800 + i * 500,
  cacheReadTokens: 300 + i * 200,
}))

const audits = Array.from({ length: 12 }, (_, i) => ({
  id: 'a' + i,
  service: i % 3 === 0 ? 'WEB_SEARCH' : i % 3 === 1 ? 'MCP' : 'CONNECTOR',
  tool: i % 3 === 0 ? 'web_search' : i % 3 === 1 ? 'mcp__notion__search' : 'gmail.listMessages',
  outcome: i % 5 === 0 ? 'FAILED' : i % 7 === 0 ? 'BLOCKED' : 'SUCCEEDED',
  durationMs: 120 + i * 60,
  occurredAt: iso(i * 1800_000),
}))

const base = (window.nxcore ?? {}) as Record<string, unknown>

window.nxcore = new Proxy(base, {
  get(target, prop) {
    const face = target[prop as string]
    switch (prop) {
      case 'platform':
        return 'darwin'
      case 'account':
        return new Proxy((face ?? {}) as object, {
          get(accountFace, key) {
            const f = accountFace as Record<string | symbol, unknown>
            if (key === 'status') {
              return async () => authed ? {
                authenticated: true,
                apiBaseUrl: 'https://api.everroom.example.com',
                user: { id: 'u1', tenantId: 't1', email: 'wang@example.com', name: '小王' },
                device: { id: 'dev-1', name: '小王的 MacBook Pro', platform: 'darwin' },
                subscription: {
                  status: 'active',
                  planCode: 'pro',
                  planName: 'Pro 年付',
                  periodStart: iso(3600_000 * 24 * 120),
                  periodEnd: iso(-3600_000 * 24 * 245),
                  quotaSeconds: 3600_000,
                  usedSeconds: 1200_000,
                  remainingSeconds: 2400_000,
                },
              } : { authenticated: false, apiBaseUrl: 'https://api.everroom.example.com' }
            }
            if (key === 'keyringStatus') {
              return async () => ({ enabled: true, initialized: true, umkId: 'umk-1', activeVersion: 2, deviceStatus: 'active', verificationCode: null })
            }
            if (key === 'devices') return async () => authed ? devices : []
            return typeof f[key] === 'undefined' ? async () => null : f[key]
          },
        })
      case 'aiRelay':
        return {
          status: async () => ({ configured: true, subscriptionStatus: 'active', llmCredits: 50, usedCredits: '18.5', remainingCredits: 31.5, periodEnd: iso(-3600_000 * 24 * 90) }),
          onEvent: () => () => {},
        }
      case 'transcriptions':
        return {
          onSyncCompleted: () => () => {},
          syncPrivate: async () => ({ status: { enabled: true, initialized: true, umkId: 'umk-1', activeVersion: 2, deviceStatus: 'active', verificationCode: null }, synced: 12 }),
        }
      case 'privateAudio':
        return { list: async () => ({ assets: [{ status: 'uploaded' }, { status: 'uploaded' }, { status: 'pending' }] }) }
      case 'screenCapture':
        return {
          status: async () => ({ enabled: true, intervalMs: 300_000, lastResult: null }),
          perceptionSettings: async () => ({ captureEnabled: true, captureIntervalSeconds: 300, onlineVlmEnabled: true, configVersion: 3, updatedAt: iso(3600_000) }),
          start: async () => ({ enabled: true, intervalMs: 300_000, lastResult: null }),
          stop: async () => ({ enabled: false, intervalMs: 300_000, lastResult: null }),
          updateInterval: async (ms: number) => ({ enabled: true, intervalMs: ms, lastResult: null }),
          updateOnlineVlm: async (_enabled: boolean, configVersion: number) => ({ captureEnabled: true, captureIntervalSeconds: 300, onlineVlmEnabled: true, configVersion: configVersion + 1, updatedAt: new Date().toISOString() }),
          captureCurrentWindow: async () => ({ ok: true, filePath: '/Users/xjwang/EverRoom/screenshots/2026-09-10-15-30-01.png' }),
        }
      case 'browserExtension':
        return {
          status: async () => ({ state: 'paired', mode: 'production', pairedExtensionId: 'chrome-extension://abc123', pairing: null, lastMessage: { type: 'PING' } }),
          onStatus: () => () => {},
          install: async () => ({ state: 'waiting-for-extension', mode: 'production', pairedExtensionId: null, pairing: { expiresAt: new Date(now + 300_000).toISOString(), extensionId: null }, lastMessage: null }),
          createPairing: async () => ({ state: 'waiting-for-extension', mode: 'production', pairedExtensionId: null, pairing: { expiresAt: new Date(now + 300_000).toISOString(), extensionId: null }, lastMessage: null }),
          revoke: async () => ({ state: 'not-connected', mode: 'production', pairedExtensionId: null, pairing: null, lastMessage: null }),
          openDirectory: async () => {},
          openBrowserPage: async () => {},
        }
      case 'agent':
        return new Proxy((face ?? {}) as object, {
          get(agentFace, key) {
            const f = agentFace as Record<string | symbol, unknown>
            if (key === 'discoverLocalAgents') {
              return async () => [
                { id: 'claude', provider: 'claude', displayName: 'Claude Code', version: '2.0.14', executablePath: '/usr/local/bin/claude', historyPaths: ['~/.claude/projects'], historyAvailable: true, callable: true, invocationSupported: true },
                { id: 'codex', provider: 'codex', displayName: 'Codex CLI', version: '0.9.2', executablePath: '/opt/homebrew/bin/codex', historyPaths: ['~/.codex/sessions'], historyAvailable: true, callable: false, invocationSupported: false },
              ]
            }
            if (key === 'getUsage') {
              return async () => ({
                range: '7d',
                provider: 'piagent',
                updatedAt: new Date().toISOString(),
                inputTokens: 18400,
                outputTokens: 11300,
                cacheHitTokens: 5200,
                points: usagePoints,
              })
            }
            return typeof f[key] === 'undefined' ? async () => null : f[key]
          },
        })
      case 'mcp':
        return {
          listServers: async () => ({
            configPath: '/Users/xjwang/Library/Application Support/EverRoom/mcp.json',
            servers: {
              'notion': { url: 'https://mcp.notion.com/mcp', headers: { Authorization: 'Bearer …' } },
              'filesystem': { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/Users/xjwang/Notes'], env: {} },
            },
          }),
          saveServers: async () => ({ configPath: '/Users/xjwang/Library/Application Support/EverRoom/mcp.json', servers: {} }),
        }
      case 'runtimeConfig':
        return {
          get: async () => ({
            config: {
              primary: { provider: 'openai-compatible', model: 'glm-4-flash', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
              embedding: { provider: 'openai-compatible', model: 'text-embedding-3-small', baseUrl: 'https://api.example.com/v1' },
            },
            source: 'user',
            selectedSource: 'user',
            availableSources: ['user', 'saas'],
            configVersion: 5,
            updatedAt: iso(3600_000 * 5),
            primaryConfigured: true,
            webSearchCredential: { configured: true, source: 'user' },
          }),
          saveUser: async () => null,
          clearUser: async () => null,
          refreshSaas: async () => null,
          selectSource: async () => null,
          test: async () => ({ valid: true }),
        }
      case 'externalCalls':
        return {
          listPolicies: async () => ({
            items: [
              { id: 'p1', subjectScope: 'service', subjectId: 'MCP', service: 'MCP', period: 'UTC_DAY', limit: 200, warningThreshold: 160, enforcement: 'AUDIT_ONLY' },
              { id: 'p2', subjectScope: 'service', subjectId: 'WEB_SEARCH', service: 'WEB_SEARCH', period: 'UTC_MONTH', limit: 1000, warningThreshold: 800, enforcement: 'BLOCK' },
            ],
          }),
          listUsage: async () => ({
            items: [
              { policyId: 'p1', periodStart: new Date(now).toISOString().slice(0, 10), consumedCalls: 84, reservedCalls: 2, atLimit: false, nearLimit: false },
              { policyId: 'p2', periodStart: '2026-09-01', consumedCalls: 640, reservedCalls: 0, atLimit: false, nearLimit: false },
            ],
          }),
          listAudits: async () => ({ items: audits, total: audits.length, offset: 0 }),
          savePolicy: async () => {},
          deletePolicy: async () => {},
        }
      case 'cliConnector':
        return new Proxy((face ?? {}) as object, {
          get(connectorFace, key) {
            const f = connectorFace as Record<string | symbol, unknown>
            if (key === 'mode') return async () => ({ mode: 'saas', switchedAt: iso(3600_000 * 48) })
            if (key === 'setMode') return async (mode: string) => ({ mode, switchedAt: new Date().toISOString() })
            return typeof f[key] === 'undefined' ? async () => null : f[key]
          },
        })
      case 'app':
        return new Proxy((face ?? {}) as object, {
          get(appFace, key) {
            const f = appFace as Record<string | symbol, unknown>
            if (key === 'clearUserData') return async () => {}
            return typeof f[key] === 'undefined' ? async () => null : f[key]
          },
        })
      default:
        return face
    }
  },
}) as unknown as typeof window.nxcore

createRoot(document.getElementById('mock-root')!).render(
  <LocaleProvider>
    <AccountProvider>
      <SettingsPage onStartFullOnboarding={() => window.alert('start onboarding')} />
    </AccountProvider>
  </LocaleProvider>,
)
