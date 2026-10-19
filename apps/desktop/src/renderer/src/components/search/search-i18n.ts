import i18n from '@/i18n/i18next'
import zhSearch from '@/i18n/locales/zh-CN/search.json'
import enSearch from '@/i18n/locales/en-US/search.json'

// 运行时直接挂 bundle：长驻 dev server 可能持有 resources.ts/i18next.ts 的旧编译
// 结果（观察到的怪象），新文件才会被可靠加载；重复注册（overwrite）无害。
if (i18n.isInitialized) {
  registerSearchBundle()
} else {
  void i18n.on('initialized', registerSearchBundle)
}

function registerSearchBundle(): void {
  i18n.addResourceBundle('zh-CN', 'search', zhSearch, true, true)
  i18n.addResourceBundle('en-US', 'search', enSearch, true, true)
}
