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

export type StartupGateOutcome = 'wait' | 'app'

/**
 * 配置就绪后的放行判定：本地配置（瞬时）与登录态（需 SaaS 网络往返，可达
 * 数秒）不同步——配置就绪先等登录态落定再决定去向，避免"先进控制台再弹回
 * 登录页"。未登录用户到不了这里（default 源靠中转、primaryConfigured 不会
 * 就绪，由 check() 落登录页；user 源是 BYOK 自足配置 → 照常进入应用）。
 */
export function startupGateOutcome(input: {
  configReady: boolean
  accountResolved: boolean
  authenticated: boolean | null
}): StartupGateOutcome {
  if (!input.configReady) return 'wait'
  if (!input.accountResolved) return 'wait'
  return 'app'
}

/**
 * gate 手动表单本地校验：primary 三要素必填；embedding 可选——未填全由
 * buildUserConfig 按未配置清空（历史半填数据自愈），不再阻塞进入应用。
 */
export function manualConfigFieldError(
  primary: { model: string; baseUrl: string; apiKey: string; provider?: string },
  _embedding: { model: string; baseUrl: string; apiKey: string; provider?: string },
  t: (key: string) => string,
): string | null {
  if (!primary.model.trim() || !primary.baseUrl.trim() || !primary.apiKey.trim()) {
    return t('surface:configGate.fieldRequired')
  }
  return null
}
