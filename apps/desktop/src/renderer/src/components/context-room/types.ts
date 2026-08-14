export type RoomKind = '项目' | '主题' | '人物' | '长期目标' | '议题' | '事件'

export type RoomPane =
  | 'overview'
  | 'documents'
  | 'relations'
  | 'memories'
  | 'schedule'
  | 'tasks'
  | 'mails'

export interface RoomMaterial {
  id: string
  title: string
  type: '文档' | '邮件' | '会议' | '文件'
  updated: string
}

export interface RoomTask {
  id: string
  title: string
  owner: string
  done: boolean
}

export interface RoomMemory {
  id: string
  title: string
  detail: string
  status: '已确认' | '待确认'
}

export interface ContextRoomRecord {
  id: string
  title: string
  kind: RoomKind
  description: string
  updated: string
  people: string[]
  tags: string[]
  materials: RoomMaterial[]
  memories: RoomMemory[]
  tasks: RoomTask[]
}

export interface RoomRecommendation {
  id: string
  title: string
  reason: string
  kind: RoomKind
  materialCount: number
}

export interface GraphNodeRecord {
  id: string
  label: string
  kind: RoomKind | 'fact'
  description: string
}

export interface GraphEdgeRecord {
  id: string
  source: string
  target: string
  label: string
}

export interface ContextGraphData {
  nodes: GraphNodeRecord[]
  edges: GraphEdgeRecord[]
}
