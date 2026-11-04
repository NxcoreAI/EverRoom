import { resolve } from 'node:path'

import { sentryVitePlugin } from '@sentry/vite-plugin'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'

import packageJson from './package.json'

const uploadSourceMaps = Boolean(process.env.SENTRY_AUTH_TOKEN)
const sourceMap = uploadSourceMaps ? 'hidden' as const : false
const crossOriginIsolationHeaders = {
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Opener-Policy': 'same-origin',
}

function sentryPlugins() {
  if (!uploadSourceMaps) return []
  return [sentryVitePlugin({
    authToken: process.env.SENTRY_AUTH_TOKEN,
    org: 'sentry',
    project: 'everroom-desktop',
    url: 'https://logs.everroom.vyitec.com/',
    release: { name: `everroom@${packageJson.version}`, setCommits: false },
    sourcemaps: { filesToDeleteAfterUpload: './out/**/*.map' },
    telemetry: false,
  })]
}

export default defineConfig({
  main: {
    build: {
      sourcemap: sourceMap,
      rollupOptions: {
        external: ['ws'],
      },
    },
    resolve: {
      alias: {
        '@nxcore/desktop-connector-host': resolve(__dirname, '../../submodules/everroom-connectors/desktop-host/open-connector'),
      },
    },
    plugins: sentryPlugins(),
  },
  preload: {
    build: {
      sourcemap: sourceMap,
      rollupOptions: {
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs',
        },
      },
    },
    plugins: sentryPlugins(),
  },
  renderer: {
    // 独立依赖缓存：避免与 vite.browser.config.mts 起的浏览器复现服务共用缓存互相改写，
    // 否则运行中的应用依赖引用会过期，进 room 时触发重新打包+整页刷新（闪烁）。
    cacheDir: 'node_modules/.vite-electron-renderer',
    build: {
      sourcemap: sourceMap,
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          // Agent 调试面板的独立窗口入口（主进程 openAgentDebugWindow 装载）
          'agent-debug': resolve('src/renderer/debug.html'),
        },
      },
    },
    server: {
      headers: crossOriginIsolationHeaders,
      port: 5180,
      strictPort: false,
    },
    preview: {
      headers: crossOriginIsolationHeaders,
    },
    resolve: {
      dedupe: ['react', 'react-dom'],
      alias: {
        // everoffice UI 迁移：复制来的组件用 '@/shared/*' 引用主进程/渲染层共享类型，
        // 解析到真实 shared 目录（与 tsconfig paths 对齐）。
        '@/shared': resolve('src/shared'),
        '@': resolve('src/renderer/src'),
      },
    },
    plugins: [react(), ...sentryPlugins()],
  },
})
