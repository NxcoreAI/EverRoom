import { ExternalLink, FolderOpen, Github, Globe } from 'lucide-react'

export function ConnectSourceMenu({
  busy,
  onLocalFolder,
  onGitHub,
}: {
  busy: boolean
  onLocalFolder: () => void
  onGitHub: () => void
}) {
  return (
    <div className="connect-source-menu" role="menu" aria-label="选择数据源类型">
      <button type="button" role="menuitem" disabled={busy} onClick={onLocalFolder}>
        <FolderOpen aria-hidden="true" strokeWidth={1.8} /><span><strong>本地文件夹</strong><small>扫描本机目录中的文件</small></span>
      </button>
      <button type="button" role="menuitem" disabled={busy} onClick={onGitHub}>
        <Github aria-hidden="true" strokeWidth={1.8} /><span><strong>GitHub</strong><small>同步仓库代码与 Issue</small></span>
      </button>
      <button type="button" role="menuitem" className="connect-source-disabled" disabled>
        <ExternalLink aria-hidden="true" strokeWidth={1.8} /><span><strong>飞书文档 / 云盘</strong><small>即将支持只读同步</small></span>
      </button>
      <button type="button" role="menuitem" className="connect-source-disabled" disabled>
        <Globe aria-hidden="true" strokeWidth={1.8} /><span><strong>手动网页导入</strong><small>即将支持 URL 导入</small></span>
      </button>
    </div>
  )
}
