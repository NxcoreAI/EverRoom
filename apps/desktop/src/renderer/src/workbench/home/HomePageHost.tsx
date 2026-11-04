import type { HomePageKey } from '../types'
import { AgentPage } from './AgentPage'
import { ConnectorsHost } from './ConnectorsPage'
import { FilesPage } from './FilesPage'
import { RecentPage } from './RecentPage'
import { SettingsHost } from './SettingsPage'
import { SkillsPage } from './SkillsPage'
import { SpacesPage } from './SpacesPage'
import './home.css'

/**
 * 主页标签的页面宿主：最近 / 项目空间 / 所有文件 / Agent / 技能 / 连接器 / 设置。
 *
 * 七个页面只消费真实数据（workspace / agent session / 文件库 / agent 定义 /
 * 技能清单 / 连接器快照）。
 * 连接器与设置页复用既有组件（设置只透传 `hideHeader` + `section`），
 * 主页自己的排版全部在本目录 `home.css`，与外壳样式各管一段。
 */
export function HomePageHost({ page }: { page: HomePageKey }) {
  switch (page) {
    case 'spaces':
      return <SpacesPage />
    case 'files':
      return <FilesPage />
    case 'agent':
      return <AgentPage />
    case 'skills':
      return <SkillsPage />
    case 'connectors':
      return <ConnectorsHost />
    case 'settings':
      return <SettingsHost />
    case 'recent':
    default:
      return <RecentPage />
  }
}
