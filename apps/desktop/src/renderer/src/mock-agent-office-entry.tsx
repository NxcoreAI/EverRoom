// 临时入口：纯浏览器单挂 AgentStatusPage，验证办公室背景的昼夜时钟。
// URL ?skyHour=22 把本地时间伪装成 22 点（重载即生效）。
import { createRoot } from 'react-dom/client'

import { LocaleProvider } from './i18n/LocaleContext'
import { AgentStatusPage } from './components/pages/AgentStatusPage'
import '@/styles/tokens.css'
import './styles.css'

const skyHourParam = new URLSearchParams(location.search).get('skyHour')
const fakeHour = Number(skyHourParam)
if (skyHourParam !== null && Number.isFinite(fakeHour)) {
  Date.prototype.getHours = () => Math.floor(fakeHour)
}

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString()
const run = (id: string, task: string, status: 'running' | 'completed' | 'failed', startedAgo: number) => ({
  id,
  task,
  pageLabel: null,
  status,
  startedAt: minutesAgo(startedAgo),
  completedAt: status === 'running' ? null : minutesAgo(Math.max(0, startedAgo - 3)),
})
const agent = (
  id: string,
  name: string,
  description: string,
  state: 'running' | 'idle' | 'error',
  currentRun: ReturnType<typeof run> | null,
  lastRun: ReturnType<typeof run> | null,
) => ({
  agentId: id,
  name,
  description,
  kind: 'builtin' as const,
  state,
  activeRunCount: currentRun ? 1 : 0,
  workspace: { id: `ws-${id}`, isolation: 'dedicated' as const, revisionId: null },
  currentRun,
  lastRun,
  updatedAt: minutesAgo(5),
})

const agents = [
  agent('a-main', '主理人', '日常事务与调度', 'running', run('r1', '整理今日日报', 'running', 12), run('r0', '晨间简报', 'completed', 300)),
  agent('a-slides', '幻灯师', '幻灯片生成', 'running', run('r2', '生成季度汇报 PPT', 'running', 40), null),
  agent('a-mail', '邮差', '邮箱整理', 'idle', null, run('r3', '收件箱清扫', 'completed', 120)),
  agent('a-diary', '记录员', '日记与总结', 'idle', null, null),
  agent('a-scout', '侦察兵', '外部资料检索', 'error', null, run('r4', '抓取订阅源', 'failed', 90)),
]

const original = window.nxcore as unknown as Record<string, unknown>
window.nxcore = new Proxy(original, {
  get(target, prop) {
    if (prop === 'agent') {
      return {
        ...((target.agent as object) ?? {}),
        getStatus: async () => ({
          generatedAt: new Date().toISOString(),
          summary: { total: agents.length, running: 2, idle: 2, error: 1 },
          agents,
        }),
      }
    }
    return target[prop as string]
  },
}) as unknown as typeof window.nxcore

createRoot(document.getElementById('mock-root')!).render(
  <LocaleProvider>
    <AgentStatusPage />
  </LocaleProvider>,
)
