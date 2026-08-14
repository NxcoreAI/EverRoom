import { Brain, Cloud, HardDrive, LoaderCircle, LogIn, LogOut, Settings, ShieldCheck, type LucideIcon } from 'lucide-react'
import { FormEvent, useEffect, useState } from 'react'

import type { CloudAccountStatus } from '../../../../shared/sources'
import { PageHeader } from './PageHeader'
import './SettingsPage.css'

const SETTINGS: Array<{ icon: LucideIcon; title: string; description: string }> = [
  { icon: HardDrive, title: '本地数据', description: '数据目录、备份与保留策略' },
  { icon: Brain, title: '模型与记忆', description: '模型供应商、Embedding 与记忆治理' },
  { icon: ShieldCheck, title: '隐私与权限', description: '外发范围、审批和审计记录' },
  { icon: Settings, title: '通用', description: '语言、启动行为与界面偏好' },
]

export function SettingsPage() {
  const [account,setAccount]=useState<CloudAccountStatus|null>(null)
  const [identifier,setIdentifier]=useState('')
  const [password,setPassword]=useState('')
  const [busy,setBusy]=useState(false)
  const [error,setError]=useState<string|null>(null)

  useEffect(()=>{void window.nxcore?.account.status().then(setAccount).catch(caught=>setError(caught instanceof Error?caught.message:'无法读取账号状态。'))},[])
  const login=async(event:FormEvent)=>{event.preventDefault();if(!window.nxcore)return;setBusy(true);setError(null);try{setAccount(await window.nxcore.account.login({identifier,password}));setPassword('')}catch(caught){setError(caught instanceof Error?caught.message:'登录失败。')}finally{setBusy(false)}}
  const logout=async()=>{if(!window.nxcore)return;setBusy(true);setError(null);try{setAccount(await window.nxcore.account.logout())}catch(caught){setError(caught instanceof Error?caught.message:'退出失败。')}finally{setBusy(false)}}

  return (
    <div className="page settings-page">
      <PageHeader title="设置" description="管理本地工作区、云端账号和数据边界。" />
      <section className="cloud-account-section" aria-labelledby="cloud-account-title">
        <header><span className="item-icon"><Cloud aria-hidden="true" /></span><div><h2 id="cloud-account-title">EverRoom 账号</h2><p>{account?.authenticated?'已连接 SaaS 托管转写':'登录可使用订阅额度；不登录仍可使用本地自有配置'}</p></div></header>
        {account?.authenticated ? (
          <div className="cloud-account-session"><div><strong>{account.user?.name||account.user?.email||account.user?.phone||'EverRoom 用户'}</strong><span>{account.user?.email||account.user?.phone}</span><small>{account.apiBaseUrl}</small></div><button className="secondary-button" type="button" disabled={busy} onClick={logout}>{busy?<LoaderCircle className="spin" aria-hidden="true"/>:<LogOut aria-hidden="true"/>}退出登录</button></div>
        ) : (
          <form className="cloud-login-form" onSubmit={login}>
            <label><span>邮箱或手机号</span><input autoComplete="username" value={identifier} onChange={event=>setIdentifier(event.target.value)} required /></label>
            <label><span>密码</span><input type="password" autoComplete="current-password" value={password} onChange={event=>setPassword(event.target.value)} required /></label>
            <button className="primary-button" type="submit" disabled={busy||!identifier.trim()||!password}>{busy?<LoaderCircle className="spin" aria-hidden="true"/>:<LogIn aria-hidden="true"/>}登录</button>
          </form>
        )}
        {error?<p className="cloud-account-error" role="alert">{error}</p>:null}
      </section>
      <div className="settings-list">
        {SETTINGS.map(({ icon: Icon, title, description }) => (
          <button key={title} type="button" className="settings-row">
            <span className="item-icon"><Icon aria-hidden="true" strokeWidth={1.8} /></span>
            <span><strong>{title}</strong><small>{description}</small></span>
          </button>
        ))}
      </div>
    </div>
  )
}
