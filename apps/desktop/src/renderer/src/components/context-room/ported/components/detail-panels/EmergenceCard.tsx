import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {
  AlertTriangle,
  EyeOff,
  FileSearch,
  HelpCircle,
  History,
  MessagesSquare,
  MoreVertical,
  Pin,
  Quote,
  Route,
  Users,
  FolderOpen,
} from 'lucide-react';

import { useLocale } from '../../../../../i18n/LocaleContext';
import type {
  EmergenceCardDto,
  EmergenceCardKind,
  EmergenceMode,
} from '../../../../../../../shared/knowledge';

interface KindMeta {
  icon: typeof FileSearch;
  tone: string;
}

const KIND_META: Record<EmergenceCardKind, KindMeta> = {
  evidence: { icon: FileSearch, tone: 'document' },
  decision: { icon: History, tone: 'data' },
  viewpoint: { icon: MessagesSquare, tone: 'communication' },
  conflict: { icon: AlertTriangle, tone: 'communication' },
  actor: { icon: Users, tone: 'people' },
  case: { icon: FolderOpen, tone: 'room' },
  question: { icon: HelpCircle, tone: 'ai' },
};

/**
 * 涌现卡片：点卡展开预览（引文/路径/理由）；主动作位置固定、语义随模式变
 * （聚焦=引用、漫步=沿此漫步）；固定/隐藏收进「···」。
 */
export function EmergenceCard({
  card,
  mode,
  nodeLabels,
  expanded,
  onToggle,
  onPrimaryAction,
  onPin,
  onHide,
}: {
  card: EmergenceCardDto;
  mode: EmergenceMode;
  /** nodeRef → 节点标题（路径渲染用）。 */
  nodeLabels: Map<string, string>;
  expanded: boolean;
  onToggle: () => void;
  onPrimaryAction: () => void;
  onPin: () => void;
  onHide: () => void;
}) {
  const { locale, t } = useLocale();
  const meta = KIND_META[card.kind];

  return (
    <article
      className="context-room-emergence-card"
      data-kind={card.kind}
      data-expanded={expanded || undefined}
    >
      <button type="button" className="context-room-emergence-card-body" onClick={onToggle}>
        <header data-icon-tone={meta.tone}>
          <meta.icon aria-hidden="true" />
          {t(`contextRoom:emergence.kind.${card.kind}`)}
          {card.roomRef ? <span className="context-room-emergence-card-room">{card.roomRef.title}</span> : null}
        </header>
        <h4>{card.title}</h4>
        <p>{card.summary}</p>
      </button>
      {expanded ? (
        <div className="context-room-emergence-card-detail">
          {card.quote ? <blockquote>{card.quote}</blockquote> : null}
          {card.path && card.path.hops.length > 0 ? (
            <p className="context-room-emergence-card-path">
              <Route aria-hidden="true" />
              {card.path.nodeRefs.map((nodeRef, index) => (
                <span key={`${nodeRef}-${index}`}>
                  {index > 0 ? <em>{card.path?.hops[index - 1]}</em> : null}
                  {nodeLabels.get(nodeRef) ?? nodeRef}
                </span>
              ))}
            </p>
          ) : null}
          <p className="context-room-emergence-card-reason">
            {card.reason}
          </p>
          {card.occurredAt ? (
            <time>{new Date(card.occurredAt).toLocaleDateString(locale)}</time>
          ) : null}
        </div>
      ) : null}
      <footer>
        <button type="button" className="context-room-emergence-card-primary" onClick={onPrimaryAction}>
          <Quote aria-hidden="true" />
          {t(mode === 'focus' ? 'contextRoom:emergence.quote' : 'contextRoom:emergence.wanderAlong')}
        </button>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button
              type="button"
              className="context-room-card-menu-button"
              aria-label={t('contextRoom:emergence.moreCardActions')}
            >
              <MoreVertical aria-hidden="true" />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content className="context-room-card-menu" sideOffset={6} align="end">
              <DropdownMenu.Item onSelect={onPin}>
                <Pin aria-hidden="true" />
                {t('contextRoom:emergence.pin')}
              </DropdownMenu.Item>
              <DropdownMenu.Item onSelect={onHide}>
                <EyeOff aria-hidden="true" />
                {t('contextRoom:emergence.hide')}
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </footer>
    </article>
  );
}
