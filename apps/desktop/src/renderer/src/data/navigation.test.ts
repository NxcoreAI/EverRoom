import { describe, expect, it } from 'vitest'

import { navigationSections, navigationSectionsForMode, pageLabels } from './navigation'

describe('desktop navigation', () => {
  it('keeps Office, Diary, and Schedules under Execution without legacy Agent or Tasks pages', () => {
    const execution = navigationSections.find((section) => section.id === 'execution')
    const pageIds = navigationSections.flatMap((section) => section.items.map((item) => item.id))

    expect(execution?.items.map((item) => item.id)).toEqual(['office', 'diary', 'schedules'])
    expect(pageIds).not.toContain('agents')
    expect(pageIds).not.toContain('tasks')
    expect(pageLabels.office).toBe('surface:navigation.office')
  })

  it('exposes the sources page without legacy connector pages', () => {
    const pages = navigationSectionsForMode().flatMap((section) => section.items.map((item) => item.id))

    expect(pages).toContain('sources')
    expect(pages).not.toContain('connectors')
  })

  it('shows the Office test entry only when development support is enabled', () => {
    const normalPages = navigationSectionsForMode().flatMap((section) => section.items.map((item) => item.id))
    const developmentPages = navigationSectionsForMode(true).flatMap((section) => section.items.map((item) => item.id))

    expect(normalPages).not.toContain('office-test')
    expect(developmentPages).toContain('office-test')
    expect(pageLabels['office-test']).toBe('surface:navigation.officeTest')
  })
})
