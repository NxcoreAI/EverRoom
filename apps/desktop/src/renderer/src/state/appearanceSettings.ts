/**
 * 全局外观（主题）设置。
 *
 * 只负责「选哪套主题 + 持久化 + 写到 <html>」，具体色值在 styles/themes.css。
 * 与 locale 一样用 localStorage 存偏好，并派发事件让设置页即时同步。
 */
export type AppearanceTheme = 'paper' | 'plain' | 'moss' | 'night'

export const APPEARANCE_THEMES: readonly AppearanceTheme[] = ['paper', 'plain', 'moss', 'night']

export const DEFAULT_APPEARANCE_THEME: AppearanceTheme = 'paper'

const STORAGE_KEY = 'everroom:appearance-theme:v1'
const CHANGE_EVENT = 'everroom:appearance-theme-changed'

export function resolveAppearanceTheme(value: unknown): AppearanceTheme {
  return typeof value === 'string' && (APPEARANCE_THEMES as readonly string[]).includes(value)
    ? value as AppearanceTheme
    : DEFAULT_APPEARANCE_THEME
}

export function isDarkAppearance(theme: AppearanceTheme): boolean {
  return theme === 'night'
}

export function loadAppearanceTheme(): AppearanceTheme {
  try {
    return resolveAppearanceTheme(window.localStorage.getItem(STORAGE_KEY))
  } catch {
    return DEFAULT_APPEARANCE_THEME
  }
}

/** 把主题写到 <html>：data-theme 给 themes.css，data-color-mode 给原生控件/滚动条。 */
export function applyAppearanceTheme(theme: AppearanceTheme): void {
  const root = document.documentElement
  root.dataset.theme = theme
  root.dataset.colorMode = isDarkAppearance(theme) ? 'dark' : 'light'
}

export function saveAppearanceTheme(theme: AppearanceTheme): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, theme)
  } catch {
    // localStorage 不可用时仅本次会话生效。
  }
  applyAppearanceTheme(theme)
  // 镜像到主进程：窗口底色与原生主题（滚动条/系统菜单）跟随，避免深色下闪白。
  try {
    void window.nxcore?.appearance?.setTheme(theme)
  } catch {
    // 浏览器预览 / 单测没有桌面桥。
  }
  window.dispatchEvent(new CustomEvent<AppearanceTheme>(CHANGE_EVENT, { detail: theme }))
}

export function onAppearanceThemeChanged(listener: (theme: AppearanceTheme) => void): () => void {
  const handle = (event: Event) => {
    listener((event as CustomEvent<AppearanceTheme>).detail)
  }
  window.addEventListener(CHANGE_EVENT, handle)
  return () => window.removeEventListener(CHANGE_EVENT, handle)
}

/** 启动时调用一次：读取偏好并立刻应用（index.html 里还有一段防闪白的同步脚本）。 */
export function initAppearanceTheme(): AppearanceTheme {
  const theme = loadAppearanceTheme()
  applyAppearanceTheme(theme)
  return theme
}
