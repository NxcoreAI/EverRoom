import React from 'react'
import ReactDOM from 'react-dom/client'

import { App } from '@/App'
import { AccountProvider } from '@/state/AccountContext'
import '@/styles/tokens.css'
import '@/styles.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AccountProvider>
      <App />
    </AccountProvider>
  </React.StrictMode>
)
