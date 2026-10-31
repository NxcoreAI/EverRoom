import { FolderOpen, Plus, X } from 'lucide-react'
import { useEffect, useState } from 'react'

import { useWorkbenchStore } from '../state/store'
import { Button, Field, IconButton, TextArea, TextInput } from '../ui/primitives'
import { Modal } from '../ui/modal'
import { cn } from '../ui/cn'

/** 新建项目空间：名称 / 描述 / 目标（药丸增删）/ 本地目录，创建后开标签并进入三步引导。 */
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

        <Field label="本地目录（可选）">
          <div className="wb-newspace-path">
            <span className={cn('wb-newspace-path-value', !path && 'is-empty')} title={path ?? undefined}>
              <span className="wb-newspace-path-text">{path ?? '未选择目录'}</span>
            </span>
            {path ? (
              <IconButton label="清除目录" size="sm" icon={<X size={13} />} onClick={() => setPath(null)} />
            ) : null}
            <Button variant="secondary" icon={<FolderOpen size={14} />} onClick={() => { void pickDirectory() }}>
              选择
            </Button>
          </div>
        </Field>

        {error ? <div className="ui-field-error" role="alert">{error}</div> : null}
      </div>
    </Modal>
  )
}
