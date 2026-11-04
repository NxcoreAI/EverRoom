/**
 * Agent 调试面板的只读展示层：右侧详情按选中类型渲染。
 *
 * - 内置 / 子 Agent：系统上下文（模型、系统提示词）、各种上下文（静态注入 + 运行期注入说明、
 *   子 Agent manifest/schema）、工具上下文（实际挂载的内置/网关注入工具、MCP 服务器、限制）、运行记录。
 * - 外部 Agent 连接：恢复旧「Agent 连接页」的调试面板（回写提交 + 最近调用）。
 * - 本地 Agent：发现结果（适配器、能力、Skills）。
 *
 * 所有数据均为只读展示；风格保持极简（发丝线、单色、等宽正文）。
 */
import type { ReactNode } from 'react'

import type { AgentConnectionDto } from '@/shared/agent-access'
import type {
  AgentDebugActivityItem,
  AgentDebugAgentDetail,
  AgentDebugToolInfo,
  AgentDebugUsageResponse,
} from '@/shared/agent-debug'
import type { LocalAgentInstallation } from '@/shared/local-agents'

export type AgentDebugTab = 'system' | 'context' | 'tools' | 'usage'

const ACTIVITY_STATUS: Record<AgentDebugActivityItem['status'], string> = {
  running: '运行中',
  completed: '完成',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '中断',
}

const CAPABILITY_LABELS: Array<[keyof NonNullable<AgentDebugAgentDetail['capabilities']>, string]> = [
  ['streaming', '流式'],
  ['reasoning', '推理'],
  ['tools', '工具'],
  ['steering', '转向'],
  ['resume', '恢复会话'],
]

const SOURCE_LABELS: Record<string, string> = {
  primary_agent: '来自主 Agent',
  'primary-agent': '来自主 Agent',
  scheduler: '定时任务',
  internal_workflow: '内部工作流',
  'internal-workflow': '内部工作流',
}

const ROLE_LABELS: Record<string, string> = {
  'user-facing': '用户对话档',
  internal: '内部运行',
}

function formatTime(value: string | null | undefined): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

function formatDuration(startedAt: string | null, completedAt: string | null): string {
  if (!startedAt) return '—'
  const start = new Date(startedAt).getTime()
  const end = completedAt ? new Date(completedAt).getTime() : Date.now()
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return '—'
  const seconds = Math.round((end - start) / 1000)
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="op-agent-debug-section">
      <div className="op-agent-debug-section-head">
        <h3>{title}</h3>
        {hint ? <span>{hint}</span> : null}
      </div>
      {children}
    </section>
  )
}

function KeyValue({ rows }: { rows: Array<[string, ReactNode]> }) {
  const visible = rows.filter(([, value]) => value !== null && value !== undefined && value !== '')
  if (visible.length === 0) return <p className="op-agent-debug-empty-inline">暂无数据</p>
  return (
    <dl className="op-agent-debug-kv">
      {visible.map(([key, value]) => (
        <div key={key}>
          <dt>{key}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  )
}

function ToolRows({ tools }: { tools: AgentDebugToolInfo[] }) {
  if (tools.length === 0) return <p className="op-agent-debug-empty-inline">未挂载</p>
  return (
    <ul className="op-agent-debug-tools">
      {tools.map((tool) => (
        <li key={`${tool.source}:${tool.name}`}>
          <code>{tool.name}</code>
          <div>
            {tool.label ? <span className="op-agent-debug-tool-label">{tool.label}</span> : null}
            {tool.description ? <p>{tool.description}</p> : null}
          </div>
        </li>
      ))}
    </ul>
  )
}

function ContextBlock({
  title,
  tag,
  defaultOpen = false,
  children,
}: {
  title: string
  tag: string
  defaultOpen?: boolean
  children: ReactNode
}) {
  return (
    <details className="op-agent-debug-block" open={defaultOpen}>
      <summary>
        <span className="op-agent-debug-block-title">{title}</span>
        <span className="op-agent-debug-tag">{tag}</span>
      </summary>
      <div className="op-agent-debug-block-body">{children}</div>
    </details>
  )
}

/** 系统上下文：模型/运行时参数 + 系统提示词 + 追加规范。 */
function SystemTab({ detail }: { detail: AgentDebugAgentDetail }) {
  const model = detail.modelInfo
  const capabilities = detail.capabilities
  return (
    <>
      <Section title="模型与运行时">
        <KeyValue
          rows={[
            ['运行时', detail.runtime ?? '—'],
            ['角色', detail.runtimeRole ? (ROLE_LABELS[detail.runtimeRole] ?? detail.runtimeRole) : null],
            ['提供方', model?.provider ?? null],
            ['模型', model?.model ?? null],
            ['API', model?.api ?? null],
            ['推理档位', model?.reasoning ?? null],
            ['温度', model?.temperature ?? null],
            ['最大输出', model?.maxTokens ?? null],
            ['上下文窗口', model?.contextWindow ?? null],
            ['Base URL', model?.baseUrl ? <code className="op-agent-debug-inline-code">{model.baseUrl}</code> : null],
          ]}
        />
        {capabilities ? (
          <div className="op-agent-debug-chips">
            {CAPABILITY_LABELS.map(([key, label]) => (
              <span key={key} className={capabilities[key] ? 'is-on' : ''}>{label}</span>
            ))}
          </div>
        ) : null}
      </Section>

      <Section
        title="系统提示词"
        hint={`${detail.systemPrompt.length.toLocaleString('zh-CN')} 字符 · bundle SYSTEM.md`}
      >
        <pre className="op-agent-debug-pre">{detail.systemPrompt || '（该 Agent 没有系统提示词）'}</pre>
      </Section>

      {detail.promptGuidelines.length > 0 ? (
        <Section title="追加规范" hint="DocumentMcpHost.promptGuidelines()">
          <ul className="op-agent-debug-lines">
            {detail.promptGuidelines.map((line) => <li key={line}>{line}</li>)}
          </ul>
        </Section>
      ) : null}
    </>
  )
}

/** 各种上下文：静态注入内容 + 运行期注入说明 + 子 Agent manifest。 */
function ContextTab({ detail }: { detail: AgentDebugAgentDetail }) {
  return (
    <>
      <Section title="静态注入" hint="每次运行都会进入上下文">
        <ContextBlock title="系统提示词" tag={`${detail.systemPrompt.length.toLocaleString('zh-CN')} 字符`}>
          <pre className="op-agent-debug-pre is-compact">{detail.systemPrompt || '（空）'}</pre>
        </ContextBlock>

        {detail.skills.length > 0 ? (
          <ContextBlock title="Skills" tag={`${detail.skills.length} 个`}>
            {detail.skills.map((skill) => (
              <div key={skill.name} className="op-agent-debug-skill">
                <div className="op-agent-debug-skill-head">
                  <code>{skill.name}</code>
                  {skill.path ? <span>{skill.path}</span> : null}
                </div>
                {skill.prompt
                  ? <pre className="op-agent-debug-pre is-compact">{skill.prompt}</pre>
                  : <p className="op-agent-debug-empty-inline">全文不内联，由 Agent 用 read 工具按需读取。</p>}
              </div>
            ))}
          </ContextBlock>
        ) : null}

        {detail.mcpServers.length > 0 ? (
          <ContextBlock title="MCP 服务器" tag={`${detail.mcpServers.length} 个`}>
            <ul className="op-agent-debug-lines">
              {detail.mcpServers.map((server) => <li key={server}><code className="op-agent-debug-inline-code">{server}</code></li>)}
            </ul>
          </ContextBlock>
        ) : null}
      </Section>

      <Section title="运行期注入" hint="值随每次请求变化，不落库">
        <ContextBlock title="房间与页面" tag="动态">
          <p>运行输入的 pageLabel / roomId 会拼成「当前工作区」段落；Room 未定时注入 &lt;available_rooms&gt;，已定时注入 &lt;room_metadata&gt;（背景、目标、状态、摘要）。</p>
        </ContextBlock>
        <ContextBlock title="活动文件" tag="动态">
          <p>用户正在浏览的 Office 文件（标题 / fileId / 类型 / 是否只读）经 buildActiveFileContext() 注入，并点名 file_read、slides_read、office_edit 等对应工具。</p>
        </ContextBlock>
        <ContextBlock title="打开的文件页签" tag="动态">
          <p>工作区当前打开的 Office 页签清单（最多 20 个，含 active 标记与 fileId）；只有一个且就是当前文件时不重复注入。</p>
        </ContextBlock>
        <ContextBlock title="界面语言" tag="动态">
          <p>responseLanguage 决定「当前界面 locale」段落，约束回答、文档标题与正文的语言。</p>
        </ContextBlock>
        <ContextBlock title="附件与选中文本" tag="动态">
          <p>附件以 &lt;attachments&gt; JSON + document_analysis 指令注入；划选内容包在 &lt;selected_text&gt; 中。</p>
        </ContextBlock>
        <ContextBlock title="连接器与交接" tag="动态">
          <p>已连接服务清单以 &lt;connectors&gt; 注入（30s TTL）；跨档位/子 Agent 运行时另有 &lt;everroom_agent_handoff&gt; 或引用对话说明。</p>
        </ContextBlock>
      </Section>

      {detail.subagent ? (
        <Section title="子 Agent 契约" hint={`revision v${detail.subagent.version}`}>
          <KeyValue
            rows={[
              ['Revision', detail.subagent.revisionId],
              ['Digest', <code className="op-agent-debug-inline-code">{detail.subagent.digest.slice(0, 16)}…</code>],
              ['调用方', Array.isArray(detail.subagent.manifest.allowedCallers) ? String(detail.subagent.manifest.allowedCallers.join(', ')) : null],
              ['Skills', detail.subagent.skills.length > 0 ? detail.subagent.skills.join(', ') : '无'],
              ['MCP 绑定', detail.subagent.mcp.length > 0
                ? detail.subagent.mcp.map((binding) => binding.server).join(', ')
                : '无'],
            ]}
          />
          {detail.subagent.mcp.length > 0 ? (
            <div className="op-agent-debug-schema">
              <span>MCP 白名单</span>
              <pre className="op-agent-debug-pre is-compact">{JSON.stringify(detail.subagent.mcp, null, 2)}</pre>
            </div>
          ) : null}
          {detail.subagent.inputSchema ? (
            <div className="op-agent-debug-schema">
              <span>输入 Schema</span>
              <pre className="op-agent-debug-pre is-compact">{JSON.stringify(detail.subagent.inputSchema, null, 2)}</pre>
            </div>
          ) : null}
          {detail.subagent.outputSchema ? (
            <div className="op-agent-debug-schema">
              <span>输出 Schema</span>
              <pre className="op-agent-debug-pre is-compact">{JSON.stringify(detail.subagent.outputSchema, null, 2)}</pre>
            </div>
          ) : null}
        </Section>
      ) : null}
    </>
  )
}

/** 工具上下文：实际挂载的内置/网关注入工具 + MCP + 运行限制。 */
function ToolsTab({ detail }: { detail: AgentDebugAgentDetail }) {
  const builtin = detail.tools.filter((tool) => tool.source === 'builtin')
  const custom = detail.tools.filter((tool) => tool.source === 'custom')
  return (
    <>
      <Section title="内置工具" hint={`${builtin.length} 个 · pi runtime`}>
        <ToolRows tools={builtin} />
      </Section>

      <Section title="网关注入工具" hint={`${custom.length} 个 · 文档/PPT/连接器/搜索等`}>
        <ToolRows tools={custom} />
      </Section>

      <Section title="MCP 服务器" hint="工具清单由各服务器自行声明，网关不可见">
        {detail.mcpServers.length === 0
          ? <p className="op-agent-debug-empty-inline">未挂载 MCP 服务器</p>
          : (
            <ul className="op-agent-debug-lines">
              {detail.mcpServers.map((server) => <li key={server}><code className="op-agent-debug-inline-code">{server}</code></li>)}
            </ul>
          )}
      </Section>

      <Section title="运行限制">
        <KeyValue
          rows={[
            ['单次运行工具调用上限', detail.limits?.maxToolCallsPerRun ?? null],
            ['单条工具结果字符上限', detail.limits?.maxToolResultChars ?? null],
            ['上下文裁剪', detail.limits?.runContextGuard
              ? `超过 ${detail.limits.runContextGuard.triggerTokens.toLocaleString('zh-CN')} tokens 后保留最近 ${detail.limits.runContextGuard.keepRecentTurns} 轮`
              : null],
          ]}
        />
      </Section>
    </>
  )
}

/** 运行记录：状态快照里的当前/最近运行，子 Agent 取最近 5 次调用。 */
function formatTokens(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—'
  if (value < 1_000) return String(value)
  if (value < 1_000_000) return `${(value / 1_000).toFixed(1)}k`
  return `${(value / 1_000_000).toFixed(2)}M`
}

/** 使用记录：每次运行/子 Agent 调用的任务、状态、耗时、工具调用次数与 token。 */
function UsageTab({
  usage,
  loading,
  error,
}: {
  usage: AgentDebugUsageResponse | null
  loading: boolean
  error: string | null
}) {
  const records = usage?.records ?? []
  const totals = usage?.totals ?? null
  return (
    <Section
      title="使用记录"
      hint={usage ? `最近 ${records.length} 条` : undefined}
    >
      {loading && !usage ? <p className="op-agent-debug-empty-inline">加载中…</p> : null}
      {error ? <p className="op-agent-debug-error">{error}</p> : null}
      {usage ? (
        <p className="op-agent-debug-usage-totals">
          输入 {formatTokens(totals?.inputTokens ?? 0)} tokens · 输出 {formatTokens(totals?.outputTokens ?? 0)} tokens · {totals?.runs ?? 0} 次运行
        </p>
      ) : null}
      {!loading && !error && records.length === 0 ? (
        <p className="op-agent-debug-empty-inline">暂无使用记录。发起一次对话或派发一次子 Agent 调用后，这里会出现任务、状态、耗时与 token 用量。</p>
      ) : null}
      {records.length > 0 ? (
        <ul className="op-agent-debug-runs">
          {records.map((record) => (
            <li key={`${record.kind}:${record.id}`}>
              <div className="op-agent-debug-run-main">
                <span className="op-agent-debug-run-task">{record.task || '（无任务描述）'}</span>
                <span className="op-agent-debug-run-time">
                  {formatTime(record.startedAt)} · {formatDuration(record.startedAt, record.completedAt)}
                </span>
              </div>
              <div className="op-agent-debug-run-meta">
                <span className={`op-agent-debug-run-status is-${record.status}`}>
                  {ACTIVITY_STATUS[record.status] ?? record.status}
                </span>
                <span>{record.toolCalls} 次工具调用</span>
                {record.inputTokens !== null || record.outputTokens !== null ? (
                  <span>
                    {formatTokens(record.inputTokens)} in / {formatTokens(record.outputTokens)} out
                  </span>
                ) : null}
                {record.sessionTitle ? <span>{record.sessionTitle}</span> : null}
                {record.pageLabel ? <span>{record.pageLabel}</span> : null}
                {record.source ? <span>{SOURCE_LABELS[record.source] ?? record.source}</span> : null}
                {record.kind === 'invocation' ? <span>子 Agent 调用</span> : null}
              </div>
              {record.error ? <p className="op-agent-debug-error">{record.error}</p> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </Section>
  )
}

export function AgentDetailTab({
  detail,
  tab,
  usage,
  usageLoading,
  usageError,
}: {
  detail: AgentDebugAgentDetail
  tab: AgentDebugTab
  usage: AgentDebugUsageResponse | null
  usageLoading: boolean
  usageError: string | null
}) {
  if (tab === 'context') return <ContextTab detail={detail} />
  if (tab === 'tools') return <ToolsTab detail={detail} />
  if (tab === 'usage') return <UsageTab usage={usage} loading={usageLoading} error={usageError} />
  return <SystemTab detail={detail} />
}

export interface ConnectionDebugData {
  submissions: Array<Record<string, unknown>>
  events: Array<Record<string, unknown>>
}

function asText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

/** 外部 Agent 连接：连接信息 + 恢复旧调试面板（回写提交 / 最近调用）。 */
export function ExternalConnectionPanel({
  connection,
  debug,
  loading,
  error,
}: {
  connection: AgentConnectionDto
  debug: ConnectionDebugData | null
  loading: boolean
  error: string | null
}) {
  const statusLabels: Record<AgentConnectionDto['status'], string> = {
    active: '使用中',
    paused: '已暂停',
    revoked: '已吊销',
  }
  return (
    <>
      <Section title="连接信息">
        <KeyValue
          rows={[
            ['目标工具', connection.tool],
            ['状态', statusLabels[connection.status] ?? connection.status],
            ['Token 前缀', <code className="op-agent-debug-inline-code">{connection.tokenPrefix}</code>],
            ['最近调用', formatTime(connection.lastSeenAt)],
            ['创建时间', formatTime(connection.createdAt)],
          ]}
        />
      </Section>

      <Section title="访问范围">
        <KeyValue
          rows={[
            ['Room', connection.scopes.roomIds === 'all'
              ? '全部 Room'
              : connection.scopes.roomIds.join(', ') || '无'],
            ['回写位置', connection.scopes.writebackRoomId
              ? <code className="op-agent-debug-inline-code">{connection.scopes.writebackRoomId}</code>
              : '不回写'],
          ]}
        />
        <div className="op-agent-debug-chips">
          {connection.scopes.capabilities.map((capability) => (
            <span key={capability} className="is-on">{capability}</span>
          ))}
        </div>
      </Section>

      <Section title="调试数据" hint="恢复自旧 Agent 连接页 · 各取最近 10 条">
        {loading ? <p className="op-agent-debug-empty-inline">加载中…</p> : null}
        {error ? <p className="op-agent-debug-error">{error}</p> : null}
        {!loading && !error ? (
          <>
            <h4 className="op-agent-debug-subhead">回写提交</h4>
            {debug && debug.submissions.length > 0 ? (
              <ul className="op-agent-debug-debug-list">
                {debug.submissions.slice(0, 10).map((item, index) => (
                  <li key={index}>
                    <code>{asText(item.clientSubmissionId ?? item.submissionId ?? '—')}</code>
                    <span>{asText(item.status ?? '')}</span>
                    <small>{asText(item.duplicateCount ?? 0)} 次重放 · {formatTime(asText(item.createdAt))}</small>
                  </li>
                ))}
              </ul>
            ) : <p className="op-agent-debug-empty-inline">还没有回写提交</p>}

            <h4 className="op-agent-debug-subhead">最近调用</h4>
            {debug && debug.events.length > 0 ? (
              <ul className="op-agent-debug-debug-list">
                {debug.events.slice(0, 10).map((item, index) => (
                  <li key={index}>
                    <code>{asText(item.kind ?? '')}{item.tool ? ` · ${asText(item.tool)}` : ''}</code>
                    <span>{asText(item.status ?? '')}</span>
                    <small>{formatTime(asText(item.createdAt))}</small>
                  </li>
                ))}
              </ul>
            ) : <p className="op-agent-debug-empty-inline">还没有调用记录</p>}
          </>
        ) : null}
      </Section>
    </>
  )
}

/** 本地 Agent（Claude Code / Codex / OpenClaw）：发现结果只读展示。 */
export function LocalAgentPanel({ installation }: { installation: LocalAgentInstallation }) {
  const card = installation.card
  return (
    <>
      <Section title="安装与适配器">
        <KeyValue
          rows={[
            ['提供方', installation.provider],
            ['是否可调用', installation.callable ? '是' : '否'],
            ['是否支持调用', installation.invocationSupported ? '是' : '否'],
            ['可导入历史', installation.historyAvailable ? '是' : '否'],
            ['ACP 适配器', installation.acpAdapter
              ? (installation.acpAdapter.installed ? '已安装' : `未安装${installation.acpAdapter.installCommand ? ` · ${installation.acpAdapter.installCommand}` : ''}`)
              : '无需适配器'],
          ]}
        />
        {installation.error ? <p className="op-agent-debug-error">{installation.error}</p> : null}
      </Section>

      <Section title="能力">
        <div className="op-agent-debug-chips">
          <span className={card.capabilities.streaming ? 'is-on' : ''}>流式</span>
          <span className={card.capabilities.pushNotifications ? 'is-on' : ''}>推送通知</span>
          <span className={card.defaultInputModes.includes('text') ? 'is-on' : ''}>文本输入</span>
          <span className={card.defaultOutputModes.includes('text') ? 'is-on' : ''}>文本输出</span>
        </div>
      </Section>

      <Section title="Skills" hint={`${card.skills.length} 个`}>
        {card.skills.length === 0
          ? <p className="op-agent-debug-empty-inline">该 Agent 未声明 Skills</p>
          : (
            <ul className="op-agent-debug-tools">
              {card.skills.map((skill) => (
                <li key={skill.id}>
                  <code>{skill.name}</code>
                  <div>{skill.description ? <p>{skill.description}</p> : null}</div>
                </li>
              ))}
            </ul>
          )}
      </Section>
    </>
  )
}