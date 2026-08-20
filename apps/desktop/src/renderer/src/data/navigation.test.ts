import { describe, expect, it } from 'vitest'

import { navigationSections, pageLabels } from './navigation'

describe('desktop navigation', () => {
  it('keeps Diary under Execution without legacy Agent, Office, or Tasks pages', () => {
    const execution = navigationSections.find((section) => section.id === 'execution')
    const pageIds = navigationSections.flatMap((section) => section.items.map((item) => item.id))

    expect(execution?.items.map((item) => item.id)).toEqual(['diary'])
    expect(pageIds).not.toContain('agents')
    expect(pageIds).not.toContain('tasks')
    expect(pageLabels).not.toHaveProperty('office')
  })
})
