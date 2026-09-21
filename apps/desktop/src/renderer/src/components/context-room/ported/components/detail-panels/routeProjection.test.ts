import { describe, expect, it } from 'vitest';

import type { RouteGraphDto, RouteNodeDto } from '../../../../../../../shared/knowledge';
import { routePathProjection, routePathTo, routeProjectionCards, routeProjectionToGraph, routeTailNode } from './routeProjection';

function leaf(ref: string, label: string, note: string | null = null): RouteNodeDto {
  return { ref, label, note };
}

const graph: RouteGraphDto = {
  root: {
    ref: 'route:root',
    label: '连接器统一调研',
    note: null,
    children: [
      {
        ref: 'route:c0',
        label: '从现状痛点切入',
        note: '先摆双链路排障成本',
        children: [
          leaf('route:c0-0', 'Gmail 链路深挖', '分表结构先说清'),
          leaf('route:c0-1', '云文档链路', null),
        ],
      },
      leaf('route:c1', '按目标架构分层', '两阶段叙事'),
      leaf('route:c2', '风险清单', null),
    ],
  },
};

describe('routePathProjection', () => {
  it('无图返回 null', () => {
    expect(routePathProjection(null, ['route:root'])).toBeNull();
  });

  it('压成线性链：每层 children=该层全部选项，尾节点带当前分岔', () => {
    const projection = routePathProjection(graph, ['route:root', 'route:c0']);
    expect(projection?.path.map((node) => node.ref)).toEqual(['route:root', 'route:c0']);
    expect(projection?.path[0]?.depth).toBe(0);
    expect(projection?.path[0]?.children.map((child) => child.ref)).toEqual(['route:c0', 'route:c1', 'route:c2']);
    expect(projection?.path[1]?.children.map((child) => child.ref)).toEqual(['route:c0-0', 'route:c0-1']);
    expect(routeTailNode(projection)?.ref).toBe('route:c0');
  });

  it('selectionPath 缺失或首项不在图中：回退根+第一层', () => {
    expect(routePathProjection(graph, null)?.path.map((node) => node.ref)).toEqual(['route:root']);
    expect(routePathProjection(graph, ['ghost'])?.path.map((node) => node.ref)).toEqual(['route:root']);
  });

  it('中途断链（下一项不是子级）：截到最后一层有效节点', () => {
    const projection = routePathProjection(graph, ['route:root', 'route:c1', 'route:c0-0']);
    expect(projection?.path.map((node) => node.ref)).toEqual(['route:root', 'route:c1']);
  });

  it('只到根=第一层全选项露出（回退后的形态）', () => {
    const projection = routePathProjection(graph, ['route:root']);
    expect(routeTailNode(projection)?.children).toHaveLength(3);
  });
});

const deepGraph: RouteGraphDto = {
  root: {
    ref: 'route:root',
    label: '连接器统一调研',
    note: null,
    children: [
      {
        ref: 'route:c0',
        label: '从现状痛点切入',
        note: null,
        children: [
          {
            ref: 'route:c0-0',
            label: 'Gmail 链路深挖',
            note: '分表结构先说清',
            children: [leaf('route:c0-0-0', '双表游标对账'), leaf('route:c0-0-1', '静默失效排查')],
          },
        ],
      },
      leaf('route:c1', '按目标架构分层'),
    ],
  },
};

describe('routeProjectionToGraph 已展开子树全下发', () => {
  it('回退到根：已生成子级连同其已生成子级（孙子层）全部露出', () => {
    const result = routeProjectionToGraph(routePathProjection(deepGraph, ['route:root']));
    expect(result?.nodes.map((node) => node.id)).toEqual([
      'route:root', 'route:c0', 'route:c0-0', 'route:c0-0-0', 'route:c0-0-1', 'route:c1',
    ]);
    expect(result?.edges.map((edge) => `${edge.from}->${edge.to}`)).toEqual([
      'route:root->route:c0',
      'route:c0->route:c0-0',
      'route:c0-0->route:c0-0-0',
      'route:c0-0->route:c0-0-1',
      'route:root->route:c1',
    ]);
  });

  it('回退到中间层：该层以下的已生成子树全露出；未选分支（c1）不下发', () => {
    const result = routeProjectionToGraph(routePathProjection(deepGraph, ['route:root', 'route:c0']));
    expect(result?.nodes.map((node) => node.id)).toEqual([
      'route:root', 'route:c0', 'route:c0-0', 'route:c0-0-0', 'route:c0-0-1',
    ]);
  });

  it('深层 note 也生成卡片（断点续选后底部详情条有内容）', () => {
    const cards = routeProjectionCards(routePathProjection(deepGraph, ['route:root']));
    expect(cards.map((card) => card.nodeRef)).toEqual(['route:c0-0']);
  });
});

describe('routeProjectionToGraph', () => {
  it('路径链逐级相连 + 尾节点挂全部子级；未选分支不下发', () => {
    const result = routeProjectionToGraph(routePathProjection(graph, ['route:root', 'route:c0']));
    expect(result?.nodes.map((node) => node.id)).toEqual(['route:root', 'route:c0', 'route:c0-0', 'route:c0-1']);
    expect(result?.edges.map((edge) => `${edge.from}->${edge.to}`)).toEqual([
      'route:root->route:c0',
      'route:c0->route:c0-0',
      'route:c0->route:c0-1',
    ]);
    expect(result?.nodes.every((node) => node.nodeType === 'document')).toBe(true);
  });

  it('尾节点无子级=只有路径链本身', () => {
    const result = routeProjectionToGraph(routePathProjection(graph, ['route:root', 'route:c0', 'route:c0-0']));
    expect(result?.nodes.map((node) => node.id)).toEqual(['route:root', 'route:c0', 'route:c0-0']);
    expect(result?.edges.map((edge) => `${edge.from}->${edge.to}`)).toEqual([
      'route:root->route:c0',
      'route:c0->route:c0-0',
    ]);
  });

  it('空投影返回 null', () => {
    expect(routeProjectionToGraph(null)).toBeNull();
  });
});

describe('routePathTo（已拍板后的只读浏览换层）', () => {
  it('根→目标节点的完整链（含目标自身）', () => {
    const chain = routePathTo(deepGraph.root, 'route:c0-0-0');
    expect(chain?.map((node) => node.ref)).toEqual(['route:root', 'route:c0', 'route:c0-0', 'route:c0-0-0']);
  });

  it('目标=根：只返回根自身', () => {
    expect(routePathTo(deepGraph.root, 'route:root')?.map((node) => node.ref)).toEqual(['route:root']);
  });

  it('不在图中返回 null', () => {
    expect(routePathTo(deepGraph.root, 'ghost')).toBeNull();
  });
});

describe('routeProjectionCards', () => {
  it('只有带 note 的节点生成卡片（路径节点+当前分岔子级）', () => {
    const cards = routeProjectionCards(routePathProjection(graph, ['route:root', 'route:c0']));
    expect(cards.map((card) => card.nodeRef)).toEqual(['route:c0', 'route:c0-0']);
    expect(cards[0]).toMatchObject({ title: '从现状痛点切入', summary: '先摆双链路排障成本', nodeRef: 'route:c0' });
  });

  it('无图返回空数组', () => {
    expect(routeProjectionCards(null)).toEqual([]);
  });
});
