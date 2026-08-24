import { AlertCircle, LoaderCircle } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { PerceptionNodeDetail, RealityTag } from '../../../../shared/sources'
import { useLocale } from '../../i18n/LocaleContext'

const SYSTEM_PERCEPTION_KEYS: Record<string, string> = {
  '屏幕活动': 'perception.screenActivity',
  '照片': 'perception.photo',
  '等待视觉理解': 'perception.waiting',
}

export function perceptionDisplayText(value: string, t: (key: string) => string): string {
  const key = SYSTEM_PERCEPTION_KEYS[value]
  return key ? t(key) : value
}

const ENTITY_TYPE_KEYS: Record<NonNullable<RealityTag['entityType']>, string> = {
  person: 'diaryReality:reality.entityType.person',
  organization: 'diaryReality:reality.entityType.organization',
  project: 'diaryReality:reality.entityType.project',
  product: 'diaryReality:reality.entityType.product',
  place: 'diaryReality:reality.entityType.place',
  other: 'diaryReality:reality.entityType.other',
}

export function realityTagKindLabel(tag: RealityTag, t: (key: string) => string): string {
  if (tag.kind !== 'entity') return t('diaryReality:reality.fact')
  const key = tag.entityType ? ENTITY_TYPE_KEYS[tag.entityType] : undefined
  return key ? t(key) : t('diaryReality:reality.entity')
}

export function VisualDetail({ node }: { node: PerceptionNodeDetail }) {
  const { t } = useLocale()
  const { t: perceptionT } = useTranslation('diaryReality')
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
        {imageUrl ? <img src={imageUrl} alt={t(node.kind === 'photo' ? 'diaryReality:visualPerception.perceptionPhoto' : 'diaryReality:visualPerception.windowScreenshots')} /> : (
          <div className="visual-perception-image-state">
            {imageFailed ? <AlertCircle aria-hidden="true" /> : <LoaderCircle className="spin" aria-hidden="true" />}
            <span>{t(imageFailed ? 'diaryReality:visualPerception.unableToLoadRepresentativeImage' : 'diaryReality:visualPerception.loadingLocalRepresentativeImage')}</span>
          </div>
        )}
        <span>{node.sampleCount > 1 ? t('diaryReality:visualPerception.sequenceCountFrames', { count: node.sampleCount }) : t('diaryReality:visualPerception.singleFrame')}</span>
      </div>
      <div className="visual-perception-reading">
        <section>
          <span>{t('diaryReality:visualPerception.visualSummary')}</span>
          <h3>{perceptionDisplayText(node.title, perceptionT)}</h3>
          <p>{perceptionDisplayText(node.summary, perceptionT)}</p>
        </section>
        <section>
          <span>{t('diaryReality:visualPerception.keyPoints')}</span>
          {node.keyPoints.length > 0 ? (
            <div className="visual-perception-tags">
              {node.keyPoints.map((point) => <span key={point}>{point}</span>)}
            </div>
          ) : <p className="visual-perception-muted">{t('diaryReality:visualPerception.noKeyPoints')}</p>}
        </section>
        <section>
          <span>{t('diaryReality:visualPerception.entitiesAndFacts')}</span>
          {node.insightTags.length > 0 ? (
            <div className="visual-perception-tags">
              {node.insightTags.map((tag) => <span key={`${tag.kind}:${tag.label}`} data-kind={tag.kind} title={tag.label}>{realityTagKindLabel(tag, perceptionT)} · {tag.label}</span>)}
            </div>
          ) : <p className="visual-perception-muted">{t('diaryReality:visualPerception.noRepresentativeTags')}</p>}
        </section>
        <dl>
          <div><dt>{t('diaryReality:visualPerception.eventType')}</dt><dd>{node.eventType ?? t('diaryReality:visualPerception.uncategorized')}</dd></div>
          <div><dt>{t('diaryReality:visualPerception.confidence')}</dt><dd>{node.confidence === null ? t('diaryReality:visualPerception.notProvided') : `${Math.round(node.confidence * 100)}%`}</dd></div>
          <div><dt>{t('diaryReality:visualPerception.model')}</dt><dd>{node.model ?? t('diaryReality:visualPerception.pendingLocalProcessing')}</dd></div>
        </dl>
      </div>
    </div>
  )
}
