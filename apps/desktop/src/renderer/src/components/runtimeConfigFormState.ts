import type { RuntimeConfigSnapshot } from '../../../shared/sources'

/**
 * runtime config 表单共享纯函数：启动 gate 与设置页共用。
 * 语义约定（与 gateway runtime-config 一致）：
 * - 快照里的 secret 掩码 "********" 播种为空（preserveMasked 会在保存时
 *   保留库中原值，空串提交不清空已存 secret）；
 * - 表单字段 trim 后写回；可选段全空存空串（gateway 侧空串=未配置，
 *   不覆盖 env 兜底，但显式空串可覆盖旧的用户配置值）。
 */

/** AI 段表单四要素（primary/embedding/vlm 同形）。 */
export interface ManualAiConfigFields {
  provider: string
  model: string
  baseUrl: string
  apiKey: string
}

/** ASR 表单：标量 + 阿里云 OSS 子表单（提交转写必须 OSS）。provider 即引擎选择：
 *  'aliyun'（默认，标量+OSS 必填）或 'openai-compatible'（自建离线服务，仅 baseUrl 必填）。 */
export interface ManualAsrFields {
  provider: string
  model: string
  baseUrl: string
  apiKey: string
  language: string
  oss: ManualAsrOssFields
}

export interface ManualAsrOssFields {
  region: string
  bucket: string
  accessKeyId: string
  accessKeySecret: string
  stsToken: string
  prefix: string
}

export function emptyAiFields(provider = 'openai-compatible'): ManualAiConfigFields {
  return { provider, model: '', baseUrl: '', apiKey: '' }
}

export function emptyAsrFields(): ManualAsrFields {
  return {
    provider: 'aliyun',
    model: '',
    baseUrl: '',
    apiKey: '',
    language: '',
    oss: { region: '', bucket: '', accessKeyId: '', accessKeySecret: '', stsToken: '', prefix: '' },
  }
}

function sectionOf(config: Record<string, unknown> | undefined, key: string): Record<string, unknown> {
  const value = config?.[key]
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

/** 播种只认用户源（userConfig）：默认/中转源不进表单——否则官方默认值会把
 *  「可选段未配置」误判成「填写不完整」，用户填了 LLM 也保存不了。 */
function userSectionsOf(snapshot: RuntimeConfigSnapshot | null): Record<string, unknown> {
  const user = snapshot?.userConfig
  return user && typeof user === 'object' && !Array.isArray(user) ? user : {}
}

/** 段内字段提取：掩码/空串归一为 ''，provider 回退默认值。 */
function textOf(value: Record<string, unknown>, key: string, fallback = ''): string {
  const raw = value[key]
  return typeof raw === 'string' && raw && raw !== '********' ? raw : fallback
}

/** 从用户源 primary 播种（掩码 apiKey 留空）。 */
export function primaryFieldsFromSnapshot(snapshot: RuntimeConfigSnapshot | null): ManualAiConfigFields {
  const value = sectionOf(userSectionsOf(snapshot), 'primary')
  return {
    provider: textOf(value, 'provider', 'openai-compatible'),
    model: textOf(value, 'model'),
    baseUrl: textOf(value, 'baseUrl'),
    apiKey: textOf(value, 'apiKey'),
  }
}

/** 从用户源 knowledge.embedding 播种（缺段给空表单）。 */
export function embeddingFieldsFromSnapshot(snapshot: RuntimeConfigSnapshot | null): ManualAiConfigFields {
  const knowledge = sectionOf(userSectionsOf(snapshot), 'knowledge')
  const value = sectionOf(knowledge, 'embedding')
  return {
    provider: textOf(value, 'provider', 'openai-compatible'),
    model: textOf(value, 'model'),
    baseUrl: textOf(value, 'baseUrl'),
    apiKey: textOf(value, 'apiKey'),
  }
}

/** 从用户源 vlm 播种（缺段给空表单）。 */
export function vlmFieldsFromSnapshot(snapshot: RuntimeConfigSnapshot | null): ManualAiConfigFields {
  const value = sectionOf(userSectionsOf(snapshot), 'vlm')
  return {
    provider: textOf(value, 'provider', 'openai-compatible'),
    model: textOf(value, 'model'),
    baseUrl: textOf(value, 'baseUrl'),
    apiKey: textOf(value, 'apiKey'),
  }
}

/** 从用户源 lite 播种（缺段给空表单；连接字段留空＝沿用 primary）。 */
export function liteFieldsFromSnapshot(snapshot: RuntimeConfigSnapshot | null): ManualAiConfigFields {
  const value = sectionOf(userSectionsOf(snapshot), 'lite')
  return {
    provider: textOf(value, 'provider', 'openai-compatible'),
    model: textOf(value, 'model'),
    baseUrl: textOf(value, 'baseUrl'),
    apiKey: textOf(value, 'apiKey'),
  }
}

/** 从用户源 asr + asr.oss 播种（缺段给空表单；oss secrets 掩码留空）。
 * 托管实例（127.0.0.1:8300）回读为 nxcore-asr-managed 显示态。 */
export function asrFieldsFromSnapshot(snapshot: RuntimeConfigSnapshot | null): ManualAsrFields {
  const value = sectionOf(userSectionsOf(snapshot), 'asr')
  const oss = sectionOf(value, 'oss')
  const seededProvider = textOf(value, 'provider', 'aliyun')
  // nxcore-asr 一律显示为内置托管态：手动地址模式已从表单移除（托管复用
  // 模式覆盖同端口自建实例；异机实例走 NXCORE_ASR_BASE_URL 环境变量）。
  const isManaged = seededProvider === 'nxcore-asr'
  return {
    provider: isManaged ? 'nxcore-asr-managed' : seededProvider,
    model: textOf(value, 'model'),
    baseUrl: textOf(value, 'baseUrl'),
    apiKey: textOf(value, 'apiKey'),
    language: textOf(value, 'language'),
    oss: {
      region: textOf(oss, 'region'),
      bucket: textOf(oss, 'bucket'),
      accessKeyId: textOf(oss, 'accessKeyId'),
      accessKeySecret: textOf(oss, 'accessKeySecret'),
      stsToken: textOf(oss, 'stsToken'),
      prefix: textOf(oss, 'prefix'),
    },
  }
}

/** AI 段是否完全未填（provider 预置值不算填写）。 */
export function isAiFieldsEmpty(fields: ManualAiConfigFields): boolean {
  return !fields.model.trim() && !fields.baseUrl.trim() && !fields.apiKey.trim()
}

/** 可选 AI 段「填了一部分」：model 与 baseUrl 必须成对；apiKey 独立可空——
 *  快照脱敏播种的空 key 在 gateway preserveMasked 语义下表示"保留已存密钥"，
 *  不是填写不完整（否则每次重存都误报）。历史半填数据同样命中并被清空。 */
export function aiFieldsIncomplete(fields: ManualAiConfigFields): boolean {
  if (isAiFieldsEmpty(fields)) return false
  return !(fields.model.trim() && fields.baseUrl.trim())
}

/** ASR 段未填全（含引擎分支判定）：落库时按未配置清空。 */
export function asrFieldsIncomplete(fields: ManualAsrFields): boolean {
  return asrFieldsError(fields, () => '') !== null
}

/** lite 段未填全（只填连接没填 model 等）：落库时按未配置清空。 */
export function liteFieldsIncomplete(fields: ManualAiConfigFields): boolean {
  return liteFieldsError(fields, () => '') !== null
}

/** ASR 标量是否完全未填。 */
export function isAsrScalarEmpty(fields: ManualAsrFields): boolean {
  return !fields.model.trim() && !fields.baseUrl.trim() && !fields.apiKey.trim()
}

function trimmedAiFields(fields: ManualAiConfigFields): Record<string, string> {
  return {
    provider: fields.provider.trim() || 'openai-compatible',
    model: fields.model.trim(),
    baseUrl: fields.baseUrl.trim(),
    apiKey: fields.apiKey.trim(),
  }
}

/**
 * 表单 → user source 完整 runtime config。只写提供的段，其余段原样保留；
 * 提供的段始终写全部字段（全空存空串，gateway 空串=未配置）。
 */
export function buildUserConfig(
  snapshot: RuntimeConfigSnapshot | null,
  sections: {
    primary?: ManualAiConfigFields
    embedding?: ManualAiConfigFields
    vlm?: ManualAiConfigFields
    asr?: ManualAsrFields
    lite?: ManualAiConfigFields
  },
): Record<string, unknown> {
  // 底板只取用户源自身（不是合并后的生效配置）：曾用 snapshot.config 作底，
  // 默认档（qwen-flash + openai-responses 的 cursorCompletion 等）被整份拷进
  // 用户 payload，触发"默认模型名 + 用户连接"的混搭 400。派生档
  // （background/transcriptionSummary/cursorCompletion）由 gateway 按用户源
  // 判定后重置为主模型，用户 payload 不携带；其余无关段原样保留。
  const base = (snapshot?.userConfig ?? {}) as Record<string, unknown>
  const { background: _background, transcriptionSummary: _transcriptionSummary, cursorCompletion: _cursorCompletion, ...preserved } = base
  const result: Record<string, unknown> = { ...preserved, schemaVersion: 1 }
  if (sections.primary) result.primary = trimmedAiFields(sections.primary)
  if (sections.embedding) {
    const fields = aiFieldsIncomplete(sections.embedding) ? emptyAiFields(sections.embedding.provider) : sections.embedding
    const knowledge = (base.knowledge ?? {}) as Record<string, unknown>
    result.knowledge = { ...knowledge, embedding: trimmedAiFields(fields) }
  }
  if (sections.vlm) {
    const fields = aiFieldsIncomplete(sections.vlm) ? emptyAiFields(sections.vlm.provider) : sections.vlm
    result.vlm = trimmedAiFields(fields)
  }
  // lite 连接字段写空串：gateway 侧 model 空＝未配置（档位隐藏），
  // model 有值而连接空＝继承 primary 的供应商/接口/密钥。未填全按未配置清空。
  if (sections.lite) {
    const fields = liteFieldsIncomplete(sections.lite) ? emptyAiFields(sections.lite.provider) : sections.lite
    result.lite = trimmedAiFields(fields)
  }
  if (sections.asr) {
    const section = asrFieldsIncomplete(sections.asr) ? emptyAsrFields() : sections.asr
    const { oss, ...scalar } = section
    result.asr = {
      ...scalar,
      provider: scalar.provider.trim() || 'aliyun',
      model: scalar.model.trim(),
      baseUrl: scalar.baseUrl.trim(),
      apiKey: scalar.apiKey.trim(),
      language: scalar.language.trim(),
      // oss 全空写空串：阿里云 provider 无 OSS 提交转写直接抛错，构造分支
      // 在 gateway 侧要求必填项齐全才生效；oss secrets 空串经 preserveMasked
      // 保留库中原值。自建引擎（openai-compatible）不消费 oss。
      oss: {
        region: oss.region.trim(),
        bucket: oss.bucket.trim(),
        accessKeyId: oss.accessKeyId.trim(),
        accessKeySecret: oss.accessKeySecret.trim(),
        stsToken: oss.stsToken.trim(),
        prefix: oss.prefix.trim(),
      },
    }
  }
  return result
}

/**
 * 可选 AI 段校验：全空 OK；填了必须填全（部分填写最常见于漏 apiKey，
 * 保存出去是必然失败的配置）。
 */
export function aiFieldsError(fields: ManualAiConfigFields, t: (key: string) => string): string | null {
  if (isAiFieldsEmpty(fields)) return null
  // model/baseUrl 必须成对；apiKey 可空＝保留已存密钥（preserveMasked）。
  return fields.model.trim() && fields.baseUrl.trim() ? null : t('surface:configGate.embeddingIncomplete')
}

/**
 * 轻量模型段校验：model 是唯一必填项（连接字段留空时 gateway 会继承
 * primary 的供应商/接口/密钥）。全空＝未配置；只填连接字段没填 model 视为
 * 填写不完整。
 */
export function liteFieldsError(fields: ManualAiConfigFields, t: (key: string) => string): string | null {
  if (fields.model.trim()) return null
  const hasOverride = [fields.baseUrl, fields.apiKey].some((value) => value.trim())
    || (fields.provider.trim() && fields.provider.trim() !== 'openai-compatible')
  return hasOverride ? t('surface:configGate.embeddingIncomplete') : null
}

/**
 * ASR 段校验：标量全空 OK；填了则标量必填全 + OSS 必填四项（region/
 * bucket/accessKeyId/accessKeySecret；stsToken/prefix 可选）。gateway 构造
 * 分支同样只认"标量+OSS 必填项齐全"，这里提前拦截给出可读文案。
 */
export function asrFieldsError(fields: ManualAsrFields, t: (key: string) => string): string | null {
  if (fields.provider === 'openai-compatible') {
    // 自建引擎：仅 baseUrl 必填（http(s) 绝对地址）；model 缺省 whisper-1，
    // apiKey/language 可选（部分自建服务无鉴权）。
    if (isAsrScalarEmpty(fields) && !fields.language.trim()) return null
    if (!fields.baseUrl.trim()) return t('surface:configGate.embeddingIncomplete')
    return /^https?:\/\//.test(fields.baseUrl.trim()) ? null : t('surface:settings.rcAsrUrlInvalid')
  }
  if (fields.provider === 'nxcore-asr-managed') {
    // 内置托管引擎：连接由主进程 supervisor 提供，表单无需任何字段。
    return null
  }
  if (isAsrScalarEmpty(fields)) {
    // 标量空但 OSS 填了一半也提示（顺手填了 OSS 的人显然想配 ASR）。
    const ossFilled = [fields.oss.region, fields.oss.bucket, fields.oss.accessKeyId, fields.oss.accessKeySecret]
      .filter((value) => value.trim()).length
    return ossFilled > 0 ? t('surface:configGate.embeddingIncomplete') : null
  }
  if (![fields.model, fields.baseUrl, fields.apiKey].every((value) => value.trim())) {
    return t('surface:configGate.embeddingIncomplete')
  }
  const required = [fields.oss.region, fields.oss.bucket, fields.oss.accessKeyId, fields.oss.accessKeySecret]
  return required.every((value) => value.trim()) ? null : t('surface:settings.rcAsrOssRequired')
}

/** 连通测试失败原因 → 用户可读文案（primary/embedding/vlm 共用 taxonomy）。
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
