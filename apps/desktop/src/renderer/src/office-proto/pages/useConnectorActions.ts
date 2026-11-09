import { useCallback, useState } from 'react'
import type { ConnectorConnection, ConnectorProviderSummary } from '@nxcore/connector-contract'

/** 飞书连接器在网关墓碑里的固定 id（lark-cli 本机单账号）。 */
export const FEISHU_CONNECTION_ID = 'feishu:default'

/** 授权动作的目标连接器卡片（ConnectorItem 的结构子集，两个宿主都能直接传卡片）。 */
export interface ConnectorActionTarget {
  provider: string
  name: string
  comingSoon?: boolean
  authChannel?: ConnectorProviderSummary['authChannel']
  /** 凭据来源：oo OAuth token / 本机 lark-cli（飞书走设备码授权）。 */
  credentialSource?: 'oo' | 'feishu-cli'
}

/**
 * 连接器授权动作（连接 / 开启 / 关闭 / 注销），主页连接器页与对话区连接器弹窗共用。
 *
 * 从 ConnectorsView 抽出的纯逻辑层：视图只负责卡片与状态渲染，这里的轮询、
 * 刷新、busy 标记全部内聚——两处宿主行为永远一致。
 *
 * - connect：oo 渠道发起 Nango 授权并轮询结果；飞书走本机 lark-cli 设备码授权
 * - enable / disconnect：切换本地墓碑（凭据保留）
 * - revokeFeishu：注销本机 lark-cli 凭据（真的清凭据）
 */
export function useConnectorActions({ onToast, refresh, feishuDisconnected }: {
  onToast: (msg: string) => void
  /** 动作完成后刷新快照（宿主各自的 loadConnectorsSnapshot + setState）。 */
  refresh: () => Promise<unknown> | void
  /** 飞书墓碑还在（授权成功后要顺带开启，省一次点击）。 */
  feishuDisconnected: boolean
}): {
  /** 正在处理授权/开关的 provider（卡片与按钮的 busy 态）。 */
  busyProvider: string | null
  connect: (item: ConnectorActionTarget) => Promise<void>
  revokeFeishu: () => Promise<void>
  disconnect: (item: { name: string }, connection: ConnectorConnection) => Promise<void>
  enableConnection: (item: { name: string }, connection: ConnectorConnection) => Promise<void>
} {
  const [busyProvider, setBusyProvider] = useState<string | null>(null)

  /** 飞书授权（本机 lark-cli）：两阶段（应用初始化 → 用户设备码授权）由主进程
   *  自动推进；这里只轮询 agentAuth.status()。授权页由主进程 onVerificationUrl
   *  自动打开系统浏览器（每阶段一次）——渲染层不再 window.open，否则同一验证
   *  链接会被打开两次（用户看到「发起了两个请求」，第二个标签页提示已使用）。 */
  const connect = useCallback(async (item: ConnectorActionTarget) => {
    if (item.credentialSource === 'feishu-cli') {
      const api = window.nxcore?.agentAuth
      if (!api) {
        onToast('未连接桌面服务，暂时不能操作。')
        return
      }
      setBusyProvider(item.provider)
      try {
        await api.start({ provider: 'feishu' })
        onToast('正在发起飞书授权，请在自动打开的浏览器页面中完成授权。')
        const deadline = Date.now() + 15 * 60_000
        while (Date.now() < deadline) {
          await new Promise((resolve) => window.setTimeout(resolve, 2_000))
          const status = await api.status()
          if (status.feishu?.userAuthorized) {
            // 之前被「关闭」过（墓碑还在）：授权成功后顺带开启，省一次点击。
            if (feishuDisconnected) {
              await window.nxcore?.nangoConnector?.reconnectConnection?.(FEISHU_CONNECTION_ID).catch(() => undefined)
            }
            await refresh()
            onToast(`「${item.name}」已连接${status.feishu.userName ? `（${status.feishu.userName}）` : ''}。`)
            return
          }
          const active = status.activeChallenge
          if (!active || active.status === 'failed' || active.status === 'expired' || active.status === 'cancelled') {
            await refresh()
            if (active?.message) onToast(active.message)
            return
          }
        }
        onToast('飞书授权超时，请重试。')
      } catch (error) {
        onToast(error instanceof Error ? error.message : '飞书授权失败。')
      } finally {
        setBusyProvider(null)
      }
      return
    }
    const api = window.nxcore?.nangoConnector
    if (!api) {
      onToast('未连接桌面服务，暂时不能操作。')
      return
    }
    if (item.comingSoon) {
      onToast(`「${item.name}」即将上线。`)
      return
    }
    if (item.authChannel !== 'nango-oauth') {
      onToast(`「${item.name}」暂不支持在线授权。`)
      return
    }
    setBusyProvider(item.provider)
    try {
      const attempt = await api.startAuthorization(item.provider)
      onToast(`已打开「${item.name}」授权页，请在浏览器完成授权。`)
      const deadline = Date.now() + 15 * 60_000
      while (Date.now() < deadline) {
        await new Promise((resolve) => window.setTimeout(resolve, 2_000))
        try {
          const status = await api.authorizationStatus(attempt.id)
          if (status.status === 'connected') {
            await refresh()
            onToast(`已连接「${item.name}」，Agent 在工作中可以直接查询。`)
            return
          }
          if (status.status === 'failed' || status.status === 'expired') {
            await refresh()
            onToast(status.error ?? `「${item.name}」授权失败，请重试。`)
            return
          }
        } catch {
          // 网关瞬断：继续轮询直到超时。
        }
      }
      onToast('授权超时，请重试。')
    } catch (error) {
      onToast(error instanceof Error ? error.message : '连接失败。')
    } finally {
      setBusyProvider(null)
    }
  }, [onToast, refresh, feishuDisconnected])

  /** 注销本机飞书凭据（lark-cli auth logout）——与「关闭」开关不同，会真的清凭据。 */
  const revokeFeishu = useCallback(async () => {
    const api = window.nxcore?.agentAuth
    if (!api) return
    setBusyProvider('feishu')
    try {
      await api.disconnect('feishu')
      await refresh()
      onToast('已注销本机飞书授权。')
    } catch (error) {
      onToast(error instanceof Error ? error.message : '注销飞书授权失败。')
    } finally {
      setBusyProvider(null)
    }
  }, [onToast, refresh])

  const disconnect = useCallback(async (item: { name: string }, connection: ConnectorConnection) => {
    const api = window.nxcore?.nangoConnector
    if (!api) {
      onToast('未连接桌面服务，暂时不能操作。')
      return
    }
    setBusyProvider(connection.provider)
    try {
      await api.purgeConnection(connection.id)
      await refresh()
      onToast(`已关闭「${item.name} · ${connection.connectionName}」，凭据保留，可随时重新开启。`)
    } catch (error) {
      onToast(error instanceof Error ? error.message : '关闭失败。')
    } finally {
      setBusyProvider(null)
    }
  }, [onToast, refresh])

  /** 开启（未开启 → 已连接）：移除墓碑，oo 凭据一直在。 */
  const enableConnection = useCallback(async (item: { name: string }, connection: ConnectorConnection) => {
    const api = window.nxcore?.nangoConnector
    if (!api?.reconnectConnection) {
      onToast('当前版本不支持开启，请升级应用。')
      return
    }
    setBusyProvider(connection.provider)
    try {
      await api.reconnectConnection(connection.id)
      await refresh()
      onToast(`已开启「${item.name} · ${connection.connectionName}」，Agent 在工作中可以直接查询。`)
    } catch (error) {
      onToast(error instanceof Error ? error.message : '开启失败。')
    } finally {
      setBusyProvider(null)
    }
  }, [onToast, refresh])

  return { busyProvider, connect, revokeFeishu, disconnect, enableConnection }
}
