import * as Sentry from '@sentry/electron/renderer'
import React from 'react'
import ReactDOM from 'react-dom/client'

import { App } from '@/App'
import { ContextRoomStateProvider } from '@/components/context-room/ContextRoomStateProvider'
import { RoomDocumentsProvider } from '@/components/context-room/RoomDocumentsProvider'
import { AccountProvider } from '@/state/AccountContext'
import '@/styles/tokens.css'
import '@/styles.css'

Sentry.init({ beforeBreadcrumb: () => null })

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AccountProvider>
      <ContextRoomStateProvider>
        <RoomDocumentsProvider>
          <App />
        </RoomDocumentsProvider>
      </ContextRoomStateProvider>
    </AccountProvider>
  </React.StrictMode>
)
