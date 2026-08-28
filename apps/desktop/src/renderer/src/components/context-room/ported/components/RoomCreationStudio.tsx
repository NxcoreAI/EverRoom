import { FileText, Folder, LoaderCircle, Send, X } from 'lucide-react'
import { useEffect, useState } from 'react'

import { showToast } from '@/state/toast'
import { useLocale } from '../../../../i18n/LocaleContext'
import {
  ROOM_RECOMMENDATION_RUN_EVENT,
  type RoomRecommendationRunPayload,
  type StagedPath,
} from '../roomRecommendationRun'

const basenameOf = (path: StagedPath): string => path.split(/[\\/]/).filter(Boolean).pop() ?? path

/**
 * 新建 Room 统一入口：只暂存文件/文件夹路径与目标描述，不导入。
 * 提交后关闭弹窗，由首页「推荐 Rooms」卡片接手：先统一导入，再走原有
 * 推荐机制（路由 → 实体证据累积 → 达阈值进推荐池），整卡蒙层显示进度。
 */
export function RoomCreationStudio({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useLocale()
  const [intent, setIntent] = useState('')
  const [paths, setPaths] = useState<StagedPath[]>([])
  const [picking, setPicking] = useState(false)

  // 重新打开时保留上一轮暂存内容，避免误关丢列表。
  useEffect(() => {
    if (open) setPicking(false)
  }, [open])

  const pickPaths = async () => {
    const filesApi = window.nxcore?.files
    if (!filesApi?.pickPaths || picking) return
    setPicking(true)
    try {
      const picked = await filesApi.pickPaths()
      if (picked.length > 0) {
        setPaths((current) => {
          const seen = new Set(current)
          return [...current, ...picked.filter((path) => !seen.has(path))]
        })
      }
    } catch (cause) {
      showToast({
        title: t('contextRoom:knowledgePending.uploadFailed'),
        message: cause instanceof Error ? cause.message : undefined,
      })
    } finally {
      setPicking(false)
    }
  }

  const removePath = (path: StagedPath) => {
    setPaths((current) => current.filter((item) => item !== path))
  }

  /** 提交：把暂存路径与描述交接给推荐卡片的进度会话，随即关闭弹窗。 */
  const submit = () => {
    if (paths.length === 0) return
    const payload: RoomRecommendationRunPayload = {
      paths,
      intent: intent.trim() || null,
    }
    window.dispatchEvent(new CustomEvent(ROOM_RECOMMENDATION_RUN_EVENT, { detail: payload }))
    showToast({ title: t('contextRoom:creation.submitted', { count: paths.length }) })
    onOpenChange(false)
  }

  return (
    <div className="context-room-creation-studio" data-testid="context-room-creation-studio">
      <header className="context-room-creation-header">
        <h2>{t('contextRoom:home.newContextRoom')}</h2>
        <p>{t('contextRoom:creation.headerSubtitle')}</p>
      </header>

      <div className="context-room-creation-body">
        <div className="context-room-creation-tabpanel context-room-creation-smart">
          <label className="context-room-creation-description">
            <span>{t('contextRoom:creation.descriptionLabel')}</span>
            <textarea
              rows={3}
              maxLength={2_000}
              value={intent}
              placeholder={t('contextRoom:creation.descriptionPlaceholder')}
              onChange={(event) => setIntent(event.target.value)}
            />
          </label>

          <div className="context-room-creation-files">
            <button
              type="button"
              className="context-room-creation-dropzone"
              data-testid="context-room-creation-dropzone"
              disabled={picking}
              onClick={() => void pickPaths()}
            >
              <span className="context-room-creation-dropzone-icon" aria-hidden="true">
                {picking ? <LoaderCircle className="spin" /> : <Folder />}
              </span>
              <b>{t('contextRoom:creation.pickFiles')}</b>
              <small>{t('contextRoom:creation.dropzoneHint')}</small>
            </button>
            {paths.length > 0 ? (
              <>
                <p className="context-room-creation-filelist-count">
                  {t('contextRoom:creation.filesSelected', { count: paths.length })}
                </p>
                <ul data-testid="context-room-creation-filelist">
                  {paths.map((path) => (
                    <li key={path}>
                      <FileText aria-hidden="true" />
                      <span title={path}>{basenameOf(path)}</span>
                      <button
                        type="button"
                        className="context-room-creation-file-remove"
                        aria-label={t('contextRoom:creation.removeFile', { filename: basenameOf(path) })}
                        onClick={() => removePath(path)}
                      >
                        <X aria-hidden="true" />
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </div>

          <div className="context-room-creation-footer">
            <button
              type="button"
              className="context-room-primary context-room-creation-submit"
              data-testid="context-room-creation-start"
              disabled={picking || paths.length === 0}
              onClick={submit}
            >
              <Send aria-hidden="true" />
              {t('contextRoom:creation.submit')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
