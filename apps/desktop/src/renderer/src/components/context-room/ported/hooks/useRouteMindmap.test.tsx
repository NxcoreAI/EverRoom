// @vitest-environment happy-dom
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RouteMindmapActionInput, RouteMindmapStatusDto } from '../../../../../../shared/knowledge';
import { useRouteMindmap } from './useRouteMindmap';

let latest: ReturnType<typeof useRouteMindmap> | null = null;

function Probe({ roomId, documentId }: { roomId: string; documentId: string | null }) {
  latest = useRouteMindmap({ roomId, documentId });
  return null;
}

type GetMock = ReturnType<typeof vi.fn>;
type ActionMock = ReturnType<typeof vi.fn>;

function stubNxcore(get: GetMock, action: ActionMock) {
  (window as unknown as { nxcore: unknown }).nxcore = {
    knowledge: { getRouteMindmap: get, routeMindmapAction: action },
  };
}

function dto(over: Partial<RouteMindmapStatusDto> & { requestVersion: number }): RouteMindmapStatusDto {
  return {
    roomId: 'room-1',
    documentId: 'doc-1',
    title: '调研',
    description: null,
    status: 'active',
    skipped: false,
    writing: false,
    error: null,
    expandingNodeRef: null,
    graph: null,
    selectionPath: ['route:root'],
    finalizedAt: null,
    generatedAt: null,
    promptVersion: 1,
    ...over,
  };
}

function render(roomId: string, documentId: string | null) {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<Probe roomId={roomId} documentId={documentId} />);
  });
  return renderer;
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('useRouteMindmap', () => {
  it('documentId 就位即 GET；null 时不动取数', async () => {
    const get = vi.fn().mockResolvedValue(dto({ requestVersion: 1 }));
    const action = vi.fn();
    stubNxcore(get, action);
    render('room-1', null);
    expect(get).not.toHaveBeenCalled();

    const renderer = render('room-1', 'doc-1');
    await act(async () => {});
    expect(get).toHaveBeenCalledWith('room-1', { documentId: 'doc-1', requestVersion: 1 });
    expect(latest?.view?.status).toBe('active');
    renderer.unmount();
  });

  it('换文档：视图重置为 null，旧身份的迟到响应被版本守卫丢弃', async () => {
    let releaseFirst: ((value: RouteMindmapStatusDto) => void) | null = null;
    const get = vi.fn().mockImplementation((_roomId: string, q: { documentId: string }) =>
      q.documentId === 'doc-old'
        ? new Promise<RouteMindmapStatusDto>((resolve) => { releaseFirst = resolve; })
        : Promise.resolve(dto({ documentId: 'doc-new', requestVersion: 2 })));
    stubNxcore(get, vi.fn());
    const renderer = render('room-1', 'doc-old');
    await act(async () => {});

    act(() => { renderer.update(<Probe roomId="room-1" documentId="doc-new" />); });
    await act(async () => {});
    expect(latest?.view?.documentId).toBe('doc-new');

    // 旧身份的响应此刻才回来（requestVersion 已过期）：不得覆盖新视图。
    await act(async () => {
      releaseFirst?.(dto({ documentId: 'doc-old', requestVersion: 1 }));
    });
    expect(latest?.view?.documentId).toBe('doc-new');
    renderer.unmount();
  });

  it('expanding 态每 1.5s 轮询，回到 active 即停', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let status: RouteMindmapStatusDto['status'] = 'expanding';
    const get = vi.fn().mockImplementation((_roomId: string, q: { requestVersion: number }) =>
      Promise.resolve(dto({ status, requestVersion: q.requestVersion })));
    stubNxcore(get, vi.fn());
    const renderer = render('room-1', 'doc-1');
    await act(async () => {});
    expect(get).toHaveBeenCalledTimes(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(get).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(get).toHaveBeenCalledTimes(3);

    status = 'active';
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    const settled = get.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(8000); });
    expect(get.mock.calls.length).toBe(settled);
    renderer.unmount();
  });

  it('五动作走单通道并携带身份与 requestVersion；响应即新状态', async () => {
    const action = vi.fn().mockImplementation((_roomId: string, q: RouteMindmapActionInput) =>
      Promise.resolve(dto({ status: 'expanding', expandingNodeRef: q.nodeRef ?? null, requestVersion: q.requestVersion })));
    stubNxcore(vi.fn().mockResolvedValue(dto({ requestVersion: 1 })), action);
    const renderer = render('room-1', 'doc-1');
    await act(async () => {});

    act(() => { latest?.start('新标题'); });
    await act(async () => {});
    expect(action).toHaveBeenCalledWith('room-1', expect.objectContaining({ action: 'start', documentId: 'doc-1', title: '新标题', requestVersion: 2 }));

    act(() => { latest?.expand('route:c0'); });
    await act(async () => {});
    expect(action).toHaveBeenCalledWith('room-1', expect.objectContaining({ action: 'expand', nodeRef: 'route:c0', requestVersion: 3 }));

    act(() => { latest?.back(1); });
    await act(async () => {});
    expect(action).toHaveBeenCalledWith('room-1', expect.objectContaining({ action: 'back', toDepth: 1, requestVersion: 4 }));

    act(() => { latest?.skip(); });
    await act(async () => {});
    expect(action).toHaveBeenCalledWith('room-1', expect.objectContaining({ action: 'skip', requestVersion: 5 }));

    act(() => { latest?.finalize(); });
    await act(async () => {});
    expect(action).toHaveBeenCalledWith('room-1', expect.objectContaining({ action: 'finalize', requestVersion: 6 }));
    expect(latest?.view?.status).toBe('expanding');
    expect(latest?.actionError).toBeNull();
    renderer.unmount();
  });

  it('动作被拒置 actionError，下一次成功动作清除；failed 重试=start', async () => {
    const action = vi.fn()
      .mockRejectedValueOnce(new Error('route_busy'))
      .mockResolvedValueOnce(dto({ status: 'active', requestVersion: 3 }));
    stubNxcore(vi.fn().mockResolvedValue(dto({ requestVersion: 1 })), action);
    const renderer = render('room-1', 'doc-1');
    await act(async () => {});

    act(() => { latest?.expand('route:c0'); });
    await act(async () => {});
    expect(latest?.actionError).toBe('route_busy');

    act(() => { latest?.retry(); });
    await act(async () => {});
    expect(action).toHaveBeenLastCalledWith('room-1', expect.objectContaining({ action: 'start', requestVersion: 3 }));
    expect(latest?.actionError).toBeNull();
    expect(latest?.view?.status).toBe('active');
    renderer.unmount();
  });
});
