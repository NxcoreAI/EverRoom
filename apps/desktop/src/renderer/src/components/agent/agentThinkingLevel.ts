import type { AgentThinkingLevel } from '@nxcore/agent-contract'
import { isAgentThinkingLevel } from '@nxcore/agent-contract'

/**
 * 会话思考档位选择器的纯逻辑模块（不依赖 React，便于单测）。
 *
 * 契约（packages/agent-contract）共七档：off/minimal/low/medium/high/xhigh/max；
 * 桌面端 Input 只暴露常用的「默认（跟随模型配置）+ 关闭/低/中/高」五项，
 * 其余档位（其他客户端/后端写入）展示时归到最接近的常用档，避免选择器
 * 出现空白或抛错。
 */

/** 一个思考档位选项：value=null 表示「跟随模型配置」（默认项）。 */
export interface ThinkingLevelOption {
  value: AgentThinkingLevel | null
  labelKey: string
  hintKey: string
}

const SURFACE_PREFIX = 'surface:agentComposer'

/** UI 暴露的思考档位（数组顺序＝下拉展示顺序）。 */
export const THINKING_LEVEL_OPTIONS: readonly ThinkingLevelOption[] = [
  {
    value: null,
    labelKey: `${SURFACE_PREFIX}.thinkingLevelDefault`,
    hintKey: `${SURFACE_PREFIX}.thinkingLevelDefaultHint`,
  },
  {
    value: 'off',
    labelKey: `${SURFACE_PREFIX}.thinkingLevelOff`,
    hintKey: `${SURFACE_PREFIX}.thinkingLevelOffHint`,
  },
  {
    value: 'low',
    labelKey: `${SURFACE_PREFIX}.thinkingLevelLow`,
    hintKey: `${SURFACE_PREFIX}.thinkingLevelLowHint`,
  },
  {
    value: 'medium',
    labelKey: `${SURFACE_PREFIX}.thinkingLevelMedium`,
    hintKey: `${SURFACE_PREFIX}.thinkingLevelMediumHint`,
  },
  {
    value: 'high',
    labelKey: `${SURFACE_PREFIX}.thinkingLevelHigh`,
    hintKey: `${SURFACE_PREFIX}.thinkingLevelHighHint`,
  },
]

/** 契约七档 → UI 可展示档位的兜底映射（minimal 归「低」，xhigh/max 归「高」）。 */
const UI_THINKING_LEVEL_FALLBACK: Record<AgentThinkingLevel, AgentThinkingLevel | null> = {
  off: 'off',
  minimal: 'low',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'high',
  max: 'high',
}

/**
 * 任意契约档位/未知值 → UI 可展示档位。
 * null/undefined = 跟随模型配置；非法值同样回落到 null，保证渲染永不抛错。
 */
export function displayThinkingLevel(level: AgentThinkingLevel | null | undefined): AgentThinkingLevel | null {
  if (!isAgentThinkingLevel(level)) return null
  return UI_THINKING_LEVEL_FALLBACK[level]
}

/** 当前档位对应的选项元数据（未知/无值 → 默认项）。 */
export function thinkingLevelOption(level: AgentThinkingLevel | null | undefined): ThinkingLevelOption {
  const displayValue = displayThinkingLevel(level)
  return THINKING_LEVEL_OPTIONS.find((option) => option.value === displayValue) ?? THINKING_LEVEL_OPTIONS[0]
}

/** 「下次新会话默认思考档位」的本地持久化 key（与 modelPreference 的存储风格一致）。 */
export const THINKING_LEVEL_STORAGE_KEY = 'nxcore-ce:agent-thinking-level:v1'

/** 读取上次选择的默认档位；未存过/非法/存储不可用 → null（跟随模型配置）。 */
export function storedThinkingLevel(): AgentThinkingLevel | null {
  try {
    const raw = localStorage.getItem(THINKING_LEVEL_STORAGE_KEY)
    return isAgentThinkingLevel(raw) ? raw : null
  } catch {
    return null
  }
}

/** 持久化默认档位；null（跟随模型配置）会清掉已存值。 */
export function persistThinkingLevel(level: AgentThinkingLevel | null): void {
  try {
    if (level === null) localStorage.removeItem(THINKING_LEVEL_STORAGE_KEY)
    else localStorage.setItem(THINKING_LEVEL_STORAGE_KEY, level)
  } catch {
    // localStorage 不可用时仅本次会话生效。
  }
}