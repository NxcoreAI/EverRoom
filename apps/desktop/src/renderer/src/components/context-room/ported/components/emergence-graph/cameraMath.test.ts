import { describe, expect, it } from 'vitest';

import { bezierMid, clampScale, cubicHorizontalPath, fitTransform, pinTransform, screenOf } from './cameraMath';

describe('pinTransform / screenOf', () => {
  it('round-trips between content and screen coordinates', () => {
    const cam = pinTransform(120, 40, 300, 200, 1.5);
    const back = screenOf(120, 40, cam);
    expect(back.x).toBeCloseTo(300);
    expect(back.y).toBeCloseTo(200);
    expect(cam.scale).toBe(1.5);
  });

  it('keeps the pinned point fixed regardless of scale', () => {
    const p = pinTransform(50, 50, 100, 100, 2);
    expect(p.x).toBeCloseTo(0);
    expect(p.y).toBeCloseTo(0);
  });

  it('sanitizes NaN inputs instead of producing a broken transform', () => {
    const cam = pinTransform(Number.NaN, Number.NaN, Number.NaN, Number.NaN, Number.NaN);
    expect(Number.isFinite(cam.x)).toBe(true);
    expect(Number.isFinite(cam.y)).toBe(true);
    expect(Number.isFinite(cam.scale)).toBe(true);
  });
});

describe('clampScale', () => {
  it('bounds the zoom range', () => {
    expect(clampScale(0.01)).toBe(0.3);
    expect(clampScale(9)).toBe(2.5);
    expect(clampScale(1)).toBe(1);
  });
});

describe('fitTransform', () => {
  it('centers the bbox with padding and never exceeds maxScale', () => {
    const cam = fitTransform(
      { minX: 0, minY: 0, maxX: 540, maxY: 200 },
      { width: 800, height: 600 },
      28,
      1.15,
    );
    const center = screenOf(270, 100, cam);
    expect(center.x).toBeCloseTo(400);
    expect(center.y).toBeCloseTo(300);
    expect(cam.scale).toBeLessThanOrEqual(1.15);
  });

  it('zooms out when content overflows the viewport, floored at SCALE_MIN', () => {
    const cam = fitTransform({ minX: 0, minY: 0, maxX: 2000, maxY: 100 }, { width: 600, height: 400 }, 20, 1.15);
    expect(cam.scale).toBe(0.3);
  });

  it('returns identity for an empty bbox', () => {
    expect(fitTransform({ minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }, { width: 100, height: 100 })).toEqual({ x: 0, y: 0, scale: 1 });
  });
});

describe('geometry helpers', () => {
  it('bezierMid of symmetric controls equals the segment midpoint', () => {
    const mid = bezierMid({ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 60, y: 20 }, { x: 100, y: 20 });
    expect(mid.x).toBeCloseTo(50);
    expect(mid.y).toBeCloseTo(10);
  });

  it('builds a horizontal cubic path anchored at both endpoints', () => {
    const d = cubicHorizontalPath({ x: 0, y: 10 }, { x: 100, y: 30 });
    expect(d).toBe('M 0 10 C 40 10, 60 30, 100 30');
  });

  it('flips control points for right-to-left paths so the return edge converges', () => {
    const d = cubicHorizontalPath({ x: 100, y: 10 }, { x: 0, y: 30 });
    expect(d).toBe('M 100 10 C 60 10, 40 30, 0 30');
  });
});
