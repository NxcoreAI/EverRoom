import React, { useState } from 'react'
import { Bot, Sparkles } from 'lucide-react'

import {
  type OfficeFile, agentSessions, agentSkills, files, knowledgeCards,
  mcpServers, memoryKindMeta, persona, userProfile,
} from '../data'
import { FileTypeIcon, PageHead, Seg } from './parts'

type AgentTab = 'memory' | 'sessions' | 'mcp' | 'skills' | 'persona' | 'profile'

const agentTabs: { key: AgentTab; label: string }[] = [
  { key: 'memory', label: '记忆' },
  { key: 'sessions', label: '会话记录' },
  { key: 'mcp', label: 'MCP 工具' },
  { key: 'skills', label: 'Skills' },
  { key: 'persona', label: '人格' },
  { key: 'profile', label: '用户画像' },
]

export function AgentView({
  onOpenFile, onToast,
}: {
  onOpenFile: (f: OfficeFile) => void
  onToast: (msg: string) => void
}) {
  const [tab, setTab] = useState<AgentTab>('memory')

  /** 调试面板是独立窗口：这里只触发主进程开窗（单例），失败给出可读提示。 */
  const openAgentDebug = () => {
    const api = window.nxcore?.agentDebug
    if (!api?.openWindow) {
      onToast('调试窗口不可用（桌面服务未就绪）')
      return
    }
    void api.openWindow().catch((error: unknown) => {
      onToast(error instanceof Error ? error.message : '打开调试窗口失败')
    })
  }

  return (
    <>
      <PageHead title="智能体" hint="管理本地 Agent 的记忆、工具与人格" />

      <section className="op-agent-hero">
        <div className="op-agent-avatar"><Bot size={24} /></div>
        <div className="op-agent-hero-text">
          <div className="op-agent-hero-name">
            工作台 Agent
            <span className="op-pill on"><i className="op-dot on" />运行中</span>
          </div>
          <p>基于你的记忆、连接器与技能自动起草文档</p>
        </div>
        <button className="op-ghost-btn" type="button" title="打开独立的 Agent 调试窗口" onClick={openAgentDebug}>调试</button>
      </section>

      <Seg items={agentTabs} value={tab} onChange={setTab} />

      <div className="op-agent-body">
        {tab === 'memory' && <MemoryTab onToast={onToast} />}
        {tab === 'sessions' && <SessionsTab onOpenFile={onOpenFile} onToast={onToast} />}
        {tab === 'mcp' && <McpTab />}
        {tab === 'skills' && <SkillsTab onToast={onToast} />}
        {tab === 'persona' && <PersonaTab onToast={onToast} />}
        {tab === 'profile' && <ProfileTab />}
      </div>
    </>
  )
}

function MemoryTab({ onToast }: { onToast: (msg: string) => void }) {
  return (
    <div className="op-list-card">
      {knowledgeCards.map((k) => {
        const meta = memoryKindMeta[k.kind]
        return (
          <button
            key={k.id}
            type="button"
            className="op-mem-row"
            onClick={() => onToast(`「${k.title}」：${k.quote}`)}
          >
            <span className={`op-mem-kind op-mem-kind--${k.kind}`}>{meta.label}</span>
            <span className="op-mem-main">
              <span className="op-mem-title">{k.title}</span>
              <span className="op-mem-quote">{k.quote}</span>
            </span>
            <span className="op-mem-side">
              <span>{k.source}</span>
              <span className="op-mem-refs">被 {k.refCount} 篇文档引用</span>
            </span>
          </button>
        )
      })}
    </div>
  )
}

function SessionsTab({
  onOpenFile, onToast,
}: {
  onOpenFile: (f: OfficeFile) => void
  onToast: (msg: string) => void
}) {
  return (
    <div className="op-list-card">
      {agentSessions.map((s) => {
        const related = s.fileId ? files.find((f) => f.id === s.fileId) : undefined
        return (
          <button
            key={s.id}
            type="button"
            className="op-mem-row"
            onClick={() => {
              if (related) onOpenFile(related)
              else onToast('该会话没有关联文档')
            }}
          >
            <span className="op-mem-main">
              <span className="op-mem-title">{s.title}</span>
              <span className="op-mem-quote">{s.whenLabel} · {s.duration} · {s.turns} 轮对话</span>
            </span>
            <span className="op-mem-side">
              <span className="op-file-chip">
                {related && <FileTypeIcon kind={related.kind} size={15} />}
                {related ? related.name : '无关联文档'}
              </span>
            </span>
          </button>
        )
      })}
    </div>
  )
}

function McpTab() {
  return (
    <div className="op-list-card">
      {mcpServers.map((m) => (
        <div key={m.id} className="op-mcp-row">
          <div className="op-mcp-top">
            <span className="op-mcp-name">{m.name}</span>
            <span className="op-mcp-transport">{m.transport}</span>
            <span className={`op-pill${m.connected ? ' on' : ''}`}>
              <i className={`op-dot${m.connected ? ' on' : ''}`} />
              {m.connected ? '已连接' : '未连接'}
            </span>
          </div>
          <div className="op-mcp-tools">
            {m.tools.map((t) => <span key={t} className="op-chip op-chip-sm">{t}</span>)}
          </div>
        </div>
      ))}
    </div>
  )
}

function SkillsTab({ onToast }: { onToast: (msg: string) => void }) {
  const [skills, setSkills] = useState(agentSkills)
  const toggle = (id: string) => {
    setSkills((prev) => prev.map((s) => {
      if (s.id !== id) return s
      onToast(`技能「${s.name}」已${s.enabled ? '停用' : '启用'}`)
      return { ...s, enabled: !s.enabled }
    }))
  }
  return (
    <div className="op-tpl-row">
      {skills.map((s) => (
        <div key={s.id} className="op-skill-card">
          <span className="op-skill-name">{s.name}</span>
          <span className="op-skill-desc">{s.desc}</span>
          <div className="op-skill-foot">
            <span className={`op-skill-state${s.enabled ? '' : ' off'}`}>{s.enabled ? '已启用' : '已停用'}</span>
            <button
              type="button"
              aria-label={s.enabled ? '停用' : '启用'}
              className={`op-toggle${s.enabled ? ' on' : ''}`}
              onClick={() => toggle(s.id)}
            >
              <i />
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}

function PersonaTab({ onToast }: { onToast: (msg: string) => void }) {
  return (
    <section className="op-info-card op-persona-card">
      <div className="op-persona-head">
        <div className="op-agent-avatar sm"><Sparkles size={17} /></div>
        <div className="op-persona-head-text">
          <div className="op-info-title">{persona.name}</div>
          <p>{persona.tagline}</p>
        </div>
        <button className="op-ghost-btn" type="button" onClick={() => onToast('人格编辑（原型占位）')}>编辑</button>
      </div>
      <div className="op-chips">
        {persona.styleTags.map((t) => <span key={t} className="op-chip">{t}</span>)}
      </div>
      <div className="op-persona-prompt">
        <div className="op-persona-prompt-label">系统提示词（摘要）</div>
        <p>{persona.promptSummary}</p>
      </div>
    </section>
  )
}

function ProfileTab() {
  return (
    <div className="op-profile-grid">
      {userProfile.map((g) => (
        <section key={g.title} className="op-info-card">
          <div className="op-info-title">{g.title}</div>
          <ul>
            {g.items.map((i) => <li key={i}>{i}</li>)}
          </ul>
        </section>
      ))}
    </div>
  )
}
