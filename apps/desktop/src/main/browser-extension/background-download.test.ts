import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

type BackgroundModule = typeof import('../../../../browser-extension/background.js')

const chromeMock = {
  action: { setBadgeBackgroundColor: vi.fn(), setBadgeText: vi.fn(), setTitle: vi.fn() },
  contextMenus: {
    create: vi.fn(),
    removeAll: vi.fn(),
    update: vi.fn(),
    refresh: vi.fn(),
    onClicked: { addListener: vi.fn() },
    onShown: { addListener: vi.fn() },
  },
  i18n: { getUILanguage: vi.fn(() => 'en-US') },
  permissions: { contains: vi.fn(), request: vi.fn() },
  runtime: {
    id: 'everroom-test',
    getManifest: vi.fn(() => ({ name: 'EverRoom' })),
    onInstalled: { addListener: vi.fn() },
    onMessage: { addListener: vi.fn() },
    onStartup: { addListener: vi.fn() },
  },
  scripting: { executeScript: vi.fn() },
  storage: { local: { get: vi.fn(), set: vi.fn(), remove: vi.fn() } },
  tabs: { sendMessage: vi.fn() },
}

let background: BackgroundModule

beforeAll(async () => {
  vi.stubGlobal('chrome', chromeMock)
  background = await import('../../../../browser-extension/background.js')
})

beforeEach(() => {
  vi.clearAllMocks()
})

describe('browser extension background image downloads', () => {
  it('requests only missing image origins', async () => {
    chromeMock.permissions.contains.mockImplementation(async ({ origins }: { origins: string[] }) =>
      origins[0] === 'https://already.example/*')
    chromeMock.permissions.request.mockResolvedValue(true)

    const granted = await background.requestImageHostPermissions([
      { originalUrl: 'https://already.example/a.png' },
      { originalUrl: 'https://cdn.example/b.png' },
      { originalUrl: 'https://cdn.example/c.png' },
    ])

    expect(chromeMock.permissions.request).toHaveBeenCalledWith({ origins: ['https://cdn.example/*'] })
    expect([...granted]).toEqual(['https://already.example/*', 'https://cdn.example/*'])
  })

  it('retries a transient CDN failure', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('temporary network failure'))
      .mockResolvedValueOnce(new Response(png, { status: 200, headers: { 'content-length': String(png.byteLength) } }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await background.readAssetInBackground(
      { originalUrl: 'https://cdn.example/image.png' },
      new Set(['https://cdn.example/*']),
      'https://example.com/article',
    )

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(result).toMatchObject({ ok: true, byteSize: png.byteLength })
  })

  it('isolates an upload exception and still finalizes the remaining assets', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith('https://cdn.example/')) {
        return new Response(png, { status: 200, headers: { 'content-length': String(png.byteLength) } })
      }
      if (url.endsWith('/assets/asset-one') && init?.method === 'PUT') throw new TypeError('bridge interrupted')
      if (url.endsWith('/assets/asset-two') && init?.method === 'PUT') return new Response('{}', { status: 200 })
      if (url.endsWith('/finalize')) {
        return new Response(JSON.stringify({ failedAssetCount: 1, storedAssetCount: 1 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      throw new Error(`unexpected fetch: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    chromeMock.storage.local.set.mockResolvedValue(undefined)

    const capture = {
      captureId: 'capture-one',
      url: 'https://example.com/article',
      assets: [
        { id: 'asset-one', originalUrl: 'https://cdn.example/one.png' },
        { id: 'asset-two', originalUrl: 'https://cdn.example/two.png' },
      ],
    }
    const result = await background.uploadPendingAssets(
      42,
      capture,
      'access-token',
      { pendingAssetIds: ['asset-one', 'asset-two'], capture: {} },
      new Set(['https://cdn.example/*']),
    )

    expect(result).toMatchObject({ ok: true, capture: { failedAssetCount: 1, storedAssetCount: 1 } })
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/assets/asset-two'))).toBe(true)
    const finalizeCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/finalize'))
    expect(JSON.parse(String(finalizeCall?.[1]?.body))).toEqual({
      failures: [{ assetId: 'asset-one', code: 'asset_upload_failed' }],
    })
    expect(chromeMock.storage.local.set).toHaveBeenCalledWith({
      retryCapture: { tabId: 42, capture: { captureId: 'capture-one', assets: capture.assets } },
    })
  })
})
