import { useState } from 'react'
import { Bot } from 'lucide-react'

import { workbenchToast } from '../shell/toast'
import { useAgentPersona } from './useAgentPersona'

/**
 * 主页「Agent」页。
 *
 * **页面代码直接复制自原型 `office-proto/pages/AgentView.tsx`**（页头 / Hero / Seg /
 * `.op-info-card` 卡片），样式全部沿用 `office-proto.css`（`main.tsx` 已全局引入），
 * 这里不另造样式，只做两件事：
 *   1. 把原型里的 mock 数据换成网关真实数据（`useAgentPersona`：人格 / 用户画像 / 经验）；
 *   2. 原型的六个 tab 里，我们在这页有数据源的是「人格 / 用户画像 / 经验」，其余
 *      （知识卡片 / 会话记录 / MCP 工具 / Skills）各有自己的页面，不在这里重复造。
 */

type AgentTab = 'persona' | 'profile' | 'insights'

const agentTabs: { key: AgentTab; label: string }[] = [
  { key: 'persona', label: '人格' },
  { key: 'profile', label: '用户画像' },
  { key: 'insights', label: '经验' },
]

/* ───────────── 以下两段结构复制自 `office-proto/pages/parts.tsx` ─────────────
   只复制 PageHead / Seg 的 JSX 与类名：parts.tsx 本身 import 了原型的 mock 文件数据，
   整包引进来会把 mock 打进工作台 bundle。 */

function PageHead({ title, hint }: { title: string; hint?: string }) {
  return (
    <header className="op-page-head">
      <div className="op-page-head-text">
        <h1>{title}</h1>
        {hint && <p>{hint}</p>}
      </div>
    </header>
  )
}

function Seg<T extends string>({
  items, value, onChange,
}: {
  items: { key: T; label: string }[]
  value: T
  onChange: (key: T) => void
}) {
  return (
    <div className="op-seg" role="tablist">
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          role="tab"
          aria-selected={value === item.key}
          className={`op-seg-btn${value === item.key ? ' active' : ''}`}
          onClick={() => onChange(item.key)}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}

/* ───────────── 原型三个 tab 的同一套结构，数据换成真实数据 ───────────── */

/** 人格：原型 `PersonaTab`（`op-info-card op-persona-card` + 技能 chips + 提示词摘要）。 */
function PersonaTab({ persona }: {
  persona: { name: string; tagline: string; skills: string[]; promptSummary: string }
}) {
  return (
    <section className="op-info-card op-persona-card">
      <div className="op-persona-head">
        <div className="op-agent-avatar sm"><Bot size={17} /></div>
        <div className="op-persona-head-text">
          <div className="op-info-title">{persona.name}</div>
        </div>
      </div>
      {persona.skills.length > 0 && (
        <div className="op-chips">
          {persona.skills.map((skill) => <span key={skill} className="op-chip">{skill}</span>)}
        </div>
      )}
      {persona.promptSummary ? (
        <div className="op-persona-prompt">
          <div className="op-persona-prompt-label">系统提示词（摘要）</div>
          <p>{persona.promptSummary}</p>
        </div>
      ) : null}
    </section>
  )
}

/** 用户画像：原型 `ProfileTab`（`op-profile-grid` + 每组一张 `op-info-card`）。 */
function ProfileTab({ groups }: {
  groups: { title: string; items: { id: string; content: string }[] }[]
}) {
  return (
    <div className="op-profile-grid">
      {groups.map((group) => (
        <section key={group.title} className="op-info-card">
          <div className="op-info-title">{group.title}</div>
          <ul>
            {group.items.map((item) => <li key={item.id}>{item.content}</li>)}
          </ul>
        </section>
      ))}
    </div>
  )
}

/**
 * 读取失败 ≠ 真的没有：接口 400/网络异常时绝不能显示「还没有用户画像」
 * （用户会以为自己的信息没被记住）。样式沿用原型 `.op-empty`，只加一个就地重试。
 */
function ReadFailed({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="op-empty" role="alert">
      {message}
      <button className="op-ghost-btn" type="button" onClick={onRetry} style={{ marginLeft: 10 }}>重试</button>
    </div>
  )
}

/** 经验：原型没有这个 tab，沿用同一张 `op-info-card` 与列表结构。 */
function InsightsTab({ items }: { items: { id: string; text: string; whenLabel: string }[] }) {
  return (
    <section className="op-info-card">
      <div className="op-info-title">经验</div>
      <ul>
        {items.map((item) => (
          <li key={item.id}>
            {item.text}
            {item.whenLabel && <span className="wb-home-exp-meta">{item.whenLabel}</span>}
          </li>
        ))}
      </ul>
    </section>
  )
}

export function AgentPage() {
  const [tab, setTab] = useState<AgentTab>('profile')
  const { state, reload } = useAgentPersona()

  const persona = state.status === 'ready' ? state.value.persona : null
  const profile = state.status === 'ready' ? state.value.profile : []
  const experiences = state.status === 'ready' ? state.value.experiences : []
  const failed = state.status === 'ready' ? state.value.failed : { profile: false, experiences: false }
  const ready = state.status === 'ready'

  /** 调试面板是独立窗口：这里只触发主进程开窗（单例），失败给出可读提示。 */
  const openAgentDebug = () => {
    const api = window.nxcore?.agentDebug
    if (!api?.openWindow) {
      workbenchToast('调试窗口不可用（桌面服务未就绪）')
      return
    }
    void api.openWindow().catch((error: unknown) => {
      workbenchToast(error instanceof Error ? error.message : '打开调试窗口失败')
    })
  }

  return (
    <div className="wb-home-scroll wb-home-agent-host">
      <PageHead title="智能体" />

      <section className="op-agent-hero">
        <div className="op-agent-avatar"><Bot size={24} /></div>
        <div className="op-agent-hero-text">
          <div className="op-agent-hero-name">
            {persona?.name ?? '工作台 Agent'}
            <span className={`op-pill${ready ? ' on' : ''}`}>
              <i className={`op-dot${ready ? ' on' : ''}`} />
              {state.status === 'error' ? '未连接' : ready ? '运行中' : '连接中'}
            </span>
          </div>
        </div>
        <button className="op-ghost-btn" type="button" title="打开独立的 Agent 调试窗口" onClick={openAgentDebug}>调试</button>
      </section>

      {state.status === 'error' ? (
        <ReadFailed message="Agent 设定读取失败。" onRetry={reload} />
      ) : state.status === 'loading' ? (
        <div className="op-empty">正在读取…</div>
      ) : (
        <>
          <Seg items={agentTabs} value={tab} onChange={setTab} />

          <div className="op-agent-body">
            {tab === 'persona' && (persona
              ? <PersonaTab persona={persona} />
              : <div className="op-empty">这个 Agent 没有可展示的系统提示词。</div>)}

            {tab === 'profile' && (failed.profile
              ? <ReadFailed message="用户画像读取失败。" onRetry={reload} />
              : profile.length > 0
                ? <ProfileTab groups={profile} />
                : <div className="op-empty">还没有用户画像。在对话里告诉 Agent 关于你的事，它记下来后会出现在这里。</div>)}

            {tab === 'insights' && (failed.experiences
              ? <ReadFailed message="经验列表读取失败。" onRetry={reload} />
              : experiences.length > 0
                ? <InsightsTab items={experiences} />
                : <div className="op-empty">还没有积累经验。做过的工作越多，这里沉淀越完整。</div>)}
          </div>
        </>
      )}
    </div>
  )
}
