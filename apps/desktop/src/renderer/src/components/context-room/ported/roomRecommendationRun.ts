/**
 * 推荐生成会话：创建弹窗（RoomCreationStudio）只暂存文件/文件夹路径与
 * 目标描述；提交后关闭弹窗，把暂存内容经该事件交给首页「推荐 Rooms」
 * 卡片（KnowledgePendingPanel）：先统一导入，再由原有推荐机制（路由 →
 * 实体证据累积 → 达阈值进推荐池）推进，整卡蒙层展示进度。
 */

/** 用户暂存的路径（文件或文件夹，导入时展开）。 */
export type StagedPath = string

export interface RoomRecommendationRunPayload {
  paths: StagedPath[]
  /** 弹窗里填写的目标描述；作为会话标注展示在进度蒙层上。 */
  intent: string | null
}

/** 导入完成后进入推荐链路的文件（路由轮询按 fileId 匹配决策）。 */
export interface UploadedFile {
  fileId: string
  filename: string
}

export const ROOM_RECOMMENDATION_RUN_EVENT = 'everroom:room-recommendation-started'
