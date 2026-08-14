import type { ContextRoomMemoryItem, ContextRoomRecord } from '../types';

interface EntityFactGraphNodeBase {
  description: string;
  id: string;
  label: string;
}

export interface EntityFactGraphEntityNode extends EntityFactGraphNodeBase {
  entityType: string;
  kind: 'entity';
}

export interface EntityFactGraphFactNode extends EntityFactGraphNodeBase {
  kind: 'fact';
  memory: ContextRoomMemoryItem;
}

export type EntityFactGraphNode = EntityFactGraphEntityNode | EntityFactGraphFactNode;

export interface EntityFactGraphEdge {
  id: string;
  relation: string;
  source: string;
  target: string;
}

export interface EntityFactGraphData {
  edges: EntityFactGraphEdge[];
  nodes: EntityFactGraphNode[];
  rootId: string;
}

const ENTITY_LIMIT = 6;
const FACT_LIMIT = 4;

function entityId(index: number) {
  return `entity:${String(index)}`;
}

function relatedEntityDescription(room: ContextRoomRecord, label: string) {
  const person = room.people.find((candidate) => candidate.name === label);
  if (person) return person.role;
  const relations = room.graphEdges
    .filter((edge) => edge.from === label || edge.to === label)
    .map((edge) => edge.relation);
  return relations.join('；') || '当前 Room 关联实体';
}

function memoryEntityMatches(memory: ContextRoomMemoryItem, label: string) {
  if (memory.content.includes(label)) return true;
  return memory.sources?.some((source) => source.name.includes(label)) ?? false;
}

export function createEntityFactGraphData(room: ContextRoomRecord): EntityFactGraphData {
  const labels = new Set<string>([room.title]);
  room.people.forEach((person) => labels.add(person.name));
  room.graphEdges.forEach((edge) => {
    labels.add(edge.from);
    labels.add(edge.to);
  });

  const entityLabels = [...labels].slice(0, ENTITY_LIMIT);
  const entityIdByLabel = new Map(entityLabels.map((label, index) => [label, entityId(index)]));
  const rootId = entityId(0);
  const entityNodes: EntityFactGraphEntityNode[] = entityLabels.map((label, index) => {
    const person = room.people.find((candidate) => candidate.name === label);
    return {
      id: entityId(index),
      kind: 'entity',
      label,
      entityType: label === room.title ? room.kind : person ? '人物' : '关联对象',
      description:
        label === room.title ? room.brief.background : relatedEntityDescription(room, label),
    };
  });
  const factNodes: EntityFactGraphFactNode[] = room.memoryItems
    .slice(0, FACT_LIMIT)
    .map((memory) => ({
      id: `fact:${memory.id}`,
      kind: 'fact',
      label: memory.type,
      description: memory.content,
      memory,
    }));

  const edges: EntityFactGraphEdge[] = [];
  room.graphEdges.forEach((edge, index) => {
    const source = entityIdByLabel.get(edge.from);
    const target = entityIdByLabel.get(edge.to);
    if (!source || !target) return;
    edges.push({
      id: `entity-edge:${String(index)}`,
      relation: edge.relation,
      source,
      target,
    });
  });
  factNodes.forEach((fact, factIndex) => {
    const matchingEntities = entityNodes.filter(
      (entity) => entity.label !== room.title && memoryEntityMatches(fact.memory, entity.label)
    );
    const targets: Array<Pick<EntityFactGraphEntityNode, 'id'>> = matchingEntities.length
      ? matchingEntities.slice(0, 2)
      : [{ id: rootId }];
    targets.forEach((entity, targetIndex) => {
      edges.push({
        id: `fact-edge:${String(factIndex)}:${String(targetIndex)}`,
        relation: matchingEntities.length ? '内容命中' : 'Room 记忆',
        source: entity.id,
        target: fact.id,
      });
    });
  });

  return { edges, nodes: [...entityNodes, ...factNodes], rootId };
}
