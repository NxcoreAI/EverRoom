# 「技能」页：从原型迁入 + 接真实网关

> 状态：**已实现**（2026-11-02）。来源原型：`/Users/xjwang/EerRoom/everoffice`
> `src/renderer/src/office-proto/pages/SkillsView.tsx`（50 行静态卡片 + 本地 state 假开关）。
> 目标端：`apps/desktop` 的 workbench 外壳（主页第七个一级页面）。

## 1. 原型 vs 现在

| | 原型 SkillsView | 现在 |
| --- | --- | --- |
| 入口 | 主页侧栏一级菜单「技能」 | 同（侧栏排在 Agent 与连接器之间） |
| 数据 | `data.ts` 里 4 条 mock（周报起草 / 报价成表 / …） | 网关真实目录：内置 Agent bundle 与子 Agent 清单里的 `SKILL.md` |
| 启停 | 组件内 `useState`，切页即丢 | 落网关 `agent_skill_states`，并立即重装运行时 |
| 详情 | 无 | 点行看 `SKILL.md` 全文（frontmatter + 正文） |
| 搜索/筛选 | 无 | 本地搜索（名称/说明/归属 Agent/路径）+ 归属类别筛选 |
| 新增 | 「新增技能（原型占位）」按钮 | 手写 SKILL.md 或从文件夹导入（落网关数据目录，见 §5） |
| 删除 | 无 | 只对自定义技能开放（内置/子 Agent 技能是发布物，接口拒绝） |

## 2. 技能到底是什么

技能没有数据库表，也没有第二份正文。清单由三处权威来源拼成（前两类随应用发布，
第三类由用户自己加，见 §5）：

1. **内置 Agent bundle**：`agents/<id>/agent.yaml` 的 `skills:` 列出 `./skills/<dir>`，
   每个目录里必须有 `SKILL.md`（frontmatter 带 `name` / `description`）。
   这些技能在装配 runtime 时**内联进系统提示词**（`skillPrompts`）。
2. **子 Agent（dispatch_only）**：`agent.yaml` 的 `skills:` 会被注册表复制进
   Revision 目录，子 Agent 用 `read` 工具**按需读取**，不内联。
3. **用户技能**：`<dataDir>/agent/skills/<dir>/SKILL.md`，磁盘形态与 ① 相同，
   但根目录可写，所以能新增/删除。

技能 id = `<kind>:<ownerId>:<目录名>`，例如：

```
builtin:main:document-export        ← agents/main/skills/document-export
subagent:doc-writer:rewrite         ← agents/doc-writer/skills/rewrite
user:local:weekly-report            ← <dataDir>/agent/skills/weekly-report
```

不带 revision、不带文件摘要：改一行 `SKILL.md` 不该把用户关掉的技能悄悄打开。

## 3. 数据与生效链路

```
网关
  modules/skills/skill-markdown.ts   SKILL.md 的 frontmatter 解析（name/description）
  modules/skills/gate.ts             SkillGate（运行时过滤接口）+ skillIdOf
  modules/skills/state-store.ts      agent_skill_states 读写（内存镜像 + 落库）
  modules/skills/service.ts          目录构建 / 详情 / 启停 + 实现 SkillGate
  modules/skills/user-skills.ts      用户技能根目录读写（新增/导入/删除 + 校验）
  modules/skills/routes.ts           GET/POST /v1/skills、POST /v1/skills/import、
                                     PATCH/DELETE /v1/skills/:id
  drizzle/0095_agent_skill_states.sql

装配点（开关真正起作用的地方）
  modules/agent/runtime-factory.ts   createUserFacingRuntime / createCursorCompletionRuntime
                                     用 gate.builtinSkillPrompts(bundle) 过滤后注入
  modules/subagents/runtime-manager.ts
                                     gate.subagentSkillPaths(agentId, paths) 过滤技能路径，
                                     `read` 工具对已停用技能返回 subagent_skill_disabled
  server/create-server.ts            PATCH 后调 hotReloadAgentRuntimes()（重装运行时）

桌面端
  shared/sources.ts                  AgentSkillDto / AgentSkillDetailDto / AgentSkillsSnapshotDto
  main/gateway/agent-gateway-bridge.ts  listSkills / getSkill / setSkillEnabled
  main/index.ts + preload/index.ts   agent:list-skills / agent:get-skill / agent:set-skill-enabled
  shared/skill-error-message.ts      写操作机器码 → 用户话术
  renderer workbench/home/useSkills.ts + SkillsPage.tsx + SkillDialogs.tsx + skills.css
```

生效语义：

- **内置 Agent**（main / main-direct / main-lite 共用 primary bundle）：关掉即从
  `skillPrompts` 剔除，网关随即 reload 三档 runtime，下一次对话就生效。
- **子 Agent**：关掉后 `read` 工具读不到该技能目录，且 `skillsEnabled` 在全部关闭时为 false；
  网关 `invalidate()` 子 Agent runtime 缓存，下一次派发生效。
- **补全 Agent（cursor-completion）**：由独立网关进程提供服务，它在**启动时**读一次状态，
  所以这条开关要等补全服务下次启动才生效。桌面端主网关无法热替换那个进程的 runtime，
  这里不假装能热生效。

## 4. 页面

`workbench/home/SkillsPage.tsx`：

- 页头：标题 + 「n / m 已启用」徽标（全启用时是中性色，有停用时转警告色）+ 「新增技能」。
- 工具条：搜索框（名称/说明/归属 Agent/路径）+ 分段筛选（全部 / 内置 Agent / 子 Agent）。
- 列表：按归属 Agent 分组，每组带类别徽标与一句「关掉意味着什么」；
  行内是技能名、说明、`path · 体积`、状态文案与开关。
- 详情：点行开弹窗，按原文展示 `SKILL.md`（它就是写给模型读的，不做二次排版）。
- 新增：弹窗里两档——「手写 SKILL.md」（名称/说明/正文）与「从文件夹导入」（系统选择器）。
- 删除：只有「自定义」分组的行才有删除按钮，二次确认后删目录并刷新清单。
- 失败/空态分开：「技能清单读取失败」给重试（说明网关没返回目录），
  只有真的没有技能时才显示空态。

样式全部在 `workbench/home/skills.css`，选择器 scoped 到 `.wb-skills-*`；
开关是 `ui/primitives.tsx` 里新增的 `Toggle`（`role="switch"`），样式在 `ui/ui.css`。

同时把 Agent 页人格段里原来当「风格标签」展示的技能名改成「技能」小块：
只列名字，右侧给「查看技能说明与启停 →」跳到技能页（原来那里会让人以为技能=写作风格）。

## 5. 新增 / 删除技能

### 5.1 三类技能的可写性

| 归属 | 位置 | 能否新增 | 能否删除 |
| --- | --- | --- | --- |
| `builtin:<agent>:<dir>` | `agents/<agent>/skills/`（应用包内，只读） | 否（随版本发布） | 否（接口 409 `skill_not_removable`） |
| `subagent:<agent>:<dir>` | 子 Agent Revision 目录（由清单复制生成） | 否 | 否（同上） |
| `user:local:<dir>` | `<dataDir>/agent/skills/<dir>/`（用户可写） | **是** | **是** |

用户技能不是「第二种技能格式」，而是同一套磁盘形态换了个可写根目录：
一个目录 + `SKILL.md`（frontmatter `name` / `description`）+ 可选附属文件，
所以目录读取、正文展示、启停记录三处逻辑完全复用。

### 5.2 两种新增方式

1. **手写 SKILL.md**：表单只收「技能名 / 一句话说明 / 正文」，frontmatter 由网关生成
   （`name` + `description` 两个平面键）。
2. **从文件夹导入**：桌面端用系统目录选择器拿到绝对路径 → 网关校验该目录里有
   `SKILL.md` → 只读复制进 `agent/skills/<name>`（目录名取 frontmatter 的 `name`，
   缺失时退回来源文件夹名）。复制走「临时目录 + rename」，中途失败不留半个技能。

### 5.3 服务端校验（不依赖 UI）

- 目录名：单段、不含 `/` 或 `\`、不以 `.` 开头、无控制字符、≤ 64 字符；重名拒绝（409）。
- `SKILL.md`：必须存在、是普通文件、不是符号链接。
- 体积：单文件 ≤ 256KB、合计 ≤ 2MB、文件数 ≤ 64。
- 导入来源必须是绝对路径；遍历时拒绝符号链接与非普通文件（`symbolic link is not allowed`）。

### 5.4 生效范围与时机

- 用户技能**只注入用户档 Agent**（`main` / `main-direct` / `main-lite` 共用 primary bundle）。
  子 Agent 与补全/联网搜索代理有各自的输出契约，不塞用户技能。
- 与内置技能同名时**不覆盖发布物**，只留一条网关 warn（`skills: user skill name collides`）。
- 新增 / 导入 / 删除后网关立刻 `hotReloadAgentRuntimes()`，下一次对话就带上（或不再带上）它。
- 删除时同时清掉 `agent_skill_states` 里那条开关记录，避免同名技能下次进来继承旧状态。

### 5.5 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/v1/skills` | 清单 + 计数（三类混排） |
| GET | `/v1/skills/:id` | 详情（含 SKILL.md 全文） |
| PATCH | `/v1/skills/:id` | `{ enabled }` 启停（三类都能改） |
| POST | `/v1/skills` | `{ name, description, body }` 手写一个用户技能 |
| POST | `/v1/skills/import` | `{ sourceDirectory }` 从文件夹导入 |
| DELETE | `/v1/skills/:id` | 删除用户技能（其余返回 409 `skill_not_removable`） |

错误体固定 `{ error: 机器码, message: 机器码(±细节) }`；桌面端
`shared/skill-error-message.ts` 把机器码翻成一句能照做的话（与 thesis / connector 同口径）。

## 6. 测试

- `apps/gateway/tests/skills.test.ts`：目录（内置/子 Agent/用户）、frontmatter 解析、
  启停落库与重建后仍生效、gate 过滤（skillPrompts 与子 Agent 路径）、
  六个端点（含 404/409 与 onChange 回调）、用户技能的新增/导入/删除与注入范围。
- `apps/desktop/tests/workbench-skills.test.tsx`：分组渲染与计数、搜索/筛选本地收敛、
  开关成功更新 / 失败回滚 + toast、读取失败与空态区分、详情展示 SKILL.md，
  以及手写新增、文件夹导入（含取消）、机器码话术翻译、删除仅对自定义技能开放。
- `apps/desktop/tests/workbench-home.test.tsx`：侧栏入口顺序（新增「技能」）。

## 7. 排障

| 现象 | 先看什么 |
| --- | --- |
| 页面「技能清单读取失败」 | 网关没起 / `/v1/skills` 401：看 `apps/gateway` 日志与 `agent:list-skills` 通道 |
| 技能列表少了某个 | `agents/<id>/agent.yaml` 的 `skills:` 是否声明；`SKILL.md` 是否有 `name` frontmatter |
| 子 Agent 技能没有描述 | 该技能 `SKILL.md` 缺 `description`（注册表允许，页面按空描述处理并打 warn） |
| 关掉后还生效 | 看 `hotReloadAgentRuntimes` 日志；补全技能见 §3 的进程边界说明 |
| 迁移后报 `no such table: agent_skill_states` | 0095 未跑：重启网关，或按 `client.ts` 的 repaired 逻辑补记 |
| 新增报 `skill_name_taken` | `<dataDir>/agent/skills` 下已有同名目录：换名或先删旧的 |
| 新增的技能没进提示词 | 只注入用户档 Agent（main 三档）；确认它不是被停用状态，且没有与内置技能同名 |
| 想手工改用户技能 | 直接编辑 `<dataDir>/agent/skills/<dir>/SKILL.md`，重启网关或改一次开关即生效 |
