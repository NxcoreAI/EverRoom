import { Activity, Database, Gauge, RefreshCw, Zap } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useLocale } from '@/i18n/LocaleContext'

type UsageRange = '24h' | '7d' | '30d'
type UsagePoint = { label: string; input: number; output: number; cache: number }

const USAGE_DATA: Record<UsageRange, UsagePoint[]> = {
  '24h': [
    { label: '00:00', input: 1_240, output: 460, cache: 820 },
    { label: '04:00', input: 980, output: 330, cache: 700 },
    { label: '08:00', input: 2_480, output: 920, cache: 1_840 },
    { label: '12:00', input: 3_120, output: 1_280, cache: 2_540 },
    { label: '16:00', input: 2_760, output: 1_040, cache: 2_210 },
    { label: '20:00', input: 3_860, output: 1_640, cache: 3_180 },
    { label: '现在', input: 2_940, output: 1_120, cache: 2_460 },
  ],
  '7d': [
    { label: '周一', input: 12_400, output: 4_800, cache: 8_900 },
    { label: '周二', input: 18_200, output: 7_300, cache: 13_600 },
    { label: '周三', input: 15_800, output: 6_100, cache: 12_200 },
    { label: '周四', input: 22_400, output: 8_900, cache: 17_800 },
    { label: '周五', input: 26_800, output: 10_200, cache: 21_400 },
    { label: '周六', input: 9_600, output: 3_700, cache: 7_800 },
    { label: '今天', input: 19_400, output: 7_600, cache: 15_900 },
  ],
  '30d': [
    { label: '第 1 周', input: 78_000, output: 31_000, cache: 62_000 },
    { label: '第 2 周', input: 96_000, output: 38_000, cache: 79_000 },
    { label: '第 3 周', input: 124_000, output: 47_000, cache: 101_000 },
    { label: '第 4 周', input: 143_000, output: 56_000, cache: 118_000 },
  ],
}

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

export function TokenUsageSettingsSection() {
  const { t } = useLocale()
  const [range, setRange] = useState<UsageRange>('7d')
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null)
  const data = USAGE_DATA[range]
  const totals = useMemo(() => data.reduce((result, point) => ({
    input: result.input + point.input,
    output: result.output + point.output,
    cache: result.cache + point.cache,
  }), { input: 0, output: 0, cache: 0 }), [data])
  const max = Math.max(...data.flatMap((point) => [point.input, point.output, point.cache]))
  const selected = selectedIndex === null ? null : data[selectedIndex]

  return (
    <section className="reality-settings-section token-usage-settings" aria-labelledby="token-usage-settings-title">
      <header>
        <span><Activity aria-hidden="true" /></span>
        <div>
          <div className="token-usage-title-row">
            <h2 id="token-usage-settings-title">{t('surface:settings.tokenUsage')}</h2>
            <span className="token-usage-preview-badge">piagent</span>
          </div>
          <p>{t('surface:settings.tokenUsageBody')}</p>
        </div>
        <button className="cloud-account-refresh token-usage-refresh" type="button" title={t('surface:settings.refreshUsage')} aria-label={t('surface:settings.refreshUsage')} onClick={() => setSelectedIndex(null)}>
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
        <span className="token-usage-mock-note">{t('surface:settings.tokenUsageMock')}</span>
      </div>

      <div className="token-usage-metrics">
        <div className="token-usage-metric input">
          <span><Database aria-hidden="true" />{t('surface:settings.inputTokens')}</span>
          <strong>{formatTokens(totals.input)}</strong>
          <small>{t('surface:settings.inputTokensDescription')}</small>
        </div>
        <div className="token-usage-metric output">
          <span><Zap aria-hidden="true" />{t('surface:settings.outputTokens')}</span>
          <strong>{formatTokens(totals.output)}</strong>
          <small>{t('surface:settings.outputTokensDescription')}</small>
        </div>
        <div className="token-usage-metric cache">
          <span><Gauge aria-hidden="true" />{t('surface:settings.cacheHitTokens')}</span>
          <strong>{formatTokens(totals.cache)}</strong>
          <small>{t('surface:settings.cacheHitTokensDescription')}</small>
        </div>
      </div>

      <div className="token-usage-chart-wrap">
        <div className="token-usage-chart-header">
          <div>
            <strong>{t('surface:settings.tokenTrend')}</strong>
            <small>{selected ? `${selected.label} · ${t('surface:settings.inputTokens')} ${formatTokens(selected.input)} · ${t('surface:settings.outputTokens')} ${formatTokens(selected.output)} · ${t('surface:settings.cacheHitTokens')} ${formatTokens(selected.cache)}` : t('surface:settings.clickChartToInspect')}</small>
          </div>
          <div className="token-usage-legend" aria-label="图表图例">
            <span className="input"><i />{t('surface:settings.inputTokens')}</span>
            <span className="output"><i />{t('surface:settings.outputTokens')}</span>
            <span className="cache"><i />{t('surface:settings.cacheHitTokens')}</span>
          </div>
        </div>
          <div className="token-usage-chart" role="img" aria-label={t('surface:settings.tokenTrend')}>
          <div className="token-usage-gridlines"><i /><i /><i /><i /></div>
          <svg viewBox="0 0 700 220" preserveAspectRatio="none" aria-hidden="true">
            <polyline className="token-line input" points={points(data.map((point) => point.input), 700, 190, max)} />
            <polyline className="token-line output" points={points(data.map((point) => point.output), 700, 190, max)} />
            <polyline className="token-line cache" points={points(data.map((point) => point.cache), 700, 190, max)} />
          </svg>
          <div className="token-chart-hit-targets">
            {data.map((point, index) => (
              <button key={point.label} className="token-chart-hit-target" style={{ left: `${(index / Math.max(1, data.length - 1)) * 100}%` }} type="button" aria-label={`${t('surface:settings.inspectUsageAt')} ${point.label}`} onClick={() => setSelectedIndex(index)} />
            ))}
          </div>
          <div className="token-usage-x-labels">{data.map((point) => <span key={point.label}>{point.label}</span>)}</div>
        </div>
      </div>
    </section>
  )
}
