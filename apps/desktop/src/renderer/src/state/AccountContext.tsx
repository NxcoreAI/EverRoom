import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import type { CloudAccountStatus } from '../../../shared/sources'

interface AccountContextValue {
  account: CloudAccountStatus | null
  refreshAccount(): Promise<CloudAccountStatus>
  setAccount(account: CloudAccountStatus): void
}

const AccountContext = createContext<AccountContextValue | null>(null)

export function AccountProvider({ children }: { children: ReactNode }) {
  const [account, setAccountState] = useState<CloudAccountStatus | null>(null)
  const statusRequestRef = useRef(0)

  const setAccount = useCallback((next: CloudAccountStatus) => {
    setAccountState(next)
    window.dispatchEvent(new CustomEvent('everroom-account-status-changed', { detail: next }))
  }, [])

  const refreshAccount = useCallback(async () => {
    const next = window.nxcore
      ? await window.nxcore.account.status()
      : { authenticated: false, apiBaseUrl: '' }
    setAccount(next)
    return next
  }, [])

  useEffect(() => {
    if (!window.nxcore) {
      setAccountState({ authenticated: false, apiBaseUrl: '' })
      return
    }
    const onAccountChanged = (event: Event) => {
      const next = (event as CustomEvent<CloudAccountStatus>).detail
      if (!next || typeof next !== 'object' || typeof next.authenticated !== 'boolean') return
      statusRequestRef.current += 1
      setAccountState(next)
    }
    window.addEventListener('everroom-account-status-changed', onAccountChanged)
    const requestId = ++statusRequestRef.current
    void window.nxcore.account.status({ quiet: true }).then((next) => {
      if (statusRequestRef.current === requestId) setAccountState(next)
    }).catch(() => undefined)
    return () => window.removeEventListener('everroom-account-status-changed', onAccountChanged)
  }, [])

  const value = useMemo(() => ({ account, refreshAccount, setAccount }), [account, refreshAccount, setAccount])
  return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>
}

export function useAccount(): AccountContextValue {
  const context = useContext(AccountContext)
  if (!context) throw new Error('useAccount must be used inside AccountProvider.')
  return context
}
