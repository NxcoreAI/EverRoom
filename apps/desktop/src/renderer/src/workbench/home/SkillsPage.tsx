import { Plus, RotateCw, Search, Sparkles, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { workbenchToast } from '../shell/toast'
import { Modal } from '../ui/modal'
import {
  Badge, Button, EmptyState, IconButton, PageHeader, Segmented, Spinner, TextInput, Toggle,
} from '../ui/primitives'
import { CreateSkillDialog, DeleteSkillDialog } from './SkillDialogs'
import { HomeNote } from './parts'
import {
  toSkillDetail,
  useSkills,
  type SkillDetailView,
  type SkillItemView,
  type SkillOwnerKind,
} from './useSkills'
import './skills.css'

/**
 * 主页「技能」页：Agent 可以调用的成熟能力。
 *
 * 与原型（静态卡片 + 本地 state 假开关）的区别：清单来自网关真实目录
 * （内置 Agent bundle 与子 Agent 清单里的 SKILL.md），开关落网关
 * `agent_skill_states`，并立即重装运行时——关掉的技能真的不会进上下文。
 *
 * 技能是随应用发布的只读资源，所以这里没有新增/编辑/删除，只做
 * 「看清它是什么」和「要不要让它生效」两件事。
 */

type OwnerFilter = 'all' | SkillOwnerKind

interface OwnerGroup {
  key: string
  name: string
  kind: SkillOwnerKind
  skills: SkillItemView[]
}

const OWNER_KIND_LABEL: Record<SkillOwnerKind, string> = {
  builtin: '内置 Agent',
  subagent: '子 Agent',
  user: '自定义',
}

const OWNER_KIND_HINT: Record<SkillOwnerKind, string> = {
  builtin: '技能随内置 Agent 装配进系统提示词，关掉后该 Agent 不再具备这项能力。',
  subagent: '技能由子 Agent 按需读取；关掉后它在派发任务里读不到这份说明。',
  user: '你自己加的技能，只注入主 Agent。删除会移除它的文件夹。',
}

function filterSkills(skills: readonly SkillItemView[], query: string, owner: OwnerFilter): SkillItemView[] {
  const needle = query.trim().toLowerCase()
  return skills.filter((skill) => {
    if (owner !== 'all' && skill.ownerKind !== owner) return false
    if (!needle) return true
    return [skill.name, skill.description, skill.ownerName, skill.path]
      .some((field) => field.toLowerCase().includes(needle))
  })
}

function groupByOwner(skills: readonly SkillItemView[]): OwnerGroup[] {
  const groups = new Map<string, OwnerGroup>()
  for (const skill of skills) {
    const key = `${skill.ownerKind}:${skill.ownerId}`
    const existing = groups.get(key)
    if (existing) {
      existing.skills.push(skill)
      continue
    }
    groups.set(key, { key, name: skill.ownerName, kind: skill.ownerKind, skills: [skill] })
  }
  return [...groups.values()]
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  return `${(bytes / 1024).toFixed(1)} KB`
}

export function SkillsPage() {
  const { state, reload, pending, setEnabled, createSkill, importDirectory, removeSkill } = useSkills()
  const [query, setQuery] = useState('')
  const [owner, setOwner] = useState<OwnerFilter>('all')
  const [detailId, setDetailId] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<SkillItemView | null>(null)

  const skills = state.status === 'ready' ? state.value.skills : []
  const counts = state.status === 'ready' ? state.value.counts : { total: 0, enabled: 0 }
  const visible = useMemo(() => filterSkills(skills, query, owner), [skills, query, owner])
  const groups = useMemo(() => groupByOwner(visible), [visible])

  const toggle = useCallback((skill: SkillItemView, next: boolean) => {
    void setEnabled(skill.id, next)
      .then(() => {
        workbenchToast(next ? `已启用「${skill.name}」` : `已停用「${skill.name}」，${skill.ownerName} 不再使用它`)
      })
      .catch((error: unknown) => {
        workbenchToast(`「${skill.name}」切换失败：${error instanceof Error ? error.message : '请稍后重试'}`)
      })
  }, [setEnabled])

  return (
    <div className="wb-home-scroll">
      <PageHeader
        title="技能"
        subtitle="Agent 可以调用的成熟能力。关掉的技能不会进入它的上下文，随时可以再打开。"
        actions={(
          <>
            {state.status === 'ready' ? (
              <Badge tone={counts.enabled === counts.total ? 'neutral' : 'warning'}>
                {counts.enabled} / {counts.total} 已启用
              </Badge>
            ) : null}
            <Button variant="primary" size="sm" icon={<Plus size={13} />} onClick={() => setCreateOpen(true)}>
              新增技能
            </Button>
          </>
        )}
      />

      {state.status === 'error' ? (
        <EmptyState
          icon={<Sparkles size={18} />}
          title="技能清单读取失败"
          description="网关没有返回技能目录。确认网关在运行后重试。"
          action={(
            <Button variant="secondary" size="sm" icon={<RotateCw size={13} />} onClick={reload}>
              重试
            </Button>
          )}
        />
      ) : state.status === 'loading' ? (
        <div className="wb-home-state"><Spinner /> 正在读取技能…</div>
      ) : skills.length === 0 ? (
        <HomeNote>
          当前没有可用的技能。内置技能随应用发布，也可以自己新增一个。
          <Button variant="secondary" size="sm" icon={<Plus size={12} />} onClick={() => setCreateOpen(true)}>
            新增技能
          </Button>
        </HomeNote>
      ) : (
        <>
          <div className="wb-skills-toolbar">
            <label className="wb-skills-search">
              <Search size={13} aria-hidden="true" />
              <TextInput
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索技能名称、说明或归属 Agent"
                aria-label="搜索技能"
              />
            </label>
            <Segmented<OwnerFilter>
              ariaLabel="按归属筛选技能"
              items={[
                { key: 'all', label: '全部', count: skills.length },
                { key: 'builtin', label: OWNER_KIND_LABEL.builtin, count: skills.filter((skill) => skill.ownerKind === 'builtin').length },
                { key: 'subagent', label: OWNER_KIND_LABEL.subagent, count: skills.filter((skill) => skill.ownerKind === 'subagent').length },
                { key: 'user', label: OWNER_KIND_LABEL.user, count: skills.filter((skill) => skill.ownerKind === 'user').length },
              ]}
              value={owner}
              onChange={setOwner}
            />
          </div>

          {visible.length === 0 ? (
            <HomeNote>没有匹配的技能。</HomeNote>
          ) : (
            <div className="wb-skills-groups">
              {groups.map((group) => (
                <section key={group.key} className="wb-skills-group" aria-label={`${group.name} 的技能`}>
                  <header className="wb-skills-group-head">
                    <h2>{group.name}</h2>
                    <Badge tone={group.kind === 'builtin' ? 'accent' : 'neutral'}>
                      {OWNER_KIND_LABEL[group.kind]}
                    </Badge>
                    <span className="wb-skills-group-count">{group.skills.length} 个</span>
                  </header>
                  <p className="wb-skills-group-hint">{OWNER_KIND_HINT[group.kind]}</p>
                  <div className="wb-skills-list">
                    {group.skills.map((skill) => (
                      <div key={skill.id} className="wb-skills-row" data-disabled={!skill.enabled || undefined}>
                        <button
                          type="button"
                          className="wb-skills-row-main"
                          onClick={() => setDetailId(skill.id)}
                          title="查看技能说明"
                        >
                          <span className="wb-skills-row-name">{skill.name}</span>
                          <span className="wb-skills-row-desc">
                            {skill.description || '这个技能没有写说明。'}
                          </span>
                          <span className="wb-skills-row-meta">{skill.path} · {formatBytes(skill.bytes)}</span>
                        </button>
                        <div className="wb-skills-row-side">
                          <span className="wb-skills-row-state">{skill.enabled ? '已启用' : '已停用'}</span>
                          <Toggle
                            checked={skill.enabled}
                            busy={pending.includes(skill.id)}
                            onChange={(next) => toggle(skill, next)}
                            label={skill.enabled ? `停用「${skill.name}」` : `启用「${skill.name}」`}
                          />
                          {/* 只有自定义技能能删：内置与子 Agent 技能是应用包内的发布物。 */}
                          {skill.ownerKind === 'user' ? (
                            <IconButton
                              size="sm"
                              tone="danger"
                              label={`删除「${skill.name}」`}
                              icon={<Trash2 size={13} />}
                              onClick={() => setDeleteTarget(skill)}
                            />
                          ) : null}
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}
        </>
      )}

      <SkillDetailModal skillId={detailId} onClose={() => setDetailId(null)} />

      <CreateSkillDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreate={async (input) => {
          await createSkill(input)
          workbenchToast(`已新增「${input.name}」，主 Agent 现在可以用它`)
        }}
        onImport={async () => {
          const imported = await importDirectory()
          if (imported) workbenchToast('技能已导入')
          return imported
        }}
      />

      <DeleteSkillDialog
        skill={deleteTarget}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}
        onConfirm={async (skill) => {
          await removeSkill(skill.id)
          workbenchToast(`已删除「${skill.name}」`)
        }}
      />
    </div>
  )
}

type DetailState =
  | { status: 'loading' }
  | { status: 'ready'; value: SkillDetailView }
  | { status: 'missing' }

/** 详情弹窗：SKILL.md 全文按原文展示（它就是写给模型读的，不做二次排版）。 */
function SkillDetailModal({ skillId, onClose }: { skillId: string | null; onClose: () => void }) {
  const [detail, setDetail] = useState<DetailState>({ status: 'loading' })

  useEffect(() => {
    if (!skillId) return
    let cancelled = false
    setDetail({ status: 'loading' })
    void Promise.resolve(window.nxcore?.agent?.getSkill?.(skillId))
      .then((raw) => {
        if (cancelled) return
        const value = toSkillDetail(raw)
        setDetail(value ? { status: 'ready', value } : { status: 'missing' })
      })
      .catch(() => {
        if (!cancelled) setDetail({ status: 'missing' })
      })
    return () => { cancelled = true }
  }, [skillId])

  const skill = detail.status === 'ready' ? detail.value : null

  return (
    <Modal
      open={skillId !== null}
      onOpenChange={(open) => { if (!open) onClose() }}
      size="lg"
      title={skill?.name ?? '技能说明'}
      description={skill ? `${skill.ownerName} · ${skill.path}` : undefined}
      footer={(
        <Button variant="secondary" size="sm" onClick={onClose}>关闭</Button>
      )}
    >
      {detail.status === 'loading' ? (
        <div className="wb-home-state"><Spinner /> 正在读取 SKILL.md…</div>
      ) : detail.status === 'missing' ? (
        <HomeNote>这个技能读不到了：它可能已经随版本更新被移除。</HomeNote>
      ) : skill ? (
        <div className="wb-skills-detail">
          <div className="wb-skills-detail-meta">
            <span>{skill.enabled ? '已启用' : '已停用'}</span>
            <span>{formatBytes(skill.bytes)}</span>
            <span>路径 {skill.path}</span>
          </div>
          {skill.description ? <p className="wb-skills-detail-desc">{skill.description}</p> : null}
          <pre className="wb-skills-prompt">{skill.prompt || '（SKILL.md 是空的）'}</pre>
        </div>
      ) : null}
    </Modal>
  )
}
