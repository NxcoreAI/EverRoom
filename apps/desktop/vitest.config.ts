import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    setupFiles: ['./tests/setup.ts'],
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src/renderer/src'),
      '@nxcore/desktop-connector-host': resolve(__dirname, '../../submodules/everroom-connectors/desktop-host/open-connector'),
    },
  },
})
