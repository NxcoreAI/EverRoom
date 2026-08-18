import { ArrowRight, Folder, Layers3, Mail, Mic } from 'lucide-react'

import type { ContextRoomKind } from '../types'
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
  if (!ROOM_RECOMMENDATIONS.length) return null;
  return (
    <section className="context-room-home-section" data-testid="context-room-recommendations">
      <div className="context-room-home-section-title">
        <span>推荐</span>
        <h2>推荐的 Room</h2>
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
              <span className="context-room-recommendation-count" title={`相关资料 ${String(item.dataCount)} 份`}>
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
  onCreate: (draft: DraftRoom) => void
  onOpenSource: (source: RoomRecommendationSource) => void
}) {
  return (
    <div className="context-room-recommendation-dialog">
      <header>
        <div>
          <span>推荐创建 Room：{recommendation.name}</span>
          <h2>{recommendation.anchorEntity.name}</h2>
        </div>
      </header>
      <p>{recommendation.anchorEntity.description}</p>
      <div className="context-room-recommendation-stats">
        <div><b>{recommendation.factCount}</b><span>事实数量</span></div>
        <div><b>{recommendation.dataCount}</b><span>资料数</span></div>
      </div>
      <section>
        <h3>相关资料 ({recommendation.sources.length})</h3>
        <div className="context-room-recommendation-source-list">
          {recommendation.sources.map((source) => {
            const Icon = sourceIcon(source.type)
            return (
              <button
                type="button"
                disabled={!source.roomId || !source.objectId}
                title={source.objectId ? `打开${source.type}` : '该资料暂未接入当前工作区'}
                key={`${source.type}-${source.name}`}
                onClick={() => onOpenSource(source)}
              >
                <span data-icon-tone={sourceTone(source.type)}><Icon aria-hidden="true" />{source.type}</span>
                <b>{source.name}</b>
              </button>
            )
          })}
        </div>
      </section>
      <footer>
        <button type="button" className="context-room-secondary" onClick={onClose}>取消</button>
        <button
          type="button"
          className="context-room-primary"
          onClick={() => onCreate({
            name: recommendation.name,
            kind: recommendation.kind,
            summary: recommendation.anchorEntity.description,
          })}
        >
          确认创建
          <ArrowRight aria-hidden="true" />
        </button>
      </footer>
    </div>
  )
}
