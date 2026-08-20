import { ArrowRight, Folder, Layers3, Mail, Mic } from 'lucide-react'
import { useState } from 'react'
import { useLocale } from '../../../../i18n/LocaleContext'

import type { ContextRoomKind } from '../types'
import { uiText } from '../adapters'
import type { DraftRoom } from './RoomDialogs'
import { roomKindIcon, roomKindTone } from './utils'

export interface RoomRecommendationSource {
  name: string
  objectId?: string
  roomId?: string
  type: '邮件' | '会议' | '文件'
}

export interface RoomRecommendation {
  anchorEntity: { description: string; name: string; type: string }
  dataCount: number
  factCount: number
  id: string
  kind: Extract<ContextRoomKind, '议题' | '事件'>
  name: string
  reason: string
  sources: RoomRecommendationSource[]
}

// 推荐引擎未接入前留空（原演示卡已移除）：首页推荐区在空数组时不渲染。
export const ROOM_RECOMMENDATIONS: RoomRecommendation[] = []

function sourceIcon(type: RoomRecommendationSource['type']) {
  if (type === '邮件') return Mail
  if (type === '文件') return Folder
  return Mic
}

function sourceTone(type: RoomRecommendationSource['type']) {
  if (type === '邮件') return 'communication'
  if (type === '文件') return 'document'
  return 'calendar'
}

export function RoomRecommendations({ onSelect }: { onSelect: (item: RoomRecommendation) => void }) {
  const { t } = useLocale()
  if (!ROOM_RECOMMENDATIONS.length) return null;
  return (
    <section className="context-room-home-section" data-testid="context-room-recommendations">
      <div className="context-room-home-section-title">
        <span>{t('contextRoom:roomRecommendations.recommended')}</span>
        <h2>{t('contextRoom:roomRecommendations.recommendedRooms')}</h2>
      </div>
      <div className="context-room-home-grid context-room-recommendation-grid">
        {ROOM_RECOMMENDATIONS.map((item) => {
          const Icon = roomKindIcon(item.kind)
          return (
            <button
              type="button"
              className="context-room-home-card context-room-recommendation-card"
              key={item.id}
              onClick={() => onSelect(item)}
            >
              <span className="context-room-home-card-icon" data-icon-tone={roomKindTone(item.kind)}>
                <Icon aria-hidden="true" />
              </span>
              <span className="context-room-home-card-body">
                <strong>{item.name}</strong>
                <span className="context-room-home-card-brief">{item.reason}</span>
              </span>
              <span className="context-room-recommendation-count" title={t('contextRoom:roomRecommendations.countRelatedResources', { count: item.dataCount })}>
                <Layers3 aria-hidden="true" />
                <b>{item.dataCount}</b>
              </span>
            </button>
          )
        })}
      </div>
    </section>
  )
}

export function RoomRecommendationDialog({
  recommendation,
  onClose,
  onCreate,
  onOpenSource,
}: {
  recommendation: RoomRecommendation
  onClose: () => void
  onCreate: (draft: DraftRoom) => void | Promise<void>
  onOpenSource: (source: RoomRecommendationSource) => void
}) {
  const { t } = useLocale()
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <div className="context-room-recommendation-dialog">
      <header>
        <div>
          <span>{t('contextRoom:roomRecommendations.recommendedRoomName', { name: recommendation.name })}</span>
          <h2>{recommendation.anchorEntity.name}</h2>
        </div>
      </header>
      <p>{recommendation.anchorEntity.description}</p>
      <div className="context-room-recommendation-stats">
        <div><b>{recommendation.factCount}</b><span>{t('contextRoom:roomRecommendations.facts')}</span></div>
        <div><b>{recommendation.dataCount}</b><span>{t('contextRoom:roomRecommendations.resources')}</span></div>
      </div>
      <section>
        <h3>{t('contextRoom:roomRecommendations.relatedResourcesCount', { count: recommendation.sources.length })}</h3>
        <div className="context-room-recommendation-source-list">
          {recommendation.sources.map((source) => {
            const Icon = sourceIcon(source.type)
            return (
              <button
                type="button"
                disabled={!source.roomId || !source.objectId}
                title={source.objectId ? t('contextRoom:roomRecommendations.openType', { type: t(uiText(source.type)) }) : t('contextRoom:roomRecommendations.thisResourceIsNotAvailableInTheCurrent')}
                key={`${source.type}-${source.name}`}
                onClick={() => onOpenSource(source)}
              >
                <span data-icon-tone={sourceTone(source.type)}><Icon aria-hidden="true" />{t(uiText(source.type))}</span>
                <b>{source.name}</b>
              </button>
            )
          })}
        </div>
      </section>
      {error ? <p className="context-room-form-error" role="alert">{error}</p> : null}
      <footer>
        <button type="button" className="context-room-secondary" disabled={creating} onClick={onClose}>{t('contextRoom:roomRecommendations.cancel')}</button>
        <button
          type="button"
          className="context-room-primary"
          disabled={creating}
          onClick={() => {
            setCreating(true)
            setError(null)
            void Promise.resolve(onCreate({
              name: recommendation.name,
              description: recommendation.anchorEntity.description,
            })).catch((cause: unknown) => {
              setError(cause instanceof Error ? cause.message : t('contextRoom:roomDialogs.createFailed'))
            }).finally(() => setCreating(false))
          }}
        >
          {creating ? t('contextRoom:roomDialogs.creating') : t('contextRoom:roomRecommendations.create')}
          <ArrowRight aria-hidden="true" />
        </button>
      </footer>
    </div>
  )
}
