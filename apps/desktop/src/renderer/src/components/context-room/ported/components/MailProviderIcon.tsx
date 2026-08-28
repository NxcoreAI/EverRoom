import { Mail } from 'lucide-react';

import { SourceIcon, type SourceIconKind } from '@/components/pages/sources/SourceIcon';

/**
 * 邮箱服务商 → 品牌图标注册表（邮箱面板邮件列表的数据源标识）。
 * 新增邮箱服务商时：在 assets/source-icons/ 放品牌 SVG → SourceIcon 注册 → 此处加一行映射，
 * 网关侧只需把 provider slug 透传到 RoomMail.provider，即可自动点亮。
 * 未登记的 provider 与本地快照邮件回退通用邮件图标，不阻断展示。
 */
const MAIL_PROVIDER_ICONS: Record<string, SourceIconKind> = {
  gmail: 'gmail',
  outlook: 'outlook',
};

export function MailProviderIcon({ provider }: { provider?: string | null }) {
  const kind = provider ? MAIL_PROVIDER_ICONS[provider.trim().toLowerCase()] : undefined;
  if (!kind) return <Mail aria-hidden="true" />;
  return <SourceIcon kind={kind} />;
}
