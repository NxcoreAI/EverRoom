import { describe, expect, it } from 'vitest'

import { resolveDesktopPageMode } from './page-mode'

describe('desktop page mode', () => {
  it('defaults to the data sources page', () => {
    expect(resolveDesktopPageMode(undefined)).toBe('sources')
    expect(resolveDesktopPageMode('')).toBe('sources')
    expect(resolveDesktopPageMode('invalid')).toBe('sources')
  })

  it('accepts connectors case-insensitively', () => {
    expect(resolveDesktopPageMode(' connectors ')).toBe('connectors')
  })
})
