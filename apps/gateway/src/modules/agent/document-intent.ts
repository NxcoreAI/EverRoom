/**
 * 文档写作意图的确定性启发式（中英双语，含否定式与咨询式排除）。
 *
 * 消费方：
 * - `ambiguousDocumentTopic`（service.ts）：无 Room 上下文时的澄清卡片预检。
 * - intent 复检（service.ts 运行时执行上下文）。
 * （写作风格生成注入的信号③消费方已随 writing-style-gate.ts 退役，
 * 见 docs/doc-writer-subagent-plan.zh-CN.md §7。）
 *
 * 注意：只判定“这句话是否在要 Agent 写/建文档”，不判定 Room 归属。
 */
export function requestsWorkspaceDocument(prompt: string): boolean {
  const text = prompt.trim();
  if (!text) return false;
  if (/(?:创建|新建|建立)(?:一个|一间)(?:(?!保存到|存入|写入).){0,32}(?:context\s*room|Room|房间)|\b(?:create|make|build)\s+(?:a|an|the)\s+(?:new\s+)?(?:context\s+)?room\b/iu.test(text)) {
    return false;
  }
  if (/(?:不要|别|无需|不需要|不想|禁止|不是要|并非要).{0,10}(?:创建|新建|生成|写入|保存|落盘|存入|写|撰写).{0,32}(?:文档|文件)/iu.test(text)) {
    return false;
  }
  if (/(?:如何|怎么|怎样|为什么|介绍|解释|说明).{0,12}(?:创建|新建|生成|写入|保存|撰写).{0,24}(?:文档|文件)/iu.test(text)) {
    return false;
  }
  if (/\b(?:do not|don't|dont|no need to|not asking (?:you )?to|should not|shouldn't)\b.{0,24}\b(?:create|draft|write|generate|compose|prepare|save)\b.{0,64}\b(?:doc(?:ument)?|file)s?\b/iu.test(text)) {
    return false;
  }
  if (/\b(?:how (?:do|can|should|would)|why|explain|describe)\b.{0,24}\b(?:create|draft|write|generate|compose|prepare|save)\b.{0,64}\b(?:doc(?:ument)?|file)s?\b/iu.test(text)) {
    return false;
  }
  return /(?:创建|新建|生成|写入|保存|落盘|存入|写|撰写).{0,32}(?:文档|文件)/iu.test(text)
    || /(?:文档|文件).{0,20}(?:创建|新建|写入|保存|落盘)/iu.test(text)
    || /(?:我要|我想要|给我|帮我做).{0,24}(?:文档|文件)/iu.test(text)
    || /(?:保存|写入|落盘|存入).{0,20}(?:文档|Room|房间)/iu.test(text)
    || /\b(?:create|draft|write|generate|compose|prepare|save)\b.{0,64}\b(?:doc(?:ument)?|file)s?\b/iu.test(text);
}

const DOCUMENT_MODIFICATION_VERB = "(?:修改|编辑|改动|润色|改写|重写|续写|扩写|补写|更新|完善|精简|缩短|删掉|删除|改一改|改一下|改改|改)";
const DOCUMENT_TARGET = "(?:文档|文件|文章|这篇|那份|这篇文章|这篇文档)";

/**
 * 判定“这句话是否在要 Agent 修改/续写已有文档”。与 requestsWorkspaceDocument
 * 同口径的否定式与咨询式排除；刻意不含纯创建/写入意图——选择卡片只服务
 * “改哪一篇”的歧义，创建类歧义由 ambiguousDocumentTopic 预检承担。
 *
 * 消费方：documents/pi-tools.ts——context_room_document_list 仅在此为真时才向
 * 桌面端声明 selectionRequired，避免无文档诉求的运行误弹“选择要编辑的文档”卡片。
 */
export function requestsDocumentModification(prompt: string): boolean {
  const text = prompt.trim();
  if (!text) return false;
  if (new RegExp(`(?:不要|别|无需|不需要|不想|禁止|不是要|并非要).{0,10}${DOCUMENT_MODIFICATION_VERB}.{0,32}${DOCUMENT_TARGET}`, "iu").test(text)) return false;
  if (new RegExp(`(?:如何|怎么|怎样|为什么|介绍|解释|说明).{0,12}${DOCUMENT_MODIFICATION_VERB}.{0,24}${DOCUMENT_TARGET}`, "iu").test(text)) return false;
  if (/\b(?:do not|don't|dont|no need to|not asking (?:you )?to|should not|shouldn't)\b.{0,24}\b(?:edit|update|revise|rewrite|extend|modify|polish|proofread)\b.{0,64}\b(?:doc(?:ument)?|file|article)s?\b/iu.test(text)) return false;
  if (/\b(?:how (?:do|can|should|would)|why|explain|describe)\b.{0,24}\b(?:edit|update|revise|rewrite|extend|modify|polish|proofread)\b.{0,64}\b(?:doc(?:ument)?|file|article)s?\b/iu.test(text)) return false;
  return new RegExp(`${DOCUMENT_MODIFICATION_VERB}.{0,32}${DOCUMENT_TARGET}`, "iu").test(text)
    || new RegExp(`${DOCUMENT_TARGET}.{0,20}${DOCUMENT_MODIFICATION_VERB}`, "iu").test(text)
    || /\b(?:edit|update|revise|rewrite|extend|modify|polish|proofread)\b.{0,64}\b(?:doc(?:ument)?|file|article|it)\b/iu.test(text);
}
