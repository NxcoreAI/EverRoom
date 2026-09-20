import type { RuntimeConfigSnapshot } from '../../../../shared/sources'

export * from '../runtimeConfigFormState'

/**
 * 启动 gate 判定（runtime-config gate）：
 * gateway snapshot 的 primaryConfigured 由服务端按 primary 四要素非空计算——
 * 空串占位（默认 runtime config）视为未配置。快照不可达（gateway 未起好）
 * 视为"检查中"，不当作未配置，避免网关慢启动时误弹配置页。
 */
export function isRuntimeConfigReady(snapshot: RuntimeConfigSnapshot | null): boolean {
  return snapshot?.primaryConfigured === true
}

export type StartupGateOutcome = 'wait' | 'app' | 'login'

/**
 * 配置就绪后的放行判定：本地配置（瞬时）与登录态（需 SaaS 网络往返，可达
 * 数秒）不同步——配置就绪先等登录态落定再决定去向，避免"先进控制台再弹回
 * 登录页"。未登录时 default 源必须靠中转（relay 未激活则 primaryConfigured
 * 为 false，走不到这里），user 源是 BYOK 自足配置 → 照常进入应用。
 */
export function startupGateOutcome(input: {
  configReady: boolean
  accountResolved: boolean
  authenticated: boolean | null
}): StartupGateOutcome {
  if (!input.configReady) return 'wait'
  if (!input.accountResolved) return 'wait'
  if (input.authenticated === true) return 'app'
  return 'app'
}

/**
 * gate 手动表单本地校验：primary 三要素必填；embedding 可选（填了必须填全）。
 * 校验逻辑复用共享模块（settings 页同语义）。参数带 provider 字段（表单形状）。
 */
export function manualConfigFieldError(
  primary: { model: string; baseUrl: string; apiKey: string; provider?: string },
  embedding: { model: string; baseUrl: string; apiKey: string; provider?: string },
  t: (key: string) => string,
): string | null {
  if (!primary.model.trim() || !primary.baseUrl.trim() || !primary.apiKey.trim()) {
    return t('surface:configGate.fieldRequired')
  }
  const filled = [embedding.model, embedding.baseUrl, embedding.apiKey].filter((value) => value.trim()).length
  if (filled > 0 && filled < 3) return t('surface:configGate.embeddingIncomplete')
  return null
}
