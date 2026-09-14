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
import '@/styles/tokens.css'
import './styles.css'

const ROOM_ID = 'room-board-mock'

const doc = (id: string, title: string, origin: 'native' | 'import', trashed = false): RoomDocument => {
  const contentJson: TiptapJsonContent = {
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: title }] },
      { type: 'paragraph', content: [{ type: 'text', text: `${title} 的正文段落（mock）。` }] },
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

const backendDocuments = [
  doc('doc-native-1', '产物：发布计划', 'native'),
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

const stored = loadRoomWorkspaceState(ROOM_ID)
let createdCount = 0

/** 与 main.tsx 同构的 Provider 链（编辑器/操作审阅需要），数据仍来自 mock fixture。 */
function DocumentOperationRoot() {
  const { upsertDocument } = useRoomDocumentsState()
  const operationBridge = React.useMemo(() => desktopOperationBridge(), [])
  return (
    <DocumentOperationProvider operationBridge={operationBridge} onDocumentApplied={upsertDocument}>
      <ActiveDocumentProvider>
        <PortedDetail
          room={room}
          rooms={[room]}
          backendDocuments={backendDocuments}
          trashedDocuments={trashedDocuments}
          focusedDocumentId={null}
          focusedBlockId={null}
          documentFocusRequestId={null}
          initialActiveBoard={stored?.board ?? 'work'}
          initialSubtab={stored?.subtab}
          onActiveBoardChange={() => undefined}
          onBack={() => undefined}
          onOpenRoom={() => undefined}
          onUpdateRoom={() => undefined}
          onBackendDocumentChange={() => undefined}
          onCreateDocument={async (_roomId, title) => {
            createdCount += 1
            return doc(`doc-native-new-${String(createdCount)}`, title, 'native')
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
