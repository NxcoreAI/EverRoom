/**
 * FA 全阶段分析控制台。
 *
 * 左侧八站流水线（每站一个可独立测试的节点）；中间选中节点的三栏：
 * 输入（真实取数预填 + 可改写）→ 执行（调用真实接口/真实 agent run）→
 * 产出（原始 JSON + 结构化视图）。提示词节点的提示词、工具调用、解析链路
 * 从 agent-debug run trace 实时展示。全部数据来自本机 Gateway（真实 EverRoom 数据）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  loadSources,
  loadNodes,
  loadRooms,
  loadFacts,
  loadVerifiedFacts,
  loadFunds,
  loadInvestments,
  loadPositions,
  loadBpTemplate,
  runMatch,
  loadMeetingBrief,
  loadFeedbacks,
  listAgentSessions,
  createAgentSession,
  startAgentRun,
  loadSnapshot,
  loadRunEvents,
  type FaConsoleNode,
  type FaConsoleRoom,
  type FactItem,
  type FaFund,
  type FaInvestment,
  type FaPosition,
  type BpTemplateResult,
  type MatchCandidate,
  type MeetingBrief,
  type FeedbackRow,
  type AgentSession,
  type DebugRun,
  type DebugEvent,
} from './api'

const STAGE_LABELS: Record<string, string> = {
  intake: '01 进入 Room',
  verification: '02 核实事实',
  archive: '03 机构档案',
  materials: '04 制作材料',
  matching: '05 投资人匹配',
  meeting: '06 会前准备',
  feedback: '07 会后反馈',
  loopback: '08 知识回流',
}

const GRADE_LABELS: Record<string, string> = {
  fact: '事实',
  analysis: '分析',
  forecast: '预测',
  opinion: '观点',
  unknown: '未知',
}

interface RunTraceState {
  runId: string
  status: string
  events: DebugEvent[]
  toolCallCount: number
  latestSeq: number
  elapsedMs: number | null
  error: string | null
}

/** 从 run 事件流提取最终 assistant 文本（run 产物）。 */
function finalOutput(events: DebugEvent[]): string {
  let text = ''
  for (const event of events) {
    if (event.type !== 'message.completed') continue
    const payload = event.payload as { content?: unknown } | null
    const content = payload?.content
    if (typeof content === 'string' && content.trim()) text = content
    else if (Array.isArray(content)) {
      const joined = content
        .map((part) => (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : ''))
        .join('')
      if (joined.trim()) text = joined
    }
  }
  return text
}

function jsonView(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

export default function FaConsoleApp() {
  const [sources, setSources] = useState<{ id: string; label: string }[]>([])
  const [sourceId, setSourceId] = useState<string | null>(null)
  const [nodes, setNodes] = useState<FaConsoleNode[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [rooms, setRooms] = useState<FaConsoleRoom[]>([])
  const [error, setError] = useState<string | null>(null)
  const [booting, setBooting] = useState(true)

  useEffect(() => {
    void (async () => {
      try {
        const list = await loadSources()
        // 探测 fa-console 路由是否已部署（实时网关跑旧构建时没有 /v1/fa-console/*）：
        // 已部署来源全功能；未部署来源保留可选——提示词节点（agent run 通道）仍然可用，
        // 数据节点会报路由缺失，标签里明确标注。
        const probes = await Promise.all(list.map(async (source) => {
          if (!source.available) return { id: source.id, label: `${source.label}（离线）`, ready: false }
          try {
            await loadNodes(source.id)
            return { id: source.id, label: source.label, ready: true }
          } catch {
            return { id: source.id, label: `${source.label}（未部署 fa-console · 仅提示词节点可用）`, ready: false }
          }
        }))
        const ready = probes.filter((probe) => probe.ready)
        setSources(probes)
        if (ready.length > 0) setSourceId(ready[0]!.id)
        else if (probes.length > 0) setSourceId(probes[0]!.id)
        else setError('未发现可用的本机 Gateway（请先启动 EverRoom）')
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setBooting(false)
      }
    })()
  }, [])

  useEffect(() => {
    if (!sourceId) return
    void (async () => {
      try {
        const [nodeResult, roomResult] = await Promise.all([loadNodes(sourceId), loadRooms(sourceId)])
        setNodes(nodeResult.nodes)
        setRooms(roomResult.items)
        if (!selectedId && nodeResult.nodes.length > 0) setSelectedId(nodeResult.nodes[0]!.id)
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    })()
  }, [sourceId, selectedId])

  const selected = useMemo(() => nodes.find((node) => node.id === selectedId) ?? null, [nodes, selectedId])

  // 深链：?node=<id> 直选节点（书签/复测用）；&auto=1 数据节点自动执行一次。
  useEffect(() => {
    if (nodes.length === 0) return
    const params = new URLSearchParams(window.location.search)
    const wanted = params.get('node')
    if (wanted && nodes.some((node) => node.id === wanted)) setSelectedId(wanted)
  }, [nodes])

  const projectRooms = useMemo(() => rooms.filter((room) => room.kind === '项目'), [rooms])
  /** 项目侧节点下拉兜底：无项目 Room 时用全部 Room（真实库可能只有主题/人物房）。 */
  const projectScopeRooms = useMemo(
    () => projectRooms.length > 0 ? projectRooms : rooms,
    [projectRooms, rooms],
  )
  const institutionRooms = useMemo(() => rooms.filter((room) => room.kind === '机构'), [rooms])
  const personRooms = useMemo(() => rooms.filter((room) => room.kind === '人物'), [rooms])

  if (booting) return <div className="boot">正在发现本机 Gateway…</div>

  return (
    <div className="console">
      <header className="topbar">
        <strong>FA 全阶段分析控制台</strong>
        <span className="muted">{nodes.length} 个节点 · 数据源：本机 EverRoom（真实数据）</span>
        {sources.length > 1 && (
          <select value={sourceId ?? ''} onChange={(event) => setSourceId(event.target.value)}>
            {sources.map((source) => (
              <option key={source.id} value={source.id}>{source.label}</option>
            ))}
          </select>
        )}
        {error && <span className="error">{error}</span>}
      </header>
      <div className="body">
        <nav className="pipeline">
          {nodes.map((node) => (
            <button
              key={node.id}
              className={`node ${node.id === selectedId ? 'active' : ''}`}
              onClick={() => setSelectedId(node.id)}
            >
              <span className="stage">{STAGE_LABELS[node.stage] ?? node.stage}</span>
              <span className="name">{node.name}</span>
              <span className={`kind kind-${node.kind}`}>{node.kind === 'prompt' ? '提示词' : node.kind === 'template' ? '模板' : '数据'}</span>
            </button>
          ))}
        </nav>
        <main className="main">
          {selected && sourceId && (
            <NodePanel
              key={selected.id}
              node={selected}
              sourceId={sourceId}
              projectRooms={projectScopeRooms}
              institutionRooms={institutionRooms.length > 0 ? institutionRooms : rooms}
              personRooms={personRooms}
            />
          )}
        </main>
      </div>
    </div>
  )
}

function NodePanel(props: {
  node: FaConsoleNode
  sourceId: string
  projectRooms: FaConsoleRoom[]
  institutionRooms: FaConsoleRoom[]
  personRooms: FaConsoleRoom[]
}) {
  const { node, sourceId } = props
  return (
    <section className="panel">
      <h2>{node.name}</h2>
      <p className="desc">{node.description}</p>
      <div className="io-grid">
        <div>
          <h3>输入</h3>
          <ul>
            {node.inputs.map((io) => (
              <li key={io.label}><strong>{io.label}</strong><span>{io.detail}</span></li>
            ))}
          </ul>
        </div>
        <div>
          <h3>产出</h3>
          <ul>
            {node.outputs.map((io) => (
              <li key={io.label}><strong>{io.label}</strong><span>{io.detail}</span></li>
            ))}
          </ul>
        </div>
        <div>
          <h3>真实工具/接口</h3>
          <ul className="tools">
            {node.tools.map((tool) => <li key={tool}><code>{tool}</code></li>)}
          </ul>
        </div>
      </div>
      <Runner node={node} sourceId={sourceId} projectRooms={props.projectRooms} institutionRooms={props.institutionRooms} personRooms={props.personRooms} />
    </section>
  )
}

/** 节点执行区：按 kind 分派到对应的真实执行通道。 */
function Runner(props: {
  node: FaConsoleNode
  sourceId: string
  projectRooms: FaConsoleRoom[]
  institutionRooms: FaConsoleRoom[]
  personRooms: FaConsoleRoom[]
}) {
  const { node, sourceId } = props
  if (node.kind === 'prompt') return <PromptRunner sourceId={sourceId} node={node} projectRooms={props.projectRooms} />
  if (node.id === 'bp-template') return <TemplateRunner sourceId={sourceId} node={node} />
  if (node.id === 'intake' || node.id === 'loopback') return <FactsRunner sourceId={sourceId} label={node.name} />
  if (node.id === 'verification') return <VerifiedFactsRunner sourceId={sourceId} projectRooms={props.projectRooms} />
  if (node.id === 'archive') return <ArchiveRunner sourceId={sourceId} institutionRooms={props.institutionRooms} />
  if (node.id === 'matching') return <MatchRunner sourceId={sourceId} projectRooms={props.projectRooms} />
  if (node.id === 'meeting-brief') return <BriefRunner sourceId={sourceId} projectRooms={props.projectRooms} institutionRooms={props.institutionRooms} personRooms={props.personRooms} />
  if (node.id === 'feedback') return <FeedbackRunner sourceId={sourceId} projectRooms={props.projectRooms} />
  return <p className="muted">该节点经其余节点通道执行。</p>
}

function FactsRunner(props: { sourceId: string; label: string }) {
  const { sourceId } = props
  const [rooms, setRooms] = useState<FaConsoleRoom[]>([])
  const [roomId, setRoomId] = useState('')
  const [grade, setGrade] = useState('')
  const [items, setItems] = useState<FactItem[] | null>(null)
  const [raw, setRaw] = useState<string | null>(null)
  const [ms, setMs] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void loadRooms(sourceId).then((result) => {
      setRooms(result.items)
      if (result.items[0]) setRoomId(result.items[0].id)
    }).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
  }, [sourceId])

  const run = useCallback(async () => {
    if (!roomId) return
    setError(null)
    const started = performance.now()
    try {
      const result = await loadFacts(sourceId, roomId, grade || undefined)
      setItems(result.items)
      setRaw(jsonView(result))
      setMs(Math.round(performance.now() - started))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [sourceId, roomId, grade])

  return (
    <Exec
      inputs={(
        <>
          <label>Room <select value={roomId} onChange={(event) => setRoomId(event.target.value)}>
            {rooms.map((room) => <option key={room.id} value={room.id}>{room.kind} · {room.title}</option>)}
          </select></label>
          <label>分级 <select value={grade} onChange={(event) => setGrade(event.target.value)}>
            <option value="">全部五档</option>
            {Object.entries(GRADE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select></label>
          <button onClick={() => void run()}>执行取数</button>
          {ms !== null && <span className="ms">{ms} ms</span>}
        </>
      )}
      output={<FactTable items={items} />}
      raw={raw}
      error={error}
    />
  )
}

function VerifiedFactsRunner(props: { sourceId: string; projectRooms: FaConsoleRoom[] }) {
  const { sourceId, projectRooms } = props
  const [roomId, setRoomId] = useState('')
  const [items, setItems] = useState<FactItem[] | null>(null)
  const [raw, setRaw] = useState<string | null>(null)
  const [ms, setMs] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!roomId && projectRooms[0]) setRoomId(projectRooms[0].id)
  }, [projectRooms, roomId])

  const run = useCallback(async () => {
    if (!roomId) return
    setError(null)
    const started = performance.now()
    try {
      const result = await loadVerifiedFacts(sourceId, roomId)
      setItems(result.items)
      setRaw(jsonView(result))
      setMs(Math.round(performance.now() - started))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [sourceId, roomId])

  return (
    <Exec
      inputs={(
        <>
          <label>项目 Room <select value={roomId} onChange={(event) => setRoomId(event.target.value)}>
            {projectRooms.map((room) => <option key={room.id} value={room.id}>{room.title}</option>)}
          </select></label>
          <button onClick={() => void run()}>取已核事实（fact）</button>
          {ms !== null && <span className="ms">{ms} ms</span>}
        </>
      )}
      output={<FactTable items={items} />}
      raw={raw}
      error={error}
    />
  )
}

function FactTable(props: { items: FactItem[] | null }) {
  const { items } = props
  if (!items) return null
  if (items.length === 0) return <p className="muted">0 条（该 Room 暂无此分级事实）</p>
  return (
    <table>
      <thead><tr><th>内容</th><th>分级</th><th>数字口径</th><th>来源</th></tr></thead>
      <tbody>
        {items.map((item) => (
          <tr key={item.id}>
            <td>{item.content}</td>
            <td><span className={`grade grade-${item.grade}`}>{GRADE_LABELS[item.grade] ?? item.grade}</span></td>
            <td>{item.numeric ? [item.numeric.value, item.numeric.unit, item.numeric.period].filter(Boolean).join(' ') : ''}</td>
            <td><code>{item.sourceKind}/{item.sourceId.slice(0, 12)}</code></td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function ArchiveRunner(props: { sourceId: string; institutionRooms: FaConsoleRoom[] }) {
  const { sourceId, institutionRooms } = props
  const [roomId, setRoomId] = useState('')
  const [funds, setFunds] = useState<FaFund[] | null>(null)
  const [investments, setInvestments] = useState<FaInvestment[] | null>(null)
  const [positions, setPositions] = useState<FaPosition[] | null>(null)
  const [raw, setRaw] = useState<string | null>(null)
  const [ms, setMs] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!roomId && institutionRooms[0]) setRoomId(institutionRooms[0].id)
  }, [institutionRooms, roomId])

  const run = useCallback(async () => {
    if (!roomId) return
    setError(null)
    const started = performance.now()
    try {
      const [fundResult, investmentResult, positionResult] = await Promise.all([
        loadFunds(sourceId, roomId),
        loadInvestments(sourceId, roomId),
        loadPositions(sourceId, roomId),
      ])
      setFunds(fundResult.items)
      setInvestments(investmentResult.items)
      setPositions(positionResult.items)
      setRaw(jsonView({ funds: fundResult, investments: investmentResult, positions: positionResult }))
      setMs(Math.round(performance.now() - started))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [sourceId, roomId])

  return (
    <Exec
      inputs={(
        <>
          <label>机构 Room <select value={roomId} onChange={(event) => setRoomId(event.target.value)}>
            {institutionRooms.map((room) => <option key={room.id} value={room.id}>{room.title}</option>)}
          </select></label>
          <button onClick={() => void run()}>读三表</button>
          {ms !== null && <span className="ms">{ms} ms</span>}
        </>
      )}
      output={(
        <>
          {funds && <div><h4>基金（{funds.length}）</h4><table><thead><tr><th>名称</th><th>状态</th><th>投资期止</th><th>确认人</th></tr></thead><tbody>
            {funds.map((fund) => <tr key={fund.id}><td>{fund.name}</td><td>{fund.status}</td><td>{fund.investmentPeriodEnd ?? ''}</td><td>{fund.confirmedBy ?? '未确认'}</td></tr>)}
          </tbody></table></div>}
          {investments && <div><h4>投资记录（{investments.length}）</h4><table><thead><tr><th>公司</th><th>轮次</th><th>角色</th><th>组合关系</th><th>确认人</th></tr></thead><tbody>
            {investments.map((investment) => <tr key={investment.id}><td>{investment.portfolioCompany}</td><td>{investment.round ?? ''}</td><td>{investment.role}</td><td>{investment.relationToPortfolio}</td><td>{investment.confirmedBy ?? '未确认'}</td></tr>)}
          </tbody></table></div>}
          {positions && <div><h4>关键任职（{positions.length}）</h4><table><thead><tr><th>人物</th><th>头衔</th><th>投委会</th><th>可领投</th><th>赛道</th></tr></thead><tbody>
            {positions.map((position) => <tr key={position.id}><td><code>{position.personRoomId.slice(0, 16)}</code></td><td>{position.title ?? ''}</td><td>{position.icMember === null ? '' : position.icMember ? '是' : '否'}</td><td>{position.canLead === null ? '' : position.canLead ? '是' : '否'}</td><td>{(position.sectors ?? []).join('、')}</td></tr>)}
          </tbody></table></div>}
        </>
      )}
      raw={raw}
      error={error}
    />
  )
}

function TemplateRunner(props: { sourceId: string; node: FaConsoleNode }) {
  const { sourceId, node } = props
  const options = node.execute?.paramOptions ?? {}
  const [trackId, setTrackId] = useState('T01')
  const [stage, setStage] = useState('early')
  const [narrative, setNarrative] = useState('')
  const [x01, setX01] = useState(false)
  const [addons, setAddons] = useState<string[]>([])
  const [result, setResult] = useState<BpTemplateResult | null>(null)
  const [ms, setMs] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  const run = useCallback(async () => {
    setError(null)
    const started = performance.now()
    try {
      const outcome = await loadBpTemplate(sourceId, {
        trackId,
        stage,
        ...(narrative !== '' ? { narrativeOrderIndex: Number(narrative) } : {}),
        ...(x01 ? { includeX01: true } : {}),
        ...(addons.length > 0 ? { addonIds: addons } : {}),
      })
      setResult(outcome)
      setMs(Math.round(performance.now() - started))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [sourceId, trackId, stage, narrative, x01, addons])

  return (
    <Exec
      inputs={(
        <>
          <label>赛道 <select value={trackId} onChange={(event) => setTrackId(event.target.value)}>
            {(options.trackId ?? []).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select></label>
          <label>阶段 <select value={stage} onChange={(event) => setStage(event.target.value)}>
            {(options.stage ?? []).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select></label>
          <label>讲述顺序 <select value={narrative} onChange={(event) => setNarrative(event.target.value)}>
            <option value="">缺省（赛道顺序）</option>
            {(options.narrativeOrderIndex ?? []).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select></label>
          <label className="check"><input type="checkbox" checked={x01} onChange={(event) => setX01(event.target.checked)} /> 叠加 X01 资产运营</label>
          <label>专项 {addons.length > 0 && <code>{addons.join(',')}</code>}
            <select value="" onChange={(event) => {
              if (event.target.value && !addons.includes(event.target.value)) setAddons([...addons, event.target.value])
            }}>
              <option value="">＋添加…</option>
              {(options.addonIds ?? []).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
            {addons.length > 0 && <button className="mini" onClick={() => setAddons([])}>清空</button>}
          </label>
          <button onClick={() => void run()}>渲染模板</button>
          {ms !== null && <span className="ms">{ms} ms</span>}
        </>
      )}
      output={result ? (result.ok
        ? <pre className="brief">{result.brief}</pre>
        : <p className="error">{result.error}</p>) : null}
      raw={result ? jsonView(result) : null}
      error={error}
    />
  )
}

function MatchRunner(props: { sourceId: string; projectRooms: FaConsoleRoom[] }) {
  const { sourceId, projectRooms } = props
  const [projectRoomId, setProjectRoomId] = useState('')
  const [round, setRound] = useState('A')
  const [comparables, setComparables] = useState('')
  const [items, setItems] = useState<MatchCandidate[] | null>(null)
  const [raw, setRaw] = useState<string | null>(null)
  const [ms, setMs] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!projectRoomId && projectRooms[0]) setProjectRoomId(projectRooms[0].id)
  }, [projectRooms, projectRoomId])

  const run = useCallback(async () => {
    if (!projectRoomId) return
    setError(null)
    const started = performance.now()
    try {
      const result = await runMatch(sourceId, {
        projectRoomId,
        ...(round.trim() ? { round: round.trim() } : {}),
        ...(comparables.trim()
          ? { comparableCompanies: comparables.split(/[，,]/).map((entry) => entry.trim()).filter(Boolean) }
          : {}),
      })
      setItems(result.items)
      setRaw(jsonView(result))
      setMs(Math.round(performance.now() - started))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [sourceId, projectRoomId, round, comparables])

  return (
    <Exec
      inputs={(
        <>
          <label>项目 Room <select value={projectRoomId} onChange={(event) => setProjectRoomId(event.target.value)}>
            {projectRooms.map((room) => <option key={room.id} value={room.id}>{room.title}</option>)}
          </select></label>
          <label>轮次 <input value={round} onChange={(event) => setRound(event.target.value)} /></label>
          <label>可比公司（逗号分隔）<input value={comparables} onChange={(event) => setComparables(event.target.value)} placeholder="如：可比AI公司，冲突公司" /></label>
          <button onClick={() => void run()}>执行匹配</button>
          {ms !== null && <span className="ms">{ms} ms</span>}
        </>
      )}
      output={items ? (
        items.length === 0 ? <p className="muted">0 家候选（无机构 Room 档案）</p> : (
          <table>
            <thead><tr><th>机构</th><th>硬筛</th><th>适配分</th><th>评分依据</th><th>组合解释</th></tr></thead>
            <tbody>
              {items.map((candidate) => (
                <tr key={candidate.institutionRoomId}>
                  <td>{candidate.institutionTitle}</td>
                  <td>{candidate.passed ? '✓ 通过' : `✗ ${candidate.reasons.join('；')}`}{candidate.unknowns.length > 0 && <em className="muted"> unknown: {candidate.unknowns.join('；')}</em>}</td>
                  <td>{candidate.passed ? candidate.fitScore : ''}</td>
                  <td>{candidate.scoreBreakdown.map((entry) => `${entry.factor} ${entry.points}`).join(' · ')}</td>
                  <td>{candidate.portfolioNotes.map((note) => `${note.company}(${note.interpretation === 'conflict' ? '冲突' : '认知'})`).join('、')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      ) : null}
      raw={raw}
      error={error}
    />
  )
}

function BriefRunner(props: {
  sourceId: string
  projectRooms: FaConsoleRoom[]
  institutionRooms: FaConsoleRoom[]
  personRooms: FaConsoleRoom[]
}) {
  const { sourceId, projectRooms, institutionRooms, personRooms } = props
  const [projectRoomId, setProjectRoomId] = useState('')
  const [institutionRoomId, setInstitutionRoomId] = useState('')
  const [personRoomId, setPersonRoomId] = useState('')
  const [brief, setBrief] = useState<MeetingBrief | null>(null)
  const [ms, setMs] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!projectRoomId && projectRooms[0]) setProjectRoomId(projectRooms[0].id)
    if (!institutionRoomId && institutionRooms[0]) setInstitutionRoomId(institutionRooms[0].id)
  }, [projectRooms, institutionRooms, projectRoomId, institutionRoomId])

  const run = useCallback(async () => {
    if (!projectRoomId || !institutionRoomId) return
    setError(null)
    const started = performance.now()
    try {
      const result = await loadMeetingBrief(sourceId, {
        projectRoomId,
        institutionRoomId,
        ...(personRoomId ? { personRoomId } : {}),
      })
      setBrief(result)
      setMs(Math.round(performance.now() - started))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [sourceId, projectRoomId, institutionRoomId, personRoomId])

  return (
    <Exec
      inputs={(
        <>
          <label>项目 Room <select value={projectRoomId} onChange={(event) => setProjectRoomId(event.target.value)}>
            {projectRooms.map((room) => <option key={room.id} value={room.id}>{room.title}</option>)}
          </select></label>
          <label>机构 Room <select value={institutionRoomId} onChange={(event) => setInstitutionRoomId(event.target.value)}>
            {institutionRooms.map((room) => <option key={room.id} value={room.id}>{room.title}</option>)}
          </select></label>
          <label>人物 Room（可选）<select value={personRoomId} onChange={(event) => setPersonRoomId(event.target.value)}>
            <option value="">不指定</option>
            {personRooms.map((room) => <option key={room.id} value={room.id}>{room.title}</option>)}
          </select></label>
          <button onClick={() => void run()}>聚合简报</button>
          {ms !== null && <span className="ms">{ms} ms</span>}
        </>
      )}
      output={brief ? (
        <div className="brief-blocks">
          <div><h4>{brief.institution.title} · 基金（{brief.funds.length}）</h4>
            <ul>{brief.funds.map((fund, index) => <li key={index}>{fund.name} · {fund.status} · 投资期止 {fund.investmentPeriodEnd ?? '未知'}</li>)}</ul></div>
          <div><h4>相关投资（{brief.relevantInvestments.length}）</h4>
            <ul>{brief.relevantInvestments.map((investment, index) => <li key={index}>{investment.portfolioCompany} · {investment.round ?? ''} · {investment.role} · {investment.relationToPortfolio}</li>)}</ul></div>
          <div><h4>历史反馈（{brief.pastFeedbacks.length}）</h4>
            <ul>{brief.pastFeedbacks.map((feedback, index) => <li key={index}>{feedback.disposition} · {feedback.status}{feedback.reopenConditions ? ` · 重启条件：${feedback.reopenConditions}` : ''}</li>)}</ul></div>
          <div><h4>未兑现重启条件（{brief.pendingReopenConditions.length}）</h4>
            <ul>{brief.pendingReopenConditions.map((condition, index) => <li key={index}>{condition}</li>)}</ul></div>
          <div><h4>项目已核事实（{brief.verifiedProjectFacts.length}）</h4>
            <ul>{brief.verifiedProjectFacts.map((fact, index) => <li key={index}>{fact}</li>)}</ul></div>
        </div>
      ) : null}
      raw={brief ? jsonView(brief) : null}
      error={error}
    />
  )
}

function FeedbackRunner(props: { sourceId: string; projectRooms: FaConsoleRoom[] }) {
  const { sourceId, projectRooms } = props
  const [roomId, setRoomId] = useState('')
  const [status, setStatus] = useState('')
  const [items, setItems] = useState<FeedbackRow[] | null>(null)
  const [ms, setMs] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!roomId && projectRooms[0]) setRoomId(projectRooms[0].id)
  }, [projectRooms, roomId])

  const run = useCallback(async () => {
    setError(null)
    const started = performance.now()
    try {
      const result = await loadFeedbacks(sourceId, {
        ...(roomId ? { roomId } : {}),
        ...(status ? { status } : {}),
      })
      setItems(result.items)
      setMs(Math.round(performance.now() - started))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [sourceId, roomId, status])

  return (
    <Exec
      inputs={(
        <>
          <label>项目 Room <select value={roomId} onChange={(event) => setRoomId(event.target.value)}>
            <option value="">全部项目</option>
            {projectRooms.map((room) => <option key={room.id} value={room.id}>{room.title}</option>)}
          </select></label>
          <label>状态 <select value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="">全部</option>
            <option value="draft">draft</option>
            <option value="confirmed">confirmed</option>
            <option value="dismissed">dismissed</option>
          </select></label>
          <button onClick={() => void run()}>读反馈</button>
          {ms !== null && <span className="ms">{ms} ms</span>}
        </>
      )}
      output={items ? (
        items.length === 0 ? <p className="muted">0 条反馈</p> : (
          <table>
            <thead><tr><th>处置</th><th>状态</th><th>原因码</th><th>重启条件</th><th>项目进展</th></tr></thead>
            <tbody>
              {items.map((feedback) => (
                <tr key={feedback.id}>
                  <td>{feedback.disposition}</td>
                  <td>{feedback.status}</td>
                  <td>{(feedback.passReasons ?? []).join('、')}</td>
                  <td>{feedback.reopenConditions ?? ''}</td>
                  <td>{feedback.projectUpdates?.slice(0, 80) ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      ) : null}
      raw={items ? jsonView({ items }) : null}
      error={error}
    />
  )
}

/** 提示词节点：真实 agent run（POST /v1/agent/sessions/:id/runs）+ agent-debug trace 展示。 */
function PromptRunner(props: { sourceId: string; node: FaConsoleNode; projectRooms: FaConsoleRoom[] }) {
  const { sourceId, node, projectRooms } = props
  const [sessions, setSessions] = useState<AgentSession[]>([])
  const [sessionId, setSessionId] = useState('')
  const [roomId, setRoomId] = useState('')
  const [facts, setFacts] = useState<FactItem[]>([])
  const [prompt, setPrompt] = useState('')
  const [runId, setRunId] = useState<string | null>(null)
  const [trace, setTrace] = useState<RunTraceState | null>(null)
  const [output, setOutput] = useState('')
  const [ms, setMs] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const startedAtRef = useRef<number | null>(null)
  const pollRef = useRef<number | null>(null)

  useEffect(() => {
    void (async () => {
      try {
        const list = await listAgentSessions(sourceId)
        setSessions(list.slice(0, 30))
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    })()
  }, [sourceId])

  useEffect(() => {
    if (!roomId && projectRooms[0]) setRoomId(projectRooms[0].id)
  }, [projectRooms, roomId])

  const loadFactsForRoom = useCallback(async () => {
    if (!roomId) return
    try {
      const result = await loadVerifiedFacts(sourceId, roomId)
      setFacts(result.items)
    } catch {
      setFacts([])
    }
  }, [sourceId, roomId])

  useEffect(() => { void loadFactsForRoom() }, [loadFactsForRoom])

  const stopPolling = useCallback(() => {
    if (pollRef.current !== null) {
      window.clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [])

  useEffect(() => stopPolling, [stopPolling])

  const traceRun = useCallback(async (targetRunId: string) => {
    try {
      const page = await loadRunEvents(sourceId, targetRunId, trace?.latestSeq ?? 0)
      setTrace((previous) => {
        const merged = mergeEvents(previous?.events ?? [], page.events)
        const toolCalls = merged.filter((event) => event.type === 'tool.started').length
        return {
          runId: targetRunId,
          status: page.run.status,
          events: merged,
          toolCallCount: toolCalls,
          latestSeq: page.latestSeq,
          elapsedMs: startedAtRef.current !== null && page.run.completedAt
            ? Math.round(Date.parse(page.run.completedAt) - startedAtRef.current)
            : null,
          error: page.run.errorMessage,
        }
      })
      const text = finalOutput(page.events)
      if (text) setOutput(text)
      if (page.run.status !== 'running' && page.run.status !== 'accepted') {
        setBusy(false)
        stopPolling()
        if (startedAtRef.current !== null) setMs(Math.round(Date.now() - startedAtRef.current))
      }
    } catch (cause) {
      // run 刚提交时 trace 可能还没建好；下一轮重试。
      if (!`${cause}`.includes('404')) setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [sourceId, trace?.latestSeq, stopPolling])

  const submit = useCallback(async () => {
    if (!prompt.trim()) return
    setError(null)
    setBusy(true)
    setOutput('')
    setTrace(null)
    startedAtRef.current = Date.now()
    try {
      let id = sessionId
      if (!id) {
        const created = await createAgentSession(sourceId, 'FA 分析控制台')
        id = created.id
        setSessions((previous) => [created, ...previous])
        setSessionId(created.id)
      }
      const run = await startAgentRun(sourceId, id, prompt.trim(), `fa-console-${Date.now()}`)
      setRunId(run.id)
      stopPolling()
      pollRef.current = window.setInterval(() => void traceRun(run.id), 700)
      void traceRun(run.id)
    } catch (cause) {
      setBusy(false)
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [prompt, sessionId, sourceId, traceRun, stopPolling])

  return (
    <div className="runner">
      <div className="inputs">
        <label>会话 <select value={sessionId} onChange={(event) => setSessionId(event.target.value)}>
          <option value="">新建「FA 分析控制台」会话</option>
          {sessions.map((session) => (
            <option key={session.id} value={session.id}>{session.title ?? session.id} · {session.status}</option>
          ))}
        </select></label>
        <label>项目 Room（取已核事实作输入底稿）<select value={roomId} onChange={(event) => setRoomId(event.target.value)}>
          {projectRooms.map((room) => <option key={room.id} value={room.id}>{room.title}</option>)}
        </select></label>
        <div className="fact-chips">
          {facts.slice(0, 8).map((fact) => <span key={fact.id} className={`chip grade-${fact.grade}`} title={`${fact.content}（来源 ${fact.sourceKind}/${fact.sourceId.slice(0, 12)}）`}>{fact.content.slice(0, 40)}</span>)}
          {facts.length > 8 && <span className="muted">+{facts.length - 8} 条</span>}
        </div>
        <label>提示词（可自选输入）<textarea
          value={prompt}
          rows={5}
          placeholder={`示例：基于本项目已核事实（${projectRooms.find((room) => room.id === roomId)?.title ?? '项目'}），生成投资方尽调（DD）清单，按业务/财务/法律分组，每项注明所需证据与优先级。`}
          onChange={(event) => setPrompt(event.target.value)}
        /></label>
        <div className="actions">
          <button onClick={() => void submit()} disabled={busy || !prompt.trim()}>{busy ? 'run 进行中…' : '发起真实 run'}</button>
          {runId && <code className="run-id">run {runId.slice(0, 12)}</code>}
          {trace && <span>工具调用 {trace.toolCallCount} 次</span>}
          {trace?.elapsedMs !== null && trace?.elapsedMs != null && <span className="ms">{trace.elapsedMs} ms</span>}
          {ms !== null && !busy && <span className="ms">{ms} ms（含轮询）</span>}
        </div>
        {error && <p className="error">{error}</p>}
      </div>
      {trace && (
        <div className="trace">
          <h3>Run Trace（agent-debug 实时）· {trace.status}{trace.error ? ` · ${trace.error}` : ''}</h3>
          <ul className="events">
            {trace.events.map((event) => {
              if (event.type === 'message.delta' || event.type === 'reasoning.delta') return null
              const payload = event.payload as Record<string, unknown> | null
              return (
                <li key={event.seq} className={`event event-${event.type}`}>
                  <span className="seq">#{event.seq}</span>
                  <span className="type">{event.type}</span>
                  {event.type === 'tool.started' && (
                    <code>{String(payload?.name ?? '')} {summarizeArgs(payload?.args)}</code>
                  )}
                  {event.type === 'tool.completed' && <code>{String(payload?.name ?? '')} ✓</code>}
                  {event.type === 'tool.failed' && <code>{String(payload?.name ?? '')} ✗</code>}
                  {event.type === 'run.accepted' && <span>{String((payload as { prompt?: unknown })?.prompt ?? '').slice(0, 120)}</span>}
                  {event.type === 'run.failed' && <span className="error">{String(payload ?? '')}</span>}
                </li>
              )
            })}
          </ul>
        </div>
      )}
      {output && (
        <div className="output">
          <h3>Run 产物（最终回复原文）</h3>
          <pre className="brief">{output}</pre>
        </div>
      )}
    </div>
  )
}

function summarizeArgs(args: unknown): string {
  if (!args || typeof args !== 'object') return ''
  const entries = Object.entries(args as Record<string, unknown>)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .slice(0, 3)
    .map(([key, value]) => {
      const text = typeof value === 'string' ? value : JSON.stringify(value)
      return `${key}=${text.length > 40 ? `${text.slice(0, 40)}…` : text}`
    })
  return entries.join(' ')
}

function mergeEvents(previous: DebugEvent[], incoming: DebugEvent[]): DebugEvent[] {
  const bySeq = new Map<number, DebugEvent>()
  for (const event of previous) bySeq.set(event.seq, event)
  for (const event of incoming) bySeq.set(event.seq, event)
  return [...bySeq.values()].sort((left, right) => left.seq - right.seq)
}

/** 执行区通用布局：输入行 + 产出区 + 原始 JSON 折叠。 */
function Exec(props: {
  inputs: React.ReactNode
  output: React.ReactNode
  raw: string | null
  error: string | null
}) {
  const [showRaw, setShowRaw] = useState(false)
  return (
    <div className="runner">
      <div className="inputs">
        <h3>输入（真实取数）</h3>
        <div className="input-row">{props.inputs}</div>
        {props.error && <p className="error">{props.error}</p>}
      </div>
      {props.output && (
        <div className="output">
          <h3>产出（真实数据）{props.raw && <button className="mini" onClick={() => setShowRaw(!showRaw)}>{showRaw ? '收起原始 JSON' : '查看原始 JSON'}</button>}</h3>
          {props.output}
          {showRaw && props.raw && <pre className="brief">{props.raw}</pre>}
        </div>
      )}
    </div>
  )
}
