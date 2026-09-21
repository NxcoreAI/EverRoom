/** 转写总结相关测试共用的样本数据：带时间戳标记的逐字稿与一份正规总结。 */

export function transcriptLine(seconds: number, speaker: string, text: string): string {
  const timestamp = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
  return `[${timestamp}] ${speaker}：${text}`
}

export function buildTranscript(turns = 25): string {
  return Array.from({ length: turns }, (_, index) =>
    transcriptLine(index * 30, `发言人 ${(index % 3) + 1}`, `第${index + 1}条发言：我们讨论了项目${index + 1}的进度，确认下周三之前交付评审意见，主要风险是数据源延迟。`),
  ).join('\n')
}

/** 重新组织的正规总结：不含逐字稿的连续原文片段，长度满足 300-1500 字档门槛（overview≥180）。 */
export const LEGIT_SUMMARY = '本次为项目周会，三位与会人依次同步了各自项目的进展。多数条线按计划推进，评审意见统一约定在下周三前交付。主要风险集中在数据源延迟，会上决定由数据侧先给出缓冲方案，并请各负责人会后再次确认时间点。会议还回顾了上一轮遗留问题的处理情况，确认阻塞已基本清零，各条线明确了下一步的验证方式与参与人员。整体结论是进度可控，后续重点跟进攻期与数据依赖两项，下次会议复核结果。'
