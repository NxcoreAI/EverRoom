import type { RuntimeConfigSnapshot } from '../../../shared/sources'

/**
 * runtime config 表单共享纯函数：启动 gate 与设置页共用。
 * 语义约定（与 gateway runtime-config 槽位级语义一致）：
 * - 表单播种自快照的 userConfig（user 源原始 payload），不再播种生效快照——
 *   生效快照在中转激活时含代理地址与令牌，摊进保存值会把官方出口冻结进
 *   用户配置；
 * - payload 里「不出现的槽位 = 用官方」；文本场景可选择跟随通用模型、
 *   单独配模型名或整段用官方；特殊模型（vlm）自定义时连接留空同样继承
 *   通用连接；
 * - 快照里的 secret 掩码 "********" 播种为空（gateway 侧 preserveMasked
 *   会在保存时保留库中原值，空串提交不清空已存 secret）；
 * - 已删子系统（ASR/转写摘要/记忆/知识）的历史槽位由 gateway 读取与保存时
 *   静默剥离，本模块不再管理。
 */

/** AI 段表单四要素（primary/vlm 同形）。 */
export interface ManualAiConfigFields {
  provider: string
  model: string
  baseUrl: string
  apiKey: string
}

export function emptyAiFields(provider = 'openai-compatible'): ManualAiConfigFields {
  return { provider, model: '', baseUrl: '', apiKey: '' }
}

/** 文本场景槽位：主对话/后台任务/轻量档/光标补全共用通用文本模型。 */
export type TextScenarioId = 'primary' | 'background' | 'lite' | 'cursorCompletion'

export const TEXT_SCENARIO_IDS: readonly TextScenarioId[] = ['primary', 'background', 'lite', 'cursorCompletion']

/** 场景启用方式：跟随通用模型 / 单独配置（可只换模型，也可独立连接）/ 整段用官方。 */
export type ScenarioMode = 'generic' | 'custom' | 'official'

export interface ScenarioAssignment {
  mode: ScenarioMode
  model: string
  /** 独立连接（留空沿用通用模型的 Base URL / API Key）。 */
  baseUrl: string
  apiKey: string
}

/** 特殊模型（vlm）启用方式：官方 / 自定义。
 * 自定义时连接留空 = 继承通用连接（解析层从 primary 继承）；填全 = 独立连接。 */
export interface SpecialModelAssignment extends ManualAiConfigFields {
  mode: 'official' | 'custom'
}

export interface RuntimeConfigFormState {
  /** 通用文本模型四要素；场景启用（跟随通用/单独配置）时必须填全。 */
  generic: ManualAiConfigFields
  scenarios: Record<TextScenarioId, ScenarioAssignment>
  vlm: SpecialModelAssignment
  webSearch: ManualAiConfigFields
  webSearchCustom: boolean
  /** 本次保存是否顺带删除本地已存搜索密钥。 */
  deleteSearchKey: boolean
  /** 各段已存密钥（掩码播种为空后，重存不必重输；空串提交保留库中原值）。 */
  keyConfigured: {
    generic: boolean
    vlm: boolean
    /** 单独配置了独立连接的场景。 */
    scenarios: Partial<Record<TextScenarioId, boolean>>
  }
}

function sectionOf(config: Record<string, unknown> | undefined, key: string): Record<string, unknown> {
  const value = config?.[key]
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

/** 段内字段提取：掩码/空串归一为 ''，provider 回退默认值。 */
function textOf(value: Record<string, unknown>, key: string, fallback = ''): string {
  const raw = value[key]
  return typeof raw === 'string' && raw && raw !== '********' ? raw : fallback
}

function aiFieldsOf(value: Record<string, unknown>, providerFallback = 'openai-compatible'): ManualAiConfigFields {
  return {
    provider: textOf(value, 'provider', providerFallback),
    model: textOf(value, 'model'),
    baseUrl: textOf(value, 'baseUrl'),
    apiKey: '',
  }
}

/** AI 段是否完全未填（provider 预置值不算填写）。 */
export function isAiFieldsEmpty(fields: ManualAiConfigFields): boolean {
  return !fields.model.trim() && !fields.baseUrl.trim() && !fields.apiKey.trim()
}

/**
 * 从快照 userConfig 播种表单。槽位解析规则（区别旧版整 payload 摊开）：
 * - 槽位缺失 = 用官方（新版语义；旧版 payload 经摊开必含全部槽位，缺失只可能来自新语义）；
 * - 槽位在但连接字段空/掩码 = 旧版继承语义 → 跟随通用；
 * - 槽位连接字段与通用端点一致 → 模型相同跟随通用、不同单独配置；
 * - 其余（旧 payload 冻结的独立端点）降级为单独配置（沿用其模型名）。
 * 从未保存过自定义配置时给全新默认态：全部场景跟随通用。
 */
export function formStateFromSnapshot(snapshot: RuntimeConfigSnapshot | null): RuntimeConfigFormState {
  const userConfig = (snapshot?.userConfig ?? null) as Record<string, unknown> | null
  const primary = userConfig ? sectionOf(userConfig, 'primary') : {}
  const generic: ManualAiConfigFields = userConfig
    ? {
      provider: textOf(primary, 'provider', 'openai-compatible'),
      model: textOf(primary, 'model'),
      baseUrl: textOf(primary, 'baseUrl'),
      apiKey: '',
    }
    : emptyAiFields()

  const scenarios = {} as Record<TextScenarioId, ScenarioAssignment>
  const scenarioKeys: Partial<Record<TextScenarioId, boolean>> = {}
  for (const id of TEXT_SCENARIO_IDS) {
    if (!userConfig) {
      scenarios[id] = { mode: 'generic', model: '', baseUrl: '', apiKey: '' }
      continue
    }
    const slot = sectionOf(userConfig, id)
    const baseUrl = textOf(slot, 'baseUrl')
    const model = textOf(slot, 'model')
    const rawApiKey = typeof slot.apiKey === 'string' ? slot.apiKey : ''
    if (!model && !baseUrl && !rawApiKey) {
      scenarios[id] = { mode: 'official', model: '', baseUrl: '', apiKey: '' }
      continue
    }
    if (!baseUrl) {
      // 连接字段空/仅掩码：旧版继承 primary 语义（解析层会继承通用连接）。
      scenarios[id] = { mode: 'generic', model: '', baseUrl: '', apiKey: '' }
      continue
    }
    const ownBaseUrl = baseUrl === generic.baseUrl ? '' : baseUrl
    if (!ownBaseUrl) {
      scenarios[id] = model === generic.model
        ? { mode: 'generic', model: '', baseUrl: '', apiKey: '' }
        : { mode: 'custom', model, baseUrl: '', apiKey: '' }
      continue
    }
    // 独立连接：单独配置场景，可只换模型也可整段独立。
    scenarios[id] = { mode: 'custom', model, baseUrl: ownBaseUrl, apiKey: '' }
    if (rawApiKey.trim()) scenarioKeys[id] = true
  }

  const vlmFields = aiFieldsOf(userConfig ? sectionOf(userConfig, 'vlm') : {})
  const webSearch = aiFieldsOf(userConfig ? sectionOf(userConfig, 'webSearch') : {}, 'openai-compatible')
  // 脱敏快照里已配置的密钥是掩码串（"********"），空串才是未配置——
  // 非空即「库里有值」，重存时表单里留空沿用原值。
  const rawKeyOf = (value: Record<string, unknown>): boolean => {
    const raw = value.apiKey
    return typeof raw === 'string' && raw.trim() !== ''
  }

  return {
    generic,
    scenarios,
    vlm: { ...vlmFields, mode: vlmFields.model || vlmFields.baseUrl ? 'custom' : 'official' },
    webSearch,
    webSearchCustom: Boolean(webSearch.model || webSearch.baseUrl),
    deleteSearchKey: false,
    keyConfigured: {
      generic: userConfig ? rawKeyOf(primary) : false,
      vlm: rawKeyOf(userConfig ? sectionOf(userConfig, 'vlm') : {}),
      scenarios: scenarioKeys,
    },
  }
}

function trimmedAiFields(fields: ManualAiConfigFields): Record<string, string> {
  return {
    provider: fields.provider.trim() || 'openai-compatible',
    model: fields.model.trim(),
    baseUrl: fields.baseUrl.trim(),
    apiKey: fields.apiKey.trim(),
  }
}

/** 启动 gate 手动表单播种：读 user 源原始 primary（掩码密钥留空）。 */
export function primaryFieldsFromSnapshot(snapshot: RuntimeConfigSnapshot | null): ManualAiConfigFields {
  const userConfig = (snapshot?.userConfig ?? null) as Record<string, unknown> | null
  return aiFieldsOf(userConfig ? sectionOf(userConfig, 'primary') : {})
}

/**
 * 启动 gate 手动入口专用：只覆盖 primary，其余槽位原样保留——gate 只展示
 * 通用模型字段，不能顺手清掉用户在设置页配好的其他模型。
 */
export function buildManualEntryPayload(
  snapshot: RuntimeConfigSnapshot | null,
  input: { primary: ManualAiConfigFields },
): Record<string, unknown> {
  const base = { ...((snapshot?.userConfig ?? {}) as Record<string, unknown>) }
  base.primary = trimmedAiFields(input.primary)
  return { ...base, schemaVersion: 1 }
}

/** 特殊模型槽位落盘：独立连接存全量；连接留空只存 provider+model（解析层
 * 从 primary 继承连接，密钥轮换自动同步）。 */
function specialSlotPayload(slot: SpecialModelAssignment, generic: ManualAiConfigFields): Record<string, string> {
  if (slot.baseUrl.trim() || slot.apiKey.trim()) return trimmedAiFields(slot)
  return { provider: generic.provider.trim() || 'openai-compatible', model: slot.model.trim() }
}

/**
 * 表单 → user 源 payload。只写配置过的槽位，其余槽位从 payload 删除
 * （= 用官方）；已删子系统的历史槽位（asr/transcriptionSummary/knowledge）
 * 不在这里管理，由 gateway 读取与保存时静默剥离。
 * webSearch 的 apiKey 走 mutation envelope（set/keep/delete）。
 */
export function buildUserPayload(
  snapshot: RuntimeConfigSnapshot | null,
  state: RuntimeConfigFormState,
): Record<string, unknown> {
  const base = { ...((snapshot?.userConfig ?? {}) as Record<string, unknown>) }
  for (const id of TEXT_SCENARIO_IDS) delete base[id]
  delete base.vlm
  delete base.webSearch

  const genericActive = TEXT_SCENARIO_IDS.some((id) => state.scenarios[id].mode !== 'official')
  if (genericActive) {
    const generic = trimmedAiFields(state.generic)
    // 通用连接必须落在 primary 槽位：其他场景的「跟随通用/仅模型覆盖」靠解析
    // 层从 primary 继承连接。primary 本身选了官方但其他场景启用时，primary
    // 仍要写入（场景依赖它）。
    const dependentsActive = TEXT_SCENARIO_IDS.some((id) => id !== 'primary' && state.scenarios[id].mode !== 'official')
    const primaryModel = state.scenarios.primary.mode === 'custom' ? state.scenarios.primary.model.trim() || generic.model : generic.model
    if (state.scenarios.primary.mode !== 'official' || dependentsActive) {
      base.primary = { ...generic, model: primaryModel }
    }
    for (const id of TEXT_SCENARIO_IDS) {
      if (id === 'primary') continue
      const assignment = state.scenarios[id]
      if (assignment.mode === 'official') continue
      const ownConnection = assignment.baseUrl.trim() || assignment.apiKey.trim()
      if (ownConnection) {
        base[id] = {
          provider: generic.provider,
          model: assignment.mode === 'custom' ? assignment.model.trim() || generic.model : generic.model,
          baseUrl: assignment.baseUrl.trim(),
          apiKey: assignment.apiKey.trim(),
        }
      } else {
        // 连接留空：只存模型，解析层继承通用模型的连接（密钥轮换自动同步）。
        base[id] = { provider: generic.provider, model: assignment.mode === 'custom' ? assignment.model.trim() || generic.model : generic.model }
      }
    }
  }
  if (state.vlm.mode === 'custom') base.vlm = specialSlotPayload(state.vlm, state.generic)
  if (state.webSearchCustom) {
    base.webSearch = {
      provider: state.webSearch.provider.trim() || 'openai-compatible',
      model: state.webSearch.model.trim(),
      baseUrl: state.webSearch.baseUrl.trim(),
      api: 'openai-completions',
      apiKey: state.deleteSearchKey
        ? { operation: 'delete' }
        : state.webSearch.apiKey.trim()
          ? { operation: 'set', value: state.webSearch.apiKey.trim() }
          : { operation: 'keep' },
    }
  }
  return { ...base, schemaVersion: 1 }
}

/**
 * 新版表单整体验证：任一场景启用时通用模型必填全；单独配置的场景必须有
 * 模型名；vlm 段 all-or-nothing。
 */
export function runtimeConfigFormError(state: RuntimeConfigFormState, t: (key: string) => string): string | null {
  const genericActive = TEXT_SCENARIO_IDS.some((id) => state.scenarios[id].mode !== 'official')
  if (genericActive) {
    const filled = [state.generic.model, state.generic.baseUrl].filter((value) => value.trim()).length
    const keyReady = state.generic.apiKey.trim() || state.keyConfigured.generic ? 1 : 0
    if (filled !== 2 || keyReady !== 1) return t('surface:settings.rcGenericIncomplete')
  }
  for (const id of TEXT_SCENARIO_IDS) {
    const assignment = state.scenarios[id]
    if (assignment.mode === 'custom' && !assignment.model.trim()) return t('surface:settings.rcScenarioModelRequired')
    // 独立连接要么整体留空（沿用通用），要么 Base URL + API Key 成对填全；
    // 已存过独立密钥的场景，密钥留空视为沿用原值。
    const hasOwnConnection = assignment.baseUrl.trim() || assignment.apiKey.trim()
    if (hasOwnConnection) {
      const pairReady = assignment.baseUrl.trim()
        && (assignment.apiKey.trim() || state.keyConfigured.scenarios[id])
      if (!pairReady) return t('surface:settings.rcScenarioConnectionIncomplete')
    }
  }
  const specialSlotError = (slot: SpecialModelAssignment, hasStoredKey: boolean): string | null => {
    if (slot.mode !== 'custom') return null
    if (!slot.model.trim()) return t('surface:settings.rcScenarioModelRequired')
    const ownConnection = slot.baseUrl.trim() || slot.apiKey.trim()
    if (!ownConnection) return genericActive ? null : t('surface:settings.rcGenericIncomplete')
    return slot.baseUrl.trim() && (slot.apiKey.trim() || hasStoredKey)
      ? null
      : t('surface:settings.rcScenarioConnectionIncomplete')
  }
  const vlmError = specialSlotError(state.vlm, state.keyConfigured.vlm)
  if (vlmError) return vlmError
  return null
}

/** 连通测试失败原因 → 用户可读文案（primary/vlm 共用 taxonomy）。
 * 兜底分支（5xx/429 等未分类状态）必须带上服务端原始错误——端点应答了但
 * 报错时，用户和排障都需要知道它说了什么，不能只剩一句「未通过」。 */
export function configTestErrorMessage(error: string | undefined, t: (key: string) => string): string {
  if (!error) return t('surface:configGate.testFailedGeneric')
  if (error.includes('incomplete')) return t('surface:configGate.testIncomplete')
  if (error.includes('_http_401') || error.includes('_http_403')) return t('surface:configGate.testAuthFailed')
  if (error.includes('_http_404')) return t('surface:configGate.testNotFound')
  if (error.includes('unreachable') || error.includes('timeout') || error.includes('TimeoutError')) {
    return `${t('surface:configGate.testUnreachable')}${testErrorDetail(error)}`
  }
  return `${t('surface:configGate.testFailedGeneric')}${testErrorDetail(error)}`
}

/** 服务端原始错误尾巴（去 taxonomy 前缀、截断）；空/纯前缀返回空串。 */
function testErrorDetail(error: string): string {
  const detail = error.replace(/^runtime_config_test[a-z0-9_]*(?::\s*)?/, '').trim()
  return detail ? `（${detail.slice(0, 160)}）` : ''
}