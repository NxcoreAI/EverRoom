/**
 * SKILL.md 的最小解析：只认 YAML frontmatter 里的 `name` / `description` 两行。
 *
 * 为什么不引 yaml 解析器：SKILL.md 的 frontmatter 由技能作者手写，历史上只用
 * 这两个平面键（内置 bundle 与子 Agent 清单都是），多余结构一律忽略更稳；
 * 解析失败（没有 frontmatter / 没有 name）由调用方决定降级方式。
 */

export interface SkillMarkdown {
  /** frontmatter 的 name（缺省为空串）。 */
  name: string;
  /** frontmatter 的 description（缺省为空串）。 */
  description: string;
  /** frontmatter 之后的正文（用于「技能」页展示）。 */
  body: string;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === "\"" && last === "\"") || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1).trim();
    }
  }
  return trimmed;
}

export function parseSkillMarkdown(text: string): SkillMarkdown {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) return { name: "", description: "", body: text.trim() };
  const frontmatter = match[1] ?? "";
  const field = (key: string): string => {
    const line = new RegExp(`^${key}:\\s*(.*)$`, "m").exec(frontmatter)?.[1];
    return line === undefined ? "" : unquote(line);
  };
  return {
    name: field("name"),
    description: field("description"),
    body: text.slice(match[0].length).trim(),
  };
}
