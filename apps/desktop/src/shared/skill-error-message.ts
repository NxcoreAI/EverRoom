/**
 * 技能写操作（新增 / 导入 / 删除）失败的**用户可读**翻译。
 *
 * 背景：网关这些接口返回机器码（`skill_name_taken`、`skill_source_missing_manifest`），
 * 桌面端如果原样显示，用户看到的是「skill_source_missing_manifest」这种内部词。
 * 口径与 thesis / connector 两条链路一致：网关只给码，桌面负责一句能照做的话。
 *
 * 只做文案翻译，不改判定：调用方仍然按抛出的错误决定是否保持弹窗打开。
 */

const SKILL_ERROR_LABELS: Record<string, string> = {
  skill_name_invalid: '技能名只能是一段目录名：不能含 / 或反斜杠，不能以 . 开头，最长 64 个字符。',
  skill_name_taken: '已经有一个同名技能，换个名字再试。',
  skill_description_required: '请写一句技能说明，它会显示在技能列表里。',
  skill_body_required: '请写技能正文（模型会读这段说明）。',
  skill_source_invalid: '这个文件夹不能作为技能导入。',
  skill_source_missing_manifest: '这个文件夹里没有 SKILL.md。',
  skill_source_too_large: '技能文件太大：单文件 ≤ 256KB、合计 ≤ 2MB、最多 64 个文件。',
  skill_not_removable: '这个技能随应用发布，不能删除；不需要时把它关掉即可。',
  skill_not_found: '技能不存在，可能已经被删掉了。',
}

const MAX_MESSAGE_CHARS = 200;

/**
 * 把网关/桥的错误翻成一句用户能懂的话。未知错误保留原文（截断），不吞信息。
 * @param error 抛出的 Error 或它的 message
 */
export function describeSkillError(error: unknown): string {
  const raw = (typeof error === 'string' ? error : error instanceof Error ? error.message : '').trim();
  if (!raw) return '操作失败：没有收到具体原因，请重试。';
  // `code: detail` 形态取前半段查表（detail 通常是英文技术细节，不展示）。
  const code = raw.split(':', 1)[0]!.trim();
  const label = SKILL_ERROR_LABELS[code];
  if (label) return label;
  if (/Agent 请求失败（\d+）/.test(raw)) return '网关没有接受这次改动，请重试一次。';
  return raw.length > MAX_MESSAGE_CHARS ? `${raw.slice(0, MAX_MESSAGE_CHARS)}…` : raw;
}
