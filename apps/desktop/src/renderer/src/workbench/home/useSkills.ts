import { useCallback, useEffect, useState } from 'react'

/**
 * 「技能」页的真实数据层（网关 `/v1/skills`）。
 *
 * 技能清单来自磁盘上的两处权威来源：内置 Agent bundle 的 `agent.yaml → skills`
 * 与子 Agent 清单的 `skills`，正文永远是 SKILL.md 本身。网关只多做一件事：
 * 记住用户关掉了哪些（`agent_skill_states`），并在装配运行时按它过滤。
 *
 * 归一函数接受 `unknown`（桥可能缺失、形状可能不同）：异常形状降级为空清单，
 * 由页面区分「加载失败」和「真的没有」。
 */

export type SkillOwnerKind = 'builtin' | 'subagent' | 'user'

export interface SkillItemView {
  id: string
  name: string
  description: string
  ownerId: string
  ownerName: string
  ownerKind: SkillOwnerKind
  path: string
  enabled: boolean
  bytes: number
  /** 最近一次显式启停的时刻（ISO）；从未改过为 null。 */
  updatedAt: string | null
}

export interface SkillsData {
  skills: SkillItemView[]
  counts: { total: number; enabled: number }
}

export interface SkillDetailView extends SkillItemView {
  /** SKILL.md 全文。 */
  prompt: string
}

export type SkillsLoadable =
  | { status: 'loading' }
  | { status: 'ready'; value: SkillsData }
  | { status: 'error' }

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : null
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function toSkill(raw: unknown): SkillItemView | null {
  const record = asRecord(raw)
  if (!record) return null
  const id = asString(record.id).trim()
  if (!id) return null
  const ownerKind: SkillOwnerKind = record.ownerKind === 'subagent'
    ? 'subagent'
    : record.ownerKind === 'user' ? 'user' : 'builtin'
  return {
    id,
    // 名称兜底用 id 最后一段：技能目录名至少不会让行变空。
    name: asString(record.name).trim() || id.split(':').pop() || id,
    description: asString(record.description).trim(),
    ownerId: asString(record.ownerId),
    ownerName: asString(record.ownerName).trim() || asString(record.ownerId),
    ownerKind,
    path: asString(record.path),
    enabled: record.enabled !== false,
    bytes: typeof record.bytes === 'number' && Number.isFinite(record.bytes) ? record.bytes : 0,
    updatedAt: asString(record.updatedAt) || null,
  }
}

export function toSkillDetail(raw: unknown): SkillDetailView | null {
  const skill = toSkill(raw)
  if (!skill) return null
  const record = asRecord(raw)
  return { ...skill, prompt: asString(record?.prompt) }
}

export interface CreateSkillInput {
  name: string
  description: string
  body: string
}

export function useSkills(): {
  state: SkillsLoadable
  reload: () => void
  /** 正在提交的技能 id（行内开关显示忙碌态）。 */
  pending: readonly string[]
  setEnabled: (skillId: string, enabled: boolean) => Promise<void>
  /** 手写一个技能（成功后刷新清单）。 */
  createSkill: (input: CreateSkillInput) => Promise<void>
  /** 选文件夹导入；用户取消返回 false（不算失败）。 */
  importDirectory: () => Promise<boolean>
  /** 删除一个用户技能（成功后刷新清单）。 */
  removeSkill: (skillId: string) => Promise<void>
} {
  const [state, setState] = useState<SkillsLoadable>({ status: 'loading' })
  const [pending, setPending] = useState<string[]>([])
  const [nonce, setNonce] = useState(0)

  const reload = useCallback(() => {
    setState({ status: 'loading' })
    setNonce((value) => value + 1)
  }, [])

  useEffect(() => {
    let cancelled = false

    const load = async () => {
      const snapshot = await Promise.resolve(window.nxcore?.agent?.listSkills?.()).catch(() => null)
      if (cancelled) return
      const record = asRecord(snapshot)
      const items = Array.isArray(record?.skills) ? record.skills : null
      if (!items) {
        // 桥缺失或接口失败：整页按失败处理，不假装「没有技能」。
        setState({ status: 'error' })
        return
      }
      const skills = items
        .map(toSkill)
        .filter((skill): skill is SkillItemView => skill !== null)
        .sort(compareSkills)
      setState({
        status: 'ready',
        value: {
          skills,
          counts: { total: skills.length, enabled: skills.filter((skill) => skill.enabled).length },
        },
      })
    }

    void load()
    return () => { cancelled = true }
  }, [nonce])

  const setEnabled = useCallback(async (skillId: string, enabled: boolean) => {
    const bridge = window.nxcore?.agent
    if (!bridge?.setSkillEnabled) throw new Error('桌面服务 Agent 接口未就绪，请重启 EverRoom')
    setPending((current) => (current.includes(skillId) ? current : [...current, skillId]))
    // 先改界面再等网关：开关是幂等的布尔写入，失败时会回滚。
    setState((current) => current.status === 'ready'
      ? { status: 'ready', value: patchSkill(current.value, skillId, enabled) }
      : current)
    try {
      const updated = await bridge.setSkillEnabled(skillId, enabled)
      const view = toSkill(updated)
      if (view) {
        setState((current) => current.status === 'ready'
          ? { status: 'ready', value: patchSkill(current.value, skillId, view.enabled) }
          : current)
      }
    } catch (error) {
      setState((current) => current.status === 'ready'
        ? { status: 'ready', value: patchSkill(current.value, skillId, !enabled) }
        : current)
      throw error
    } finally {
      setPending((current) => current.filter((id) => id !== skillId))
    }
  }, [])

  const createSkill = useCallback(async (input: CreateSkillInput) => {
    const bridge = window.nxcore?.agent
    if (!bridge?.createSkill) throw new Error('桌面服务 Agent 接口未就绪，请重启 EverRoom')
    await bridge.createSkill(input)
    reload()
  }, [reload])

  const importDirectory = useCallback(async (): Promise<boolean> => {
    const bridge = window.nxcore?.agent
    if (!bridge?.pickSkillDirectory || !bridge.importSkillDirectory) {
      throw new Error('桌面服务 Agent 接口未就绪，请重启 EverRoom')
    }
    const directory = await bridge.pickSkillDirectory()
    if (!directory) return false
    await bridge.importSkillDirectory(directory)
    reload()
    return true
  }, [reload])

  const removeSkill = useCallback(async (skillId: string) => {
    const bridge = window.nxcore?.agent
    if (!bridge?.deleteSkill) throw new Error('桌面服务 Agent 接口未就绪，请重启 EverRoom')
    await bridge.deleteSkill(skillId)
    reload()
  }, [reload])

  return { state, reload, pending, setEnabled, createSkill, importDirectory, removeSkill }
}

/**
 * 排序：内置 Agent → 子 Agent → 自定义技能（发布物在前，自己加的在后），
 * 同类按归属 Agent 分组，再按技能名。
 */
const OWNER_KIND_RANK: Record<SkillOwnerKind, number> = { builtin: 0, subagent: 1, user: 2 }

function compareSkills(left: SkillItemView, right: SkillItemView): number {
  if (left.ownerKind !== right.ownerKind) {
    return OWNER_KIND_RANK[left.ownerKind] - OWNER_KIND_RANK[right.ownerKind]
  }
  if (left.ownerName !== right.ownerName) return left.ownerName.localeCompare(right.ownerName, 'zh-Hans-CN')
  return left.name.localeCompare(right.name, 'zh-Hans-CN')
}

function patchSkill(data: SkillsData, skillId: string, enabled: boolean): SkillsData {
  const skills = data.skills.map((skill) => (skill.id === skillId ? { ...skill, enabled } : skill))
  return { skills, counts: { total: skills.length, enabled: skills.filter((skill) => skill.enabled).length } }
}
