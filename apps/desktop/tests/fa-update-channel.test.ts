import { describe, expect, it, vi } from 'vitest'

/**
 * FA 试点渠道的更新隔离语义回归。
 *
 * 背景：FA 构建版本号形如 X.Y.Z-fa.N，semver 上低于 stable 正式版
 * X.Y.Z。若 FA 客户端仍走 stable feed，autoUpdater 会把它判为"可升级"
 * 并自动下载正式版覆盖安装——试点设备直接被毁。因此 fa 渠道必须：
 * 1) currentChannel() 能识别 NXCORE_UPDATE_CHANNEL=fa；
 * 2) 应用内更新整体停用（getStatus().supported=false、checkNow 报错）。
 *
 * 不拉起真实 Electron：mock 最小 electron 表面 + 只测渠道解析与 IPC 表层。
 */

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getVersion: () => '0.1.9-fa.20261119.130',
  },
  ipcMain: { handle: vi.fn() },
  dialog: { showMessageBox: vi.fn() },
  webContents: { getAllWebContents: () => [] },
}))

const { DesktopUpdater } = await import('../src/main/updater')

describe('updater: fa 渠道隔离', () => {
  it('NXCORE_UPDATE_CHANNEL=fa 时渠道为 fa 且应用内更新停用', () => {
    process.env.NXCORE_UPDATE_CHANNEL = 'fa'
    try {
      const status = new DesktopUpdater(null).getStatus()
      expect(status.channel).toBe('fa')
      expect(status.supported).toBe(false)
      expect(status.lastError).toContain('FA')
    } finally {
      delete process.env.NXCORE_UPDATE_CHANNEL
    }
  })

  it('fa 渠道 checkNow 明确报错而非静默"无更新"', async () => {
    process.env.NXCORE_UPDATE_CHANNEL = 'fa'
    try {
      await expect(new DesktopUpdater(null).checkNow()).resolves.toBe('error')
    } finally {
      delete process.env.NXCORE_UPDATE_CHANNEL
    }
  })

  it('未设置渠道变量时回退 stable', () => {
    delete process.env.NXCORE_UPDATE_CHANNEL
    expect(new DesktopUpdater(null).getStatus().channel).toBe('stable')
  })
})
