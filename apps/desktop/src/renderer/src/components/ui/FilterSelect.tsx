import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { Check, ChevronDown } from 'lucide-react'
import './FilterSelect.css'

export function FilterSelect<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  disabled = false,
}: {
  value: T
  options: ReadonlyArray<{ value: T; label: string }>
  onChange: (value: T) => void
  ariaLabel: string
  disabled?: boolean
}) {
  const current = options.find((option) => option.value === value) ?? options[0]
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button type="button" className="filter-select" aria-label={ariaLabel} disabled={disabled}>
          <span className="filter-select-value">{current?.label}</span>
          <ChevronDown className="filter-select-chevron" size={13} strokeWidth={1.8} aria-hidden="true" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="filter-menu" align="start" sideOffset={4}>
          <DropdownMenu.RadioGroup value={value}>
            {options.map((option) => (
              <DropdownMenu.RadioItem
                key={option.value}
                value={option.value}
                className="filter-menu-item"
                onSelect={() => onChange(option.value)}
              >
                <span className="filter-menu-check" aria-hidden="true">
                  {value === option.value ? <Check size={13} strokeWidth={2} /> : null}
                </span>
                <span className="filter-menu-item-label">{option.label}</span>
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
