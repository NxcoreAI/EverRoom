import contextRoomEnglishMessages from './locales/en-US/contextRoom.json'
import diaryRealityEnglishMessages from './locales/en-US/diaryReality.json'
import memoryEnglishMessages from './locales/en-US/memory.json'
import surfaceEnglishMessages from './locales/en-US/surface.json'
import contextRoomChineseMessages from './locales/zh-CN/contextRoom.json'
import diaryRealityChineseMessages from './locales/zh-CN/diaryReality.json'
import memoryChineseMessages from './locales/zh-CN/memory.json'
import surfaceChineseMessages from './locales/zh-CN/surface.json'

export const SUPPORTED_LOCALES = ['zh-CN', 'en-US'] as const
export type AppLocale = typeof SUPPORTED_LOCALES[number]

export const i18nResources = {
  'zh-CN': {
    common: {},
    contextRoom: contextRoomChineseMessages,
    diaryReality: diaryRealityChineseMessages,
    memory: memoryChineseMessages,
    surface: surfaceChineseMessages,
  },
  'en-US': {
    common: {},
    contextRoom: contextRoomEnglishMessages,
    diaryReality: diaryRealityEnglishMessages,
    memory: memoryEnglishMessages,
    surface: surfaceEnglishMessages,
  },
} as const

export type I18nNamespace = keyof typeof i18nResources['en-US']
