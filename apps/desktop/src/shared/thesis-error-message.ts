/**
 * 论文排版（AI 页签「排版」面板 / 资料区「设为模版」）失败的**用户可读**翻译。
 *
 * 背景：这条链路内部到处是机器码（thesis_format_card_not_found）与上游原样报错
 * （nginx 502 HTML、模型输出上限长句）。面板与 toast 直接把它们甩给用户，用户看到
 * 的是一串莫名其妙的东西——「点了排版，它没反应」的观感主要来自这里。
 *
 * 只做文案翻译，不改判定：调用方仍按 ok/reason 决定流程。
 */

/** 上游中转/网络类瞬时故障（重试通常能过）。 */
const TRANSIENT_UPSTREAM = /(502|503|504|bad gateway|gateway time-?out|service unavailable|econnreset|etimedout|econnaborted|socket hang up|fetch failed|network error|temporarily unavailable)/i;
/** 模型账号额度耗尽。 */
const QUOTA_EXHAUSTED = /(insufficient_user_quota|insufficient quota|exceeded your current quota|预扣费额度失败|额度不足|余额不足|积分已用完)/i;

const MAX_MESSAGE_CHARS = 300;

/** 去掉上游 HTML 报错里的标签与多余空白，避免把整页 nginx 页面显示给用户。 */
function plainText(message: string): string {
  return message
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 把内部错误码/上游报错翻成一句用户能懂的话。
 * 未知错误保留原文（截断），不吞信息。
 */
export function describeThesisError(message: string | null | undefined): string {
  const raw = typeof message === 'string' ? message.trim() : '';
  if (!raw) return '排版失败：没有收到具体原因，请重试。';

  // 顺序敏感：上游故障/额度判定要在错误码匹配之前，因为上游报错可能夹带任意文本。
  if (QUOTA_EXHAUSTED.test(raw)) {
    return 'AI 模型额度不足：请到「设置 → AI 模型」检查账号余额后重试。';
  }
  if (TRANSIENT_UPSTREAM.test(raw)) {
    return 'AI 模型服务暂时不可用或响应超时。模版解析是长任务（约 1–5 分钟），请稍后重试；刚失败的那次没有产生格式卡。';
  }
  if (/模型输出上限/.test(raw)) {
    return '这份模版的解析结果超出模型单次输出上限（规范条文越多越容易超）。请重试，或改用条文更集中的模版文件。';
  }

  switch (raw) {
    case 'thesis_format_card_not_found':
      return '这个工作区还没有可用的论文格式卡。请先点「上传论文模版」（或到资料库把 Word 设为排版模版）并等解析完成（约 1–5 分钟）再排版；模版和要排版的文档必须在同一个工作区。';
    case 'thesis_template_not_in_workspace':
      return '这份模版不在当前工作区：请把模版上传到该工作区的资料库（或用排版面板里的上传入口），再设为排版模版。';
    case 'thesis_template_file_not_found':
      return '资料库里这份模版文件已不存在（可能被删除）：请重新上传一次。';
    case 'thesis_template_file_not_readable':
      return '读不到这份模版文件的内容：请确认它还在资料库里、且不是空文件。';
    case 'thesis_bridge_unavailable':
      return '排版引擎未就绪，请重启应用后重试。';
    case 'thesis_source_not_docx':
      return '只有 .docx 文档能使用论文排版；旧 .doc 请先用 Word 另存为 .docx。';
    case 'thesis_source_not_readable':
    case 'thesis_source_file_not_found':
      return '读不到这份文档的文件内容：请确认它还在资料区、且已被保存。';
    case 'thesis_source_outline_empty':
      return '这份文档没解析出正文内容：请确认它不是空文档。';
    case 'thesis_format_card_missing':
      return '模版解析没有产出格式卡（模型可能没按格式返回）。请重试上传。';
    case 'thesis_template_no_readable_member':
      return '模版文件里没有可读取的内容：请上传 .docx/.doc/.pdf，或包含它们的 zip。';
    case 'thesis_source_not_docx_or_pdf':
      return '模版格式不支持：请上传 .docx、.doc、.pdf 或 zip。';
  }
  if (raw.startsWith('thesis_template_unpack_failed')) {
    return '模版压缩包打不开（可能已损坏或不是 zip）：请重新上传 .docx/.doc/.pdf。';
  }
  if (raw.startsWith('thesis_template_normalize_failed')) {
    return '模版转换失败（旧 .doc 或加密文件常见）：请用 Word 另存为 .docx 后重试。';
  }
  if (raw.startsWith('thesis_template_facts_extract_failed') || raw.startsWith('thesis_template_text_extract_failed')) {
    return '模版版式读取失败（文件可能已损坏或加密）。请重新导出 .docx 后上传。';
  }
  if (raw.startsWith('thesis_formatter_failed') || raw.startsWith('thesis_binding_')) {
    return '解析代理执行失败，请重试。';
  }
  if (raw.startsWith('论文模版解析失败')) return raw;

  const text = plainText(raw).slice(0, MAX_MESSAGE_CHARS);
  return text ? `排版失败：${text}` : '排版失败：没有收到具体原因，请重试。';
}

/** 面板/toast 用：是否是「还没模版」这类可自解的状态（文案已含引导）。 */
export function isThesisCardMissing(message: string | null | undefined): boolean {
  return typeof message === 'string' && message.includes('thesis_format_card_not_found');
}