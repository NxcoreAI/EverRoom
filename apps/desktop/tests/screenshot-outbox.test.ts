import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GatewaySupervisor } from '../src/main/gateway/gateway-supervisor'
import { ScreenshotOutbox } from '../src/main/screenshot/screenshot-outbox'

const directories: string[] = []

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('ScreenshotOutbox', () => {
  it('persists captures while offline and replays upload before observation after restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'nxcore-screenshot-outbox-test-'))
    directories.push(directory)
    const statePath = join(directory, 'perception', 'outbox.json')
    const imagePath = join(directory, 'capture.jpg')
    await writeFile(imagePath, Buffer.from('local screenshot'))

    const offline = new ScreenshotOutbox(statePath, () => null)
    await offline.initialize()
    await offline.enqueue({
      ok: true, filePath: imagePath, fileName: 'capture.jpg', width: 100, height: 80,
      bytes: 16, capturedAt: '2026-08-20T10:00:00.000Z', perceptualHash: '0000000000000000',
    })
    await offline.dispose()
    expect(JSON.parse(await readFile(statePath, 'utf8'))).toHaveLength(1)

    const request = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'file-capture' }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ observationId: 'observation-1' }), { status: 200 }))
    vi.stubGlobal('fetch', request)
    const supervisor = {
      ensureConnection: vi.fn().mockResolvedValue({ baseUrl: 'http://127.0.0.1:8422', token: 'secret' }),
    } as unknown as GatewaySupervisor
    const replay = new ScreenshotOutbox(statePath, () => supervisor)
    await replay.initialize()
    await replay.flush()

    expect(request).toHaveBeenCalledTimes(2)
    expect(String(request.mock.calls[0]?.[0])).toContain('/v1/files')
    expect(String(request.mock.calls[1]?.[0])).toContain('/v1/perception/visual-observations')
    expect(JSON.parse(await readFile(statePath, 'utf8'))).toEqual([])
    await replay.dispose()
  })

  it('does not upload the same screenshot again when observation registration is retried', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'nxcore-screenshot-outbox-test-'))
    directories.push(directory)
    const statePath = join(directory, 'perception', 'outbox.json')
    const imagePath = join(directory, 'capture.jpg')
    await writeFile(imagePath, Buffer.from('local screenshot'))
    const request = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'file-capture' }), { status: 201 }))
      .mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ observationId: 'observation-1' }), { status: 200 }))
    vi.stubGlobal('fetch', request)
    const supervisor = {
      ensureConnection: vi.fn().mockResolvedValue({ baseUrl: 'http://127.0.0.1:8422', token: 'secret' }),
    } as unknown as GatewaySupervisor
    const outbox = new ScreenshotOutbox(statePath, () => supervisor)
    await outbox.initialize()
    await outbox.enqueue({
      ok: true, filePath: imagePath, fileName: 'capture.jpg', width: 100, height: 80,
      bytes: 16, capturedAt: '2026-08-20T10:00:00.000Z', perceptualHash: '0000000000000000',
    })
    await outbox.flush()

    expect(request).toHaveBeenCalledTimes(3)
    expect(String(request.mock.calls[0]?.[0])).toContain('/v1/files')
    expect(String(request.mock.calls[1]?.[0])).toContain('/v1/perception/visual-observations')
    expect(String(request.mock.calls[2]?.[0])).toContain('/v1/perception/visual-observations')
    expect(JSON.parse(await readFile(statePath, 'utf8'))).toEqual([])
    await outbox.dispose()
  })
})
