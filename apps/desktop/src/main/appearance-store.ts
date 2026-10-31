/**
 * 全局外观主题的主进程侧存储。
 *
 * 渲染端用 localStorage 做权威偏好（首帧由 index.html 内联脚本应用）；
 * 这里镜像一份到 userData，让主进程在建窗时就能拿到正确底色、
 * 并让原生主题（滚动条/右键菜单/系统对话框）跟随深色。
 */
import { app, nativeTheme } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  APPEARANCE_THEME_BACKGROUND,
  isAppearanceThemeId,
  type AppearanceThemeId,
} from '../shared/sources'

export { isAppearanceThemeId }

const FILE_NAME = 'appearance.json'

function appearanceFile(): string {
  return join(app.getPath('userData'), FILE_NAME)
}

export function readAppearanceTheme(): AppearanceThemeId {
  try {
    const parsed = JSON.parse(readFileSync(appearanceFile(), 'utf8')) as { theme?: unknown }
    if (isAppearanceThemeId(parsed.theme)) return parsed.theme
  } catch {
    // 首次启动 / 文件损坏：回落到默认暖纸。
  }
  return 'paper'
}

export function applyNativeTheme(theme: AppearanceThemeId): void {
  try {
    nativeTheme.themeSource = theme === 'night' ? 'dark' : 'light'
  } catch {
    // 测试环境无 nativeTheme 时忽略。
  }
}

export function writeAppearanceTheme(theme: AppearanceThemeId): void {
  try {
    writeFileSync(appearanceFile(), `${JSON.stringify({ theme }, null, 2)}\n`, 'utf8')
  } catch {
    // 写盘失败不影响本次会话（渲染端仍有 localStorage）。
  }
  applyNativeTheme(theme)
}

/** 建窗底色：读不到偏好时用暖纸默认值。 */
export function appearanceWindowBackground(): string {
  return APPEARANCE_THEME_BACKGROUND[readAppearanceTheme()]
}
