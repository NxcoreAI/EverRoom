// 临时配置：只服务 RuntimeConfigGate 浏览器验证（mock-gate.html）。
// 与 vite.browser.config.mts 分离：那个文件是多会话共用的活跃工作区，
// 这里只需要最小 nxcore 兜底注入，避免互相干扰。
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

const here = dirname(fileURLToPath(import.meta.url))

function nxcoreMock(): Plugin {
  return {
    name: 'mock-nxcore-minimal',
    transformIndexHtml(html) {
      return html.replace('<head>', '<head><script src="/@mock/nxcore.js"></script>')
    },
    configureServer(server) {
      server.middlewares.use('/@mock/nxcore.js', (_req, res) => {
        res.setHeader('Content-Type', 'text/javascript')
        res.end(`
const magicCache = new Map()
const magic = (name) => {
  const cached = magicCache.get(name)
  if (cached) return cached
  const fn = ((..._args) => magic(name + '()'))
  fn.then = (res2, rej) => Promise.resolve({}).then(res2, rej)
  const proxy = new Proxy(fn, {
    get: (target, prop) => {
      if (prop === 'then') return target.then
      if (prop === Symbol.toPrimitive) return () => 0
      return magic(name + '.' + String(prop))
    },
  })
  magicCache.set(name, proxy)
  return proxy
}
const face = (obj) => new Proxy(obj, {
  get: (target, prop) => (prop in target ? target[prop] : magic('x.' + String(prop))),
})
const base = {
  platform: 'darwin',
  window: {
    minimize: async () => {},
    toggleMaximize: async () => {},
    close: async () => {},
    getState: async () => ({ maximized: false }),
    onMaximizedChange: () => () => {},
  },
  locale: { system: 'zh-CN', getSystem: async () => 'zh-CN' },
  account: { status: async () => ({ authenticated: true, apiBaseUrl: 'https://mock.example' }) },
  runtimeConfig: { get: async () => ({ primaryConfigured: true, configSource: 'manual' }) },
}
window.nxcore = new Proxy(Object.fromEntries(Object.entries(base).map(([k, v]) => [k, v && typeof v === 'object' ? face(v) : v])), {
  get: (target, prop) => prop in target ? target[prop] : magic(String(prop)),
})
`)
      })
    },
  }
}

export default defineConfig({
  root: resolve(here, 'src/renderer'),
  cacheDir: resolve(here, 'node_modules/.vite-gate-mock'),
  server: {
    port: 5199,
    strictPort: true,
  },
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: { '@': resolve(here, 'src/renderer/src') },
  },
  plugins: [react(), nxcoreMock()],
})
