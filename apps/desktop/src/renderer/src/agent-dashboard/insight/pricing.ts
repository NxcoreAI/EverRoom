/**
 * 计价表与成本折算。
 *
 * 埋点契约里**没有**模型名（`message.started` 只带 role），所以看板不猜模型：
 * 顶栏选一个计价模型，成本按所选单价 × 本 run 各回合 token 增量估算，并在 UI 标注「估算」。
 * 单价单位是 USD / 1M tokens，缓存读按各家 cache-hit 折扣单价单列。
 */
import type { TokenUsage } from './types'

export interface PriceSpec {
  id: string
  label: string
  /** USD / 1M input tokens。 */
  input: number
  /** USD / 1M output tokens。 */
  output: number
  /** USD / 1M cache-read tokens。 */
  cacheRead: number
  /** USD / 1M cache-write tokens（无缓存写入计费模型的为 0）。 */
  cacheWrite: number
  /** 上下文窗口（tokens）；仅用于展示参考，真实值仍取埋点里的 contextWindow。 */
  contextWindow: number
}

/** 参考单价（公开列表价，2026-10 抓取口径；换模型时改这里即可）。 */
export const PRICE_SPECS: readonly PriceSpec[] = [
  { id: 'claude-sonnet-4.5', label: 'Claude Sonnet 4.5', input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, contextWindow: 200_000 },
  { id: 'claude-opus-4.1', label: 'Claude Opus 4.1', input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75, contextWindow: 200_000 },
  { id: 'claude-haiku-4.5', label: 'Claude Haiku 4.5', input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25, contextWindow: 200_000 },
  { id: 'gpt-5', label: 'GPT-5', input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0, contextWindow: 400_000 },
  { id: 'gpt-5-mini', label: 'GPT-5 mini', input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: 0, contextWindow: 400_000 },
  { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', input: 1.25, output: 10, cacheRead: 0.31, cacheWrite: 0, contextWindow: 1_000_000 },
  { id: 'deepseek-v3.2', label: 'DeepSeek V3.2', input: 0.28, output: 0.42, cacheRead: 0.028, cacheWrite: 0, contextWindow: 128_000 },
  { id: 'qwen3-max', label: 'Qwen3-Max', input: 0.86, output: 3.44, cacheRead: 0.086, cacheWrite: 0, contextWindow: 128_000 },
  { id: 'glm-4.6', label: 'GLM-4.6', input: 0.6, output: 2.2, cacheRead: 0.11, cacheWrite: 0, contextWindow: 200_000 },
] as const

export const DEFAULT_PRICE_ID = 'claude-sonnet-4.5'

/** 顶栏「未知模型」选项：不对成本做任何估算。 */
export const NO_PRICE_ID = 'none'

export function findPrice(priceId: string | null | undefined): PriceSpec | null {
  if (!priceId || priceId === NO_PRICE_ID) return null
  return PRICE_SPECS.find((spec) => spec.id === priceId) ?? null
}

const PER_MILLION = 1_000_000

/** usage × 单价 → USD；usage 缺失返回 null（不返回 0，避免把「未知」画成「免费」）。 */
export function costOf(usage: TokenUsage | null | undefined, price: PriceSpec | null): number | null {
  if (!usage || !price) return null
  const usd = (usage.input * price.input
    + usage.output * price.output
    + usage.cacheRead * price.cacheRead
    + usage.cacheWrite * price.cacheWrite) / PER_MILLION
  return usd
}

/** 美元 → 人民币的展示汇率（只用于估算展示，不做账务口径）。 */
export const CNY_PER_USD = 7.1

export type Currency = 'USD' | 'CNY'

export function currencySymbol(currency: Currency): string {
  return currency === 'CNY' ? '¥' : '$'
}

/**
 * 成本展示：金额很小时用 4 位小数（单次工具调用常是 $0.0003），
 * 大额用 2 位；null 显示「—」。
 */
export function formatCost(usd: number | null | undefined, currency: Currency = 'USD'): string {
  if (usd === null || usd === undefined || !Number.isFinite(usd)) return '—'
  const value = currency === 'CNY' ? usd * CNY_PER_USD : usd
  const symbol = currencySymbol(currency)
  const abs = Math.abs(value)
  if (abs === 0) return `${symbol}0`
  if (abs < 0.01) return `${symbol}${value.toFixed(4)}`
  if (abs < 1) return `${symbol}${value.toFixed(3)}`
  if (abs < 100) return `${symbol}${value.toFixed(2)}`
  return `${symbol}${value.toFixed(0)}`
}

/** 细粒度成本（每 token 级别的悬停提示用），保留 6 位小数。 */
export function formatCostPrecise(usd: number | null | undefined, currency: Currency = 'USD'): string {
  if (usd === null || usd === undefined || !Number.isFinite(usd)) return '—'
  const value = currency === 'CNY' ? usd * CNY_PER_USD : usd
  return `${currencySymbol(currency)}${value.toFixed(6)}`
}
