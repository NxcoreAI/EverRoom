/**
 * 模版图片与封面文字的确定性回填：字节一律从 OOXML 事实写入卡片，
 * 不经解析代理（让模型回显 base64 既烧预算又容易抄错）。
 */
import type { ThesisFormatCard, ThesisTemplateFacts } from "./types.js";

const DEFAULT_DEGREE_LINE = "本科毕业论文（设计）";

export function mergeTemplateImages(card: ThesisFormatCard, facts: ThesisTemplateFacts): ThesisFormatCard {
  const members = facts.ooxml ?? [];
  const headerImages = members.map((member) => member.headers ?? []).flat()
    .map((header) => header.images ?? []).find((images) => images.length > 0) ?? [];
  const coverImage = members.map((member) => member.coverImages ?? []).flat()[0];

  const next: ThesisFormatCard = { ...card, cover: { ...card.cover } };
  // 封面文字兜底：模版封面区文本就摆在 facts 里，但解析代理可能整段留空、让校验层
  // 填 schema 默认值（卡外观完整、内容却不是模版的）。这里用确定性规则补最机械的几项，
  // 只填空缺、绝不覆盖代理给出的非空值。
  const lines = members.flatMap((member) => member.coverText ?? []).map((line) => line.trim()).filter(Boolean);
  if (lines.length > 0) {
    if (!next.cover.schoolName) {
      const school = lines
        .filter((line) => /(学院|大学|学校|研究院|职业技术学院)$/.test(line) && line.length <= 24)
        .sort((a, b) => b.length - a.length)[0];
      if (school) next.cover.schoolName = school;
    }
    if (!next.cover.degreeLine || next.cover.degreeLine === DEFAULT_DEGREE_LINE) {
      const degree = lines.find((line) => /(课程考核报告|毕业设计|毕业论文|实践报告|课程设计报告|设计报告|研究报告)$/.test(line) && line.length <= 30);
      if (degree && degree !== next.cover.degreeLine) next.cover.degreeLine = degree;
    }
    if (!next.cover.yearLine) {
      const year = lines.find((line) => /20\d{2}\s*[-–—~至]\s*20\d{2}\s*学年/.test(line) || /^(二[〇零]|20\d{2})\S*年\S*学期/.test(line));
      if (year) next.cover.yearLine = year;
    }
    if (!next.cover.footerLine) {
      const footer = lines.find((line) => /制$/.test(line) && line.length <= 24);
      if (footer) next.cover.footerLine = footer;
    }
  }
  if ((next.header.images ?? []).length === 0 && headerImages.length > 0) {
    next.header = { ...next.header, images: headerImages.slice(0, 6) };
  }
  if (!next.cover.logo && coverImage) {
    next.cover = { ...next.cover, logo: coverImage };
  }
  return next;
}
