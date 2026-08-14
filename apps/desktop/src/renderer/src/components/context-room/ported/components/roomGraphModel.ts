import type { ContextRoomRecord } from '../types';

export interface RoomGraphEdge {
  id: string;
  relation: string;
  source: string;
  target: string;
}

export interface RoomGraphData {
  edges: RoomGraphEdge[];
  nodes: ContextRoomRecord[];
}

const ROOM_GRAPH_LIMIT = 8;

function sharedPeople(left: ContextRoomRecord, right: ContextRoomRecord) {
  const leftPeople = new Set(left.people.map((person) => person.name));
  return right.people.filter((person) => leftPeople.has(person.name));
}

export function createRoomGraphData(rooms: ContextRoomRecord[]): RoomGraphData {
  const nodes = rooms.slice(0, ROOM_GRAPH_LIMIT);
  if (nodes.length === 0) return { edges: [], nodes };
  const root = nodes[0];

  const edges: RoomGraphEdge[] = [];
  nodes.forEach((room, index) => {
    nodes.slice(index + 1).forEach((candidate) => {
      const people = sharedPeople(room, candidate);
      if (!people.length && room.kind !== candidate.kind) return;
      edges.push({
        id: `${room.id}:${candidate.id}`,
        source: room.id,
        target: candidate.id,
        relation: people.length ? `共同人物 ${String(people.length)}` : `同为${room.kind}`,
      });
    });
  });

  const connected = new Set(edges.flatMap((edge) => [edge.source, edge.target]));
  nodes.slice(1).forEach((room) => {
    if (connected.has(room.id)) return;
    edges.push({
      id: `${root.id}:${room.id}:related`,
      source: root.id,
      target: room.id,
      relation: '关联',
    });
  });

  return { edges, nodes };
}
