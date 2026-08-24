import { describe, expect, it, vi } from 'vitest'

const { openPath, showItemInFolder } = vi.hoisted(() => ({
  openPath: vi.fn(),
  showItemInFolder: vi.fn(),
}))

vi.mock('electron', () => ({
  dialog: { showOpenDialog: vi.fn() },
  shell: { openPath, showItemInFolder },
}))

import { FilesGatewayBridge } from '../src/main/gateway/files-gateway-bridge'
import type { GatewaySupervisor } from '../src/main/gateway/gateway-supervisor'

describe('FilesGatewayBridge.openOriginal', () => {
  it('opens the stored original with the system default viewer', async () => {
    openPath.mockResolvedValueOnce('')
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(
      JSON.stringify({ storagePath: '/tmp/everroom/original.pdf' }),
      { headers: { 'Content-Type': 'application/json' } },
    ))
    const supervisor = {
      getConnection: () => ({ baseUrl: 'http://gateway.test', token: 'token' }),
    } as unknown as GatewaySupervisor

    await new FilesGatewayBridge(supervisor).openOriginal('file-1')

    expect(fetchMock).toHaveBeenCalledWith(
      'http://gateway.test/v1/files/file-1/storage',
      expect.objectContaining({ headers: { Authorization: 'Bearer token' } }),
    )
    expect(openPath).toHaveBeenCalledWith('/tmp/everroom/original.pdf')
    expect(showItemInFolder).not.toHaveBeenCalled()
  })

  it('surfaces the system viewer error', async () => {
    openPath.mockResolvedValueOnce('No application can open the file')
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(
      JSON.stringify({ storagePath: '/tmp/everroom/original.bin' }),
      { headers: { 'Content-Type': 'application/json' } },
    ))
    const supervisor = {
      getConnection: () => ({ baseUrl: 'http://gateway.test', token: 'token' }),
    } as unknown as GatewaySupervisor

    await expect(new FilesGatewayBridge(supervisor).openOriginal('file-2'))
      .rejects.toThrow('No application can open the file')
  })
})
