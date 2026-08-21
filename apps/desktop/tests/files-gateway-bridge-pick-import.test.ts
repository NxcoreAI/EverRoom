import { afterEach, describe, expect, it, vi } from 'vitest'

const { showOpenDialog } = vi.hoisted(() => ({
  showOpenDialog: vi.fn(),
}))

vi.mock('electron', () => ({
  dialog: { showOpenDialog },
  shell: { openPath: vi.fn(), showItemInFolder: vi.fn() },
}))

import { FilesGatewayBridge } from '../src/main/gateway/files-gateway-bridge'
import type { GatewaySupervisor } from '../src/main/gateway/gateway-supervisor'

describe('FilesGatewayBridge.pickAndImport', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    showOpenDialog.mockReset()
  })

  it('allows selecting directories from the import dialog', async () => {
    showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ['/Users/test/Documents'] })
    const supervisor = {
      getConnection: () => ({ baseUrl: 'http://gateway.test', token: 'token' }),
    } as unknown as GatewaySupervisor
    const bridge = new FilesGatewayBridge(supervisor)
    const importPathsOnce = vi.spyOn(bridge, 'importPathsOnce').mockResolvedValue([])

    await bridge.pickAndImport()

    expect(showOpenDialog).toHaveBeenCalledWith(expect.objectContaining({
      properties: ['openFile', 'openDirectory', 'multiSelections'],
    }))
    expect(importPathsOnce).toHaveBeenCalledWith(['/Users/test/Documents'], undefined)
  })
})
