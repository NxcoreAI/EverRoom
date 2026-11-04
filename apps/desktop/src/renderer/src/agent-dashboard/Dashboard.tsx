/**
 * 看板外壳：顶栏（来源/范围/计价）→ run 轨道 → 读数条 → 执行带 → 分页标签 → 面板。
 * 状态很少且彼此独立：回放光标、下钻步骤、活动标签、计价偏好。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { formatMonthDayTime, formatOffset } from './insight/format'
import { DEFAULT_PRICE_ID, findPrice, type Currency } from './insight/pricing'
import { useDashboardData } from './state/useDashboardData'
import { AnomalyList } from './components/AnomalyList'
import { ContextPanel } from './components/ContextPanel'
import { DrillDownDrawer } from './components/DrillDownDrawer'
import { GanttLanes } from './components/GanttLanes'
import { HeaderBar, type ConnectionState } from './components/HeaderBar'
import { KpiStrip } from './components/KpiStrip'
import { RagPanel } from './components/RagPanel'
import { ReplayStrip } from './components/ReplayStrip'
import { RunRail } from './components/RunRail'
import { TimeBreakdownPanel } from './components/TimeBreakdownPanel'
import { TokenCostPanel } from './components/TokenCostPanel'
import { ToolPanel } from './components/ToolPanel'
import { TopologyGraph } from './components/TopologyGraph'

import './styles/base.css'
import './styles/dashboard.css'

type TabId = 'overview' | 'time' | 'cost' | 'context' | 'tools'

const TABS: ReadonlyArray<{ id: TabId; label: string; hint: string }> = [
  { id: 'overview', label: '概览', hint: '慢在哪：时间瀑布 + 异常' },
  { id: 'time', label: '时间', hint: '执行流拓扑 + 时间构成' },
  { id: 'cost', label: '成本', hint: 'Token 与估算花费' },
  { id: 'context', label: '上下文', hint: '占用、记忆与压缩' },
  { id: 'tools', label: '工具', hint: '调用全景 + 检索召回' },
]

const PRICE_KEY = 'nxcore.agent-dashboard.price'
const CURRENCY_KEY = 'nxcore.agent-dashboard.currency'

/** 深链参数：`?tab=cost&run=<runId>&step=<stepId>`，方便把某次复盘直接发给别人。 */
function initialTab(): TabId {
  const raw = new URLSearchParams(window.location.search).get('tab')
  return TABS.some((item) => item.id === raw) ? (raw as TabId) : 'overview'
}

function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

export function Dashboard() {
  const [priceId, setPriceId] = useState<string>(() => readStored(PRICE_KEY) ?? DEFAULT_PRICE_ID)
  const [currency, setCurrency] = useState<Currency>(() => (readStored(CURRENCY_KEY) === 'CNY' ? 'CNY' : 'USD'))
  const deepLink = useMemo(() => new URLSearchParams(window.location.search), [])
  const [tab, setTab] = useState<TabId>(initialTab)
  const [cursorMs, setCursorMs] = useState<number | null>(() => {
    const raw = deepLink.get('cursor')
    const value = raw === null ? Number.NaN : Number(raw)
    return Number.isFinite(value) && value >= 0 ? value : null
  })
  const [selectedStepId, setSelectedStepId] = useState<string | null>(() => deepLink.get('step'))

  const price = useMemo(() => findPrice(priceId), [priceId])
  const data = useDashboardData(price)
  const { insight, source, sources, sourceId, range } = data

  useEffect(() => {
    try {
      window.localStorage.setItem(PRICE_KEY, priceId)
      window.localStorage.setItem(CURRENCY_KEY, currency)
    } catch {
      // 隐私模式下 localStorage 不可用：偏好只在本次会话生效。
    }
  }, [priceId, currency])

  // 深链 `?run=`：快照到达后只应用一次，之后仍按用户点击切换。
  const deepLinkApplied = useRef(false)
  const deepLinkRunRef = useRef<string | null>(null)
  const [deepLinkMiss, setDeepLinkMiss] = useState<string | null>(null)
  useEffect(() => {
    if (deepLinkApplied.current || data.runs.length === 0) return
    deepLinkApplied.current = true
    const wanted = deepLink.get('run')
    if (!wanted) return
    if (data.runs.some((run) => run.runId === wanted)) {
      // 这次选择来自深链：不要被「切 run 清空回放/下钻」的逻辑冲掉 `?step=` / `?cursor=`。
      deepLinkRunRef.current = wanted
      data.selectRun(wanted)
      return
    }
    // 快照只带最近 150/300 条 run，更早的 run 不在窗口里：如实说明，而不是静默落到别的 run。
    setDeepLinkMiss(wanted)
  }, [data, deepLink])

  const runSettledRef = useRef(false)

  // 切 run 时清掉回放光标与下钻，避免读到上一条 run 的坐标；
  // 首次落到 run 上时保留深链里的 `?step=` / `?cursor=`。
  useEffect(() => {
    if (!data.selectedRunId) return
    if (!runSettledRef.current) {
      runSettledRef.current = true
      return
    }
    if (deepLinkRunRef.current === data.selectedRunId) {
      deepLinkRunRef.current = null
      return
    }
    setCursorMs(null)
    setSelectedStepId(null)
  }, [data.selectedRunId])

  useEffect(() => {
    if (!selectedStepId) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setSelectedStepId(null)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [selectedStepId])

  const selectStep = useCallback((stepId: string | null) => setSelectedStepId(stepId), [])

  const connection = useMemo((): { state: ConnectionState; label: string; title: string } => {
    if (!source) {
      return { state: 'pending', label: '未发现来源', title: '未发现 Gateway manifest 或本机归档；请确认 EverRoom 已启动一次' }
    }
    if (source.backend === 'archive') {
      return {
        state: 'readonly',
        label: `${source.runCount} 条历史`,
        title: source.archiveDir ?? '直接读取本机归档，无需 EverRoom 运行',
      }
    }
    if (!source.available) {
      return { state: 'error', label: 'Gateway 离线', title: `manifest 指向 ${source.baseUrl}，但进程已退出` }
    }
    if (data.runsState === 'error') {
      return { state: 'error', label: '拉取失败', title: data.runsError ?? '未知错误' }
    }
    return { state: 'live', label: `在线 · v${source.version || '?'}`, title: `代理目标 ${source.baseUrl}` }
  }, [source, data.runsState, data.runsError])

  const run = data.selectedRun

  return (
    <div className="db-shell">
      <HeaderBar
        sources={sources}
        sourceId={sourceId}
        source={source}
        onSelectSource={data.selectSource}
        range={range}
        onRange={data.setRange}
        priceId={priceId}
        onPriceId={setPriceId}
        currency={currency}
        onCurrency={setCurrency}
        connection={connection}
        lastSyncedAt={data.lastSyncedAt}
        onRefresh={data.refresh}
        warning={data.sourcesWarning}
      />

      <div className="db-body">
        <RunRail
          runs={data.runs}
          selectedRunId={data.selectedRunId}
          onSelect={data.selectRun}
          state={data.runsState}
          error={data.runsError}
          range={range}
        />

        <main className="db-main">
          {run && insight ? (
            <>
              <div className="db-runbar">
                <span className="db-runbar-agent">{run.agentName || run.agentId}</span>
                <span className="db-runbar-task" title={run.task}>{run.task || '（无任务描述）'}</span>
                <span className="db-runbar-meta">
                  {run.sessionTitle && <span className="db-runbar-session">{run.sessionTitle}</span>}
                  <span className="num">{formatMonthDayTime(run.startedAt)}</span>
                  <span className="db-runbar-origin">{run.origin === 'archive' ? '历史归档' : '本次'}</span>
                  {data.eventsLive && <span className="db-runbar-live">跟进中</span>}
                </span>
              </div>

              <KpiStrip insight={insight} currency={currency} />

              <ReplayStrip insight={insight} cursorMs={cursorMs} onCursor={setCursorMs} />

              <nav className="db-tabs" aria-label="维度">
                {TABS.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={item.id === tab ? 'db-tab is-on' : 'db-tab'}
                    onClick={() => setTab(item.id)}
                    title={item.hint}
                  >
                    {item.label}
                  </button>
                ))}
                <span className="db-tabs-hint">
                  {data.eventsState === 'loading' ? '正在拉取事件…' : `${data.events.length} 条事件`}
                  {cursorMs !== null ? ` · 回放至 ${formatOffset(cursorMs)}` : ''}
                </span>
              </nav>

              <div className="db-panel-area">
                <div className="db-panel-scroll">
                  {tab === 'overview' && (
                    <>
                      <GanttLanes
                        insight={insight}
                        cursorMs={cursorMs}
                        selectedStepId={selectedStepId}
                        onSelectStep={selectStep}
                        currency={currency}
                      />
                      <AnomalyList insight={insight} selectedStepId={selectedStepId} onSelectStep={selectStep} />
                    </>
                  )}

                  {tab === 'time' && (
                    <>
                      <TopologyGraph
                        insight={insight}
                        cursorMs={cursorMs}
                        selectedStepId={selectedStepId}
                        onSelectStep={selectStep}
                        currency={currency}
                      />
                      <TimeBreakdownPanel
                        insight={insight}
                        cursorMs={cursorMs}
                        selectedStepId={selectedStepId}
                        onSelectStep={selectStep}
                        currency={currency}
                      />
                    </>
                  )}

                  {tab === 'cost' && (
                    <TokenCostPanel
                      insight={insight}
                      cursorMs={cursorMs}
                      selectedStepId={selectedStepId}
                      onSelectStep={selectStep}
                      currency={currency}
                    />
                  )}

                  {tab === 'context' && (
                    <ContextPanel
                      insight={insight}
                      cursorMs={cursorMs}
                      selectedStepId={selectedStepId}
                      onSelectStep={selectStep}
                    />
                  )}

                  {tab === 'tools' && (
                    <>
                      <ToolPanel
                        insight={insight}
                        cursorMs={cursorMs}
                        selectedStepId={selectedStepId}
                        onSelectStep={selectStep}
                      />
                      <RagPanel
                        insight={insight}
                        cursorMs={cursorMs}
                        selectedStepId={selectedStepId}
                        onSelectStep={selectStep}
                      />
                    </>
                  )}
                </div>
              </div>
            </>
          ) : (
            <div className="db-empty">
              <span className="db-empty-title">{data.runsState === 'loading' ? '正在读取 run…' : '还没有可分析的 run'}</span>
              <span className="db-empty-hint">
                {data.runsState === 'error'
                  ? (data.runsError ?? '拉取失败')
                  : '看板读取 Gateway 的 /v1/agent-debug 埋点；EverRoom 没运行时，把顶栏「来源」切到历史归档即可复盘本机 run。'}
              </span>
            </div>
          )}
        </main>
      </div>

      {insight && (
        <DrillDownDrawer
          insight={insight}
          stepId={selectedStepId}
          onClose={() => setSelectedStepId(null)}
          onSelectStep={selectStep}
          currency={currency}
        />
      )}

      {deepLinkMiss && (
        <div className="db-toast">
          链接里的 run <span className="num">{deepLinkMiss.slice(0, 8)}</span> 不在当前快照窗口内（快照只保留最近若干条），已显示默认 run
          <button type="button" className="db-toast-close" onClick={() => setDeepLinkMiss(null)}>知道了</button>
        </div>
      )}
    </div>
  )
}
