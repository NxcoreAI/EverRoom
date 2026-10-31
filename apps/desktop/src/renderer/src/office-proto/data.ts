// EverRoom Office 原型（方向 A）mock 数据。
// 人物与素材沿用仓库既有 mock 世界观（连接器项目室 / 林薇 / V1 视觉定稿…），
// 保证各原型页之间叙事一致。

export type FileKind = 'docx' | 'md' | 'xlsx' | 'pptx' | 'pdf'

/** 主页侧边栏五个一级菜单。 */
export type MenuKey = 'recent' | 'files' | 'agent' | 'kb' | 'connectors'

export interface DocBlock {
  type: 'h1' | 'h2' | 'p' | 'quote'
  text: string
  cite?: { label: string; source: string }
}

export type FileContent =
  | { type: 'doc'; blocks: DocBlock[] }
  | { type: 'sheet'; columns: string[]; rows: string[][] }
  | { type: 'slides'; slides: { title: string; bullets: string[]; note?: string }[] }
  | { type: 'md'; source: string }
  | { type: 'pdf'; pages: { paragraphs: string[] }[] }

export interface OfficeFile {
  id: string
  name: string
  kind: FileKind
  roomId: string | null
  updatedLabel: string
  sizeLabel: string
  memoryCount: number
  content: FileContent
  /** 真实文件库条目：存在时编辑页走 nxcore 文件库内置预览（可编辑 + 保存回填版本链），
   *  不存在（mock 文件）才走原型 GenOffice 桥。 */
  realCatalog?: FileCatalogDto
}

export const files: OfficeFile[] = [
  {
    id: 'f-weekly',
    name: '周报：连接器统一排期.docx',
    kind: 'docx',
    roomId: 'kb-connector',
    updatedLabel: '2 小时前',
    sizeLabel: '128 KB',
    memoryCount: 6,
    content: { type: 'doc', blocks: [
      { type: 'h1', text: '连接器统一排期 · 周报' },
      { type: 'p', text: '本周连接器统一进入阶段一：身份合并与命名对齐。Gmail 双链路排障入口已明确，映射表三处同值收口过半。' },
      { type: 'h2', text: '本周结论' },
      { type: 'quote', text: 'V1 视觉已定稿，动效统一 240ms，列表类内容做 40ms 错峰。', cite: { label: '设计周报', source: '邮件 · 林薇 · 2 天前' } },
      { type: 'quote', text: '阶段一范围确认：身份合并 + 命名对齐，联调窗口 10/28–11/05。', cite: { label: '周会纪要 0928', source: '会议 · 连接器项目室 · 3 天前' } },
      { type: 'h2', text: '风险' },
      { type: 'p', text: '视觉与连接器里程碑在同一周重叠，需要提前一周确认取舍；会话失效静默问题仍未有结论。' },
      { type: 'h2', text: '下周计划' },
      { type: 'p', text: '完成映射表收口；与设计师同步连接器视觉；输出阶段一联调环境清单。' },
    ] },
  },
  {
    id: 'f-supplier',
    name: '供应商比价（Q4）.xlsx',
    kind: 'xlsx',
    roomId: 'kb-buy',
    updatedLabel: '昨天',
    sizeLabel: '46 KB',
    memoryCount: 3,
    content: { type: 'sheet', columns: ['供应商', '报价（万）', '交期', '付款条件', '备注'], rows: [
      ['华辰科技', '42.0', '4 周', '3-6-1', '含一年驻场'],
      ['远大智造', '38.5', '6 周', '5-5', '本地化支持较弱'],
      ['启明互联', '45.2', '3 周', '3-3-3-1', '报价最高但交期最短'],
      ['合计', '125.7', '—', '—', ''],
    ] },
  },
  {
    id: 'f-release',
    name: 'V1 视觉定稿 · 发布计划.pptx',
    kind: 'pptx',
    roomId: 'kb-visual',
    updatedLabel: '昨天',
    sizeLabel: '2.4 MB',
    memoryCount: 4,
    content: { type: 'slides', slides: [
      { title: 'V1 视觉定稿 · 发布计划', bullets: ['动效统一 240ms，列表错峰 40ms', '11 月第一周灰度，第二周全量', '回滚预案：视觉开关一键退回 V0'], note: '封面页 · 场景字阶 L1' },
      { title: '时间线', bullets: ['10/28 冻结视觉资产', '11/04 灰度 10%', '11/11 全量发布'], note: '时间线页 · 值轴刻度自动' },
      { title: '风险与依赖', bullets: ['连接器里程碑同周重叠', '动效性能在低端机待压测'], note: '结论页 · 颜色守门通过' },
    ] },
  },
  {
    id: 'f-notes',
    name: '产品调研笔记.md',
    kind: 'md',
    roomId: 'kb-connector',
    updatedLabel: '昨天',
    sizeLabel: '12 KB',
    memoryCount: 2,
    content: { type: 'md', source: [
      '# 产品调研笔记',
      '',
      '三条链路并存的现状已经确认；目标架构以**统一执行面**为先。',
      '',
      '> Gmail：oo runs 与 managed-gmail 分表，排障成本集中在身份不一致。——《连接器架构评审》',
      '',
      '## 待办',
      '',
      '- [ ] 映射表三处同值收口',
      '- [ ] 确认会话失效静默的复现路径',
      '- [x] 双链路现状盘点',
    ].join('\n') },
  },
  {
    id: 'f-meet',
    name: '会议纪要：飞书周会 0928.docx',
    kind: 'docx',
    roomId: 'kb-meet',
    updatedLabel: '3 天前',
    sizeLabel: '86 KB',
    memoryCount: 5,
    content: { type: 'doc', blocks: [
      { type: 'h1', text: '飞书周会纪要 · 0928' },
      { type: 'p', text: '连接器阶段一范围确认，联调窗口定为 10/28–11/05。' },
      { type: 'quote', text: '排期表由李明输出，视觉与连接器里程碑撞车需要提前取舍。', cite: { label: '周会录音转写', source: '会议 · 52 分钟 · 3 天前' } },
    ] },
  },
  {
    id: 'f-rival',
    name: '竞品分析：Notion AI vs EverRoom.pdf',
    kind: 'pdf',
    roomId: 'kb-visual',
    updatedLabel: '3 天前',
    sizeLabel: '1.8 MB',
    memoryCount: 1,
    content: { type: 'pdf', pages: [
      { paragraphs: [
        '一、市场格局：Notion AI 的优势在通用写作补全与模板生态，其 AI 能力面向「任何人在任何文档」的通用场景，付费墙较高（每席 $10/月）。',
        'EverRoom 的机会不在通用补全，而在「带着用户自己的记忆写」：邮件、会议、Wiki 构成的私有上下文是 Copilot 类产品拿不到的。',
      ] },
      { paragraphs: [
        '二、能力对比：Notion AI 支持问答、翻译、摘要、改写；EverRoom 原型已具备记忆起草、引用锚定、数据成表、论文装订四项独占能力。',
        '在「从零起草」场景，Notion AI 产出通用模板化内容；EverRoom 能引用真实邮件与会议结论，可信度与可用性显著更高。',
      ] },
      { paragraphs: [
        '三、结论：以「引用锚定的 AI 写作」为核心叙事切入，避开与 Notion AI 在通用补全上的正面消耗战；定价锚点建议对齐 WPS 超级会员而非 Notion。',
      ] },
    ] },
  },
  {
    id: 'f-okr',
    name: 'OKR 2026 Q3.xlsx',
    kind: 'xlsx',
    roomId: 'kb-personal',
    updatedLabel: '上周',
    sizeLabel: '32 KB',
    memoryCount: 0,
    content: { type: 'sheet', columns: ['目标', '关键结果', '进度', '负责人'], rows: [
      ['视觉体系落地', 'V1 定稿并全量', '80%', '林薇'],
      ['连接器统一', '阶段一联调完成', '45%', '李明'],
      ['知识库活跃', 'Wiki 周更新 20 页', '60%', '王小雨'],
    ] },
  },
  {
    id: 'f-thesis',
    name: '论文初稿：复杂系统认知框架.docx',
    kind: 'docx',
    roomId: null,
    updatedLabel: '上周',
    sizeLabel: '214 KB',
    memoryCount: 0,
    content: { type: 'doc', blocks: [
      { type: 'h1', text: '复杂系统认知框架' },
      { type: 'p', text: '4.1 关于控制论与复杂性的边界讨论。' },
      { type: 'p', text: '（这篇不在任何知识库里——演示「个人文件」与「知识库文件」共存。）' },
    ] },
  },
]

/* ───────────── 每日洞察（「最近」页首屏卡：AI 说的一段话） ───────────── */

export interface InsightAction {
  label: string
  type: 'open' | 'draft'
  fileId?: string
}

export const dailyInsight = {
  speaker: '小 E',
  text: '早上好，王小雨。Q4 三家供应商的报价昨晚已经到齐：华辰 42.0 万、远大智造 38.5 万、启明互联 45.2 万——远大最便宜但交期要 6 周，启明交期最短却贵了近 7 万，建议今天先定下取舍口径。下午 16:00 有连接器排期会，上周的纪要还没整理，我可以边开边帮你记。另外提醒一件事：V1 视觉定稿与连接器里程碑撞在了同一周，会前最好先和李明确认优先级。',
  source: '基于 42 封邮件、3 场会议与 9 页 Wiki 生成',
  updatedLabel: '每天 9:00 更新',
}

export const dailyInsightActions: InsightAction[] = [
  { label: '生成比价表', type: 'open', fileId: 'f-supplier' },
  { label: '整理会议纪要', type: 'draft' },
]

/* ───────────── 记忆（Agent 页 · 记忆标签） ───────────── */

export interface KnowledgeCard {
  id: string
  kind: 'mail' | 'meeting' | 'wiki' | 'fact'
  title: string
  source: string
  quote: string
  refCount: number
}

export const knowledgeCards: KnowledgeCard[] = [
  { id: 'k1', kind: 'mail', title: '设计周报：V1 视觉定稿', source: '邮件 · 林薇 · 2 天前', quote: 'V1 视觉已定稿，动效统一 240ms，列表类内容做 40ms 错峰。', refCount: 3 },
  { id: 'k2', kind: 'meeting', title: '周会：连接器排期', source: '会议 · 3 天前', quote: '阶段一范围确认：身份合并 + 命名对齐，联调窗口 10/28–11/05。', refCount: 2 },
  { id: 'k3', kind: 'wiki', title: 'Wiki · 双链路收敛', source: '连接器项目室 · Wiki', quote: 'Gmail 双链路并入统一格式层，映射表三处同值待收口。', refCount: 2 },
  { id: 'k4', kind: 'mail', title: '供应商报价（Q4）', source: '邮件 · 采购部 · 5 小时前', quote: '三家供应商报价见正文，请确认后回复，交期以报价单为准。', refCount: 1 },
  { id: 'k5', kind: 'fact', title: '事实 · 排期冲突', source: '自动提炼 · 9/10', quote: '视觉与连接器里程碑在同一周重叠，需提前取舍。', refCount: 2 },
]

export const memoryKindMeta: Record<KnowledgeCard['kind'], { label: string; color: string }> = {
  mail: { label: '邮件', color: '#e8823a' },
  meeting: { label: '会议', color: '#d9504a' },
  wiki: { label: 'Wiki', color: '#7d5bd6' },
  fact: { label: '事实', color: '#b88a2e' },
}

/* ───────────── Agent 会话记录 ───────────── */

export interface AgentSession {
  id: string
  title: string
  whenLabel: string
  duration: string
  turns: number
  fileId: string | null
}

export const agentSessions: AgentSession[] = [
  { id: 's1', title: '起草周报：连接器统一排期', whenLabel: '2 小时前', duration: '3 分 12 秒', turns: 6, fileId: 'f-weekly' },
  { id: 's2', title: '对比三家供应商的 Q4 报价', whenLabel: '昨天', duration: '1 分 48 秒', turns: 4, fileId: 'f-supplier' },
  { id: 's3', title: '整理 V1 视觉定稿的发布计划', whenLabel: '昨天', duration: '2 分 05 秒', turns: 5, fileId: 'f-release' },
  { id: 's4', title: '从邮件提炼映射表待办', whenLabel: '3 天前', duration: '58 秒', turns: 3, fileId: 'f-notes' },
  { id: 's5', title: '生成竞品对比摘要', whenLabel: '上周', duration: '4 分 30 秒', turns: 8, fileId: 'f-rival' },
]

/* ───────────── MCP 服务器 ───────────── */

export interface McpServer {
  id: string
  name: string
  transport: 'stdio' | 'sse'
  connected: boolean
  tools: string[]
}

export const mcpServers: McpServer[] = [
  { id: 'm-fetch', name: 'fetch', transport: 'stdio', connected: true, tools: ['fetch_url', 'fetch_text', 'list_links'] },
  { id: 'm-fs', name: 'filesystem', transport: 'stdio', connected: true, tools: ['read_file', 'list_dir', 'search'] },
  { id: 'm-gmail', name: 'gmail', transport: 'sse', connected: true, tools: ['search_mail', 'read_thread', 'send_reply'] },
  { id: 'm-wiki', name: 'wiki-search', transport: 'sse', connected: false, tools: ['search', 'get_page'] },
]

/* ───────────── Skills ───────────── */

export interface AgentSkill {
  id: string
  name: string
  desc: string
  enabled: boolean
}

export const agentSkills: AgentSkill[] = [
  { id: 'sk-weekly', name: '周报起草', desc: '汇总本周邮件与会议，按结论 / 风险 / 计划成稿', enabled: true },
  { id: 'sk-sheet', name: '报价成表', desc: '从邮件正文提取报价，生成比价表格', enabled: true },
  { id: 'sk-meet', name: '会议纪要', desc: '录音转写，提炼结论与待办', enabled: true },
  { id: 'sk-thesis', name: '论文排版', desc: '格式卡装订，一键成册', enabled: false },
]

/* ───────────── 人格与用户画像 ───────────── */

export const persona = {
  name: '小 E · 工作台助理',
  tagline: '带着你的记忆工作的办公 Agent',
  styleTags: ['简洁', '专业', '结论先行', '引用溯源'],
  promptSummary:
    '你是王小雨的工作台助理。起草前先检索记忆（邮件 / 会议 / Wiki），结论必须附带引用；不确定的内容标注「待确认」，不要编造。输出优先表格与要点，正文控制在必要篇幅内。',
}

export interface ProfileGroup {
  title: string
  items: string[]
}

export const userProfile: ProfileGroup[] = [
  { title: '角色', items: ['产品经理 · 制造业数字化', '连接器项目组成员，与设计、采购协作'] },
  { title: '工作习惯', items: ['每周五下午写周报', '平均每天 3 场会，会前需要摘要', '表格优于长文，结论先行'] },
  { title: '偏好', items: ['中文为主，术语保留英文', '动效克制、信息密度高', '引用必须能回到原始材料'] },
  { title: '常用工具', items: ['Gmail · 飞书 · Wiki', 'Excel 与在线表格', 'GitHub（只读，关注排期）'] },
]

/* ───────────── 知识库 ───────────── */

export type SourceKind = 'doc' | 'web' | 'mail' | 'meeting' | 'note'

export interface KnowledgeSource {
  id: string
  kind: SourceKind
  title: string
  timeLabel: string
  status: 'indexed' | 'syncing'
  fileId?: string
}

export interface KnowledgeBase {
  id: string
  title: string
  icon: string
  updatedLabel: string
  sources: KnowledgeSource[]
}

export const knowledgeBases: KnowledgeBase[] = [
  { id: 'kb-connector', title: '连接器项目室', icon: '🧩', updatedLabel: '2 小时前', sources: [
    { id: 'sc-weekly', kind: 'doc', title: '周报：连接器统一排期.docx', timeLabel: '2 小时前', status: 'indexed', fileId: 'f-weekly' },
    { id: 'sc-notes', kind: 'doc', title: '产品调研笔记.md', timeLabel: '昨天', status: 'indexed', fileId: 'f-notes' },
    { id: 'sc-mail', kind: 'mail', title: '设计周报：V1 视觉定稿（林薇）', timeLabel: '2 天前', status: 'indexed' },
    { id: 'sc-meet', kind: 'meeting', title: '周会：连接器排期 0928', timeLabel: '3 天前', status: 'indexed' },
    { id: 'sc-wiki', kind: 'web', title: 'Wiki · 双链路收敛', timeLabel: '上周', status: 'indexed' },
  ] },
  { id: 'kb-visual', title: '设计系统', icon: '🎨', updatedLabel: '昨天', sources: [
    { id: 'sc-release', kind: 'doc', title: 'V1 视觉定稿 · 发布计划.pptx', timeLabel: '昨天', status: 'indexed', fileId: 'f-release' },
    { id: 'sc-rival', kind: 'doc', title: '竞品分析：Notion AI vs EverRoom.pdf', timeLabel: '3 天前', status: 'indexed', fileId: 'f-rival' },
    { id: 'sc-motion', kind: 'mail', title: '动效规范讨论（邮件串）', timeLabel: '上周', status: 'indexed' },
    { id: 'sc-ref', kind: 'web', title: 'Keynote 模板参考页', timeLabel: '上周', status: 'syncing' },
  ] },
  { id: 'kb-buy', title: '采购流程', icon: '📦', updatedLabel: '5 小时前', sources: [
    { id: 'sc-quote', kind: 'mail', title: '供应商报价（Q4）· 采购部', timeLabel: '5 小时前', status: 'syncing' },
    { id: 'sc-sheet', kind: 'doc', title: '供应商比价（Q4）.xlsx', timeLabel: '昨天', status: 'indexed', fileId: 'f-supplier' },
    { id: 'sc-delivery', kind: 'mail', title: '交期确认往来', timeLabel: '3 天前', status: 'indexed' },
  ] },
  { id: 'kb-meet', title: '周会', icon: '🗓️', updatedLabel: '3 天前', sources: [
    { id: 'sc-meetdoc', kind: 'doc', title: '会议纪要：飞书周会 0928.docx', timeLabel: '3 天前', status: 'indexed', fileId: 'f-meet' },
    { id: 'sc-meet0928', kind: 'meeting', title: '飞书周会 0928（52 分钟）', timeLabel: '3 天前', status: 'indexed' },
    { id: 'sc-meet0921', kind: 'meeting', title: '飞书周会 0921', timeLabel: '上周', status: 'indexed' },
  ] },
  { id: 'kb-personal', title: '个人笔记', icon: '📝', updatedLabel: '昨天', sources: [
    { id: 'sc-reading', kind: 'note', title: '读书摘录：复杂系统导论', timeLabel: '昨天', status: 'indexed' },
    { id: 'sc-okr', kind: 'doc', title: 'OKR 2026 Q3.xlsx', timeLabel: '上周', status: 'indexed', fileId: 'f-okr' },
    { id: 'sc-thesis', kind: 'doc', title: '论文初稿：复杂系统认知框架.docx', timeLabel: '上周', status: 'indexed', fileId: 'f-thesis' },
  ] },
]

export const sourceMeta: Record<SourceKind, { label: string; color: string }> = {
  doc: { label: '文档', color: '#0a84ff' },
  web: { label: '网页', color: '#7d5bd6' },
  mail: { label: '邮件', color: '#e8823a' },
  meeting: { label: '会议', color: '#d9504a' },
  note: { label: '笔记', color: '#2fa14e' },
}

/* ───────────── 连接器 ─────────────
 * 连接器页已改为真实数据驱动（pages/ConnectorsView.tsx）：
 * 目录来自网关注册表（nangoConnector.providers），连接状态来自
 * nangoConnector.status，不再使用这里的 mock 目录。 */

/* ───────────── 模板 / 起草 ───────────── */

export const templates = [
  { id: 't-blank', name: '空白文档', kind: 'docx' as FileKind, desc: '从零开始' },
  { id: 't-weekly', name: '周报', kind: 'docx' as FileKind, desc: '自动汇总本周邮件与会议' },
  { id: 't-meet', name: '会议纪要', kind: 'docx' as FileKind, desc: '录音转写 + 结论提炼' },
  { id: 't-thesis', name: '论文排版', kind: 'docx' as FileKind, desc: '格式卡装订，一键成册' },
  { id: 't-compare', name: '比价表', kind: 'xlsx' as FileKind, desc: '从邮件报价自动成表' },
  { id: 't-plan', name: '项目计划', kind: 'pptx' as FileKind, desc: '排期成稿，智能排版' },
]

export const draftingSteps = [
  '定位相关房间：连接器项目室、周会',
  '翻阅 42 封邮件与 3 篇会议纪要',
  '提取本周结论、风险与下周计划',
  '起草正文并锚定引用来源',
]

// AI 起草产出的周报（含引用），打开编辑器时作为初始内容。
export const draftedWeeklyBlocks: DocBlock[] = [
  { type: 'h1', text: '周报：连接器统一排期（AI 起草）' },
  { type: 'p', text: '根据你本周的邮件与会议记录起草，引用已锚定在对应结论下方，点击引用可回到原始材料。' },
  { type: 'h2', text: '本周结论' },
  { type: 'quote', text: 'V1 视觉已定稿，动效统一 240ms，列表类内容做 40ms 错峰。', cite: { label: '设计周报', source: '邮件 · 林薇 · 2 天前' } },
  { type: 'quote', text: '阶段一范围确认：身份合并 + 命名对齐，联调窗口 10/28–11/05。', cite: { label: '周会纪要 0928', source: '会议 · 3 天前' } },
  { type: 'quote', text: 'Gmail 双链路并入统一格式层，映射表三处同值待收口。', cite: { label: 'Wiki · 双链路收敛', source: '连接器项目室' } },
  { type: 'h2', text: '风险' },
  { type: 'quote', text: '视觉与连接器里程碑在同一周重叠，需提前取舍。', cite: { label: '事实 · 排期冲突', source: '自动提炼 · 9/10' } },
  { type: 'h2', text: '下周计划' },
  { type: 'p', text: '完成映射表收口；与设计师同步连接器视觉；输出阶段一联调环境清单。' },
]

export const kindMeta: Record<FileKind, { label: string; color: string }> = {
  docx: { label: '文档', color: '#0a84ff' },
  md: { label: 'Markdown', color: '#8e8e93' },
  xlsx: { label: '表格', color: '#2fa14e' },
  pptx: { label: '演示', color: '#f08a24' },
  pdf: { label: 'PDF', color: '#e0564a' },
}

/** 各类型空白文件工厂（新建 tiles / 标签栏 + 按钮）。 */
export function blankFile(kind: FileKind): OfficeFile {
  const stamp = Date.now()
  if (kind === 'xlsx') {
    return {
      id: `f-blank-xlsx-${stamp}`, name: '未命名表格.xlsx', kind, roomId: null,
      updatedLabel: '刚刚', sizeLabel: '—', memoryCount: 0,
      content: { type: 'sheet', columns: ['列 1', '列 2', '列 3', '列 4'], rows: Array.from({ length: 6 }, () => ['', '', '', '']) },
    }
  }
  if (kind === 'pptx') {
    return {
      id: `f-blank-pptx-${stamp}`, name: '未命名演示.pptx', kind, roomId: null,
      updatedLabel: '刚刚', sizeLabel: '—', memoryCount: 0,
      content: { type: 'slides', slides: [{ title: '点击编辑标题', bullets: ['要点一', '要点二'], note: '新建页 · 场景字阶 L1' }] },
    }
  }
  if (kind === 'md') {
    return {
      id: `f-blank-md-${stamp}`, name: '未命名笔记.md', kind, roomId: null,
      updatedLabel: '刚刚', sizeLabel: '—', memoryCount: 0,
      content: { type: 'md', source: '# 未命名笔记\n\n' },
    }
  }
  // docx / pdf 新建都落到文档编辑器（原型不新建 pdf）
  return {
    id: `f-blank-docx-${stamp}`, name: '未命名文档.docx', kind: 'docx', roomId: null,
    updatedLabel: '刚刚', sizeLabel: '—', memoryCount: 0,
    content: { type: 'doc', blocks: [{ type: 'p', text: '' }] },
  }
}

export function draftFile(): OfficeFile {
  return {
    id: 'f-draft-weekly',
    name: '周报：连接器统一排期（AI 起草）.docx',
    kind: 'docx',
    roomId: 'kb-connector',
    updatedLabel: '刚刚',
    sizeLabel: '—',
    memoryCount: 6,
    content: { type: 'doc', blocks: draftedWeeklyBlocks },
  }
}

/* ───────────────── 侧栏 mock：材料 / 历史记录 / Agent 开场建议 ───────────────── */

export type MaterialKind = 'mail' | 'meeting' | 'wiki' | 'fact' | 'file'

export interface MaterialItem {
  id: string
  kind: MaterialKind
  title: string
  excerpt: string
  meta: string
  addedLabel: string
}

export const materialKindMeta: Record<MaterialKind, { label: string; icon: string }> = {
  mail: { label: '邮件', icon: '✉️' },
  meeting: { label: '会议', icon: '🗓️' },
  wiki: { label: 'Wiki', icon: '📘' },
  fact: { label: '事实', icon: '💡' },
  file: { label: '文件', icon: '📄' },
}

/** 各文件的初始材料（Agent 可调用的上下文）；本地添加的材料运行时追加。 */
export const fileMaterials: Record<string, MaterialItem[]> = {
  'f-weekly': [
    { id: 'm1', kind: 'mail', title: '设计周报：V1 视觉定稿', excerpt: 'V1 视觉已定稿，动效统一 240ms，列表类内容做 40ms 错峰。', meta: '邮件 · 林薇 · 2 天前', addedLabel: '2 天前添加' },
    { id: 'm2', kind: 'meeting', title: '周会：连接器排期', excerpt: '阶段一范围确认：身份合并 + 命名对齐，联调窗口 10/28–11/05。', meta: '会议 · 52 分钟 · 3 天前', addedLabel: '3 天前添加' },
    { id: 'm3', kind: 'wiki', title: 'Wiki · 双链路收敛', excerpt: 'Gmail 双链路并入统一格式层，映射表三处同值待收口。', meta: '连接器项目室 · Wiki', addedLabel: '上周添加' },
  ],
  'f-draft-weekly': [
    { id: 'm1', kind: 'mail', title: '设计周报：V1 视觉定稿', excerpt: 'V1 视觉已定稿，动效统一 240ms，列表类内容做 40ms 错峰。', meta: '邮件 · 林薇 · 2 天前', addedLabel: '起草时引用' },
    { id: 'm2', kind: 'meeting', title: '周会：连接器排期', excerpt: '阶段一范围确认：身份合并 + 命名对齐，联调窗口 10/28–11/05。', meta: '会议 · 52 分钟 · 3 天前', addedLabel: '起草时引用' },
    { id: 'm3', kind: 'wiki', title: 'Wiki · 双链路收敛', excerpt: 'Gmail 双链路并入统一格式层，映射表三处同值待收口。', meta: '连接器项目室 · Wiki', addedLabel: '起草时引用' },
    { id: 'm4', kind: 'fact', title: '事实 · 排期冲突', excerpt: '视觉与连接器里程碑在同一周重叠，需提前取舍。', meta: '自动提炼 · 9/10', addedLabel: '起草时引用' },
  ],
  'f-supplier': [
    { id: 'm1', kind: 'mail', title: '供应商报价（Q4）', excerpt: '三家供应商报价见正文，请确认后回复，交期以报价单为准。', meta: '邮件 · 采购部 · 5 小时前', addedLabel: '今天添加' },
  ],
  'f-rival': [
    { id: 'm1', kind: 'wiki', title: 'Wiki · 竞品跟踪', excerpt: 'Notion AI 定价与能力清单（每月更新）。', meta: '设计系统 · Wiki', addedLabel: '上周添加' },
  ],
}

/** 未命中专属材料的文件用这组兜底。 */
export const defaultMaterials: MaterialItem[] = [
  { id: 'd1', kind: 'wiki', title: 'Wiki · 产品术语表', excerpt: '连接器 / 统一执行面 / 格式层 等术语的定义与负责人。', meta: '知识库 · Wiki', addedLabel: '上周添加' },
  { id: 'd2', kind: 'fact', title: '事实 · 版本节奏', excerpt: '双周一个里程碑，视觉与工程错峰发布。', meta: '自动提炼 · 9/28', addedLabel: '上周添加' },
]

export interface HistoryEntry {
  id: string
  actor: 'user' | 'agent' | 'system'
  title: string
  detail?: string
  /** 版本类条目可「恢复此版本」（mock）；Agent 操作类可「查看改动」（mock）。 */
  restorable?: boolean
  diffable?: boolean
}

/** 统一时间线（新 → 旧）。 */
export const fileHistory: Record<string, HistoryEntry[]> = {
  'f-weekly': [
    { id: 'h1', actor: 'user', title: '王小雨 编辑', detail: '修改 3 处 · 已保存', restorable: true },
    { id: 'h2', actor: 'agent', title: 'Agent 修改', detail: '插入引用 ×2 · 已审阅通过', diffable: true },
    { id: 'h3', actor: 'user', title: '王小雨 编辑', detail: '补充风险章节 · 已保存', restorable: true },
    { id: 'h4', actor: 'system', title: '导入', detail: '来源：邮件《设计周报》附件' },
  ],
  'f-draft-weekly': [
    { id: 'h1', actor: 'agent', title: 'AI 起草', detail: '依据 4 条记忆起草 · 引用已锚定', restorable: true, diffable: true },
  ],
  'f-supplier': [
    { id: 'h1', actor: 'system', title: '自动成表', detail: '来源：邮件《供应商报价（Q4）》' },
    { id: 'h2', actor: 'agent', title: 'Agent 修改', detail: '补全合计行 · 已审阅通过', diffable: true },
  ],
  'f-rival': [
    { id: 'h1', actor: 'user', title: '王小雨 编辑', detail: '标注结论段落 · 已保存', restorable: true },
    { id: 'h2', actor: 'system', title: '导入', detail: '来源：本地文件' },
  ],
}

export const defaultHistory: HistoryEntry[] = [
  { id: 'h1', actor: 'user', title: '王小雨 编辑', detail: '已保存', restorable: true },
  { id: 'h2', actor: 'system', title: '创建', detail: '空白文档' },
]

/** Agent 面板空会话时的开场建议（按文件类型）。 */
export const starterPrompts: Record<FileKind, string[]> = {
  docx: ['把这份文档的结论改得更精炼', '根据本周邮件更新「下周计划」', '检查全文的引用是否还有效'],
  xlsx: ['哪家供应商交期最短？', '按总价排序并标红最高项', '把这张表写成一段采购建议'],
  pptx: ['把第 2 页的时间线改成表格', '给每页要点补一句风险提示', '整体换成更收敛的配色'],
  pdf: ['这份 PDF 的核心结论是什么？', '把第 2 页的观点改写进我的周报', '提炼三句给管理层看的摘要'],
  md: ['把这篇笔记整理成周报初稿', '补全「待办」的下一步行动', '总结这篇笔记的三条结论'],
}

/* ───────────── EverRoomMac 真实文件接入（迁移附加层，不改上方原型数据） ─────────────
 * 有 preload 网关桥（window.nxcore.files）时，最近/所有文件列表显示真实文件库；
 * 真实 docx/xlsx/pptx/pdf 点开后进标签页，由 NativeEditorHost 的 realCatalog 分支
 * 调 nxcore.files.openOriginal 打开内置 GenOffice 预览（可编辑，保存回填版本链），
 * 无桥/为空时回退原型 mock 列表。 */

import type { FileCatalogDto } from '@/shared/ingest'

export interface RealOfficeFile {
  catalog: FileCatalogDto
  file: OfficeFile
}

function extToKind(name: string): FileKind | null {
  const ext = name.toLowerCase().split('.').pop() ?? ''
  if (ext === 'docx' || ext === 'doc') return 'docx'
  if (ext === 'xlsx' || ext === 'xls' || ext === 'xlsm') return 'xlsx'
  if (ext === 'pptx' || ext === 'ppt') return 'pptx'
  if (ext === 'pdf') return 'pdf'
  if (ext === 'md' || ext === 'markdown') return 'md'
  return null
}

function bytesToLabel(bytes: number): string {
  if (bytes <= 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function updatedLabelFrom(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(ms) || ms < 0) return '刚刚'
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days} 天前`
  return new Date(iso).toLocaleDateString('zh-CN')
}

export function catalogToOfficeFile(catalog: FileCatalogDto): RealOfficeFile | null {
  const name = catalog.displayName ?? catalog.originalName
  const kind = extToKind(name)
  if (!kind) return null
  return {
    catalog,
    file: {
      id: `real:${catalog.id}`,
      name,
      kind,
      roomId: catalog.clusterId,
      updatedLabel: updatedLabelFrom(catalog.updatedAt),
      sizeLabel: bytesToLabel(catalog.bytes),
      memoryCount: 0,
      // 真实文件内容不走 mock content：编辑页按 realCatalog 打开文件库内置预览。
      content: { type: 'md', source: '' },
      realCatalog: catalog,
    },
  }
}

/** 拉取真实文件库（只取能映射到五种原型类型的）；无桥/失败返回 null（调用方回退 mock）。
 *  total 是文件库全量计数（分页语义，不受 limit 影响），供「最近」页副标题等展示。
 *  options.workspaceId = 按工作空间过滤（资料库/产物库独立）；缺省拉全库。 */
export async function fetchRealFiles(
  limit = 100,
  options?: { workspaceId?: string },
): Promise<{ items: RealOfficeFile[]; total: number } | null> {
  const api = window.nxcore?.files
  if (!api?.list) return null
  try {
    const { items, total } = await api.list(limit, 0, options)
    return {
      items: items.map(catalogToOfficeFile).filter((x): x is RealOfficeFile => x !== null),
      total,
    }
  } catch {
    return null
  }
}
