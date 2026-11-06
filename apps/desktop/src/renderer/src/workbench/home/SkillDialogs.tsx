import { useState } from 'react'

import { describeSkillError } from '../../../../shared/skill-error-message'

import { Modal } from '../ui/modal'
import { Button, Field, Segmented, TextArea, TextInput } from '../ui/primitives'
import { HomeNote } from './parts'
import type { CreateSkillInput, SkillItemView } from './useSkills'

/**
 * 技能页的两个弹窗：新增（手写 / 从文件夹导入）与删除确认。
 *
 * 校验的**权威**在网关（目录名合法性、SKILL.md 是否存在、体积上限），这里只做
 * 空值拦截与错误话术翻译，避免两份规则漂移。
 */

type CreateMode = 'write' | 'folder'

const CREATE_MODES: ReadonlyArray<{ key: CreateMode; label: string }> = [
  { key: 'write', label: '手写 SKILL.md' },
  { key: 'folder', label: '从文件夹导入' },
]

export function CreateSkillDialog({
  open, onOpenChange, onCreate, onImport,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreate: (input: CreateSkillInput) => Promise<void>
  /** 选目录并导入；用户取消返回 false。 */
  onImport: () => Promise<boolean>
}) {
  const [mode, setMode] = useState<CreateMode>('write')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reset = () => {
    setMode('write')
    setName('')
    setDescription('')
    setBody('')
    setBusy(false)
    setError(null)
  }

  const submit = async () => {
    const trimmedName = name.trim()
    const trimmedDescription = description.trim()
    const trimmedBody = body.trim()
    if (!trimmedName) {
      setError('请填写技能名')
      return
    }
    if (trimmedName.includes('/') || trimmedName.includes('\\')) {
      setError('技能名不能包含 / 或反斜杠')
      return
    }
    if (!trimmedDescription) {
      setError('请写一句技能说明')
      return
    }
    if (!trimmedBody) {
      setError('请写技能正文')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await onCreate({ name: trimmedName, description: trimmedDescription, body: trimmedBody })
      onOpenChange(false)
    } catch (submitError) {
      setError(describeSkillError(submitError))
    } finally {
      setBusy(false)
    }
  }

  const importFromFolder = async () => {
    setBusy(true)
    setError(null)
    try {
      const imported = await onImport()
      if (imported) onOpenChange(false)
    } catch (importError) {
      setError(describeSkillError(importError))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (!next) reset()
        onOpenChange(next)
      }}
      title="新增技能"
      size="md"
      footer={(
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>取消</Button>
          {mode === 'write' ? (
            <Button variant="primary" onClick={() => { void submit() }} disabled={busy}>
              {busy ? '正在创建…' : '创建技能'}
            </Button>
          ) : (
            <Button variant="primary" onClick={() => { void importFromFolder() }} disabled={busy}>
              {busy ? '正在导入…' : '选择文件夹'}
            </Button>
          )}
        </>
      )}
    >
      <div className="wb-skills-form">
        <Segmented<CreateMode>
          ariaLabel="新增技能的方式"
          items={CREATE_MODES}
          value={mode}
          onChange={(next) => { setMode(next); setError(null) }}
        />

        {mode === 'write' ? (
          <>
            <Field label="技能名">
              <TextInput
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="weekly-report"
                autoFocus
              />
            </Field>
            <Field label="一句话说明">
              <TextInput
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="把本周邮件与会议汇总成周报"
              />
            </Field>
            <Field label="正文（Markdown）">
              <TextArea
                className="wb-skills-body-input"
                value={body}
                onChange={(event) => setBody(event.target.value)}
                placeholder={'# 周报\n\n1. 汇总本周会议结论\n2. 列出风险与待确认项'}
              />
            </Field>
          </>
        ) : (
          <HomeNote>选择一个包含 SKILL.md 的文件夹。</HomeNote>
        )}

        {error ? <p className="wb-skills-form-error" role="alert">{error}</p> : null}
      </div>
    </Modal>
  )
}

export function DeleteSkillDialog({
  skill, onOpenChange, onConfirm,
}: {
  skill: SkillItemView | null
  onOpenChange: (open: boolean) => void
  onConfirm: (skill: SkillItemView) => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const confirm = async () => {
    if (!skill) return
    setBusy(true)
    setError(null)
    try {
      await onConfirm(skill)
      onOpenChange(false)
    } catch (deleteError) {
      setError(describeSkillError(deleteError))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={skill !== null}
      onOpenChange={(next) => { if (!next) { setError(null); onOpenChange(false) } }}
      title={skill ? `删除「${skill.name}」？` : '删除技能'}
      size="sm"
      footer={(
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>取消</Button>
          <Button variant="danger" onClick={() => { void confirm() }} disabled={busy}>
            {busy ? '正在删除…' : '删除'}
          </Button>
        </>
      )}
    >
      <div className="wb-skills-form">
        {skill ? <p className="wb-skills-form-note">{skill.path}</p> : null}
        {error ? <p className="wb-skills-form-error" role="alert">{error}</p> : null}
      </div>
    </Modal>
  )
}
