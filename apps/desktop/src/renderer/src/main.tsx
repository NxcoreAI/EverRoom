import * as Sentry from '@sentry/electron/renderer'
import React from 'react'
import ReactDOM from 'react-dom/client'

import { App } from '@/App'
import { GlobalErrorBoundary } from '@/components/GlobalErrorBoundary'
import { ContextRoomStateProvider } from '@/components/context-room/ContextRoomStateProvider'
import { RoomDocumentsProvider } from '@/components/context-room/RoomDocumentsProvider'
import { useRoomDocumentsState } from '@/components/context-room/RoomDocumentsProvider'
import { desktopOperationBridge, DocumentOperationProvider } from '@/components/context-room/operations'
import { AccountProvider } from '@/state/AccountContext'
import { ActiveDocumentProvider } from '@/state/ActiveDocumentContext'
import { LocaleProvider } from '@/i18n/LocaleContext'
import '@/styles/tokens.css'
import '@/styles.css'

Sentry.init({ beforeBreadcrumb: () => null })

function DocumentOperationRoot() {
  const { upsertDocument } = useRoomDocumentsState()
  const operationBridge = React.useMemo(() => desktopOperationBridge(), [])
  return (
    <DocumentOperationProvider operationBridge={operationBridge} onDocumentApplied={upsertDocument}>
      <ActiveDocumentProvider>
        <App />
      </ActiveDocumentProvider>
    </DocumentOperationProvider>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <GlobalErrorBoundary>
    <LocaleProvider>
      <AccountProvider>
        <ContextRoomStateProvider>
          <RoomDocumentsProvider>
            <DocumentOperationRoot />
          </RoomDocumentsProvider>
        </ContextRoomStateProvider>
      </AccountProvider>
    </LocaleProvider>
    </GlobalErrorBoundary>
  </React.StrictMode>
)
