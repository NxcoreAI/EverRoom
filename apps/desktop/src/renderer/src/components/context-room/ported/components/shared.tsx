import * as Dialog from '@radix-ui/react-dialog';
import { AlertTriangle, type LucideIcon, X } from 'lucide-react';
import type { ReactNode } from 'react';

import type { ToolbarAction } from '../types';
import { cn, uiText } from '../adapters';
import { useLocale } from '../../../../i18n/LocaleContext';
export function ToolbarButton({ action }: { action: ToolbarAction }) {
  const { t } = useLocale();
  const Icon = action.icon;

  return (
    <button
      type="button"
      aria-label={t(uiText(action.label))}
      aria-pressed={action.isActive ?? false}
      title={t(uiText(action.label))}
      className={cn(
        'flex size-8 items-center justify-center rounded-md border border-transparent text-zinc-600 transition-colors',
        'hover:border-zinc-200 hover:bg-white hover:text-zinc-950',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-offset-2',
        action.isActive && 'border-sky-200 bg-sky-50 text-sky-700'
      )}
      onMouseDown={(event) => event.preventDefault()}
      onClick={action.onSelect}
    >
      <Icon className="size-4" aria-hidden="true" strokeWidth={1.8} />
    </button>
  );
}

export function Metric({ label, value }: { label: string; value: string }) {
  const { t } = useLocale();
  return (
    <div className="rounded-md border border-zinc-200 bg-zinc-50 px-2 py-2 shadow-inner">
      <div className="text-[11px] text-zinc-500">{t(uiText(label))}</div>
      <div className="mt-1 text-sm font-semibold text-zinc-950">{value}</div>
    </div>
  );
}

export function Tag({
  children,
  variant = 'default',
}: {
  children: ReactNode;
  variant?: 'default' | 'info' | 'ai' | 'warn' | 'success' | 'danger';
}) {
  return (
    <span
      className={cn(
        'context-room-tag inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-medium tabular-nums',
        {
          default: 'border-zinc-200 bg-zinc-50 text-zinc-600',
          info: 'border-sky-200 bg-sky-50 text-sky-700',
          ai: 'border-violet-200 bg-violet-50 text-violet-700',
          warn: 'border-amber-200 bg-amber-50 text-amber-700',
          success: 'border-emerald-200 bg-emerald-50 text-emerald-700',
          danger: 'border-red-200 bg-red-50 text-red-700',
        }[variant]
      )}
    >
      {children}
    </span>
  );
}

export function Panel({
  title,
  badge,
  action,
  children,
  className,
}: {
  title: string;
  badge?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        'context-room-panel rounded-lg border border-zinc-200 bg-white p-4 shadow-sm',
        className
      )}
    >
      <div className="context-room-panel-head mb-4 flex items-center justify-between gap-3">
        <h2 className="min-w-0 text-base font-semibold text-zinc-950 text-balance">{title}</h2>
        {badge}
        {action}
      </div>
      {children}
    </section>
  );
}

export function ReferenceDialog({
  open,
  onOpenChange,
  title,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: ReactNode;
}) {
  const { t } = useLocale();
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="context-room-dialog-overlay" />
        <Dialog.Content className="context-room-dialog-content" aria-label={title}>
          <Dialog.Title className="sr-only">{title}</Dialog.Title>
          <Dialog.Description className="sr-only">{t('contextRoom:shared.completeTheCurrentContextRoomAction')}</Dialog.Description>
          <Dialog.Close className="context-room-dialog-close" aria-label={t('contextRoom:shared.closeDialog')}>
            <X className="size-4" aria-hidden="true" />
          </Dialog.Close>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export interface ConfirmDialogRow {
  label: string;
  value: ReactNode;
}

export function ActionConfirmDialog({
  open,
  onOpenChange,
  title,
  summary,
  rows = [],
  sources = [],
  risk,
  confirmLabel = 'contextRoom:shared.confirmAction',
  danger = false,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  summary: string;
  rows?: ConfirmDialogRow[];
  sources?: Array<{ type: string; name: string }>;
  risk?: string;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
}) {
  const { t } = useLocale();
  return (
    <ReferenceDialog open={open} onOpenChange={onOpenChange} title={title}>
      <div className="context-room-action-confirm">
        <header>
          <h2>{title}</h2>
        </header>
        <div className="context-room-action-confirm-body">
          <p>{summary}</p>
          {rows.map((row) => (
            <div className="context-room-action-confirm-row" key={row.label}>
              <span>{row.label}</span>
              <b>{row.value}</b>
            </div>
          ))}
          {sources.length ? (
            <div className="context-room-action-confirm-row">
              <span>{t('contextRoom:shared.sources')}</span>
              <b>{sources.map((source) => `${t(uiText(source.type))} · ${source.name}`).join('；')}</b>
            </div>
          ) : null}
          {risk ? (
            <div className="context-room-action-confirm-risk">
              <AlertTriangle aria-hidden="true" />
              <span>{risk}</span>
            </div>
          ) : null}
        </div>
        <footer>
          <button type="button" className="context-room-ghost" onClick={() => onOpenChange(false)}>
            {t('contextRoom:shared.cancel')}
          </button>
          <button
            type="button"
            className={danger ? 'context-room-danger-button' : 'context-room-primary'}
            onClick={() => {
              onOpenChange(false);
              onConfirm();
            }}
          >
            {t(confirmLabel)}
          </button>
        </footer>
      </div>
    </ReferenceDialog>
  );
}

export interface ReferenceFormField {
  defaultValue?: string;
  label: string;
  multiline?: boolean;
  name: string;
  options?: string[];
  placeholder?: string;
  required?: boolean;
}

export function ReferenceForm({
  title,
  fields,
  submitLabel,
  onSubmit,
}: {
  title: string;
  fields: ReferenceFormField[];
  submitLabel: string;
  onSubmit: () => void;
}) {
  const { t } = useLocale();
  return (
    <form
      className="context-room-reference-form"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <h2>{t(title)}</h2>
      <div className="context-room-reference-fields">
        {fields.map((field) => (
          <label key={field.name}>
            <span>{t(uiText(field.label))}</span>
            {field.options ? (
              <select
                name={field.name}
                defaultValue={field.defaultValue ?? field.options[0]}
                required={field.required}
              >
                {field.options.map((option) => (
                  <option key={option} value={option}>{t(uiText(option))}</option>
                ))}
              </select>
            ) : field.multiline ? (
              <textarea
                name={field.name}
                defaultValue={field.defaultValue}
                placeholder={t(uiText(field.placeholder))}
                required={field.required}
                rows={4}
              />
            ) : (
              <input
                name={field.name}
                defaultValue={field.defaultValue}
                placeholder={t(uiText(field.placeholder))}
                required={field.required}
              />
            )}
          </label>
        ))}
      </div>
      <div className="context-room-reference-form-actions">
        <button type="submit" className="context-room-primary">
          {t(submitLabel)}
        </button>
      </div>
    </form>
  );
}

export function ConfirmCard({
  title,
  summary,
  rows = [],
  risk,
  confirmLabel,
  onConfirm,
}: {
  title: string;
  summary: string;
  rows?: Array<{ label: string; value: string }>;
  risk?: string;
  confirmLabel: string;
  onConfirm?: () => void;
}) {
  const { t } = useLocale();
  return (
    <section className="context-room-confirm-card rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
      <div className="mb-2 text-base font-semibold text-zinc-950 text-balance">{t(title)}</div>
      <div className="text-sm leading-6 text-zinc-600 text-pretty">{summary}</div>
      {rows.length ? (
        <div className="mt-3 divide-y divide-dashed divide-zinc-200 border-y border-dashed border-zinc-200">
          {rows.map((row) => (
            <div key={uiText(row.label)} className="flex gap-3 py-2 text-sm">
              <span className="w-16 shrink-0 text-zinc-500">{t(uiText(row.label))}</span>
              <span className="min-w-0 flex-1 text-zinc-800">{row.value}</span>
            </div>
          ))}
        </div>
      ) : null}
      {risk ? (
        <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-700">
          {risk}
        </div>
      ) : null}
      <div className="mt-4 flex justify-end">
        <button
          type="button"
          onClick={onConfirm}
          className="rounded-md border border-sky-200 bg-sky-600 px-3 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-sky-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-offset-2"
        >
          {t(confirmLabel)}
        </button>
      </div>
    </section>
  );
}

export function SideTab({
  icon: Icon,
  label,
  active = false,
  count,
  onSelect,
}: {
  icon: LucideIcon;
  label: string;
  active?: boolean;
  count?: number;
  onSelect?: () => void;
}) {
  const { t } = useLocale();
  return (
    <button
      type="button"
      aria-pressed={active}
      className={cn(
        'context-room-side-tab flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors',
        'hover:bg-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-offset-2',
        active ? 'bg-sky-50 font-semibold text-sky-700' : 'text-zinc-700'
      )}
      onClick={onSelect}
    >
      <Icon
        className={cn('size-4 shrink-0', active ? 'text-sky-600' : 'text-zinc-500')}
        aria-hidden="true"
      />
      <span className="min-w-0 flex-1 truncate">{t(uiText(label))}</span>
      {typeof count === 'number' ? <Tag>{count}</Tag> : null}
    </button>
  );
}

export function RoomDataItem({
  type,
  title,
  time,
  summary,
  onSelect,
}: {
  type: string;
  title: string;
  time: string;
  summary: string;
  onSelect?: () => void;
}) {
  return (
    <button
      type="button"
      className="context-room-data-item rounded-md border border-zinc-200 bg-zinc-50 px-3 py-3 text-left shadow-inner"
      onClick={onSelect}
    >
      <div className="context-room-data-head flex items-center gap-2">
        <Tag variant="info">{type}</Tag>
        <b className="min-w-0 flex-1 truncate text-sm font-semibold text-zinc-950">{title}</b>
        <span className="shrink-0 text-[11px] tabular-nums text-zinc-400">{time}</span>
      </div>
      <div className="mt-2 text-xs leading-5 text-zinc-600 text-pretty">{summary}</div>
    </button>
  );
}

export function DataPanel({
  title,
  icon: Icon,
  items,
}: {
  title: string;
  icon: LucideIcon;
  items: string[];
}) {
  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-semibold text-zinc-950 text-balance">{title}</h2>
        <Icon className="size-4 text-sky-600" aria-hidden="true" strokeWidth={1.8} />
      </div>
      <div className="mt-4 grid gap-2">
        {items.map((item) => (
          <div
            key={item}
            className="rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-700"
          >
            {item}
          </div>
        ))}
      </div>
    </section>
  );
}
