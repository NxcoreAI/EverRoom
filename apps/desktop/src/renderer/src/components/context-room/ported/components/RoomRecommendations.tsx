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

export const ROOM_RECOMMENDATIONS: RoomRecommendation[] = [
  {
    id: 'rec-room-pricing',
    name: 'V1 报价与交付',
    kind: '议题',
    reason: '最近 7 天出现 2 封报价邮件、1 次客户会议和 3 个相关任务。',
    dataCount: 6,
    factCount: 12,
    anchorEntity: {
      name: '张总',
      type: '人物',
      description: '客户对来源追溯和交付范围的要求在最近资料中反复出现。',
    },
    sources: [
      { type: '邮件', name: '关于 NexOS PC 端报价确认', roomId: 'room-launch', objectId: 'mail-quote' },
      { type: '会议', name: '客户沟通会', roomId: 'room-launch', objectId: 'mtg-client' },
    ],
  },
  {
    id: 'rec-room-design',
    name: 'PC 原型评审',
    kind: '事件',
    reason: '设计稿、评审日程和晨会录音围绕同一交付节点持续更新。',
    dataCount: 4,
    factCount: 8,
    anchorEntity: {
      name: '原型 V2 评审',
      type: '事件',
      description: '设计稿、评审日程和晨会录音正在围绕同一个交付节点收敛。',
    },
    sources: [
      { type: '文件', name: 'V2-评审稿.fig', roomId: 'room-launch', objectId: 'file-prototype-review' },
      { type: '会议', name: '原型 V2 评审会' },
    ],
  },
]

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
