// 临时入口：纯浏览器挂载 PortedDetail 验证思路板块·知识涌现（配合 /@mock/nxcore.js），验证后删除。
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

const ROOM_ID = 'thoughts-mock'

const doc = (id: string, title: string, origin: 'native' | 'import'): RoomDocument => {
  const contentJson: TiptapJsonContent = {
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: title }] },
      { type: 'paragraph', content: [{ type: 'text', text: `${title} 的正文段落（mock）。选中一段文字可让思路伴随区跟随选区聚焦。` }] },
      { type: 'paragraph', content: [{ type: 'text', text: '第二段：选中文本包含「降级」两个字时，mock 会走降级样例。' }] },
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
    deletedAt: null,
    createdAt: '2026-09-10T00:00:00.000Z',
    updatedAt: '2026-09-13T00:00:00.000Z',
  }
}

const backendDocuments = [
  doc('doc-native-1', '产物：发布计划', 'native'),
  doc('doc-native-2', '产物：复盘草稿', 'native'),
  doc('doc-import-1', '资料：飞书周会纪要', 'import'),
]

const room = createEmptyContextRoom({
  id: ROOM_ID,
  title: '思路涌现验证',
  kind: '项目',
  background: '验证思路板块：聚焦/漫步两个世界、卡片流/知识脉络、伴随区三栏。',
  goal: '浏览器里可复现知识涌现交互',
  briefStatus: '进行中',
})

const stored = loadRoomWorkspaceState(ROOM_ID)

/** 与 main.tsx 同构的 Provider 链（编辑器/操作审阅需要）。 */
function DocumentOperationRoot() {
  const { upsertDocument } = useRoomDocumentsState()
  const operationBridge = React.useMemo(() => desktopOperationBridge(), [])
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
          backendDocuments={backendDocuments}
          trashedDocuments={[]}
          focusedDocumentId={null}
          focusedBlockId={null}
          documentFocusRequestId={null}
          initialActiveBoard="thoughts"
          initialSubtab={stored?.subtab}
          onActiveBoardChange={() => undefined}
          onBack={() => undefined}
          onOpenRoom={() => undefined}
          onUpdateRoom={applyRoomUpdate}
          onBackendDocumentChange={() => undefined}
          onCreateDocument={async (_roomId, title) => doc(`doc-native-${Date.now()}`, title, 'native')}
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
  <React.StrictMode>
    <LocaleProvider>
      <AccountProvider>
        <ContextRoomStateProvider>
          <RoomDocumentsProvider>
            <DocumentOperationRoot />
          </RoomDocumentsProvider>
        </ContextRoomStateProvider>
      </AccountProvider>
    </LocaleProvider>
  </React.StrictMode>,
)
