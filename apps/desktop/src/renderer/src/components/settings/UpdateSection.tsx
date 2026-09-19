import { useEffect, useState } from 'react'
import { Check, Copy, RefreshCw } from 'lucide-react'

interface UpdateStatus {
  version: string
  channel: 'stable' | 'nightly'
  installId: string
  supported: boolean
}
type CheckResult = 'update-found' | 'no-update' | 'busy' | 'error'

const resultText: Record<CheckResult, string> = {
  'update-found': '发现新版本，正在后台下载，完成后会弹窗提示重启',
  'no-update': '已是最新版本',
  busy: '正在检查…',
  error: '检查失败，请稍后重试',
}

/** 设置页「软件更新」区块：手动检查 + 更新诊断信息。 */
export function UpdateSection() {
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  const [checking, setChecking] = useState(false)
  const [result, setResult] = useState<CheckResult | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => { void window.nxcore?.updater?.getStatus().then(setStatus).catch(() => setStatus(null)) }, [])

  const check = async () => {
    if (checking) return
    setChecking(true)
    setResult('busy')
    try {
      // eslint-disable-next-line no-await-in-loop
      setResult(await (await window.nxcore?.updater?.checkNow()) ?? 'error')
    } catch {
      setResult('error')
    } finally {
      setChecking(false)
    }
  }

  const copyInstallId = async () => {
    if (!status) return
    await navigator.clipboard.writeText(status.installId)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <section id="settings-update" className="reality-settings-section settings-anchor-section" aria-labelledby="update-settings-title">
      <header>
        <span><RefreshCw aria-hidden="true" /></span>
        <div>
          <h2 id="update-settings-title">软件更新</h2>
          <p>检查并安装 EverRoom 桌面端新版本</p>
        </div>
      </header>
      <div className="reality-setting-row">
        <div>
          <strong>当前版本 {status ? `v${status.version}` : '—'}</strong>
          <small>
            更新渠道 {status?.channel ?? '—'}
            {status?.channel === 'nightly' ? '（每日构建，可能不稳定）' : ''}
          </small>
          {status?.installId && (
            <small>
              安装标识 {status.installId.slice(0, 13)}…
              <button type="button" className="link-button" onClick={() => void copyInstallId()} aria-label="复制安装标识">
                {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
              </button>
            </small>
          )}
        </div>
        <button type="button" className="primary-button" onClick={() => void check()} disabled={checking || status?.supported === false}>
          <RefreshCw aria-hidden="true" className={checking ? 'spin' : undefined} />
          {checking ? '正在检查' : '检查更新'}
        </button>
      </div>
      {result && (
        <div className="reality-setting-row">
          <small>{status?.supported === false ? '开发模式不支持更新检查' : resultText[result]}</small>
        </div>
      )}
    </section>
  )
}
