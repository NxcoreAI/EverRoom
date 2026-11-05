import contextRoomEnglishMessages from './locales/en-US/contextRoom.json'
import surfaceEnglishMessages from './locales/en-US/surface.json'
import contextRoomChineseMessages from './locales/zh-CN/contextRoom.json'
import surfaceChineseMessages from './locales/zh-CN/surface.json'

export const SUPPORTED_LOCALES = ['zh-CN', 'en-US'] as const
export type AppLocale = typeof SUPPORTED_LOCALES[number]

export const i18nResources = {
  'zh-CN': {
    common: {},
    contextRoom: contextRoomChineseMessages,
    surface: surfaceChineseMessages,
  },
  'en-US': {
    common: {},
    contextRoom: contextRoomEnglishMessages,
    surface: surfaceEnglishMessages,
  },
} as const

export type I18nNamespace = keyof typeof i18nResources['en-US']
