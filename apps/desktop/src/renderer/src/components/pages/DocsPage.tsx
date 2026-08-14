import { ChevronRight, FileText } from 'lucide-react'

import { PageHeader } from './PageHeader'

const DOCUMENTS = [
  ['开源版工程基线', 'Everroom 开源 PC 版', '刚刚'],
  ['Context Room 产品说明', '个人上下文产品设计', '昨天'],
  ['连接器技术调研', '连接器架构研究', '8 月 9 日'],
] as const

export function DocsPage() {
  return (
    <div className="page doc-page">
      <PageHeader title="文档" description="在原生写作空间中使用 Room、来源与 Agent。" action="新建文档" />
      <div className="doc-list">
        {DOCUMENTS.map(([title, room, time]) => (
          <button key={title} type="button" className="doc-row">
            <span className="item-icon"><FileText aria-hidden="true" strokeWidth={1.8} /></span>
            <span><strong>{title}</strong><small>{room}</small></span>
            <time>{time}</time><ChevronRight aria-hidden="true" strokeWidth={1.8} />
          </button>
        ))}
      </div>
    </div>
  )
}
