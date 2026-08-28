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

  it('exposes only the configured source or connector page', () => {
    const sourcePages = navigationSectionsForMode('sources').flatMap((section) => section.items.map((item) => item.id))
    const connectorPages = navigationSectionsForMode('connectors').flatMap((section) => section.items.map((item) => item.id))

    expect(sourcePages).toContain('sources')
    expect(sourcePages).not.toContain('connectors')
    expect(connectorPages).toContain('connectors')
    expect(connectorPages).not.toContain('sources')
  })

  it('shows the Office test entry only when development support is enabled', () => {
    const normalPages = navigationSectionsForMode('sources').flatMap((section) => section.items.map((item) => item.id))
    const developmentPages = navigationSectionsForMode('sources', true).flatMap((section) => section.items.map((item) => item.id))

    expect(normalPages).not.toContain('office-test')
    expect(developmentPages).toContain('office-test')
    expect(pageLabels['office-test']).toBe('surface:navigation.officeTest')
  })
})
