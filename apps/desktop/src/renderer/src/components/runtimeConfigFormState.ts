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

/** ASR 表单：标量 + 阿里云 OSS 子表单（提交转写必须 OSS）。 */
export interface ManualAsrFields {
  provider: string
  model: string
  baseUrl: string
  apiKey: string
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
    oss: { region: '', bucket: '', accessKeyId: '', accessKeySecret: '', stsToken: '', prefix: '' },
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

/** 从快照 config.primary 播种（掩码 apiKey 留空）。 */
export function primaryFieldsFromSnapshot(snapshot: RuntimeConfigSnapshot | null): ManualAiConfigFields {
  const value = sectionOf(snapshot?.config as Record<string, unknown> | undefined, 'primary')
  return {
    provider: textOf(value, 'provider', 'openai-compatible'),
    model: textOf(value, 'model'),
    baseUrl: textOf(value, 'baseUrl'),
    apiKey: textOf(value, 'apiKey'),
  }
}

/** 从快照 config.knowledge.embedding 播种（缺段给空表单）。 */
export function embeddingFieldsFromSnapshot(snapshot: RuntimeConfigSnapshot | null): ManualAiConfigFields {
  const knowledge = sectionOf(snapshot?.config as Record<string, unknown> | undefined, 'knowledge')
  const value = sectionOf(knowledge, 'embedding')
  return {
    provider: textOf(value, 'provider', 'openai-compatible'),
    model: textOf(value, 'model'),
    baseUrl: textOf(value, 'baseUrl'),
    apiKey: textOf(value, 'apiKey'),
  }
}

/** 从快照 config.vlm 播种（缺段给空表单）。 */
export function vlmFieldsFromSnapshot(snapshot: RuntimeConfigSnapshot | null): ManualAiConfigFields {
  const value = sectionOf(snapshot?.config as Record<string, unknown> | undefined, 'vlm')
  return {
    provider: textOf(value, 'provider', 'openai-compatible'),
    model: textOf(value, 'model'),
    baseUrl: textOf(value, 'baseUrl'),
    apiKey: textOf(value, 'apiKey'),
  }
}

/** 从快照 config.asr + asr.oss 播种（缺段给空表单；oss secrets 掩码留空）。 */
export function asrFieldsFromSnapshot(snapshot: RuntimeConfigSnapshot | null): ManualAsrFields {
  const value = sectionOf(snapshot?.config as Record<string, unknown> | undefined, 'asr')
  const oss = sectionOf(value, 'oss')
  return {
    provider: textOf(value, 'provider', 'aliyun'),
    model: textOf(value, 'model'),
    baseUrl: textOf(value, 'baseUrl'),
    apiKey: textOf(value, 'apiKey'),
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
  },
): Record<string, unknown> {
  const base = (snapshot?.config ?? {}) as Record<string, unknown>
  const result: Record<string, unknown> = { ...base, schemaVersion: 1 }
  if (sections.primary) result.primary = trimmedAiFields(sections.primary)
  if (sections.embedding) {
    const knowledge = (base.knowledge ?? {}) as Record<string, unknown>
    result.knowledge = { ...knowledge, embedding: trimmedAiFields(sections.embedding) }
  }
  if (sections.vlm) result.vlm = trimmedAiFields(sections.vlm)
  if (sections.asr) {
    const { oss, ...scalar } = sections.asr
    result.asr = {
      ...scalar,
      provider: scalar.provider.trim() || 'aliyun',
      model: scalar.model.trim(),
      baseUrl: scalar.baseUrl.trim(),
      apiKey: scalar.apiKey.trim(),
      // oss 全空写空串：阿里云 provider 无 OSS 提交转写直接抛错，构造分支
      // 在 gateway 侧要求必填项齐全才生效；oss secrets 空串经 preserveMasked
      // 保留库中原值。
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
  const filled = [fields.model, fields.baseUrl, fields.apiKey].filter((value) => value.trim()).length
  return filled === 3 ? null : t('surface:configGate.embeddingIncomplete')
}

/**
 * ASR 段校验：标量全空 OK；填了则标量必填全 + OSS 必填四项（region/
 * bucket/accessKeyId/accessKeySecret；stsToken/prefix 可选）。gateway 构造
 * 分支同样只认"标量+OSS 必填项齐全"，这里提前拦截给出可读文案。
 */
export function asrFieldsError(fields: ManualAsrFields, t: (key: string) => string): string | null {
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

/** 连通测试失败原因 → 用户可读文案（primary/embedding/vlm 共用 taxonomy）。 */
export function configTestErrorMessage(error: string | undefined, t: (key: string) => string): string {
  if (!error) return t('surface:configGate.testFailedGeneric')
  if (error.includes('incomplete')) return t('surface:configGate.testIncomplete')
  if (error.includes('_http_401') || error.includes('_http_403')) return t('surface:configGate.testAuthFailed')
  if (error.includes('_http_404')) return t('surface:configGate.testNotFound')
  if (error.includes('unreachable') || error.includes('timeout') || error.includes('TimeoutError')) return t('surface:configGate.testUnreachable')
  return t('surface:configGate.testFailedGeneric')
}
