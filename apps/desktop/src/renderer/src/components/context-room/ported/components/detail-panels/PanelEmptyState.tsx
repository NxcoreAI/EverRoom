import type { LucideIcon } from 'lucide-react';

export function PanelEmptyState({
  icon: Icon,
  title,
  description,
  compact = false,
  className,
}: {
  icon: LucideIcon;
  title: string;
  description?: string;
  compact?: boolean;
  className?: string;
}) {
  return (
    <div
      className={`context-room-panel-empty${compact ? ' is-compact' : ''}${className ? ` ${className}` : ''}`}
      data-testid="context-room-panel-empty"
    >
      <span className="context-room-panel-empty-icon">
        <Icon aria-hidden="true" />
      </span>
      <h3>{title}</h3>
      {description ? <p>{description}</p> : null}
    </div>
  );
}
