import { FolderOpen, Plus, X } from 'lucide-react'
import { useEffect, useState } from 'react'

import { workbenchApi } from '../api'
import { useWorkbenchStore } from '../state/store'
import { Button, Field, IconButton, TextArea, TextInput } from '../ui/primitives'
import { Modal } from '../ui/modal'
import { cn } from '../ui/cn'

/**
 * 新建项目空间：名称 / 描述 / 目标（药丸增删）/ 空间目录。
 *
 * 目录不再需要手动选：默认落点是 `<dataDir>/Workspace/<slug>`（由网关按名称生成），
 * 弹窗实时预览并在用户改名时更新；想放到别处再点「改到其他位置」（external 模式）。
 * 方案见 docs/project-space-layout-plan.zh-CN.md §8.1。
 */
export function CreateWorkspaceDialog({ open, onOpenChange }: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const createWorkspace = useWorkbenchStore((state) => state.createWorkspace)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [goals, setGoals] = useState<string[]>([])
  const [goalDraft, setGoalDraft] = useState('')
  const [path, setPath] = useState<string | null>(null)
  const [defaultRoot, setDefaultRoot] = useState<{ root: string; slug: string; exists: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 每次打开重置表单（取消后不留脏数据）。
  useEffect(() => {
    if (!open) return
    setName('')
    setDescription('')
    setGoals([])
    setGoalDraft('')
    setPath(null)
    setError(null)
    setBusy(false)
  }, [open])

  // 默认落点预览：手选了目录就不查；名称变化去抖 200ms，避免每个按键都打网关。
  useEffect(() => {
    if (!open || path) return
    let cancelled = false
    const timer = setTimeout(() => {
      void workbenchApi
        .defaultRoot(name.trim() || 'New space')
        .then((result) => { if (!cancelled) setDefaultRoot(result) })
        .catch(() => { if (!cancelled) setDefaultRoot(null) })
    }, 200)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [open, name, path])

  const addGoal = () => {
    const value = goalDraft.trim()
    if (!value) return
    if (goals.length >= 12) {
      setError('最多添加 12 个目标')
      return
    }
    if (goals.includes(value)) {
      setGoalDraft('')
      return
    }
    setGoals((current) => [...current, value])
    setGoalDraft('')
    setError(null)
  }

  const pickDirectory = async () => {
    const picked = await window.nxcore?.workspace?.pickDirectory().catch(() => null)
    if (picked) setPath(picked)
  }

  const submit = async () => {
    const trimmed = name.trim()
    if (!trimmed) {
      setError('请填写空间名称')
      return
    }
    setBusy(true)
    setError(null)
    const created = await createWorkspace({
      name: trimmed,
      description: description.trim() || null,
      goals,
      path,
    })
    setBusy(false)
    if (created) onOpenChange(false)
    else setError('创建失败，请稍后重试')
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="新建项目空间"
      size="md"
      dismissible={!busy}
      footer={(
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>取消</Button>
          <Button variant="primary" onClick={() => { void submit() }} disabled={busy}>
            {busy ? '创建中…' : '创建空间'}
          </Button>
        </>
      )}
    >
      <div className="wb-newspace-form">
        <Field label="空间名称" htmlFor="wb-newspace-name">
          <TextInput
            id="wb-newspace-name"
            autoFocus
            value={name}
            placeholder="例如：连接器项目"
            maxLength={120}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') void submit() }}
          />
        </Field>

        <Field label="描述（可选）" htmlFor="wb-newspace-desc">
          <TextArea
            id="wb-newspace-desc"
            value={description}
            maxLength={2000}
            rows={3}
            onChange={(event) => setDescription(event.target.value)}
          />
        </Field>

        <Field label="目标（可选）">
          <div className="wb-newspace-goals">
            {goals.map((goal) => (
              <span key={goal} className="wb-newspace-goal" title={goal}>
                <span className="wb-newspace-goal-text">{goal}</span>
                <button
                  type="button"
                  aria-label={`移除目标 ${goal}`}
                  onClick={() => setGoals((current) => current.filter((item) => item !== goal))}
                >
                  <X size={11} />
                </button>
              </span>
            ))}
            <span className="wb-newspace-goal-add">
              <Plus size={12} aria-hidden="true" />
              <input
                value={goalDraft}
                placeholder="新目标"
                aria-label="添加目标"
                onChange={(event) => setGoalDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    addGoal()
                  }
                }}
                onBlur={addGoal}
              />
            </span>
          </div>
        </Field>

        <Field
          label="空间目录"
          hint={path
            ? '目录将就地接管为项目空间（只新增 .everoffice/ 元数据目录，其余文件原样保留、直接作为资料库）'
            : defaultRoot
              ? `默认建在应用目录下；根上只有 .everoffice/（元数据）和 .tmp/（过程缓存），其余位置都留给你放资料${defaultRoot.exists ? '。同名目录已存在，将自动改用带后缀的名字' : ''}`
              : '默认建在应用目录下（Workspace）'}
        >
          <div className="wb-newspace-path">
            <span
              className={cn('wb-newspace-path-value', !path && !defaultRoot && 'is-empty')}
              title={path ?? defaultRoot?.root ?? undefined}
            >
              <span className="wb-newspace-path-text">
                {path ?? defaultRoot?.root ?? '正在解析默认目录…'}
              </span>
            </span>
            {path ? (
              <IconButton label="恢复默认目录" size="sm" icon={<X size={13} />} onClick={() => setPath(null)} />
            ) : null}
            <Button variant="secondary" icon={<FolderOpen size={14} />} onClick={() => { void pickDirectory() }}>
              {path ? '换目录' : '改到其他位置'}
            </Button>
          </div>
        </Field>

        {error ? <div className="ui-field-error" role="alert">{error}</div> : null}
      </div>
    </Modal>
  )
}
