import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Word 卡片 AI 面板里的排版工具接线（原产物区弹窗的功能全部搬到这里）。
 * genoffice 侧代码在子模块内，这里钉住对用户可见的关键行为，防止回退。
 */
const docsRoot = resolve(__dirname, '../vendor/genoffice/apps/docs')
const aiTab = readFileSync(resolve(docsRoot, 'src/renderer/components/AiTab.tsx'), 'utf8')
const preload = readFileSync(resolve(docsRoot, 'src/preload/index.ts'), 'utf8')
const docsMain = readFileSync(resolve(docsRoot, 'src/main/docs-main.ts'), 'utf8')
const ipc = readFileSync(resolve(docsRoot, 'src/shared/ipc.ts'), 'utf8')

describe('AI 面板排版工具', () => {
  it('上传模版成功后直接排版当前文档（导入即排版）', () => {
    expect(aiTab).toContain('if (meta.cardId && hasDoc) await reformatWith(meta.cardId)')
  })

  it('模版解析缺口在面板里显性提示，不静默', () => {
    expect(aiTab).toContain("setError(t('aiThesisPartial'")
  })

  it('排版完成后展示映射报告（守恒/未匹配/待复核）', () => {
    expect(aiTab).toContain('setReport({')
    expect(aiTab).toContain("t('aiThesisReport'")
    expect(aiTab).toContain("t('aiThesisReportUnmatched'")
    expect(aiTab).toContain("t('aiThesisReportReview'")
  })

  it('每个模版行只有一个删除按钮，且阻止冒泡（不触发选中排版）', () => {
    expect(aiTab).toContain('ai-thesis-card-del')
    expect(aiTab).toContain('event.stopPropagation()')
    expect(aiTab).toContain('event.preventDefault()')
    // 单一删除入口：不再有第二个「只删文件」按钮
    expect(aiTab).not.toContain('aiThesisDeleteFileTip')
    const dels = aiTab.match(/setPendingDeleteId\(\(current\)|setPendingDeleteId\(row\.id|deleteTemplate\(row\.id/g) ?? []
    expect(dels).toHaveLength(1)
  })

  it('二次确认在面板内完成，不用 window.confirm（否则会收起下拉）', () => {
    expect(aiTab).not.toContain('window.confirm(')
    expect(aiTab).toContain('ai-thesis-modal-mask')
    expect(aiTab).toContain("t('aiThesisDeleteConfirmNote')")
    expect(aiTab).toContain("t('aiThesisDeleteCancel')")
    const zh = readFileSync(resolve(docsRoot, 'src/renderer/i18n/strings-ai.ts'), 'utf8')
    expect(zh).toContain('确定要删除该模板文件吗？')
  })

  it('确认后调后端删除并立刻从列表移除该行', () => {
    expect(aiTab).toContain('await window.desktop.thesisDeleteTemplate(cardId, false)')
    expect(aiTab).toContain('setCards((prev) => (prev ? prev.filter((entry) => entry.id !== cardId) : prev))')
  })

  it('弹窗宽度随视口自适应，且不裁剪内容（裁剪会把右侧删除按钮藏掉）', () => {
    const css = readFileSync(resolve(docsRoot, 'src/renderer/styles.css'), 'utf8')
    const panel = css.slice(css.indexOf('.ai-thesis-panel,'), css.indexOf('.ai-thesis-title {'))
    expect(panel).toContain('width: min(336px, calc(100vw - 24px))')
    expect(panel).toContain('max-width: 100%')
    expect(panel).toContain('box-sizing: border-box')
    // 绝不能在浮层/列表上用 overflow hidden 裁掉按钮
    expect(panel).toContain('overflow: visible')
    expect(panel).not.toContain('overflow-x: hidden')
    const cards = css.slice(css.indexOf('.ai-thesis-cards {'), css.indexOf('.ai-thesis-card {'))
    expect(cards).not.toContain('overflow-x: hidden')
    // 主区自己裁剪，长文件名不会顶飞按钮
    const main = css.slice(css.indexOf('.ai-thesis-card-main {'), css.indexOf('}', css.indexOf('.ai-thesis-card-main {')) + 1)
    expect(main).toContain('overflow: hidden')
    expect(main).toContain('min-width: 0')
  })

  it('卡片行 grid 布局：文件名列可收缩、按钮恒在右侧；删除弹窗遮罩全屏居中', () => {
    const css = readFileSync(resolve(docsRoot, 'src/renderer/styles.css'), 'utf8')
    const cardFrom = css.indexOf('.ai-thesis-card {')
    const card = css.slice(cardFrom, css.indexOf('}', cardFrom) + 1)
    expect(card).toContain('display: grid')
    expect(card).toContain('grid-template-columns: minmax(0, 1fr) auto auto')
    // 确认改为居中模态：遮罩 fixed 全屏 + 内容卡片浮在其上（不再有内联确认条）
    const maskFrom = css.indexOf('.ai-thesis-modal-mask {')
    const mask = css.slice(maskFrom, css.indexOf('}', maskFrom) + 1)
    expect(mask).toContain('position: fixed')
    expect(mask).toContain('inset: 0')
    expect(mask).toContain('align-items: center')
    expect(mask).toContain('justify-content: center')
    const modalFrom = css.indexOf('.ai-thesis-modal {')
    const modal = css.slice(modalFrom, css.indexOf('}', modalFrom) + 1)
    expect(modal).toContain('border-radius')
    // 弹窗按钮：确认键红底、两键都不收缩
    for (const sel of ['.ai-thesis-modal-cancel,', '.ai-thesis-modal-ok {']) {
      const from = css.indexOf(sel)
      expect(css.slice(from, css.indexOf('}', from) + 1)).toContain('white-space: nowrap')
    }
    // 删除按钮钉在行尾
    const delFrom = css.indexOf('.ai-thesis-card-act.ai-thesis-card-del {')
    const del = css.slice(delFrom, css.indexOf('}', delFrom) + 1)
    expect(del).toContain('grid-column: -2 / -1')
    expect(del).toContain('justify-self: end')
  })

  it('删除按钮始终渲染（不依赖是否来自资料库）', () => {
    expect(aiTab).toContain('ai-thesis-card-act is-danger ai-thesis-card-del')
    // 不包在 sourceFileEntryId 条件里
    expect(aiTab).not.toContain('{row.sourceFileEntryId ? (')
  })

  it('删除按钮不被挤压且加大点击区（flex-shrink:0 / 28px / 16px 图标）', () => {
    const css = readFileSync(resolve(docsRoot, 'src/renderer/styles.css'), 'utf8')
    const from = css.indexOf('.ai-thesis-card-act.ai-thesis-card-del {')
    const del = css.slice(from, css.indexOf('}', from) + 1)
    expect(del).toContain('flex-shrink: 0')
    expect(del).toContain('width: 28px')
    expect(del).toContain('height: 28px')
    expect(del).toContain('padding: 0 6px')
    const iconFrom = css.indexOf('.ai-thesis-card-act.ai-thesis-card-del svg {')
    const icon = css.slice(iconFrom, css.indexOf('}', iconFrom) + 1)
    expect(icon).toContain('width: 16px')
    // 行内按钮组同样不压缩
    const actFrom = css.indexOf('.ai-thesis-card-act {')
    expect(css.slice(actFrom, css.indexOf('}', actFrom) + 1)).toContain('flex-shrink: 0')
  })

  it('删除按钮与其它行内按钮同尺寸，浅灰常态 hover 转红', () => {
    const css = readFileSync(resolve(docsRoot, 'src/renderer/styles.css'), 'utf8')
    const selector = '.ai-thesis-card-act.ai-thesis-card-del {'
    const from = css.indexOf(selector)
    const block = css.slice(from, css.indexOf('}', from) + 1)
    expect(block).toContain('width: 28px')
    expect(block).toContain('color: var(--text-muted)')
    expect(block).not.toContain('position: absolute')
    // hover 变红在独立规则里
    const hoverFrom = css.indexOf('.ai-thesis-card-act.ai-thesis-card-del:hover')
    const hoverBlock = css.slice(hoverFrom, css.indexOf('}', hoverFrom) + 1)
    expect(hoverBlock).toContain('var(--danger)')
  })

  it('点删除只切换确认态，不直接删（可取消）', () => {
    expect(aiTab).toContain('setPendingDeleteId((current) => (current === row.id ? null : row.id))')
    expect(aiTab).toContain('setPendingDeleteId(null)')
  })

  it('IPC 与类型齐备：docs:thesis-delete-template + keepCard', () => {
    expect(preload).toContain("invoke('docs:thesis-delete-template', cardId, keepCard === true)")
    expect(docsMain).toContain("ipcMain.handle('docs:thesis-delete-template'")
    expect(docsMain).toContain("kind: 'delete-template'")
    expect(ipc).toContain('thesisDeleteTemplate(')
    expect(ipc).toContain('sourceFileEntryId?: string | null')
  })

  it('重名模版不直接覆盖：先弹「该论文模板已存在」，给替换/取消两个选项', () => {
    expect(aiTab).toContain('setPendingDuplicate({ name: meta.sourceName')
    expect(aiTab).toContain('ai-thesis-dup')
    expect(aiTab).toContain("t('aiThesisDuplicateTitle')")
    expect(aiTab).toContain("t('aiThesisDuplicateReplace')")
    expect(aiTab).toContain("t('aiThesisDuplicateCancel')")
    const zh = readFileSync(resolve(docsRoot, 'src/renderer/i18n/strings-ai.ts'), 'utf8')
    expect(zh).toContain('该论文模板已存在')
    expect(zh).toContain('替换原文件')
    expect(zh).toContain('取消上传')
    // 确认替换后带 overwrite 复用主进程暂存的文件，不再弹选择框
    expect(aiTab).toContain('void uploadTemplate(true)')
    // 提示框在面板内完成，不使用 window.confirm（会收起下拉）
    expect(aiTab).not.toContain('window.confirm(')
  })

  it('宿主侧同名判定：大小写/空白不敏感，替换直接解析暂存文件', () => {
    const main = readFileSync(resolve(__dirname, '../src/main/index.ts'), 'utf8')
    expect(main).toContain('pendingTemplatePick')
    expect(main).toContain("card.sourceName.trim().toLowerCase() === sourceName.trim().toLowerCase()")
    // overwrite 路径：删掉暂存后立刻解析，不再弹选择框
    expect(main).toContain('if (options?.overwrite) {')
  })

  it('点删除弹居中确认弹窗：「确认删除」+「取消」两个选项', () => {
    // 面板内模态（遮罩 + 弹窗），不再是盖在卡片上的内联确认条
    expect(aiTab).toContain('ai-thesis-modal-mask')
    expect(aiTab).toContain('ai-thesis-modal')
    expect(aiTab).toContain("t('aiThesisDeleteConfirmTitle')")
    expect(aiTab).toContain("t('aiThesisDeleteConfirmOk')")
    expect(aiTab).toContain("t('aiThesisDeleteCancel')")
    // 卡片行里不再有内联确认条
    expect(aiTab).not.toContain('ai-thesis-card-confirm')
    // 确认后仍走既有的 deleteTemplate（模板文件+卡一并删）
    expect(aiTab).toContain('void deleteTemplate(pendingDeleteId)')
    // 不使用 window.confirm（会抢焦点收起面板）
    expect(aiTab).not.toContain('window.confirm(')
    const css = readFileSync(resolve(docsRoot, 'src/renderer/styles.css'), 'utf8')
    expect(css).toContain('.ai-thesis-modal-mask {')
    expect(css).toContain('position: fixed')
    const zh = readFileSync(resolve(docsRoot, 'src/renderer/i18n/strings-ai.ts'), 'utf8')
    expect(zh).toContain('确认删除')
  })

  it('预览打开模板原文件（真渲染），不再用格式卡重建示意', () => {
    // 面板按钮走宿主预览通道
    expect(aiTab).toContain('thesisPreviewTemplate')
    expect(aiTab).toContain('void previewTemplate(row.id)')
    // 格式卡重建的示意弹窗已移除（缩略示意 ≠ 真实文档）
    expect(aiTab).not.toContain('ThesisFullPaper')
    expect(aiTab).not.toContain('ai-thesis-preview-modal')
    expect(aiTab).not.toContain('SAMPLE_TITLE')
    // 拖拽直传（无文件条目）给出明确提示而非假装打开
    expect(aiTab).toContain('aiThesisPreviewNoFile')
    // 宿主侧：无文件条目返回 no_file，有则用 openOriginal 打开
    const main = readFileSync(resolve(__dirname, '../src/main/index.ts'), 'utf8')
    expect(main).toMatch(/opened: false, reason: .no_file./)
    // 预览/上传都按「工作区」分派（Room 维度已下线）
    expect(main).toContain('previewTemplate: async (workspaceId, cardId) =>')
    // 上传（选择框/拖拽）都先导入资料区再解析：卡片持有真实文件条目，
    // 预览能打开原文件、删除能级联、重复导入按内容去重
    expect(main).toContain('importTemplateFileIntoLibrary')
    expect(main).toContain('importTemplateBytesIntoLibrary')
    expect(main).toContain('importPathsOnce')
    expect(main).toContain("parseFromDisk(workspaceId, filePath, fileEntryId)")
    expect(main).toContain('parseFromBytes(workspaceId, name, data, fileEntryId)')
    // 老卡片自愈：资料区唯一同名文件直接打开
    expect(main).toContain('findLibraryFileByName')
    // 关键回归：预览必须真的打开实例（曾经只挂了个空 opener 钩子 → 点了没反应）
    expect(main).toContain('openFileInAppPreview(filesGatewayBridge, fileId, originalName')
    expect(main).not.toContain('openHostFile')
    // 从 docs 面板打开时把主窗口提到前台，否则用户看不到预览标签
    expect(main).toContain('focusWindow: true')
    expect(main).toContain('window.focus()')
    // 注册表分派直接把参数交给桥，不再经回调
    const registry = readFileSync(resolve(__dirname, '../src/main/office/office-preview-registry.ts'), 'utf8')
    expect(registry).toContain('bridge.previewTemplate(workspaceId, action.cardId)')
  })

  it('排版走任务化：提交作业 + 轮询进度 + 20 分钟硬超时', () => {
    expect(aiTab).toContain('thesisReformatJob')
    expect(aiTab).toContain('thesisReformatJobStatus')
    // 20 分钟硬上限：映射 + AI 补写两段代理叠加常超 10 分钟，短上限会在产物
    // 已生成时先报「超时」（genoffice 2f2f820 起）。
    expect(aiTab).toContain('TIMEOUT_MS = 20 * 60 * 1000')
    expect(aiTab).toContain('aiThesisTimeout')
    expect(aiTab).toContain('ai-thesis-progress')
    // 阶段文案
    expect(aiTab).toContain("t('aiThesisPhaseParsing')")
    expect(aiTab).toContain("t('aiThesisPhaseMapping')")
    expect(aiTab).toContain("t('aiThesisPhaseRendering')")
    const zh = readFileSync(resolve(docsRoot, 'src/renderer/i18n/strings-ai.ts'), 'utf8')
    expect(zh).toContain('处理超时（已等 20 分钟）')
    // 不再使用同步长请求路径
    expect(aiTab).not.toContain('await window.desktop.thesisReformat(cardId)')
  })

  it('两种模式已移除：点卡片直接排版，不再让用户选严格/融合', () => {
    expect(aiTab).not.toContain("useState<'strict' | 'blend'>")
    expect(aiTab).not.toContain('aiThesisModeStrict')
    expect(aiTab).not.toContain('aiThesisModeBlend')
    expect(aiTab).not.toContain('name="ai-thesis-mode"')
    // 点击即排版：不带 mode 参数
    expect(aiTab).toContain('reformatWith(row.id)')
    expect(aiTab).not.toContain('reformatWith(row.id, { mode })')
    expect(aiTab).toContain('reformatWith(meta.cardId)'); // 上传后自动排版
  })

  it('排版完成自动打开成品，并刷新资料库', () => {
    const main = readFileSync(resolve(__dirname, '../src/main/index.ts'), 'utf8')
    // 成品落库 → 打开成品标签（与模版预览同一条预览管线）。
    expect(main).toContain('setThesisProductHook')
    expect(main).toContain('openFileInAppPreview(bridge, product.fileEntryId, product.originalName')
    const bridge = readFileSync(resolve(__dirname, '../src/main/gateway/office-bridge.ts'), 'utf8')
    expect(bridge).toContain('this.notifyThesisProduct({')
    // 资料库消费主进程的 office:agent-file 事件：成品出现后列表自动重拉。
    const library = readFileSync(resolve(__dirname, '../src/renderer/src/workbench/workspace/useFileLibrary.ts'), 'utf8')
    expect(library).toContain('office.onAgentFile')
    expect(library).toContain("event.type !== 'done'")
  })

  it('删除结果如实反馈：文件没删掉要提示而不是假装成功', () => {
    expect(aiTab).toContain("setError(t('aiThesisDeleteFileFailed'))")
  })
})

/**
 * 点 👁 之后预览必须真的出现在用户眼前。
 *
 * 回归的坑：实例在主进程建好了，但可见性由渲染端驱动（开标签 → 上报矩形 →
 * setActiveInstance）。docs 面板发起的打开不经过渲染端的 openOriginal，
 * 少一条通知，WebContentsView 就一直是 setVisible(false) —— 用户看到的是
 * 「点预览完全没反应」，而不是报错，最难查。
 */
describe('预览可见性：主进程建好实例后必须通知渲染端', () => {
  const main = readFileSync(resolve(__dirname, '../src/main/index.ts'), 'utf8')
  const workbench = readFileSync(resolve(__dirname, '../src/renderer/src/workbench/shell/Workbench.tsx'), 'utf8')
  const preload = readFileSync(resolve(__dirname, '../src/preload/index.ts'), 'utf8')

  it('排版面板预览打开成功后补发通知（否则视图永远隐藏）', () => {
    expect(main).toContain('previewRequestFromOpenResult')
    expect(main).toContain('notifyPreviewRequested')
    const block = main.slice(main.indexOf('previewTemplate: async (workspaceId, cardId)'))
    expect(block.slice(0, block.indexOf('if (card.sourceFileEntryId)'))).toContain('notifyPreviewRequested(request)')
  })

  it('渲染端收到通知就开文件标签并激活（矩形上报沿用文件编辑视口）', () => {
    expect(workbench).toContain('office.onPreviewRequest(')
    expect(workbench).toContain('openFileTab(entry.file)')
  })

  it('preload 暴露 onPreviewRequest，通道名两端一致', () => {
    expect(preload).toContain('onPreviewRequest:')
    expect(preload).toContain('OFFICE_PREVIEW_REQUEST_CHANNEL')
    const sources = readFileSync(resolve(__dirname, '../src/shared/sources.ts'), 'utf8')
    expect(sources).toContain("export const OFFICE_PREVIEW_REQUEST_CHANNEL = 'office:preview-request'")
    expect(sources).toContain('onPreviewRequest(listener: (request: OfficePreviewRequest) => void): () => void')
  })
})

/**
 * 作业失败也必须是人话。
 *
 * 回归的坑：作业失败是「轮询成功、状态为 failed」，走不到宿主钩子的 catch，
 * describeThesisError 根本没机会跑——用户看到的是 thesis_source_not_docx 这种机器码。
 */
describe('排版作业失败：错误在返回面板前翻译成人话', () => {
  it('reformat-job-status 对 failed 快照套 describeThesisError', () => {
    const registry = readFileSync(resolve(__dirname, '../src/main/office/office-preview-registry.ts'), 'utf8')
    const block = registry.slice(registry.indexOf("case 'reformat-job-status'"))
    expect(block.slice(0, block.indexOf("case 'preview-template'"))).toContain('describeThesisError(snapshot.error)')
  })

  it('提交作业失败时保留服务端原因（不吞成裸状态码）', () => {
    const bridge = readFileSync(resolve(__dirname, '../src/main/gateway/thesis-format-gateway-bridge.ts'), 'utf8')
    const block = bridge.slice(bridge.indexOf('async startReformatJob'))
    expect(block.slice(0, block.indexOf('/** 查作业状态'))).toContain('body.error')
  })
})
