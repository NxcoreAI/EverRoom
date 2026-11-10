# 布局 + 审页合并为 Page Designer：设计评估

## 现状

- `slides-layouter`：只看单页内容与风格 token，产出 v2 树；看不到渲染结果。
- 网关：编译、落页、截图。
- `slides-reviewer`：看截图 + 当前树，决定 ok/revised；需要 `manualToken` 取回页面内容。
- 两个 agent、两套 prompt/skill；审页知道“哪里丑”，但不知道 layouter 当时为什么这样排；layouter 也不知道最终渲染问题。

## 建议：合并为 per-page `slides-page-designer`

不是把两个角色塞进一次 LLM 调用，而是**一个 agent、两个 phase、网关在两 phase 之间落页截图**：

1. `phase: "layout"`
   - 输入：单页 copy/composition/styleTokens/neighbors（不含整册历史）。
   - 输出：v2 树。
2. 网关：compile → measure → 落页 → 截图。
3. `phase: "review"`
   - 输入：**同一份页面 dossier** + currentTree + 截图 + 确定性 defects。
   - 输出：`ok` 或 revised tree。
4. 网关：重落页；最多 1 次 revise。

### 为什么这样合并

- 审页拿到 layouter 的 intent/composition，不再靠 `manualToken` 反查；
- 两个 phase 共用一套 design system/skill，减少 prompt 漂移；
- 每页上下文独立：一页 copy + 一棵树 + 一张截图，不把 20 页历史塞进一个 context；
- 可以去掉 reviewer 的 manual token 和跨 agent 的上下文重建。

### 不建议：一次调用里“边画边看”

要在一个 invocation 内看到截图，agent 必须调用一个会**写入当前 deck** 的 preview 工具；并发页面下会互相踩，且失败回滚复杂。两 phase 仍是更稳的工程边界。

## 上下文管理

- 严格单页：`pageIndex/totalPages` + 当前页 copy；不传整册 pages。
- layout phase 不传截图；review phase 只传 1 张截图（JPEG 压缩）。
- review phase 不传 layouter 的全部 validate 历史，只传 currentTree + 最近 defects + 1~2 条修改约束。
- 每 phase 独立 maxToolCalls/timeout；review 只允许 `slides_layout_validate` 与提交。
- 页面间无共享 memory；风格统一靠 styleTokens，不靠聊天历史。

## 风险

- 一个 agent 同时承担“设计”和“审稿”，prompt 更长；用 phase 分支隔离，不混在一条工作流。
- 审页需要多模态；复用现有 reviewer 的截图通道即可。
- 失败回退：review phase 失败保留 layout 结果，不阻塞整册。

## 已落地（2026-10-19）：v2 单调用预览

没有走“两 phase 两次调用”，而是按“必须一次调用”落成**只读沙箱预览工具**：

- `slides_page_preview` 是 layouter 的第二个工具：输入 deckToken/pageIndex/当前树；
- 工具内：normalize → compile → measure → `bridge.renderPptx` 临时单页 → `pptxToPng` → VLM `reviewDesign`；
- 返回 **文本**：确定性 defects + 设计审阅 issues（weak_hierarchy / flat_background / no_visual_anchor / text_wall / misalignment / low_contrast / cramped / empty_space）；
- 预览不写当前 deck，多页并发安全；没有页级回滚问题；
- 调用过预览的页在 `page-preview-context` 标记 `previewed`，最终 reviewer 阶段跳过；未预览/渲染失败/被兜底/被重排的页仍走 reviewer 兜底；
- layouter prompt 要求 validate 通过后必须预览一次，最多两次，有 major 问题先改树再提交。

这版的“合并”是**工具级 review + 单 invocation**，不是两个 agent 串联。

## 落地顺序

1. 新建 `agents/slides-page-designer`（layout/review 两 phase，共用 v2 skill）。
2. `slides-layout-tail` 的 v2 路径先双跑：新 designer 与旧 layouter+reviewer 对比 warnings/兜底率。
3. 数据稳定后 v2 默认走 designer；v1/legacy 保留旧链路。
4. 删除 reviewer 的 manual token 取页逻辑（仅 v2 路径）。
