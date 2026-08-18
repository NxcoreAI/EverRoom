import { resolve } from 'node:path'

import { sentryVitePlugin } from '@sentry/vite-plugin'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'

import packageJson from './package.json'

const uploadSourceMaps = Boolean(process.env.SENTRY_AUTH_TOKEN)
const sourceMap = uploadSourceMaps ? 'hidden' as const : false

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
    build: {
      sourcemap: sourceMap,
    },
    server: {
      port: 5180,
      strictPort: false,
    },
    resolve: {
      dedupe: ['react', 'react-dom'],
      alias: {
        '@': resolve('src/renderer/src'),
      },
    },
    plugins: [react(), ...sentryPlugins()],
  },
})
