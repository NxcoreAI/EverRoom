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
        '@': resolve('src/renderer/src'),
      },
    },
    // 进 room 时才加载的图组件依赖，不预打包会触发 vite 运行时重打包并整页刷新
    optimizeDeps: {
      include: ['d3-force'],
    },
    plugins: [react(), ...sentryPlugins()],
  },
})
