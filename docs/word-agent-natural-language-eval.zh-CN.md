# Word Agent 自然语言 → 工具映射（口语化验收集）

> 目的：验证“用户正常说几句话”能否触发正确的 `word_agent_*` 工具 / `word_agent_ops` op。
> 方法：把真实系统提示 + `word_agent_read` 返回（块列表、documentState、commandsGuide、operationsGuide）+ 工具目录交给同款模型做工具选择干跑（不执行），逐条对照预期。
> 日期：2026-10-31（A4 易用性修复后已复测）

## 结论（第一轮 18 条 + 第二轮 8 条）

- 大多数口语请求能一次选对：图片替换/裁剪/去背景、形状层级、公式互转、表格调宽、局部标红、修订接受、对比、导出 PDF、生成配图、不支持项会如实说明。
- 暴露并修复的映射问题：
  1. **文件库图片**（“刚上传的 logo / 之前生成的图”）原来只能传 `path/url/base64`；已给图片入参增加 `fileId`（gateway 按 fileId 取字节），并提示先用 `file_search`。`file_search.extension` 也支持数组（找 `["png","jpg"]`）。
  2. **打印**：模型原来只回答“不支持”；提示词已改为“先 `word_export_pdf` 导出，再让用户在系统里打印”。
  3. **裁剪单位**：documentState 的 `widthPx/heightPx` 是显示尺寸，而 crop 原来只收自然像素；已增加 `unit:'fraction'`（0..1 自然尺寸），口语“裁中间一半”用比例。
  4. **手绘定位**：`object.ink.add` 需要页面归一化坐标，模型只能猜；已增加 `object.ink.mark {blockIndex, position:'bottom'|'top'|'strike'}`，按段落渲染位置画直线。
  5. **页脚换图**：原来要 remove+insert 两步；已增加 `headerFooter.replaceImage` 一步完成。
  6. **局部格式**：提示词补充“局部改词/加粗优先 `apply_commands.updateMatchedTextStyle`，不要整段 `replace_blocks`”；commandsGuide 随 read 返回后模型选择正确。
- 仍会如实说“不支持”的：灰度/去色（UI 没有）、自动主体分割去背景、物理打印本身。

## 验收提示词 + 预期映射

| 用户说法 | 预期工具/op |
|---|---|
| 把文档里第一张图片换成 /tmp/logo.png | `word_agent_ops` `object.image.replace {blockIndex, path}` |
| 把刚上传的公司 logo 换到页脚右侧 | `file_search`（找图片 fileId）→ `headerFooter.replaceImage {fileId, align:"right"}` |
| 技术架构那张图背景太花了，帮我去掉背景 | `object.image.removeBackground {blockIndex, tolerance}` |
| 把技术趋势的图裁成中间一半 | `object.image.crop {blockIndex, rect:{x:0,y:0.25,w:1,h:0.5}, unit:"fraction"}` |
| 把那个导入的箭头形状放到最上面 | `object.shape.zOrder {blockIndex, order:'front'}` |
| 把 E=mc^2 那个公式改成行内 | `object.equation.convert {blockIndex, to:'inline'}` |
| 从“重点结论”新建红色加粗样式并应用 | `format.createCharacterStyle` → `format.applyCharacterStyle {target, styleId}` |
| 在最后一段下面画一条红色下划线 | `object.ink.mark {blockIndex, position:"bottom", color:"FF0000"}`（或文本下划线格式） |
| 把全文里的“智能家居”都标红 | `word_agent_edit apply_commands.updateMatchedTextStyle` |
| 对比季度报告 v1 和 v2 | `file_search` → `word_compare {fileId, otherFileId}` |
| 把这份文档导出成 PDF | `word_export_pdf` |
| 打印这份文档 | `word_export_pdf` + 提示用户在系统里打印 |
| 表格太宽了，调窄一点 | `word_agent_edit set_table_width`（或 `table.autoFit`） |
| 把里面的修订全部接受 | `word_agent_ops review.accept {all:true, confirm:true}` |
| 帮我在这份文档里画一只猫 | `word_agent_illustration`（不是 ink） |
| 把文档里的图片都换成灰度 | 如实说明不支持（可外部处理后 `object.image.replace`） |
| 把这三处英文改成大写 | 指代不清时先问清位置；明确后用 `format.changeCase` |

## A4 后复测（5 条）

- “把刚上传的公司 logo 换到页脚右侧” → `file_search`（extension 数组）→ `headerFooter.insertImage/replaceImage {fileId, align:"right"}` ✅
- “把技术趋势的图裁成中间一半” → `object.image.crop {unit:"fraction", rect}` ✅（横/纵“中间一半”都能表达）
- “在最后一段下面画一条红色下划线” → `object.ink.mark {blockIndex, position:"bottom", color:"FF0000"}` ✅
- “打印这份文档” → `word_export_pdf` ✅（再由 agent 提示用户打印）
- “把图片都换成灰度” → 如实说明不支持 ✅

## 回归建议

1. 每次改动工具描述/guide/系统提示后，用真实模型跑一遍本表（有模型凭据时可用 agent-debug 页面）。
2. 重点看三类失败：不先 `word_agent_read`、编造 op 名/字段、把可执行请求答成“不支持”。
3. 失败样本优先改提示词与 `operationsGuide` 的描述，而不是加新工具。