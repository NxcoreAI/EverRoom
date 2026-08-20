import { describe, expect, it } from 'vitest'

import { navigationSections, pageLabels } from './navigation'

describe('desktop navigation', () => {
  it('keeps Office and Diary under Execution without legacy Agent or Tasks pages', () => {
    const execution = navigationSections.find((section) => section.id === 'execution')
    const pageIds = navigationSections.flatMap((section) => section.items.map((item) => item.id))

    expect(execution?.items.map((item) => item.id)).toEqual(['office', 'diary'])
    expect(pageIds).not.toContain('agents')
    expect(pageIds).not.toContain('tasks')
    expect(pageLabels.office).toBe('surface:navigation.office')
  })
})
