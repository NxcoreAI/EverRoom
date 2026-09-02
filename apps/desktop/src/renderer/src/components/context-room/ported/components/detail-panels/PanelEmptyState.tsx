import type { LucideIcon } from 'lucide-react';
import { AlertTriangle } from 'lucide-react';

export function PanelEmptyState({
  icon: Icon,
  title,
  description,
  error = false,
  action,
  compact = false,
  className,
}: {
  icon: LucideIcon;
  title: string;
  description?: string;
  /** 错误态：与「确实没有数据」的空态区分——服务不可用时不假装为空。 */
  error?: boolean;
  /** 错误态的重试等就地动作。 */
  action?: { label: string; onClick: () => void };
  compact?: boolean;
  className?: string;
}) {
  return (
    <div
      className={`context-room-panel-empty${compact ? ' is-compact' : ''}${className ? ` ${className}` : ''}`}
      data-testid="context-room-panel-empty"
      data-error={error ? 'true' : undefined}
    >
      <span className="context-room-panel-empty-icon">
        {error ? <AlertTriangle aria-hidden="true" /> : <Icon aria-hidden="true" />}
      </span>
      <h3>{title}</h3>
      {description ? <p>{description}</p> : null}
      {error && action ? (
        <button type="button" className="context-room-panel-empty-action" onClick={action.onClick}>
          {action.label}
        </button>
      ) : null}
    </div>
  );
}
