import * as Sentry from '@sentry/electron/renderer'
import React from 'react'
import ReactDOM from 'react-dom/client'

import { App } from '@/App'
import { ContextRoomStateProvider } from '@/components/context-room/ContextRoomStateProvider'
import { RoomDocumentsProvider } from '@/components/context-room/RoomDocumentsProvider'
import { useRoomDocumentsState } from '@/components/context-room/RoomDocumentsProvider'
import { DocumentPatchProvider } from '@/components/context-room/patches/DocumentPatchProvider'
import { AccountProvider } from '@/state/AccountContext'
import { ActiveDocumentProvider } from '@/state/ActiveDocumentContext'
import '@/styles/tokens.css'
import '@/styles.css'

Sentry.init({ beforeBreadcrumb: () => null })

function DocumentPatchRoot() {
  const { upsertDocument } = useRoomDocumentsState()
  return (
    <DocumentPatchProvider onDocumentApplied={upsertDocument}>
      <ActiveDocumentProvider>
        <App />
      </ActiveDocumentProvider>
    </DocumentPatchProvider>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AccountProvider>
      <ContextRoomStateProvider>
        <RoomDocumentsProvider>
          <DocumentPatchRoot />
        </RoomDocumentsProvider>
      </ContextRoomStateProvider>
    </AccountProvider>
  </React.StrictMode>
)
