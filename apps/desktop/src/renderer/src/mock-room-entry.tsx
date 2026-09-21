// 临时入口:纯浏览器单独挂载 PortedDetail(配合 /@mock/nxcore.js),验证板块导航/页签切换/现场恢复(验证后删除)。
import type { RoomDocument, TiptapJsonContent } from '@nxcore/agent-contract'
import React from 'react'
import { createRoot } from 'react-dom/client'

import { LocaleProvider } from './i18n/LocaleContext'
import { ContextRoomStateProvider } from './components/context-room/ContextRoomStateProvider'
import { RoomDocumentsProvider, useRoomDocumentsState } from './components/context-room/RoomDocumentsProvider'
import { desktopOperationBridge, DocumentOperationProvider } from './components/context-room/operations'
import { AccountProvider } from './state/AccountContext'
import { ActiveDocumentProvider } from './state/ActiveDocumentContext'
import { PortedDetail } from './components/context-room/ported/components/PortedDetail'
import { createEmptyContextRoom } from './components/context-room/ported/contextRoomFactory'
import { loadRoomWorkspaceState } from './components/context-room/ported/roomWorkspaceState'
import type { ContextRoomRecord } from './components/context-room/ported/types'
import './components/context-room/ported/ContextRoom.css'
import '@/styles/tokens.css'
import './styles.css'

const ROOM_ID = 'room-board-mock'

const doc = (id: string, title: string, origin: 'native' | 'import', trashed = false, extraBlocks: TiptapJsonContent['content'] = []): RoomDocument => {
  const contentJson: TiptapJsonContent = {
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: title }] },
      { type: 'paragraph', content: [{ type: 'text', text: `${title} 的正文段落（mock）。` }] },
      ...extraBlocks,
    ],
  }
  return {
    id,
    roomId: ROOM_ID,
    title,
    contentJson,
    contentSchemaVersion: 1,
    version: 1,
    status: 'active',
    origin,
    activeTransactionId: null,
    deletedAt: trashed ? '2026-09-13T00:00:00.000Z' : null,
    createdAt: '2026-09-10T00:00:00.000Z',
    updatedAt: '2026-09-13T00:00:00.000Z',
  }
}

// 发布计划带多章节正文：验证章节级焦点（光标落在哪一节，思路板块就跟到哪一节）。
const releasePlanSections: TiptapJsonContent['content'] = [
  { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: '一、视觉定稿' }] },
  { type: 'paragraph', content: [{ type: 'text', text: 'V1 视觉定稿通过评审，动效统一 240ms，列表类内容做 40ms 错峰。' }] },
  { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: '二、联调窗口' }] },
  { type: 'paragraph', content: [{ type: 'text', text: '视觉定稿后进入连接器联调窗口，与连接器里程碑错峰排期。' }] },
]

const backendDocuments = [
  doc('doc-native-1', '产物：发布计划', 'native', false, releasePlanSections),
  doc('doc-native-2', '产物：复盘草稿', 'native'),
  doc('doc-import-1', '资料：飞书周会纪要', 'import'),
]
const trashedDocuments = [doc('doc-native-trash', '产物：旧方案', 'native', true)]

const room = createEmptyContextRoom({
  id: ROOM_ID,
  title: '板块导航验证',
  kind: '项目',
  background: '验证五大板块归位的 R1 范围：四入口、页签、资料产物分离、现场恢复。',
  goal: '浏览器里可复现 Room 内导航交互',
  briefStatus: '进行中',
})

// 工作/待办与资料的数据面（本地快照部分；连接器邮件/日历走 mock nxcore）。
const localDate = (offset: number, time: string) => {
  const date = new Date()
  date.setDate(date.getDate() + offset)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${time}`
}
room.materials = [
  { id: 'meeting-1', type: '会议', title: '周会：连接器排期', time: localDate(0, '14:00'), summary: '确认阶段一范围与负责人', attendees: ['王小雨', '李明'], location: '会议室 A', meetingActions: [{ id: 'ma-1', title: '输出阶段一排期表', owner: '李明' }] },
  { id: 'meeting-2', type: '会议', title: '设计评审', time: localDate(-3, '10:00'), summary: 'V1 视觉定稿评审', attendees: ['林薇', '王小雨'] },
  { id: 'mail-local-1', type: '邮件', title: '客户反馈汇总', time: localDate(-1, '09:30'), summary: '本周客户反馈共 12 条', sender: '客服组' },
]
room.actionItems = [
  { id: 'task-1', title: '补齐 OAuth 文档', status: '进行中', owner: '林薇', deadline: localDate(1, '18:00').slice(0, 16), completed: false, source: { type: '会议', name: '周会：连接器排期', objectId: 'meeting-1' } },
  { id: 'task-2', title: '确认测试范围', status: '未开始', owner: '我', deadline: '待排期', completed: false },
]

const stored = loadRoomWorkspaceState(ROOM_ID)
let createdCount = 0

/** 与 main.tsx 同构的 Provider 链（编辑器/操作审阅需要），数据仍来自 mock fixture。 */
function DocumentOperationRoot() {
  const { upsertDocument } = useRoomDocumentsState()
  const operationBridge = React.useMemo(() => desktopOperationBridge(), [])
  // 新建文档写回列表：否则新文档资源查不到，焦点会回退到旧文档。
  const [documents, upsert] = React.useReducer(
    (current: RoomDocument[], next: RoomDocument) =>
      current.some((item) => item.id === next.id) ? current.map((item) => (item.id === next.id ? next : item)) : [...current, next],
    backendDocuments,
  )
  // 本地快照更新走真实链路语义（新建任务/延期/勾选等写回后重渲染）。
  const [roomState, applyRoomUpdate] = React.useReducer(
    (current: ContextRoomRecord, updater: (room: ContextRoomRecord) => ContextRoomRecord) => updater(current),
    room,
  )
  return (
    <DocumentOperationProvider operationBridge={operationBridge} onDocumentApplied={upsertDocument}>
      <ActiveDocumentProvider>
        <PortedDetail
          room={roomState}
          rooms={[room]}
          backendDocuments={documents}
          trashedDocuments={trashedDocuments}
          focusedDocumentId={null}
          focusedBlockId={null}
          documentFocusRequestId={null}
          initialActiveBoard={stored?.board ?? 'work'}
          initialSubtab={stored?.subtab}
          onActiveBoardChange={() => undefined}
          onBack={() => undefined}
          onOpenRoom={() => undefined}
          onUpdateRoom={applyRoomUpdate}
          onBackendDocumentChange={upsert}
          onCreateDocument={async (_roomId, title) => {
            createdCount += 1
            const created = doc(`doc-native-new-${String(createdCount)}`, title, 'native')
            upsert(created)
            return created
          }}
          onDeleteDocument={async () => undefined}
          onRestoreDocument={async () => undefined}
          onDeleteDocumentPermanently={async () => undefined}
          onEmptyTrash={async () => undefined}
        />
      </ActiveDocumentProvider>
    </DocumentOperationProvider>
  )
}

createRoot(document.getElementById('mock-root')!).render(
  <LocaleProvider>
    <AccountProvider>
      <ContextRoomStateProvider>
        <RoomDocumentsProvider>
          <DocumentOperationRoot />
        </RoomDocumentsProvider>
      </ContextRoomStateProvider>
    </AccountProvider>
  </LocaleProvider>,
)
