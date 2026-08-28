import { CalendarDays } from 'lucide-react';

import { SourceIcon, type SourceIconKind } from '@/components/pages/sources/SourceIcon';

/**
 * 日历服务商 → 品牌图标注册表（日程面板日程列表的数据源标识）。
 * key 统一用连字符 slug（google-calendar / outlook-calendar / feishu-calendar），
 * 下划线写法（google_calendar 等域表 service 值）会在查找前归一化，两种都对得上。
 * 新增日历服务商时：assets/source-icons/ 放品牌 SVG → SourceIcon 注册 → 此处加一行映射，
 * 网关侧把 connector_calendar_events.service 透传到投影 claim 的 data.provider 即可点亮。
 * 未登记的 provider 与本地日程/LLM 快照回退通用日历图标，不阻断展示。
 */
const CALENDAR_PROVIDER_ICONS: Record<string, SourceIconKind> = {
  'google-calendar': 'google-calendar',
  outlook: 'outlook', // 预留：Outlook 日历（与邮件共用品牌标）
  'outlook-calendar': 'outlook',
  feishu: 'feishu', // 预留：飞书日历
  'feishu-calendar': 'feishu',
};

export function CalendarProviderIcon({ provider }: { provider?: string | null }) {
  const slug = provider?.trim().toLowerCase().replaceAll('_', '-');
  const kind = slug ? CALENDAR_PROVIDER_ICONS[slug] : undefined;
  if (!kind) return <CalendarDays aria-hidden="true" />;
  return <SourceIcon kind={kind} />;
}
