// 品牌 logo：
// 1. SaaS 下发的 iconUrl 优先（连接器页：管理员在 SaaS 配置的品牌图标）；
// 2. 其次 assets/source-icons 官方彩色 SVG（62×62，与旧数据源页 SourceIcon 同一套素材）；
// 3. 内置单色 path（simple-icons v13，MIT/CC0）或专用图形分支；
// 4. generic = 注册表未收录 provider 的首字母兜底。
// 远程图标加载失败（断网/URL 失效）自动逐级回落，不留空 tile。

import { useState } from 'react'

import gmailLogo from '@/assets/source-icons/gmail.svg'
import googleCalendarLogo from '@/assets/source-icons/google-calendar.svg'
import googleDocsLogo from '@/assets/source-icons/google-docs.svg'
import notionLogo from '@/assets/source-icons/notion.svg'
import outlookLogo from '@/assets/source-icons/outlook.svg'
import feishuLogo from '@/assets/source-icons/feishu.svg'
import slackLogo from '@/assets/source-icons/slack.svg'

export type BrandSlug =
  | 'gmail' | 'googledrive' | 'googlecalendar' | 'notion' | 'slack' | 'github' | 'linear'
  | 'feishu' | 'outlook' | 'generic'

/** 官方彩色 SVG 素材（provider → 打包 URL）。 */
const OFFICIAL_LOGOS: Partial<Record<BrandSlug, string>> = {
  gmail: gmailLogo,
  googledrive: googleDocsLogo,
  googlecalendar: googleCalendarLogo,
  notion: notionLogo,
  outlook: outlookLogo,
  feishu: feishuLogo,
  slack: slackLogo,
}

const brandPaths: Record<Exclude<BrandSlug, 'feishu' | 'outlook' | 'googlecalendar' | 'generic'>, string> = {
  gmail: 'M24 5.457v13.909c0 .904-.732 1.636-1.636 1.636h-3.819V11.73L12 16.64l-6.545-4.91v9.273H1.636A1.636 1.636 0 0 1 0 19.366V5.457c0-2.023 2.309-3.178 3.927-1.964L5.455 4.64 12 9.548l6.545-4.91 1.528-1.145C21.69 2.28 24 3.434 24 5.457z',
  googledrive: 'M12.01 1.485c-2.082 0-3.754.02-3.743.047.01.02 1.708 3.001 3.774 6.62l3.76 6.574h3.76c2.081 0 3.753-.02 3.742-.047-.005-.02-1.708-3.001-3.775-6.62l-3.76-6.574zm-4.76 1.73a789.828 789.861 0 0 0-3.63 6.319L0 15.868l1.89 3.298 1.885 3.297 3.62-6.335 3.618-6.33-1.88-3.287C8.1 4.704 7.255 3.22 7.25 3.214zm2.259 12.653-.203.348c-.114.198-.96 1.672-1.88 3.287a423.93 423.948 0 0 1-1.698 2.97c-.01.026 3.24.042 7.222.042h7.244l1.796-3.157c.992-1.734 1.85-3.23 1.906-3.323l.104-.167h-7.249z',
  notion: 'M4.459 4.208c.746.606 1.026.56 2.428.466l13.215-.793c.28 0 .047-.28-.046-.326L17.86 1.968c-.42-.326-.981-.7-2.055-.607L3.01 2.295c-.466.046-.56.28-.374.466zm.793 3.08v13.904c0 .747.373 1.027 1.214.98l14.523-.84c.841-.046.935-.56.935-1.167V6.354c0-.606-.233-.933-.748-.887l-15.177.887c-.56.047-.747.327-.747.933zm14.337.745c.093.42 0 .84-.42.888l-.7.14v10.264c-.608.327-1.168.514-1.635.514-.748 0-.935-.234-1.495-.933l-4.577-7.186v6.952L12.21 19s0 .84-1.168.84l-3.222.186c-.093-.186 0-.653.327-.746l.84-.233V9.854L7.822 9.76c-.094-.42.14-1.026.793-1.073l3.456-.233 4.764 7.279v-6.44l-1.215-.139c-.093-.514.28-.887.747-.933zM1.936 1.035l13.31-.98c1.634-.14 2.055-.047 3.082.7l4.249 2.986c.7.513.934.653.934 1.213v16.378c0 1.026-.373 1.634-1.68 1.726l-15.458.934c-.98.047-1.448-.093-1.962-.747l-3.129-4.06c-.56-.747-.793-1.306-.793-1.96V2.667c0-.839.374-1.54 1.447-1.632z',
  slack: 'M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z',
  github: 'M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12',
  linear: 'M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z',
}

/** 该 slug 是否有官方彩色素材（tile 容器据此切换白底样式）。 */
export function hasOfficialLogo(slug: BrandSlug): boolean {
  return Boolean(OFFICIAL_LOGOS[slug])
}

/**
 * 连接器 logo：SaaS 图标 URL 优先，失败回落本地素材链。
 * tile 白底样式同时覆盖「远程图 / 官方 SVG」两级（远程图也按白底处理）。
 */
export function ConnectorLogo({
  iconUrl, slug, color, letter, size = 24,
}: {
  iconUrl: string | null
  slug: BrandSlug
  color: string
  letter: string
  size?: number
}) {
  const [remoteFailed, setRemoteFailed] = useState(false)
  const useRemote = Boolean(iconUrl) && !remoteFailed
  return (
    <span
      className={`op-conn-tile${useRemote || hasOfficialLogo(slug) ? ' branded' : ''}`}
      style={{ width: size * 1.85, height: size * 1.85, borderRadius: size * 0.46 }}
    >
      {useRemote
        ? (
            <img
              src={iconUrl ?? undefined}
              alt=""
              aria-hidden="true"
              onError={() => setRemoteFailed(true)}
            />
          )
        : <BrandMark slug={slug} color={color} size={size} letter={letter} />}
    </span>
  )
}

export function BrandMark({
  slug, color, size = 24, letter = '?',
}: { slug: BrandSlug; color: string; size?: number; letter?: string }) {
  const official = OFFICIAL_LOGOS[slug]
  if (official) {
    // 官方彩色 logo：PNG/SVG 直接铺满；tile 底板样式由容器提供。
    return <img src={official} alt="" aria-hidden="true" width={size} height={size} style={{ objectFit: 'contain' }} />
  }
  if (slug === 'outlook') {
    // 单色兜底（OFFICIAL_LOGOS 未命中时才会走到）：
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color}
        strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <rect x="3" y="4.5" width="18" height="16" rx="2.5" />
        <path d="M3 9h18" />
        <path d="M8 2.8v3.4M16 2.8v3.4" />
        <path d="m8.6 13.6 2.3 2.3 4.6-4.6" />
      </svg>
    )
  }
  if (slug === 'generic') {
    // 注册表里未收录展示元数据的 provider：品牌色首字母方块兜底。
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
        <text x="12" y="12" dominantBaseline="central" textAnchor="middle"
          fontSize="14" fontWeight="700" fill={color}
          fontFamily="-apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif">
          {letter}
        </text>
      </svg>
    )
  }
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={color} aria-hidden>
      <path d={brandPaths[slug as Exclude<BrandSlug, 'feishu' | 'outlook' | 'googlecalendar' | 'generic'>]} />
    </svg>
  )
}
