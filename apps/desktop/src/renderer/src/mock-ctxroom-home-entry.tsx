// 临时入口:纯浏览器单独挂载 HomeView（配合 /@mock/nxcore.js 的 knowledge mock），验证首页推荐区对齐原型（验证后删除）。
import React from 'react'
import { createRoot } from 'react-dom/client'

import { LocaleProvider } from './i18n/LocaleContext'
import { ContextRoomStateProvider } from './components/context-room/ContextRoomStateProvider'
import { AccountProvider } from './state/AccountContext'
import { HomeView } from './components/context-room/ported/components/HomeView'
import { createEmptyContextRoom } from './components/context-room/ported/contextRoomFactory'
import './components/context-room/ported/ContextRoom.css'
import './components/context-room/ported/PortedAdapters.css'
import '@/styles/tokens.css'
import './styles.css'

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()

const room = (id: string, title: string, kind: '主题' | '项目', minutes: number) => ({
  ...createEmptyContextRoom({ id, title, kind, background: `${title} 的背景（mock）。`, goal: '浏览器复现首页', briefStatus: '进行中' }),
  updatedAt: minutesAgo(minutes),
  lastViewed: '刚刚',
})

const rooms = [
  room('room-1', '采购流程', '主题', 12),
  room('room-2', 'V1 视觉定稿', '项目', 95),
  room('room-3', '连接器', '项目', 60 * 5),
  room('room-4', '客户反馈', '主题', 60 * 26),
  room('room-5', 'OAuth 接入', '项目', 60 * 50),
  room('room-6', '团队协作规范', '主题', 60 * 24 * 6),
  room('room-7', '发布清单', '项目', 60 * 24 * 12),
]

createRoot(document.getElementById('mock-root')!).render(
  <LocaleProvider>
    <AccountProvider>
      <ContextRoomStateProvider>
        <HomeView
          rooms={rooms}
          deletedRooms={[]}
          onMountObsidian={async () => undefined}
          onRenameRoom={() => undefined}
          onDeleteRoom={() => undefined}
          onRestoreRoom={() => undefined}
          onOpenDetail={() => undefined}
          onShowAll={() => undefined}
          onFocusAgent={() => undefined}
          onRefreshRooms={async () => undefined}
        />
      </ContextRoomStateProvider>
    </AccountProvider>
  </LocaleProvider>,
)
