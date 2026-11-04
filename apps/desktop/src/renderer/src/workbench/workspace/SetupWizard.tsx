import { Check, CheckCircle2, FilePlus2, RefreshCw, Sparkles, TriangleAlert } from 'lucide-react'
import { useState, type ReactNode } from 'react'

import type { AgentWorkspace } from '@nxcore/agent-contract'

import {
  type ImportOutcomeView,
  bridgeErrorMessage,
  createLocalId,
  normalizeImportOutcomes,
  summarizeImportOutcomes,
} from './setupData'
import { Button, TextInput } from '../ui/primitives'
import { Modal } from '../ui/modal'
import { cn } from '../ui/cn'
import './tools.css'

const MAX_WORKS = 5

interface SetupStep {
  key: string
  title: string
  icon: ReactNode
}

const STEPS: readonly SetupStep[] = [
  {
    key: 'files',
    title: '上传资料',
    icon: <FilePlus2 size={15} />,
  },
  {
    key: 'works',
    title: '添加工作',
    icon: <Sparkles size={15} />,
  },
]

interface CreatedWork {
  /** 列表 key：真实 sessionId 可能重复（浏览器 mock），渲染用本地 key。 */
  key: string
  sessionId: string
  title: string
  named: boolean
}

/**
 * 新建空间后的两步引导。
 *
 * 真实操作：
 * ① `files.pickAndImport()` 逐文件展示成功/失败
 * ② `agent.createSession({pageLabel:'Agent', roomId:null, workspaceId})` + `updateSession(id,{title})`
 *
 * 「跳过某一步不丢前面结果」的实现：每一步的真实操作在用户点按钮时就已经落库
 * （文件已导入、会话已创建），组件里只累积展示用的结果；跳过/翻页只决定是否展示
 * 本步尚未完成草稿，绝不会清空前几步已完成的结果。
 * （原型 WsCreateFlow 的 bug 是最后一步「跳过此项」直接用空结果 onDone，这里修掉了。）
 */
export function SetupWizard({ workspace, onDone }: {
  workspace: AgentWorkspace
  onDone: () => void
}) {
  const [step, setStep] = useState(0)

  // ① 资料
  const [imported, setImported] = useState<ImportOutcomeView[]>([])
  const [importing, setImporting] = useState(false)
  const [importError, setImportError] = useState<string | null>(null)

  // ② 工作
  const [workTitle, setWorkTitle] = useState('')
  const [works, setWorks] = useState<CreatedWork[]>([])
  const [creatingWork, setCreatingWork] = useState(false)
  const [workError, setWorkError] = useState<string | null>(null)

  const importSummary = summarizeImportOutcomes(imported)
  const showSummary = importSummary.total > 0 || works.length > 0

  const importFiles = async () => {
    setImporting(true)
    setImportError(null)
    try {
      const bridge = window.nxcore?.files
      if (!bridge?.pickAndImport) throw new Error('桌面服务文件接口未就绪，请重启 EverRoom')
      // 引导发生在本空间内：导入即归属本空间（资料库按空间隔离）。
      const raw = await bridge.pickAndImport({ workspaceId: workspace.id })
      const outcomes = normalizeImportOutcomes(raw)
      if (outcomes.length === 0) {
        setImportError('没有选择文件，或格式不支持。')
      } else {
        setImported((current) => [...current, ...outcomes])
      }
    } catch (error) {
      setImportError(bridgeErrorMessage(error, '导入失败'))
    } finally {
      setImporting(false)
    }
  }

  const createWork = async () => {
    const title = workTitle.trim()
    if (!title) {
      setWorkError('工作名称不能为空。')
      return
    }
    if (works.length >= MAX_WORKS) {
      setWorkError(`一次最多添加 ${MAX_WORKS} 个工作。`)
      return
    }
    const bridge = window.nxcore?.agent
    if (!bridge?.createSession) {
      setWorkError('桌面服务 Agent 接口未就绪，请重启 EverRoom')
      return
    }
    setCreatingWork(true)
    setWorkError(null)
    try {
      const session = await bridge.createSession({ pageLabel: 'Agent', roomId: null, workspaceId: workspace.id })
      const sessionId = session?.id
      if (!sessionId) throw new Error('创建工作失败：网关没有返回会话 id')
      let named = true
      if (bridge.updateSession) {
        try {
          await bridge.updateSession(sessionId, { title })
        } catch {
          named = false
        }
      } else {
        named = false
      }
      setWorks((current) => [...current, { key: createLocalId(), sessionId, title, named }])
      setWorkTitle('')
      if (!named) setWorkError('工作已创建，命名失败。')
    } catch (error) {
      setWorkError(bridgeErrorMessage(error, '创建工作失败'))
    } finally {
      setCreatingWork(false)
    }
  }

  const isLastStep = step >= STEPS.length - 1

  /** 下一步：最后一步即完成。 */
  const goNext = () => {
    if (isLastStep) {
      onDone()
      return
    }
    setStep(step + 1)
  }

  /** 跳过本步：只放弃本步未完成的内容，前几步已落库的结果原样保留。 */
  const skipStep = () => {
    if (isLastStep) {
      onDone()
      return
    }
    setStep(step + 1)
  }

  // 步骤完成态只算本次引导里真正做成的事。
  const doneFlags = [importSummary.succeeded > 0, works.length > 0]

  return (
    <Modal
      open
      onOpenChange={() => undefined}
      title={`「${workspace.name}」已创建`}
      size="lg"
      dismissible={false}
      footer={(
        <>
          <Button variant="ghost" onClick={onDone}>全部跳过</Button>
          <span className="wb-setup-foot-spacer" />
          <Button variant="secondary" onClick={skipStep}>跳过本步</Button>
          <Button variant="primary" icon={isLastStep ? <Check size={14} /> : undefined} onClick={goNext}>
            {isLastStep ? '完成' : '下一步'}
          </Button>
        </>
      )}
    >
      <div className="wb-setup">
        <ol className="wb-setup-steps">
          {STEPS.map((item, index) => {
            const done = doneFlags[index]
            return (
              <li key={item.key} className={cn(index === step && 'is-current', done && 'is-done')}>
                <button
                  type="button"
                  className="wb-setup-step-btn"
                  aria-current={index === step ? 'step' : undefined}
                  onClick={() => setStep(index)}
                >
                  <span className="wb-setup-step-icon" aria-hidden="true">
                    {done ? <Check size={14} /> : item.icon}
                  </span>
                  <span className="wb-setup-step-label">{item.title}</span>
                  {done ? <span className="wb-setup-step-state">已记录</span> : null}
                </button>
              </li>
            )
          })}
        </ol>

        {/* 跨步骤结果摘要：跳过/翻页都不会清空，用户随时能看到已经做成了什么。 */}
        {showSummary ? (
          <div className="wb-setup-summary" aria-label="本空间进度">
            <span><strong>{importSummary.succeeded}</strong> 份资料</span>
            <span><strong>{works.length}</strong> 项工作</span>
          </div>
        ) : null}

        <div className="wb-setup-body">
          {step === 0 ? (
            <section className="wb-setup-section">
              <div className="wb-setup-row">
                <Button
                  variant="secondary"
                  size="sm"
                  icon={importing ? <RefreshCw size={13} /> : <FilePlus2 size={14} />}
                  disabled={importing}
                  onClick={() => { void importFiles() }}
                >
                  {importing ? '导入中…' : imported.length > 0 ? '再导入一批' : '选择文件并导入'}
                </Button>
                {imported.length > 0 ? (
                  <span className="wb-setup-count">
                    成功 {importSummary.succeeded} · 失败 {importSummary.failed}
                    {importSummary.skipped > 0 ? ` · 跳过 ${importSummary.skipped}` : ''}
                  </span>
                ) : null}
              </div>
              {importError ? <div className="wb-tool-error" role="alert">{importError}</div> : null}
              {imported.length > 0 ? (
                <ul className="wb-setup-result-list">
                  {imported.map((outcome, index) => (
                    <li key={`${outcome.filename}-${index}`} className={cn('wb-setup-result', !outcome.ok && 'is-failed')}>
                      <span className="wb-setup-result-icon" aria-hidden="true">
                        {outcome.ok ? <CheckCircle2 size={14} /> : <TriangleAlert size={14} />}
                      </span>
                      <span className="wb-setup-result-name">{outcome.filename}</span>
                      <span className="wb-setup-result-state">
                        {outcome.ok ? (outcome.skipped ? '已存在/跳过' : '已导入') : (outcome.error ?? '导入失败')}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </section>
          ) : null}

          {step === 1 ? (
            <section className="wb-setup-section">
              <div className="wb-setup-work-form">
                <TextInput
                  value={workTitle}
                  aria-label="工作名称"
                  placeholder="例如：整理发布计划"
                  maxLength={120}
                  onChange={(event) => setWorkTitle(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      void createWork()
                    }
                  }}
                />
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<Sparkles size={13} />}
                  disabled={creatingWork || works.length >= MAX_WORKS}
                  onClick={() => { void createWork() }}
                >
                  {creatingWork ? '创建中…' : '添加工作'}
                </Button>
              </div>
              {workError ? <div className="wb-tool-error" role="alert">{workError}</div> : null}
              {works.length > 0 ? (
                <ul className="wb-setup-result-list">
                  {works.map((work) => (
                    <li key={work.key} className="wb-setup-result">
                      <span className="wb-setup-result-icon" aria-hidden="true"><CheckCircle2 size={14} /></span>
                      <span className="wb-setup-result-name">{work.title}</span>
                      <span className="wb-setup-result-state">{work.named ? '已创建' : '已创建 · 未命名'}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </section>
          ) : null}
        </div>
      </div>
    </Modal>
  )
}
