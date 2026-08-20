import { AlertCircle, LoaderCircle } from 'lucide-react'
import { useEffect, useState } from 'react'

import type { PerceptionNodeDetail } from '../../../../shared/sources'
import { useLocale, type Translate } from '../../i18n/LocaleContext'

const SYSTEM_PERCEPTION_TEXT = new Set(['屏幕活动', '照片', '等待视觉理解'])

export function perceptionDisplayText(value: string, t: Translate): string {
  return SYSTEM_PERCEPTION_TEXT.has(value) ? t(value) : value
}

export function VisualDetail({ node }: { node: PerceptionNodeDetail }) {
  const { t } = useLocale()
  const [imageUrl, setImageUrl] = useState<string | null>(null)
  const [imageFailed, setImageFailed] = useState(false)

  useEffect(() => {
    setImageUrl(null)
    setImageFailed(false)
    if (!node.mediaFileId || !window.nxcore) return
    let cancelled = false
    void window.nxcore.files.readDataUrl(node.mediaFileId)
      .then(({ dataUrl }) => { if (!cancelled) setImageUrl(dataUrl) })
      .catch(() => { if (!cancelled) setImageFailed(true) })
    return () => { cancelled = true }
  }, [node.mediaFileId])

  return (
    <div className="visual-perception-detail">
      <div className="visual-perception-evidence">
        {imageUrl ? <img src={imageUrl} alt={t(node.kind === 'photo' ? '感知照片' : '窗口截图')} /> : (
          <div className="visual-perception-image-state">
            {imageFailed ? <AlertCircle aria-hidden="true" /> : <LoaderCircle className="spin" aria-hidden="true" />}
            <span>{t(imageFailed ? '代表图无法读取' : '正在读取本地代表图')}</span>
          </div>
        )}
        <span>{node.sampleCount > 1 ? t('连续画面 · {count} 帧', { count: node.sampleCount }) : t('单帧画面')}</span>
      </div>
      <div className="visual-perception-reading">
        <section>
          <span>{t('视觉总结')}</span>
          <h3>{perceptionDisplayText(node.title, t)}</h3>
          <p>{perceptionDisplayText(node.summary, t)}</p>
        </section>
        <section>
          <span>{t('关键内容')}</span>
          {node.tags.length > 0 ? (
            <div className="visual-perception-tags">
              {node.tags.map((tag) => <span key={tag}>{tag}</span>)}
            </div>
          ) : <p className="visual-perception-muted">{t('暂无关键内容')}</p>}
        </section>
        <dl>
          <div><dt>{t('事件类型')}</dt><dd>{node.eventType ?? t('未分类')}</dd></div>
          <div><dt>{t('置信度')}</dt><dd>{node.confidence === null ? t('未提供') : `${Math.round(node.confidence * 100)}%`}</dd></div>
          <div><dt>{t('模型')}</dt><dd>{node.model ?? t('本地待处理')}</dd></div>
        </dl>
      </div>
    </div>
  )
}
