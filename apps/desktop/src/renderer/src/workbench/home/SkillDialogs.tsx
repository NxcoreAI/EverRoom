import { useState } from 'react'

import { describeSkillError } from '../../../../shared/skill-error-message'

import { Modal } from '../ui/modal'
import { Button } from '../ui/primitives'
import type { SkillItemView } from './useSkills'

/**
 * 技能页的删除确认弹窗。
 *
 * 校验的**权威**在网关（目录名合法性、SKILL.md 是否存在、体积上限），这里只做
 * 错误话术翻译，避免两份规则漂移。「新增技能」不再走弹窗：直接弹系统选择器
 * 选文件夹或 zip 压缩包（见 SkillsPage 的 startImport）。
 */

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
