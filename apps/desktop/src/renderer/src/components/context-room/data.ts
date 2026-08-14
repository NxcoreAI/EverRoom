import type {
  ContextGraphData,
  ContextRoomRecord,
  RoomRecommendation,
} from './types'

export const INITIAL_ROOMS: ContextRoomRecord[] = [
  {
    id: 'room-nxcore-ce',
    title: '极核开源 PC 版',
    kind: '项目',
    description: '围绕开源版桌面工作台，沉淀产品边界、工程决策和交付进展。',
    updated: '12 分钟前',
    people: ['陆远', '林薇', '周明'],
    tags: ['macOS', 'Electron', '开源'],
    materials: [
      { id: 'mat-product', title: '开源版产品基线', type: '文档', updated: '刚刚' },
      { id: 'mat-review', title: '首批内测范围确认', type: '会议', updated: '今天 14:30' },
      { id: 'mat-arch', title: 'Electron 工程架构图', type: '文件', updated: '昨天' },
      { id: 'mat-mail', title: '连接器优先级讨论', type: '邮件', updated: '8 月 12 日' },
    ],
    memories: [
      { id: 'mem-platform', title: '首发平台', detail: '开源版首发只支持 macOS。', status: '已确认' },
      { id: 'mem-boundary', title: '数据边界', detail: '默认本地存储，外发前需用户确认。', status: '已确认' },
      { id: 'mem-style', title: '界面偏好', detail: '工作台保持中性、安静、适合长时间使用。', status: '待确认' },
    ],
    tasks: [
      { id: 'task-ui', title: '迁移 Context Room 工作台', owner: '陆远', done: false },
      { id: 'task-connector', title: '验证 GitHub 连接器', owner: '周明', done: false },
      { id: 'task-scope', title: '确定首发功能边界', owner: '林薇', done: true },
    ],
  },
  {
    id: 'room-connectors',
    title: '连接器架构研究',
    kind: '议题',
    description: '统一本地文件、GitHub 与未来 SaaS 数据源的发现和同步边界。',
    updated: '昨天',
    people: ['周明', '陆远'],
    tags: ['Connector', 'GitHub', '数据源'],
    materials: [
      { id: 'mat-contract', title: 'Connector 合同设计', type: '文档', updated: '昨天' },
      { id: 'mat-sync', title: '增量同步策略', type: '文件', updated: '8 月 11 日' },
    ],
    memories: [
      { id: 'mem-owner', title: '服务责任', detail: 'Core Service 拥有哈希、版本和生命周期状态。', status: '已确认' },
    ],
    tasks: [{ id: 'task-feishu', title: '定义飞书连接器能力', owner: '周明', done: false }],
  },
  {
    id: 'room-product',
    title: '个人上下文产品设计',
    kind: '长期目标',
    description: '把分散的资料、决策、记忆和执行聚合成可信的个人工作上下文。',
    updated: '3 天前',
    people: ['林薇', '陆远'],
    tags: ['Context Room', 'Agent', '记忆'],
    materials: [
      { id: 'mat-prd', title: 'Context Room 产品说明', type: '文档', updated: '8 月 10 日' },
      { id: 'mat-interview', title: '知识工作者访谈', type: '会议', updated: '8 月 9 日' },
      { id: 'mat-flow', title: '上下文生产流程', type: '文件', updated: '8 月 8 日' },
    ],
    memories: [
      { id: 'mem-room', title: 'Room 边界', detail: '用户以 Room 为稳定边界授权 Agent 读取上下文。', status: '已确认' },
      { id: 'mem-source', title: '来源追溯', detail: '生成内容需要保留到原始证据的引用。', status: '已确认' },
    ],
    tasks: [{ id: 'task-memory', title: '完成记忆治理原型', owner: '林薇', done: false }],
  },
  {
    id: 'room-linwei',
    title: '林薇',
    kind: '人物',
    description: '记录产品评审、设计决策和后续跟进事项。',
    updated: '8 月 10 日',
    people: ['林薇', '周明'],
    tags: ['产品', '评审'],
    materials: [{ id: 'mat-notes', title: '产品评审纪要', type: '会议', updated: '8 月 10 日' }],
    memories: [{ id: 'mem-pref', title: '评审关注点', detail: '优先验证信息来源和数据边界。', status: '已确认' }],
    tasks: [],
  },
]

export const ROOM_RECOMMENDATIONS: RoomRecommendation[] = [
  { id: 'rec-release', title: '开源版发布准备', reason: '来自 3 封邮件和 2 次会议的共同议题', kind: '事件', materialCount: 5 },
  { id: 'rec-security', title: '本地数据安全', reason: '最近文档中反复出现的隐私与权限议题', kind: '主题', materialCount: 8 },
]

export function createRoomGraphData(rooms: ContextRoomRecord[]): ContextGraphData {
  const nodes = rooms.slice(0, 8).map((room) => ({
    id: room.id,
    label: room.title,
    kind: room.kind,
    description: room.description,
  }))
  const edges: ContextGraphData['edges'] = []
  nodes.forEach((node, index) => {
    nodes.slice(index + 1).forEach((candidate) => {
      const left = rooms.find((room) => room.id === node.id)
      const right = rooms.find((room) => room.id === candidate.id)
      const sharedPeople = left?.people.filter((person) => right?.people.includes(person)) ?? []
      if (!sharedPeople.length && left?.kind !== right?.kind) return
      edges.push({
        id: `${node.id}:${candidate.id}`,
        source: node.id,
        target: candidate.id,
        label: sharedPeople.length ? `共同人物 ${sharedPeople.length}` : `同为${left?.kind ?? '主题'}`,
      })
    })
  })
  const connected = new Set(edges.flatMap((edge) => [edge.source, edge.target]))
  nodes.slice(1).forEach((node) => {
    if (connected.has(node.id) || !nodes[0]) return
    edges.push({ id: `${nodes[0].id}:${node.id}:related`, source: nodes[0].id, target: node.id, label: '关联' })
  })
  return { nodes, edges }
}

export function createMemoryGraphData(room: ContextRoomRecord): ContextGraphData {
  const roomNode = { id: room.id, label: room.title, kind: room.kind, description: room.description }
  const people = room.people.map((person) => ({
    id: `${room.id}:person:${person}`,
    label: person,
    kind: '人物' as const,
    description: `与「${room.title}」关联的人物`,
  }))
  const facts = room.memories.map((memory) => ({
    id: `${room.id}:fact:${memory.id}`,
    label: memory.title,
    kind: 'fact' as const,
    description: memory.detail,
  }))
  const edges = [
    ...people.map((person) => ({ id: `${room.id}:${person.id}`, source: room.id, target: person.id, label: '参与' })),
    ...facts.map((fact, index) => ({
      id: `${room.id}:${fact.id}`,
      source: people[index % Math.max(people.length, 1)]?.id ?? room.id,
      target: fact.id,
      label: '事实',
    })),
  ]
  return { nodes: [roomNode, ...people, ...facts], edges }
}
