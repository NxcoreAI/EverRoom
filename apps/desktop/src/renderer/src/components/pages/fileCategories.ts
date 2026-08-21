import type { LucideIcon } from 'lucide-react'
import {
  BarChart3,
  BookOpen,
  BriefcaseBusiness,
  ClipboardList,
  FileCheck2,
  FileText,
  GraduationCap,
  Handshake,
  Presentation,
  ScrollText,
  Table2,
  Users,
} from 'lucide-react'

import type { FileCatalogDto } from '../../../../shared/ingest'

export interface FileCategoryDefinition {
  key: string
  label: string
  icon: LucideIcon
  tone: 'blue' | 'green' | 'orange' | 'purple' | 'red' | 'teal' | 'slate'
}

export const FILE_CATEGORY_DEFINITIONS: FileCategoryDefinition[] = [
  { key: 'data', label: 'surface:files.categoryData', icon: BarChart3, tone: 'green' },
  { key: 'form', label: 'surface:files.categoryForm', icon: ClipboardList, tone: 'blue' },
  { key: 'lesson', label: 'surface:files.categoryLesson', icon: Presentation, tone: 'orange' },
  { key: 'proof', label: 'surface:files.categoryProof', icon: FileCheck2, tone: 'teal' },
  { key: 'paper', label: 'surface:files.categoryPaper', icon: ScrollText, tone: 'purple' },
  { key: 'report', label: 'surface:files.categoryReport', icon: FileText, tone: 'red' },
  { key: 'resume', label: 'surface:files.categoryResume', icon: BriefcaseBusiness, tone: 'slate' },
  { key: 'exercise', label: 'surface:files.categoryExercise', icon: GraduationCap, tone: 'blue' },
  { key: 'meeting', label: 'surface:files.categoryMeeting', icon: Users, tone: 'teal' },
  { key: 'contract', label: 'surface:files.categoryContract', icon: Handshake, tone: 'orange' },
  { key: 'summary', label: 'surface:files.categorySummary', icon: ScrollText, tone: 'purple' },
  { key: 'book', label: 'surface:files.categoryBook', icon: BookOpen, tone: 'red' },
  { key: 'document', label: 'surface:files.categoryDocument', icon: FileText, tone: 'slate' },
]

const categoryByKey = new Map(FILE_CATEGORY_DEFINITIONS.map((category) => [category.key, category]))

const MATCHERS: Array<{ key: string; terms: string[] }> = [
  { key: 'resume', terms: ['简历', 'resume', 'curriculum vitae', 'cv'] },
  { key: 'contract', terms: ['合同', 'contract', '协议', 'agreement'] },
  { key: 'proof', terms: ['证明', '证书', 'certificate', 'qualification', 'invoice', '发票'] },
  { key: 'paper', terms: ['论文', 'paper', 'arxiv', 'doi', 'journal', 'research'] },
  { key: 'report', terms: ['报告', 'report', '调研', '白皮书', 'whitepaper'] },
  { key: 'meeting', terms: ['会议', 'meeting', '纪要', 'minutes', 'standup'] },
  { key: 'summary', terms: ['总结', 'summary', '复盘', '回顾', '周报', '月报'] },
  { key: 'exercise', terms: ['习题', '题库', '试题', '作业', 'exercise', 'homework', 'exam'] },
  { key: 'book', terms: ['书籍', 'book', 'handbook', 'manual', '教材'] },
]

function extensionOf(file: FileCatalogDto): string {
  const match = file.originalName.match(/\.([^.]+)$/)
  return match?.[1]?.toLowerCase() ?? ''
}

export function categoryForFile(file: FileCatalogDto): FileCategoryDefinition {
  if (file.agentCategory && categoryByKey.has(file.agentCategory)) return categoryByKey.get(file.agentCategory)!
  const haystack = `${file.originalName} ${file.sharedTitle}`.toLocaleLowerCase()
  for (const matcher of MATCHERS) {
    if (matcher.terms.some((term) => haystack.includes(term))) {
      return categoryByKey.get(matcher.key) ?? categoryByKey.get('document')!
    }
  }

  switch (file.dataType) {
    case 'spreadsheet': return categoryByKey.get('data')!
    case 'slides': return categoryByKey.get('lesson')!
    case 'office-doc': return categoryByKey.get('form')!
    default:
      if (['csv', 'tsv', 'xls', 'xlsx', 'json'].includes(extensionOf(file))) return categoryByKey.get('data')!
      return categoryByKey.get('document')!
  }
}
