import type { MemoryOverviewDto } from '../../../../shared/memory'

import { memoryOverviewIsEmpty } from './memoryOnboardingState'

export const FULL_ONBOARDING_STORAGE_KEY = 'everroom:onboarding:full:v1'

export function readFullOnboardingCompleted(
  storage: Pick<Storage, 'getItem'> = window.localStorage,
): boolean {
  try {
    return storage.getItem(FULL_ONBOARDING_STORAGE_KEY) === 'completed'
  } catch {
    return false
  }
}

export function writeFullOnboardingCompleted(
  storage: Pick<Storage, 'setItem'> = window.localStorage,
): void {
  try {
    storage.setItem(FULL_ONBOARDING_STORAGE_KEY, 'completed')
  } catch {
    // Data checks still prevent the guide from reopening when storage is unavailable.
  }
}

export function hasExistingOnboardingData(input: {
  memoryOverview?: Pick<MemoryOverviewDto, 'l0' | 'l1'> | null
  roomCount?: number
  deletedRoomCount?: number
  sourceCount?: number
}): boolean {
  return Boolean(
    (input.memoryOverview && !memoryOverviewIsEmpty(input.memoryOverview))
      || (input.roomCount ?? 0) > 0
      || (input.deletedRoomCount ?? 0) > 0
      || (input.sourceCount ?? 0) > 0,
  )
}

/** 首启探测在保存 runtime config 后会撞上 MemoryCore 为加载 AI 环境重启的
 *  数秒窗口；与 MemoryOnboardingGate 的 overview 重试同一策略，短暂失败先重试。 */
export const ONBOARDING_PROBE_RETRY_ATTEMPTS = 3

export function onboardingProbeRetryDelayMs(attempt: number): number {
  return attempt <= 1 ? 1_000 : 2_000
}

export type OnboardingProbeAction =
  | 'complete-existing'
  | 'stand-down'
  | 'retry'
  | 'wait'
  | 'advance'

/** 首启数据探测的下一步决策。核心契约：
 *  - 短暂失败先重试（保存 runtime config 会触发 MemoryCore 重启数秒）；
 *  - 重试用尽返回 'stand-down'：停止探测但既不推进也不持久化完成，
 *    首次用户绝不能被留在「引导 stage 已推进但面板未打开」的空壳里，
 *    也不该因一次慢启动被永久跳过引导——后续检查仍可推进。 */
export function nextOnboardingProbeAction(input: {
  failed: boolean
  apisAvailable: boolean
  hasData: boolean
  /** 已完成的探测次数，从 1 开始。 */
  attempt: number
}): OnboardingProbeAction {
  if (input.hasData) return 'complete-existing'
  if (input.failed) {
    return input.attempt < ONBOARDING_PROBE_RETRY_ATTEMPTS ? 'retry' : 'stand-down'
  }
  if (!input.apisAvailable) return 'wait'
  return 'advance'
}
