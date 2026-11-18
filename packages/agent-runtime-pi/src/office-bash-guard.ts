/**
 * Office 文件的 bash 护栏。
 *
 * 实测：一个「把第 2 页某句话改 6 个字」的小任务，模型连发 120 条各不相同的 bash
 * （python heredoc 解压 .pptx、改 ppt/slides/*.xml、再打包回去），一条没成，
 * 最后撞上工具调用上限。提示词里已经写明"不要用 bash 改 .pptx"，但模型不看。
 *
 * 所以在 bash 工具入口直接拦：只要命令同时命中「Office 文件 / OOXML 内部路径」
 * 与「写入类动作」，就拒绝并告诉它该用哪个工具。只读命令（ls / file / grep -l）放行。
 */

const OFFICE_TARGET = /\.(pptx|pptm|docx|docm|xlsx|xlsm)\b|ppt\/slides|ppt\/presentation|word\/document|xl\/worksheets/i

/** 会改写文件或重建包体的动作。 */
const MUTATING_ACTION = /\b(unzip|zip|7z|tar|mv|cp|rm|truncate|dd|sed|perl|tee|install)\b|>\s*\S|python[0-9.]*\s|node\s|ruby\s/

/** 各类型对应的正确工具，用于报错文案。 */
function suggestedTools(command: string): string {
  if (/\.(pptx|pptm)\b|ppt\/(slides|presentation)/i.test(command)) {
    return "PPT 用 slides_read 读大纲、slides_edit 改内容（或 slides_draft 交给排版子代理）";
  }
  if (/\.(docx|docm)\b|word\/document/i.test(command)) {
    return "Word 用 word_agent_read 拿块索引、word_agent_edit / word_agent_ops 改";
  }
  return "Excel 用 sheets_agent_read / sheets_agent_edit 改";
}

/**
 * 命中则返回给模型看的拒绝原因；放行返回 null。
 */
export function officeBashViolation(command: string): string | null {
  const trimmed = command.trim()
  if (!trimmed) return null
  if (!OFFICE_TARGET.test(trimmed)) return null
  if (!MUTATING_ACTION.test(trimmed)) return null
  return (
    "这条命令被拦截：不要用 bash 解压或改写 Office 文件。"
    + ".pptx / .docx / .xlsx 是 OOXML 压缩包，手改其中的 XML 会损坏文件、丢失样式与关系，"
    + "而且改完编辑器不会知道内容变了。"
    + `${suggestedTools(trimmed)}。`
    + "需要看图或核对版式可以用 bash 只读查看（ls / file / grep -l），但内容修改必须走上面的工具。"
  )
}
