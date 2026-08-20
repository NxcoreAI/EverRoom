import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'

import { i18nResources } from './resources'

if (!i18n.isInitialized) {
  void i18n
    .use(initReactI18next)
    .init({
      resources: i18nResources,
      lng: 'zh-CN',
      fallbackLng: false,
      fallbackNS: 'common',
      defaultNS: 'common',
      ns: ['common', 'contextRoom', 'diaryReality', 'memory', 'surface'],
      interpolation: {
        escapeValue: false,
        prefix: '{',
        suffix: '}',
      },
      returnNull: false,
      returnEmptyString: false,
      keySeparator: false,
      react: {
        useSuspense: false,
      },
    })
}

export default i18n
