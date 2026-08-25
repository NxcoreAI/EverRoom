import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const electronMocks = vi.hoisted(() => ({
  openExternal: vi.fn(async () => undefined),
}))

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getAppPath: () => process.cwd(),
  },
  shell: {
    openExternal: electronMocks.openExternal,
    openPath: vi.fn(async () => ''),
  },
}))

import { BrowserExtensionService } from './browser-extension-service'
import { setDesktopLocale } from '../desktop-locale'

const services: BrowserExtensionService[] = []
const temporaryDirectories: string[] = []

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

async function startService(): Promise<{ service: BrowserExtensionService; bridgeUrl: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'everroom-browser-extension-'))
  const port = await freePort()
  temporaryDirectories.push(directory)
  process.env.NXCORE_BROWSER_EXTENSION_PORT = String(port)
  const service = new BrowserExtensionService(directory)
  services.push(service)
  await service.start()
  return { service, bridgeUrl: `http://127.0.0.1:${port}` }
}

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.stop()))
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
  delete process.env.NXCORE_BROWSER_EXTENSION_PORT
  setDesktopLocale('zh-CN')
  electronMocks.openExternal.mockClear()
})

describe('BrowserExtensionService one-click pairing', () => {
  it('pairs and returns a usable bearer token in one claim', async () => {
    const { service, bridgeUrl } = await startService()
    const origin = 'chrome-extension://everroom-test-extension'
    const response = await fetch(`${bridgeUrl}/v1/browser/pair/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify({ extensionId: 'everroom-test-extension', extensionName: 'EverRoom' }),
    })
    const result = await response.json() as { status: string; accessToken: string }

    expect(response.status).toBe(200)
    expect(result.status).toBe('paired')
    expect(result.accessToken).toMatch(/^[A-Za-z0-9_-]{40,}$/)
    expect(service.getStatus()).toMatchObject({ state: 'paired', pairedExtensionId: 'everroom-test-extension' })

    const session = await fetch(`${bridgeUrl}/v1/browser/session`, {
      headers: { Origin: origin, Authorization: `Bearer ${result.accessToken}` },
    })
    await expect(session.json()).resolves.toMatchObject({ ok: true })
  })

  it('opens the local handoff page when pairing starts in the app', async () => {
    const { bridgeUrl, service } = await startService()

    await service.createPairing()

    expect(electronMocks.openExternal).toHaveBeenCalledWith(`${bridgeUrl}/v1/browser/pair/connect`)
    expect(service.getStatus().state).toBe('waiting-for-extension')
  })

  it('exposes the current EverRoom locale to the extension', async () => {
    const { bridgeUrl } = await startService()

    setDesktopLocale('en-US')
    await expect(fetch(`${bridgeUrl}/v1/browser/preferences`).then((response) => response.json()))
      .resolves.toEqual({ locale: 'en-US' })
    setDesktopLocale('zh-CN')
    await expect(fetch(`${bridgeUrl}/v1/browser/preferences`).then((response) => response.json()))
      .resolves.toEqual({ locale: 'zh-CN' })
  })
})
