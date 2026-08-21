export interface SummaryDetailMinimum {
  overview: number
  keyPoints: number
}

export function summaryDetailMinimum(transcriptLength: number): SummaryDetailMinimum | null {
  if (transcriptLength > 5_000) return { overview: 600, keyPoints: 10 }
  if (transcriptLength > 1_500) return { overview: 500, keyPoints: 7 }
  if (transcriptLength > 300) return { overview: 180, keyPoints: 4 }
  return null
}
