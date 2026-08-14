import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

import type { CloudAccountStatus } from '../../../shared/sources'

interface AccountContextValue {
  account: CloudAccountStatus | null
  refreshAccount(): Promise<CloudAccountStatus>
  setAccount(account: CloudAccountStatus): void
}

const AccountContext = createContext<AccountContextValue | null>(null)

export function AccountProvider({ children }: { children: ReactNode }) {
  const [account, setAccount] = useState<CloudAccountStatus | null>(null)

  const refreshAccount = useCallback(async () => {
    const next = window.nxcore
      ? await window.nxcore.account.status()
      : { authenticated: false, apiBaseUrl: '' }
    setAccount(next)
    return next
  }, [])

  useEffect(() => {
    void refreshAccount().catch(() => undefined)
  }, [refreshAccount])

  const value = useMemo(() => ({ account, refreshAccount, setAccount }), [account, refreshAccount])
  return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>
}

export function useAccount(): AccountContextValue {
  const context = useContext(AccountContext)
  if (!context) throw new Error('useAccount must be used inside AccountProvider.')
  return context
}
