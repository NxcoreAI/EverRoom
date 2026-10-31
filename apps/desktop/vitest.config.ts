import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    setupFiles: ['./tests/setup.ts'],
    // vendor/genoffice（子模块）与 build 产物不进单测收集（其 e2e 依赖独立运行时）。
    exclude: ['**/node_modules/**', '**/dist/**', 'vendor/**', 'build/**', 'out/**'],
  },
  resolve: {
    alias: {
      '@/shared': resolve(__dirname, 'src/shared'),
      '@': resolve(__dirname, 'src/renderer/src'),
      '@nxcore/desktop-connector-host': resolve(__dirname, '../../submodules/everroom-connectors/desktop-host/open-connector'),
    },
  },
})
