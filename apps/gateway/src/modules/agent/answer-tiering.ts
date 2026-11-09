/**
 * Agent 最终答复的分级协议（L0/L1 摘要 + L2 详情）。
 *
 * 模型侧协议见 agents/main/SYSTEM.md「输出格式」：正文之后可另起一行写
 * `[[details]]`，标记行之上是默认展示的结论层（L0+L1），之下是大段细节
 * （结构清单、来源口径、核对过程等 L2）。网关在 message.completed 落库时
 * 解析：display_content 只存标记前的部分，content 存去掉标记行的全文——
 * 前端默认渲染 displayContent，差值部分折叠为"详情"；旧客户端/无标记的
 * 消息 displayContent 为 null，气泡回退 content，行为与之前完全一致。
 */

/** 标记行：允许前后有空白，行内不再允许其他字符。 */
const DETAILS_MARKER = /^\s*\[\[details\]\]\s*$/

export interface SplitAgentAnswer {
  /** 默认展示正文（标记行之前的部分，去掉首尾空白）。 */
  displayContent: string
  /** 完整答复（去掉标记行本身；标记前后的其余内容顺序保留）。 */
  content: string
  /** 是否命中标记。false 时 displayContent 与 content 相同（调用方无需落 display）。 */
  hasDetails: boolean
}

export function splitAgentAnswer(raw: string): SplitAgentAnswer {
  const text = typeof raw === "string" ? raw : ""
  const lines = text.split("\n")
  const markerIndex = lines.findIndex((line) => DETAILS_MARKER.test(line))
  if (markerIndex === -1) {
    return { displayContent: text.trim(), content: text, hasDetails: false }
  }
  const before = lines.slice(0, markerIndex).join("\n").trim()
  const after = lines.slice(markerIndex + 1).join("\n").replace(/^\n+/, "").trimEnd()
  // content 保留全文（去掉标记行），详情与正文之间留一个空行，阅读/复制时仍是完整答复。
  const content = after ? `${before}\n\n${after}` : before
  return { displayContent: before, content, hasDetails: true }
}
