import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Check, Loader2, Pause, Plus, X } from 'lucide-react'
import type { ConnectorConnection, ConnectorProviderSummary } from '@nxcore/connector-contract'
import type { AgentAuthEnvironmentStatus } from '@/shared/agent-auth'

import { ConnectorLogo, type BrandSlug } from '../brandLogos'
import { PageHead, Seg } from './parts'
import {
  loadConnectorsSnapshot, peekConnectorsSnapshot,
  type ConnectorsSnapshot,
} from './connectorsData'

/* ───────────── provider 展示元数据（图标 / 文案 / 权限范围） ─────────────
 * 目录、连接状态、可连接名单全部来自网关真实数据；这里只补注册表没有的
 * 展示层信息。未收录的 provider 走 generic 兜底（首字母方块）。
 * provider 名对齐网关注册表（gateway-module/connection-runtime 的映射）：
 * googledrive 服务 → google-docs，googlecalendar 服务 → google-calendar。 */

interface ProviderMeta {
  name: string
  desc: string
  slug: BrandSlug
  color: string
  scopes: string[]
  /** 展示分类提示：网关注册表未收录（SaaS 直配）的 provider 用它推导卡片分类。 */
  category?: ConnCategory
}

const PROVIDER_META: Record<string, ProviderMeta> = {
  gmail: {
    name: 'Gmail', desc: '邮件是记忆的主要来源，支持检索与代回', slug: 'gmail', color: '#EA4335',
    scopes: ['读取邮件正文', '搜索邮件', '以你的名义回复'], category: 'mail',
  },
  outlook: {
    name: 'Outlook', desc: '邮件检索与日程摘要', slug: 'outlook', color: '#0F6CBD',
    scopes: ['读取邮件正文', '搜索邮件'], category: 'mail',
  },
  'google-docs': {
    name: 'Google Drive', desc: '把云盘文档纳入引用范围', slug: 'googledrive', color: '#1FAF73',
    scopes: ['浏览文件', '读取文档内容'], category: 'docs',
  },
  'google-calendar': {
    name: 'Google 日历', desc: '同步日程与参会人，会前自动摘要', slug: 'googlecalendar', color: '#4285F4',
    scopes: ['读取日程', '读取参会人'], category: 'calendar',
  },
  notion: {
    name: 'Notion', desc: '同步工作区页面为知识来源', slug: 'notion', color: '#181717',
    scopes: ['读取页面', '搜索工作区'], category: 'docs',
  },
  slack: {
    name: 'Slack', desc: '频道消息检索与摘要', slug: 'slack', color: '#4A154B',
    scopes: ['读取频道', '读取消息'], category: 'chat',
  },
  feishu: {
    name: '飞书', desc: '云文档与知识库节点检索', slug: 'feishu', color: '#3370FF',
    scopes: ['读取云文档', '读取知识库'], category: 'docs',
  },
}

/* ───────────── 展示层分类（由 dataTypes 推导，比注册表的粗分类更细） ───────────── */

type ConnCategory = 'mail' | 'calendar' | 'docs' | 'chat'

const CATEGORY_LABEL: Record<ConnCategory, string> = {
  mail: '邮件',
  calendar: '日历',
  docs: '文档与云盘',
  chat: '通讯协作',
}

const CATEGORY_ORDER: ConnCategory[] = ['mail', 'calendar', 'docs', 'chat']

function categoryOf(provider: ConnectorProviderSummary): ConnCategory {
  const types = provider.dataTypes
  if (types.includes('mail')) return 'mail'
  if (types.includes('event')) return 'calendar'
  if (types.includes('message')) return 'chat'
  return 'docs'
}

const DATA_TYPE_SCOPES: Record<string, string> = {
  mail: '读取邮件',
  event: '读取日程',
  message: '读取消息',
  document: '读取文档',
}

/**
 * oo service → EverRoom provider（Google 系命名不同；与网关/主进程桥同值）。
 * 墓碑清单按 oo service 记录，卡片按 provider 索引——用它对齐。
 */
const SERVICE_OF_PROVIDER_HINT: Record<string, string> = {
  gmail: 'gmail',
  outlook: 'outlook',
  notion: 'notion',
  googlecalendar: 'google-calendar',
  googledrive: 'google-docs',
  feishu: 'feishu',
}

function prettyName(provider: ConnectorProviderSummary): string {
  const raw = provider.label?.trim() || provider.provider
  return raw.charAt(0).toUpperCase() + raw.slice(1)
}

const STATE_LABEL: Record<ConnState, string> = {
  unlinked: '未连接',
  linked: '未开启',
  active: '已连接',
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(ms) || ms < 0) return '刚刚'
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days} 天前`
  return new Date(iso).toLocaleDateString('zh-CN')
}

const CONNECTION_STATUS_LABEL: Record<ConnectorConnection['status'], string> = {
  active: '正常',
  disabled: '已禁用',
  error: '异常',
}

/* ───────────── 卡片条目 ───────────── */

/**
 * 连接器三态（用户可见语义，与凭据解耦）：
 * - unlinked：没有凭据——「未连接」，需走授权
 * - linked   ：有凭据但被本地墓碑挡住——「未开启」，一键开启（移除墓碑）
 * - active   ：有凭据且开启——「已连接」，可关闭（加墓碑，凭据保留）
 *
 * 凭据来源分两类：
 * - oo（gmail/notion/slack 等）：oo 租户里的 OAuth token
 * - feishu-cli（飞书）：本机 lark-cli 的系统安全存储凭据，不走 oo
 */
type ConnState = 'unlinked' | 'linked' | 'active'
type CredentialSource = 'oo' | 'feishu-cli'

/** 飞书连接器在网关墓碑里的固定 id（lark-cli 本机单账号）。 */
const FEISHU_CONNECTION_ID = 'feishu:default'

interface ConnectorItem {
  provider: string
  name: string
  desc: string
  category: ConnCategory
  slug: BrandSlug
  color: string
  letter: string
  scopes: string[]
  comingSoon: boolean
  authChannel: ConnectorProviderSummary['authChannel']
  connections: ConnectorConnection[]
  /** 墓碑连接（有凭据但未开启）——「未开启」状态的判断依据。 */
  pausedConnections: ConnectorConnection[]
  connected: boolean
  /** 三态展示状态。 */
  state: ConnState
  /** SaaS 下发的图标 URL（优先于本地打包 SVG / 兜底图形）。 */
  iconUrl: string | null
  /** 凭据来源：oo OAuth token / 本机 lark-cli。 */
  credentialSource: CredentialSource
  /** 飞书 CLI 账号显示名（lark-cli auth status 的 userName）。 */
  accountLabel: string | null
}

function toItem(
  provider: ConnectorProviderSummary,
  connections: ConnectorConnection[],
  iconUrls: ReadonlyMap<string, string> = new Map(),
  paused: ConnectorConnection[] = [],
): ConnectorItem {
  const meta = PROVIDER_META[provider.provider]
  const name = meta?.name ?? prettyName(provider)
  const scopes = meta?.scopes ?? (provider.dataTypes.length > 0
    ? provider.dataTypes.map((t) => DATA_TYPE_SCOPES[t] ?? t)
    : ['即席查询'])
  const iconUrl = iconUrls.get(provider.provider) ?? null
  // 三态：有活跃连接 → active；否则有墓碑（oo 凭据在但被关）→ linked；都没有 → unlinked。
  const state: ConnState = connections.length > 0 ? 'active' : paused.length > 0 ? 'linked' : 'unlinked'
  return {
    provider: provider.provider,
    name,
    desc: meta?.desc ?? 'Agent 工作途中可即席查询该来源',
    category: meta?.category ?? categoryOf(provider),
    slug: meta?.slug ?? 'generic',
    color: meta?.color ?? '#0a84ff',
    letter: name.charAt(0).toUpperCase(),
    scopes,
    comingSoon: provider.comingSoon,
    authChannel: provider.authChannel,
    connections,
    pausedConnections: paused,
    connected: state === 'active',
    state,
    iconUrl: iconUrl && /^https?:\/\//.test(iconUrl) ? iconUrl : null,
    credentialSource: 'oo',
    accountLabel: null,
  }
}

/** 飞书卡片：凭据来自本机 lark-cli（agentAuth），不看 oo 连接。 */
function toFeishuItem(
  provider: ConnectorProviderSummary,
  iconUrls: ReadonlyMap<string, string>,
  auth: AgentAuthEnvironmentStatus['feishu'] | null,
  disabled: boolean,
): ConnectorItem {
  const accountLabel = auth?.userName ?? null
  const authorized = auth?.userAuthorized === true
  const connection: ConnectorConnection = {
    id: FEISHU_CONNECTION_ID,
    provider: 'feishu',
    service: 'feishu',
    connectionName: accountLabel ?? 'lark-cli',
    accountIdentityHash: null,
    status: 'active',
    filters: {},
    createdAt: '',
    updatedAt: '',
    // lark-cli 托管的本机凭据（非 oo Nango）。
    authMethod: 'api-token',
  }
  const item = toItem(provider, [], iconUrls, [])
  const state: ConnState = !authorized ? 'unlinked' : disabled ? 'linked' : 'active'
  return {
    ...item,
    state,
    connected: state === 'active',
    connections: state === 'active' ? [connection] : [],
    pausedConnections: state === 'linked' ? [connection] : [],
    credentialSource: 'feishu-cli',
    accountLabel,
  }
}

/**
 * 快照 → 卡片条目（纯函数）。
 * 目录 = 可连接集合，连接清单只用来标记每张卡的状态，绝不反过来生成卡片：
 * oo 租户里的凭据还包含连接器之外的内部应用（npm 等），它们不进连接器页。
 * 飞书凭据走本机 lark-cli（agentAuth），不看 oo 连接与 oo 墓碑。
 */
function buildItems(snapshot: ConnectorsSnapshot): ConnectorItem[] {
  const { providers, connections, disconnected, oauthCatalog, feishuAuth } = snapshot
  const byProvider = new Map<string, ConnectorConnection[]>()
  for (const connection of connections) {
    const list = byProvider.get(connection.provider) ?? []
    list.push(connection)
    byProvider.set(connection.provider, list)
  }
  // 墓碑连接（oo 有凭据但被关掉）按 provider 分组，还原成连接对象
  // （id 即 service:connectionName，与网关连接 id 同构）。
  const pausedByProvider = new Map<string, ConnectorConnection[]>()
  for (const id of disconnected) {
    const separator = id.indexOf(':')
    if (separator <= 0) continue
    const service = id.slice(0, separator)
    const connectionName = id.slice(separator + 1)
    const provider = SERVICE_OF_PROVIDER_HINT[service] ?? service
    const list = pausedByProvider.get(provider) ?? []
    list.push({
      id,
      provider,
      service,
      connectionName,
      accountIdentityHash: null,
      status: 'disabled',
      filters: {},
      createdAt: '',
      updatedAt: '',
      authMethod: 'nango-oauth',
    })
    pausedByProvider.set(provider, list)
  }
  // SaaS 明细（新版主进程）：provider → displayName/iconUrl。
  // 注意空明细 [] 也是有效目录（SaaS 一个 OAuth 应用都没配 → 页面空态），
  // 只有 string[]（旧版）和 null（不可用）才回落注册表。
  const detailed = Array.isArray(oauthCatalog) && (oauthCatalog.length === 0 || typeof oauthCatalog[0] !== 'string')
    ? (oauthCatalog as Array<{ provider: string; displayName: string | null; iconUrl: string | null }>)
      .filter((entry) => typeof entry?.provider === 'string' && entry.provider.length > 0)
    : null
  const iconUrls = new Map<string, string>()
  for (const entry of detailed ?? []) {
    if (entry.iconUrl) iconUrls.set(entry.provider, entry.iconUrl)
  }
  // 旧版主进程（string[]）：无明细，只能按名单过滤注册表（无法授权的不显示）。
  const legacyNames = Array.isArray(oauthCatalog) && oauthCatalog.length > 0 && typeof oauthCatalog[0] === 'string'
    ? new Set(oauthCatalog as string[])
    : null
  const registryByProvider = new Map(providers.map((p) => [p.provider, p]))
  // SaaS 明细可用时：SaaS 配置 = 目录（真正打通 OAuth 的应用全集）。
  // 注册表只补展示元数据；未收录的 provider 合成卡片（SaaS displayName 命名）。
  // 否则目录 = 网关注册表（全量；旧名单可用时仅名单内 + 已连接的）。
  const source: ConnectorProviderSummary[] = detailed !== null
    ? detailed.map((entry) => registryByProvider.get(entry.provider) ?? {
        provider: entry.provider,
        label: entry.displayName ?? entry.provider,
        // 注册表粗分类只允许 mail/calendar/docs；展示分类由 toItem 按
        // PROVIDER_META.category（含 chat）推导，这里 docs 只是占位。
        category: 'docs' as const,
        iconKey: entry.provider,
        dataTypes: [],
        authChannel: 'nango-oauth' as const,
        connected: false,
        comingSoon: false,
      })
    : providers.filter((p) => legacyNames === null || legacyNames.has(p.provider) || (byProvider.get(p.provider)?.length ?? 0) > 0)
  const feishuDisabled = disconnected.has(FEISHU_CONNECTION_ID)
  return source.map((p) => p.provider === 'feishu'
    ? toFeishuItem(p, iconUrls, feishuAuth, feishuDisabled)
    : toItem(p, byProvider.get(p.provider) ?? [], iconUrls, pausedByProvider.get(p.provider) ?? []))
}

/** 单张连接器卡：logo + 名称/描述 + 三态徽标。 */
function ConnectorCard({
  item, busy, onOpen,
}: {
  item: ConnectorItem
  busy: boolean
  onOpen: () => void
}) {
  return (
    <button
      type="button"
      className={`op-conn-card${item.state === 'active' ? ' is-on' : ''}`}
      onClick={onOpen}
    >
      <ConnectorLogo iconUrl={item.iconUrl} slug={item.slug} color={item.color} letter={item.letter} size={26} />
      <span className="op-conn-info">
        <span className="op-conn-name">{item.name}</span>
        <span className="op-conn-desc">
          {item.state === 'active'
            ? `${item.connections.map((conn) => conn.connectionName).join('、')}`
            : item.state === 'linked'
              ? '已授权，点击开启'
              : item.desc}
        </span>
      </span>
      <span
        className={`op-conn-state${item.state === 'active' ? ' on' : item.state === 'linked' ? ' mid' : ''}`}
        title={STATE_LABEL[item.state]}
        aria-label={STATE_LABEL[item.state]}
      >
        {busy
          ? <Loader2 size={14} className="op-spin-icon" />
          : item.state === 'active'
            ? <><Check size={13} /><span>已连接</span></>
            : item.state === 'linked'
              ? <><Pause size={13} /><span>未开启</span></>
              : <Plus size={15} />}
      </span>
    </button>
  )
}

/**
 * 首屏骨架：与真实卡片同网格同尺寸。
 * 数据未就绪时只画它，避免「先按注册表全量画 7 张卡 → 异步数据回来收缩成真实目录」
 * 造成的卡片跳动 / 滚动条闪现。
 */
function ConnectorsSkeleton() {
  return (
    <div className="op-conn-grid" aria-busy="true" aria-label="正在读取连接器">
      {Array.from({ length: 6 }, (_, index) => (
        <div key={index} className="op-conn-skel-card" aria-hidden="true">
          <span className="op-conn-tile op-conn-skel-tile" />
          <span className="op-conn-info">
            <span className="op-conn-skel-line op-conn-skel-name" />
            <span className="op-conn-skel-line op-conn-skel-desc" />
          </span>
          <span className="op-conn-skel-dot" />
        </div>
      ))}
    </div>
  )
}

/**
 * 连接器页：目录与状态全部来自真实数据（快照式加载，见 connectorsData.ts）。
 * - 目录：SaaS 已配置 OAuth 的应用全集（oauthConfigs 明细 = 真正打通可连接的）；
 *   不可用时回落网关注册表（local 模式/未登录）
 * - 状态：Gateway 的实时连接清单（status.connections，支持同源多账号）
 * - 连接 = 发起授权 + 轮询结果；断开 = 删除该连接（本地墓碑）
 * - 没有桌面 API（纯 Web 预览）时回落静态注册表，仅保留原型观感
 * - 首帧策略：没有快照就渲染骨架，快照就绪后只提交一次；有缓存则首帧直接是真实内容
 */
export function ConnectorsView({ onToast }: { onToast: (msg: string) => void }) {
  /**
   * 数据快照：null = 首屏数据未就绪 → 渲染骨架屏，绝不先画注册表兜底目录
   * （先画假目录、异步数据一到再收缩，就是「进入页面闪一下」）。
   * 有模块级缓存时初始即有值：重复进入页面首帧直接是真实内容。
   */
  const [snapshot, setSnapshot] = useState<ConnectorsSnapshot | null>(() => peekConnectorsSnapshot())
  const [cat, setCat] = useState<ConnCategory | 'all'>('all')
  const [openId, setOpenId] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  /** 拉最新快照（动作后刷新 / 定时轮询共用）。失败兜底不会覆盖已渲染的真实目录。 */
  const refresh = useCallback(async () => {
    const next = await loadConnectorsSnapshot()
    setSnapshot(next)
    return next
  }, [])

  useEffect(() => {
    let cancelled = false
    let retryTimer: number | null = null
    let attempts = 0
    const sync = async (): Promise<void> => {
      const next = await loadConnectorsSnapshot().catch(() => null)
      if (cancelled) return
      if (next?.complete) { setSnapshot(next); return }
      // 网关/桥还没就绪：保持骨架并短暂重试，别把失败兜底当首屏数据画出来。
      attempts += 1
      if (attempts < 4) {
        retryTimer = window.setTimeout(() => { void sync() }, 700)
        return
      }
      // 多次重试仍失败：退回兜底内容，避免永远停在骨架。
      if (next) setSnapshot(next)
    }
    void sync()
    // 连接状态定时校准（同源多账号/墓碑可能在别处变化）。
    const timer = window.setInterval(() => {
      void loadConnectorsSnapshot()
        .then((next) => { if (!cancelled && next.complete) setSnapshot(next) })
        .catch(() => undefined)
    }, 60_000)
    return () => {
      cancelled = true
      if (retryTimer !== null) window.clearTimeout(retryTimer)
      window.clearInterval(timer)
    }
  }, [])

  const items = useMemo(() => (snapshot ? buildItems(snapshot) : []), [snapshot])
  const shown = cat === 'all' ? items : items.filter((c) => c.category === cat)
  const cur = items.find((c) => c.provider === openId)
  const connectedCount = items.filter((c) => c.connected).length
  const presentCategories = CATEGORY_ORDER.filter((c) => items.some((item) => item.category === c))
  const feishuAuth = snapshot?.feishuAuth ?? null
  const disconnected = snapshot?.disconnected ?? null

  // Esc 关闭抽屉
  useEffect(() => {
    if (!openId) return
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpenId(null) }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [openId])

  const connect = async (item: ConnectorItem) => {
    // 飞书凭据走本机 lark-cli（设备码授权），不走 oo/Nango。
    if (item.credentialSource === 'feishu-cli') {
      await connectFeishu(item)
      return
    }
    const api = window.nxcore?.nangoConnector
    if (!api) {
      onToast('当前是原型预览，未连接桌面服务。')
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
    setBusyId(item.provider)
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
            onToast(`「${item.name}」已连接，Agent 可随时查询。`)
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
      setBusyId(null)
    }
  }

  /**
   * 飞书授权（本机 lark-cli）：两阶段（应用初始化 → 用户设备码授权）由主进程
   * 自动推进；这里只轮询 agentAuth.status()。授权页由主进程 onVerificationUrl
   * 自动打开系统浏览器（每阶段一次）——渲染层不再 window.open，否则同一验证
   * 链接会被打开两次（用户看到「发起了两个请求」，第二个标签页提示已使用）。
   */
  const connectFeishu = async (item: ConnectorItem) => {
    const api = window.nxcore?.agentAuth
    if (!api) {
      onToast('当前是原型预览，未连接桌面服务。')
      return
    }
    setBusyId(item.provider)
    try {
      await api.start({ provider: 'feishu' })
      onToast('正在发起飞书授权，请在自动打开的浏览器页面中完成授权。')
      const deadline = Date.now() + 15 * 60_000
      while (Date.now() < deadline) {
        await new Promise((resolve) => window.setTimeout(resolve, 2_000))
        const status = await api.status()
        if (status.feishu?.userAuthorized) {
          // 之前被「关闭」过（墓碑还在）：授权成功后顺带开启，省一次点击。
          if (disconnected?.has(FEISHU_CONNECTION_ID)) {
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
      setBusyId(null)
    }
  }

  /** 注销本机飞书凭据（lark-cli auth logout）——与「关闭」开关不同，会真的清凭据。 */
  const revokeFeishu = async () => {
    const api = window.nxcore?.agentAuth
    if (!api) return
    setBusyId('feishu')
    try {
      await api.disconnect('feishu')
      await refresh()
      onToast('已注销本机飞书授权。')
    } catch (error) {
      onToast(error instanceof Error ? error.message : '注销飞书授权失败。')
    } finally {
      setBusyId(null)
    }
  }

  const disconnect = async (item: ConnectorItem, connection: ConnectorConnection) => {
    const api = window.nxcore?.nangoConnector
    if (!api) {
      onToast('当前是原型预览，未连接桌面服务。')
      return
    }
    setBusyId(item.provider)
    try {
      await api.purgeConnection(connection.id)
      await refresh()
      onToast(`已关闭「${item.name} · ${connection.connectionName}」，凭据保留，可随时重新开启。`)
    } catch (error) {
      onToast(error instanceof Error ? error.message : '关闭失败。')
    } finally {
      setBusyId(null)
    }
  }

  /** 开启（未开启 → 已连接）：移除墓碑，oo 凭据一直在。 */
  const enableConnection = async (item: ConnectorItem, connection: ConnectorConnection) => {
    const api = window.nxcore?.nangoConnector
    if (!api?.reconnectConnection) {
      onToast('当前版本不支持开启，请升级应用。')
      return
    }
    setBusyId(item.provider)
    try {
      await api.reconnectConnection(connection.id)
      await refresh()
      onToast(`已开启「${item.name} · ${connection.connectionName}」，Agent 可即席查询。`)
    } catch (error) {
      onToast(error instanceof Error ? error.message : '开启失败。')
    } finally {
      setBusyId(null)
    }
  }

  const filters = [
    { key: 'all' as const, label: '全部' },
    ...presentCategories.map((c) => ({ key: c, label: CATEGORY_LABEL[c] })),
  ]

  const hint = snapshot === null
    ? '正在读取连接器…'
    : snapshot.hasApi === false
      ? '原型预览 · 未连接桌面服务，数据仅为静态示意'
      : `连接后，Agent 可在工作途中即席查询这些来源 · 已连接 ${connectedCount}/${items.length}`
  const enabled = snapshot?.enabled ?? true

  return (
    <>
      <PageHead title="连接器" hint={hint}>
        {snapshot === null ? (
          <div className="op-seg op-conn-skel-seg" aria-hidden="true">
            <span className="op-conn-skel-pill" />
            <span className="op-conn-skel-pill" />
            <span className="op-conn-skel-pill" />
          </div>
        ) : enabled ? (
          <Seg items={filters} value={cat} onChange={setCat} />
        ) : null}
      </PageHead>

      {snapshot === null ? (
        <ConnectorsSkeleton />
      ) : enabled ? (
        <div className="op-conn-grid">
          {shown.map((c) => (
            <ConnectorCard
              key={c.provider}
              item={c}
              busy={busyId === c.provider}
              onOpen={() => setOpenId(c.provider)}
            />
          ))}
          {shown.length === 0 && <div className="op-empty">该分类下没有连接器</div>}
        </div>
      ) : (
        <div className="op-empty">连接器模块未启用（网关配置）</div>
      )}

      {cur && (
        <>
          <div className="op-drawer-mask" onClick={() => setOpenId(null)} />
          <aside className="op-drawer" aria-label={`${cur.name} 详情`}>
            <button className="op-drawer-close" type="button" onClick={() => setOpenId(null)} aria-label="关闭">
              <X size={14} />
            </button>
            <div className="op-drawer-hero">
              <ConnectorLogo iconUrl={cur.iconUrl} slug={cur.slug} color={cur.color} letter={cur.letter} size={32} />
              <div>
                <div className="op-drawer-name">{cur.name}</div>
                <div className="op-drawer-cat">{CATEGORY_LABEL[cur.category]}</div>
              </div>
            </div>
            <p className="op-drawer-desc">{cur.desc}</p>
            <div className="op-drawer-block">
              <div className="op-drawer-label">权限范围</div>
              <div className="op-chips">
                {cur.scopes.map((s) => <span key={s} className="op-chip">{s}</span>)}
              </div>
            </div>
            <div className="op-drawer-block">
              <div className="op-drawer-label">连接状态</div>
              <div className={`op-drawer-status ${cur.state}`}>
                <i className={`op-dot${cur.state === 'active' ? ' on' : ''}`} />
                {STATE_LABEL[cur.state]}
              </div>
              {cur.credentialSource === 'feishu-cli'
                ? (
                    <>
                      {cur.state === 'linked' && (
                        <p className="op-drawer-note">本机 lark-cli 已授权（凭据保留），开启后 Agent 即可使用飞书文档。</p>
                      )}
                      {feishuAuth?.cliState === 'missing' && (
                        <p className="op-drawer-note">lark-cli 未预装或不可用：{feishuAuth.message ?? '请更新应用。'}</p>
                      )}
                      {feishuAuth?.cliState === 'error' && feishuAuth.message && (
                        <p className="op-drawer-note">lark-cli 状态异常：{feishuAuth.message}</p>
                      )}
                      {cur.accountLabel && (
                        <p className="op-drawer-note">当前账号：{cur.accountLabel}</p>
                      )}
                    </>
                  )
                : cur.state === 'linked' && (
                    <p className="op-drawer-note">已在 oo 侧完成授权（凭据保留），开启后 Agent 即可查询。</p>
                  )}
            </div>
            {cur.state !== 'unlinked' && (
              <div className="op-drawer-block">
                <div className="op-drawer-label">{cur.state === 'active' ? '已开启账号' : '可开启账号'}</div>
                <div className="op-conn-accounts">
                  {cur.state === 'active' && cur.connections.map((conn) => (
                    <div key={conn.id} className="op-conn-account">
                      <i className={`op-dot${conn.status === 'active' ? ' on' : ''}`} title={CONNECTION_STATUS_LABEL[conn.status]} />
                      <span className="op-conn-account-name" title={conn.id}>{conn.connectionName}</span>
                      <span className="op-conn-account-time">{conn.updatedAt ? timeAgo(conn.updatedAt) : ''}</span>
                      <button
                        type="button"
                        className="op-conn-account-off"
                        disabled={busyId === cur.provider}
                        onClick={() => void disconnect(cur, conn)}
                      >
                        关闭
                      </button>
                    </div>
                  ))}
                  {cur.state === 'linked' && cur.pausedConnections.map((conn) => (
                    <div key={conn.id} className="op-conn-account">
                      <i className="op-dot" />
                      <span className="op-conn-account-name" title={conn.id}>{conn.connectionName}</span>
                      <button
                        type="button"
                        className="op-conn-account-on"
                        disabled={busyId === cur.provider}
                        onClick={() => void enableConnection(cur, conn)}
                      >
                        开启
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {cur.state !== 'active' && (
              <button
                type="button"
                className="op-primary-btn"
                disabled={busyId === cur.provider}
                onClick={() => cur.state === 'linked' ? void enableConnection(cur, cur.pausedConnections[0]) : void connect(cur)}
              >
                {busyId === cur.provider ? '处理中…' : cur.state === 'linked' ? '开启' : '连接'}
              </button>
            )}
            {cur.state === 'active' && cur.credentialSource !== 'feishu-cli' && (
              <button
                type="button"
                className="op-primary-btn"
                disabled={busyId === cur.provider}
                onClick={() => void connect(cur)}
              >
                {busyId === cur.provider ? '授权中…' : '添加账号'}
              </button>
            )}
            {cur.state === 'active' && cur.credentialSource === 'feishu-cli' && (
              <button
                type="button"
                className="op-danger-btn"
                disabled={busyId === cur.provider}
                onClick={() => void revokeFeishu()}
              >
                {busyId === cur.provider ? '处理中…' : '注销本机飞书授权'}
              </button>
            )}
          </aside>
        </>
      )}
    </>
  )
}
