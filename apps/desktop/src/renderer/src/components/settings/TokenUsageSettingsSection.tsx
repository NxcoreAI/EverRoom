import { Activity, Database, Gauge, RefreshCw, Zap } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { AgentUsageRange, AgentUsageSnapshot } from '@nxcore/agent-contract'
import { useLocale } from '@/i18n/LocaleContext'

type UsagePoint = { label: string; input: number; output: number; cache: number }
const number = new Intl.NumberFormat('zh-CN')
const formatTokens = (value: number): string => value >= 100_000 ? `${(value / 1000).toFixed(1)}K` : number.format(value)

function points(values: number[], width: number, height: number, max: number): string {
  if (!values.length || max <= 0) return ''
  return values.map((value, index) => {
    const x = values.length === 1 ? width / 2 : (index / (values.length - 1)) * width
    const y = height - (value / max) * height
    return `${x.toFixed(1)},${y.toFixed(1)}`
  }).join(' ')
}

function toPoints(snapshot: AgentUsageSnapshot): UsagePoint[] {
  return snapshot.points.map((point) => ({
    label: snapshot.range === '24h'
      ? new Date(point.startAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
      : new Date(point.startAt).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }),
    input: point.inputTokens,
    output: point.outputTokens,
    cache: point.cacheReadTokens,
  }))
}

export function TokenUsageSettingsSection() {
  const { t } = useLocale()
  const [range, setRange] = useState<AgentUsageRange>('7d')
  const [snapshot, setSnapshot] = useState<AgentUsageSnapshot | null>(null)
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  const load = async (nextRange: AgentUsageRange = range) => {
    setLoading(true)
    setError(false)
    try {
      const api = window.nxcore
      if (!api) throw new Error('desktop api unavailable')
      const result = await api.agent.getUsage(nextRange)
      setSnapshot(result)
    } catch {
      setSnapshot(null)
      setError(true)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void load(range) }, [range])

  const data = useMemo(() => snapshot ? toPoints(snapshot) : [], [snapshot])
  const totals = snapshot ? { input: snapshot.inputTokens, output: snapshot.outputTokens, cache: snapshot.cacheHitTokens } : { input: 0, output: 0, cache: 0 }
  const max = Math.max(0, ...data.flatMap((point) => [point.input, point.output, point.cache]))
  const selected = selectedIndex === null ? null : data[selectedIndex]

  return (
    <section className="reality-settings-section token-usage-settings" aria-labelledby="token-usage-settings-title">
      <header>
        <span><Activity aria-hidden="true" /></span>
        <div>
          <div className="token-usage-title-row">
            <h2 id="token-usage-settings-title">{t('surface:settings.tokenUsage')}</h2>
            <span className="token-usage-preview-badge">{snapshot?.provider ?? 'piagent'}</span>
          </div>
          <p>{snapshot?.model && snapshot.model !== 'unknown' ? `${snapshot.model} · ${t('surface:settings.tokenUsageBody')}` : t('surface:settings.tokenUsageBody')}</p>
        </div>
        <button className="cloud-account-refresh token-usage-refresh" type="button" title={t('surface:settings.refreshUsage')} aria-label={t('surface:settings.refreshUsage')} onClick={() => void load()} disabled={loading}>
          <RefreshCw aria-hidden="true" />
        </button>
      </header>

      <div className="token-usage-toolbar">
        <div className="segmented-control" aria-label={t('surface:settings.usageTimeRange')}>
          {([['24h', 'surface:settings.last24Hours'], ['7d', 'surface:settings.last7Days'], ['30d', 'surface:settings.last30Days']] as const).map(([value, label]) => (
            <button key={value} type="button" data-active={String(range === value)} onClick={() => { setRange(value); setSelectedIndex(null) }}>
              {t(label)}
            </button>
          ))}
        </div>
        {snapshot && <span className="token-usage-mock-note">{new Date(snapshot.updatedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span>}
      </div>

      {error ? <div className="token-usage-empty"><strong>{t('surface:settings.tokenUsageError')}</strong><button type="button" onClick={() => void load()}>{t('surface:settings.retry')}</button></div> : loading ? <div className="token-usage-empty">{t('surface:settings.loading')}</div> : (
        <>
          <div className="token-usage-metrics">
            <div className="token-usage-metric input"><span><Database aria-hidden="true" />{t('surface:settings.inputTokens')}</span><strong>{formatTokens(totals.input)}</strong><small>{t('surface:settings.inputTokensDescription')}</small></div>
            <div className="token-usage-metric output"><span><Zap aria-hidden="true" />{t('surface:settings.outputTokens')}</span><strong>{formatTokens(totals.output)}</strong><small>{t('surface:settings.outputTokensDescription')}</small></div>
            <div className="token-usage-metric cache"><span><Gauge aria-hidden="true" />{t('surface:settings.cacheHitTokens')}</span><strong>{formatTokens(totals.cache)}</strong><small>{t('surface:settings.cacheHitTokensDescription')}</small></div>
          </div>
          {data.length === 0 || max === 0 ? <div className="token-usage-empty">{t('surface:settings.tokenUsageEmpty')}</div> : <div className="token-usage-chart-wrap">
            <div className="token-usage-chart-header"><div><strong>{t('surface:settings.tokenTrend')}</strong><small>{selected ? `${selected.label} · ${t('surface:settings.inputTokens')} ${formatTokens(selected.input)} · ${t('surface:settings.outputTokens')} ${formatTokens(selected.output)} · ${t('surface:settings.cacheHitTokens')} ${formatTokens(selected.cache)}` : t('surface:settings.clickChartToInspect')}</small></div><div className="token-usage-legend" aria-label="图表图例"><span className="input"><i />{t('surface:settings.inputTokens')}</span><span className="output"><i />{t('surface:settings.outputTokens')}</span><span className="cache"><i />{t('surface:settings.cacheHitTokens')}</span></div></div>
            <div className="token-usage-chart" role="img" aria-label={t('surface:settings.tokenTrend')}><div className="token-usage-gridlines"><i /><i /><i /><i /></div><svg viewBox="0 0 700 220" preserveAspectRatio="none" aria-hidden="true"><polyline className="token-line input" points={points(data.map((point) => point.input), 700, 190, max)} /><polyline className="token-line output" points={points(data.map((point) => point.output), 700, 190, max)} /><polyline className="token-line cache" points={points(data.map((point) => point.cache), 700, 190, max)} /></svg><div className="token-chart-hit-targets">{data.map((point, index) => <button key={`${point.label}-${index}`} className="token-chart-hit-target" style={{ left: `${(index / Math.max(1, data.length - 1)) * 100}%` }} type="button" aria-label={`${t('surface:settings.inspectUsageAt')} ${point.label}`} onClick={() => setSelectedIndex(index)} />)}</div><div className="token-usage-x-labels">{data.map((point, index) => <span key={`${point.label}-${index}`}>{point.label}</span>)}</div></div>
          </div>}
        </>
      )}
    </section>
  )
}
