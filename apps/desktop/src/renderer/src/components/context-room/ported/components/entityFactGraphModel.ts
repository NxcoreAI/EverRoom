import type { RoomAppliedEntity, RoomAppliedEntityStatus } from '@nxcore/agent-contract';
import type { ContextRoomMemoryItem, ContextRoomRecord } from '../types';

interface EntityFactGraphNodeBase {
  description: string;
  id: string;
  label: string;
}

export interface EntityFactGraphEntityNode extends EntityFactGraphNodeBase {
  entityType: string;
  kind: 'entity';
  /** 应用实体（结构化实体表）字段；静态派生实体为 undefined。 */
  status?: RoomAppliedEntityStatus;
  mentionCount?: number;
  lastMentionAt?: string | null;
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

const ENTITY_LIMIT = 24;
const FACT_LIMIT = 12;
const ROOT_ID = 'entity:root';

function relatedEntityDescription(room: ContextRoomRecord, label: string) {
  const person = room.people.find((candidate) => candidate.name === label);
  if (person) return person.role;
  const relations = room.graphEdges
    .filter((edge) => edge.from === label || edge.to === label)
    .map((edge) => edge.relation);
  return relations.join('；') || '当前 Room 关联实体';
}

function memoryEntityMatches(memory: ContextRoomMemoryItem, labels: string[]) {
  const names = labels.filter((label) => label.length > 0);
  if (names.some((name) => memory.content.includes(name))) return true;
  return memory.sources?.some((source) => names.some((name) => source.name.includes(name))) ?? false;
}

export function createEntityFactGraphData(
  room: ContextRoomRecord,
  applied?: RoomAppliedEntity[] | null,
): EntityFactGraphData {
  const entityNodes: EntityFactGraphEntityNode[] = [{
    id: ROOT_ID,
    kind: 'entity',
    label: room.title,
    entityType: room.kind,
    description: room.brief.background,
  }];
  const idByLabel = new Map<string, string>([[room.title, ROOT_ID]]);
  const aliasesByLabel = new Map<string, string[]>();

  // 应用实体（结构化实体表实时数据）优先；重名跳过（首个生效）。
  for (const entity of applied ?? []) {
    if (entityNodes.length >= ENTITY_LIMIT) break;
    if (idByLabel.has(entity.name)) continue;
    const id = `applied:${entity.entityId}`;
    entityNodes.push({
      id,
      kind: 'entity',
      label: entity.name,
      entityType: entity.kind,
      description: entity.summary || entity.evidence || '当前 Room 关联实体',
      status: entity.status,
      mentionCount: entity.mentionCount,
      lastMentionAt: entity.lastMentionAt,
    });
    idByLabel.set(entity.name, id);
    aliasesByLabel.set(entity.name, entity.aliases);
  }

  // people / graphEdges 中应用实体未覆盖的静态实体合入（用户手建数据不丢）。
  const staticLabels: string[] = [
    ...room.people.map((person) => person.name),
    ...room.graphEdges.flatMap((edge) => [edge.from, edge.to]),
  ];
  for (const label of staticLabels) {
    if (entityNodes.length >= ENTITY_LIMIT) break;
    if (!label || idByLabel.has(label)) continue;
    const person = room.people.find((candidate) => candidate.name === label);
    const id = `entity:${String(entityNodes.length)}`;
    entityNodes.push({
      id,
      kind: 'entity',
      label,
      entityType: person ? '人物' : '关联对象',
      description: relatedEntityDescription(room, label),
    });
    idByLabel.set(label, id);
  }

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
    const source = idByLabel.get(edge.from);
    const target = idByLabel.get(edge.to);
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
      (entity) => entity.id !== ROOT_ID
        && memoryEntityMatches(fact.memory, [entity.label, ...(aliasesByLabel.get(entity.label) ?? [])]),
    );
    const targets: Array<Pick<EntityFactGraphEntityNode, 'id'>> = matchingEntities.length
      ? matchingEntities.slice(0, 2)
      : [{ id: ROOT_ID }];
    targets.forEach((entity, targetIndex) => {
      edges.push({
        id: `fact-edge:${String(factIndex)}:${String(targetIndex)}`,
        relation: matchingEntities.length ? '内容命中' : 'Room 记忆',
        source: entity.id,
        target: fact.id,
      });
    });
  });

  return { edges, nodes: [...entityNodes, ...factNodes], rootId: ROOT_ID };
}
