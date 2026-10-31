import type { HomePageKey } from '../types'
import { AgentPage } from './AgentPage'
import { ConnectorsHost } from './ConnectorsPage'
import { FilesPage } from './FilesPage'
import { RecentPage } from './RecentPage'
import { SettingsHost } from './SettingsPage'
import { SpacesPage } from './SpacesPage'
import './home.css'

/**
 * 主页标签的页面宿主：最近 / 项目空间 / 所有文件 / Agent / 连接器 / 设置。
 *
 * 六个页面只消费真实数据（workspace / agent session / 文件库 / 本机 Agent / MCP）；
 * 连接器与设置页复用现有组件（不改源码），主页样式全部在本目录 `home.css`。
 */
export function HomePageHost({ page }: { page: HomePageKey }) {
  switch (page) {
    case 'spaces':
      return <SpacesPage />
    case 'files':
      return <FilesPage />
    case 'agent':
      return <AgentPage />
    case 'connectors':
      return <ConnectorsHost />
    case 'settings':
      return <SettingsHost />
    case 'recent':
    default:
      return <RecentPage />
  }
}
