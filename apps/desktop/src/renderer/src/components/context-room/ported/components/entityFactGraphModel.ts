import type {
  RoomAppliedEntitiesResult,
  RoomAppliedEntity,
  RoomAppliedEntitySource,
  RoomAppliedEntityStatus,
  RoomAppliedFact,
} from '@nxcore/agent-contract';
import type { ContextRoomMemoryItem, ContextRoomRecord } from '../types';

/** Room 应用记忆（结构化实体 + 事实表实时数据），useRoomAppliedEntities 的返回形态。 */
export type RoomAppliedMemoryInput = Pick<RoomAppliedEntitiesResult, 'entities' | 'facts'> | null | undefined;

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
  /** 来源提及明细（应用实体才有），详情卡「来源资料」区块展示。 */
  sources?: RoomAppliedEntitySource[];
  /** 已建 Room 的实体可跳转（entities.roomId）；详情区提供「打开关联 Room」。 */
  linkedRoomId?: string | null;
  /** 结构化实体 id（应用实体才有），事实按 entityIds 连边时使用。 */
  entityId?: string;
  /** 引用该实体的应用事实（按 entityId 过滤，详情区「关联事实」区块展示）。 */
  relatedFacts?: RoomAppliedFact[];
}

export interface EntityFactGraphFactNode extends EntityFactGraphNodeBase {
  kind: 'fact';
  /** 静态事实（context_rooms.data.memoryItems 快照）字段。 */
  memory?: ContextRoomMemoryItem;
  /** 应用事实（room_entity_facts 实时投影）字段；与 memory 互斥。 */
  fact?: RoomAppliedFact;
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
const FACT_LIMIT = 24;
/** Room 根节点（Room 本体），导出供详情区区分根节点与普通实体。 */
export const ROOT_ID = 'entity:root';

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
  applied?: RoomAppliedMemoryInput,
): EntityFactGraphData {
  const appliedEntities: RoomAppliedEntity[] = applied?.entities ?? [];
  const appliedFacts: RoomAppliedFact[] = applied?.facts ?? [];
  const entityNodes: EntityFactGraphEntityNode[] = [{
    id: ROOT_ID,
    kind: 'entity',
    label: room.title,
    entityType: room.kind,
    description: room.brief.background,
  }];
  const idByLabel = new Map<string, string>([[room.title, ROOT_ID]]);
  const aliasesByLabel = new Map<string, string[]>();
  const nodeIdByEntityId = new Map<string, string>();

  // 应用实体（结构化实体表实时数据）优先；重名跳过（首个生效）。
  for (const entity of appliedEntities) {
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
      sources: entity.sources,
      linkedRoomId: entity.linkedRoomId,
      entityId: entity.entityId,
      relatedFacts: appliedFacts.filter((fact) => fact.entityIds.includes(entity.entityId)).slice(0, 12),
    });
    idByLabel.set(entity.name, id);
    aliasesByLabel.set(entity.name, entity.aliases);
    nodeIdByEntityId.set(entity.entityId, id);
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

  // 事实节点：应用事实（持续抽取）优先，静态 memoryItems 合入（同内容去重）。
  const factNodes: EntityFactGraphFactNode[] = [];
  const seenFactContents = new Set<string>();
  for (const fact of appliedFacts) {
    if (factNodes.length >= FACT_LIMIT) break;
    const content = fact.content.trim();
    if (!content || seenFactContents.has(content)) continue;
    seenFactContents.add(content);
    factNodes.push({
      id: `applied-fact:${fact.factId}`,
      kind: 'fact',
      label: fact.type,
      description: content,
      fact,
    });
  }
  for (const memory of room.memoryItems) {
    if (factNodes.length >= FACT_LIMIT) break;
    const content = memory.content.trim();
    if (!content || seenFactContents.has(content)) continue;
    seenFactContents.add(content);
    factNodes.push({
      id: `fact:${memory.id}`,
      kind: 'fact',
      label: memory.type,
      description: content,
      memory,
    });
  }

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
    let targets: string[];
    let relation: string;
    if (fact.fact) {
      // 应用事实：按已解析实体 id 连边（每事实 ≤3 条），解析不到实体连根。
      targets = fact.fact.entityIds
        .flatMap((entityId) => {
          const nodeId = nodeIdByEntityId.get(entityId);
          return nodeId && nodeId !== ROOT_ID ? [nodeId] : [];
        })
        .slice(0, 3);
      relation = '关联事实';
    } else {
      const memory = fact.memory!;
      const matchingEntities = entityNodes.filter(
        (entity) => entity.id !== ROOT_ID
          && memoryEntityMatches(memory, [entity.label, ...(aliasesByLabel.get(entity.label) ?? [])]),
      );
      targets = (matchingEntities.length
        ? matchingEntities.slice(0, 2)
        : [{ id: ROOT_ID }]).map((entity) => entity.id);
      relation = matchingEntities.length ? '内容命中' : 'Room 记忆';
    }
    for (const target of targets.length ? targets : [ROOT_ID]) {
      edges.push({
        id: `fact-edge:${String(factIndex)}:${target}`,
        relation,
        source: target,
        target: fact.id,
      });
    }
  });

  // 应用实体来自本 Room 资料的提及，统一连到 Room 根节点（星型主结构）；
  // 静态实体若没有任何边（如只列了 people 没给 graphEdges），也回落连根，
  // 否则画布上会出现无连线节点——自动创建的 Room 静态快照全空时尤其明显。
  const connected = new Set(edges.flatMap((edge) => [edge.source, edge.target]));
  entityNodes.forEach((node) => {
    if (node.id === ROOT_ID) return;
    const applied = node.id.startsWith('applied:');
    if (applied || !connected.has(node.id)) {
      edges.push({
        id: `root-edge:${node.id}`,
        relation: applied ? '资料提及' : 'Room 关联',
        source: ROOT_ID,
        target: node.id,
      });
    }
  });

  return { edges, nodes: [...entityNodes, ...factNodes], rootId: ROOT_ID };
}
