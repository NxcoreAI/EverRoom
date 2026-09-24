import { describe, expect, it } from 'vitest';

import { GAPS, NODE_SIZES, layoutWalkJourney } from './treeLayout';
import type { WalkHop, WalkStation } from './walkModel';

describe('layoutWalkJourney', () => {
  const station = (nodeRef: string): WalkStation => ({ nodeRef, viaRelation: '', viaLevel: null, bridgeRoom: null });
  const hop = (nodeRef: string): WalkHop => ({ nodeRef, edgeId: nodeRef, viaRelation: '', viaLevel: 'original', bridgeRoom: null, nodeType: 'fact', deadEnd: false });

  it('walks previous stations leftward one column each and hops right', () => {
    const log = [station('a'), station('b'), station('c')];
    const hops = [hop('h1'), hop('h2')];
    const { positions, bbox } = layoutWalkJourney(log, hops);
    expect(positions.get('c')).toEqual({ x: 0, y: 0 });
    expect(positions.get('b')!.x).toBe(-(GAPS.walkH + NODE_SIZES.walkPrev.width));
    expect(positions.get('a')!.x).toBe(-(GAPS.walkH + NODE_SIZES.walkPrev.width) * 2);
    const hopX = NODE_SIZES.walkCurrent.width + GAPS.walkH;
    expect(positions.get('h1')!.x).toBe(hopX);
    expect(positions.get('h2')!.x).toBe(hopX);
    expect(positions.get('h2')!.y - positions.get('h1')!.y).toBeCloseTo(NODE_SIZES.walkNext.height + GAPS.walkV);
    expect(bbox.minX).toBe(positions.get('a')!.x);
    expect(bbox.maxX).toBe(hopX + NODE_SIZES.walkNext.width);
  });

  it('centers a single hop on the current card axis', () => {
    const { positions } = layoutWalkJourney([station('a'), station('c')], [hop('h1')]);
    expect(positions.get('h1')!.y).toBeCloseTo((NODE_SIZES.walkCurrent.height - NODE_SIZES.walkNext.height) / 2);
  });
});
