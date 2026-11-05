/**
 * 记忆标签词表（唯一事实来源）。
 *
 * 为什么要有这个文件：标签口径曾经散在三处各自维护——
 * - 提炼（`distill.ts` 的允许标签）；
 * - 画像聚合（`profile.ts` 的来源标签）；
 * - 桌面「智能体 → 用户画像」页的分组白名单。
 *
 * 三处对不上时，一条记忆会「谁都不要」：既没进画像（标签不命中白名单），
 * 也不是经验（category=fact），于是在页面上彻底隐形——用户明明交代过，
 * 界面却显示「还没有沉淀用户画像」。词表集中在这里之后：
 *
 * 1. 提炼只允许产出下面这组规范标签（`DISTILL_TAGS`）；
 * 2. `memory_remember` 工具仍允许模型自由写标签（不设白名单，避免写不进去），
 *    但展示侧用 `profileGroupOf` 把同义词归一——**认不出的标签归「其他」，不丢弃**；
 * 3. 画像聚合只吃「用户本人的稳定属性」（`isProfileSourceFact`），
 *    项目/流程类留在工作空间作用域，不往全局画像里搬。
 */

/** 画像聚合产物的标记标签：`tags: ["画像", <分组名>]`。 */
export const PROFILE_TAG = "画像";

/** 经验（坑与解法）标记：写入时强制带，类别判定以它为准（见 hippo-adapter 的 categoryOf）。 */
export const LESSON_TAG = "经验";

/**
 * 画像分组。数组顺序即页面展示顺序（「其他」恒排最后，见 sortGroups）。
 * 分组名同时是聚合产物 `tags[1]` 的候选值。
 */
export const PROFILE_GROUPS = [
  "身份",
  "背景",
  "职业",
  "沟通方式",
  "偏好",
  "习惯",
  "约束",
  "决策",
  "生活",
  "项目与流程",
  "其他",
] as const;

export type ProfileGroupName = (typeof PROFILE_GROUPS)[number];

/**
 * 标签 → 分组。键一律小写比对（`profileGroupOf` 里 toLowerCase），
 * 覆盖提炼产出的规范标签 + `memory_remember` 里模型自由发挥的常见同义词。
 */
const TAG_GROUP: Record<string, ProfileGroupName> = {
  // 身份
  身份: "身份", 称呼: "身份", 姓名: "身份", 名字: "身份", 署名: "身份", 别名: "身份",
  identity: "身份", name: "身份",
  // 背景
  背景: "背景", 教育: "背景", 学历: "背景", 经历: "背景", 履历: "背景", 家乡: "背景",
  background: "背景", education: "背景",
  // 职业
  职业: "职业", 角色: "职业", 职位: "职业", 岗位: "职业", 简历: "职业", 求职: "职业",
  公司: "职业", 团队角色: "职业", career: "职业", role: "职业", job: "职业",
  // 沟通方式
  沟通方式: "沟通方式", 沟通偏好: "沟通方式", 表达: "沟通方式", 语气: "沟通方式",
  性格: "沟通方式", 交流: "沟通方式", 反馈: "沟通方式",
  communication: "沟通方式", tone: "沟通方式",
  // 偏好
  偏好: "偏好", 喜好: "偏好", 兴趣: "偏好", 爱好: "偏好", 技术: "偏好", 技术栈: "偏好",
  风格: "偏好", 文档风格: "偏好", 写作: "偏好", 写作风格: "偏好", 格式: "偏好",
  工具: "偏好", 语言: "偏好",
  preference: "偏好", preferences: "偏好", profile: "偏好", style: "偏好", tech: "偏好",
  // 习惯
  习惯: "习惯", 工作习惯: "习惯", 作息: "习惯", habit: "习惯", habits: "习惯",
  // 约束
  约束: "约束", 限制: "约束", 禁忌: "约束", 红线: "约束", 门禁: "约束",
  constraint: "约束", constraints: "约束",
  // 决策
  决策: "决策", 约定: "决策", 决定: "决策", 规范: "决策", 标准: "决策",
  decision: "决策", decisions: "决策",
  // 生活
  生活: "生活", 生活偏好: "生活", 家庭: "生活", 健康: "生活", 娱乐: "生活",
  life: "生活",
  // 项目与流程（工作空间作用域的东西，不进全局画像）
  项目: "项目与流程", 流程: "项目与流程", 业务: "项目与流程", 团队: "项目与流程",
  交付: "项目与流程", 踩坑: "项目与流程",
  project: "项目与流程", process: "项目与流程", workflow: "项目与流程",
};

/** 提炼层允许模型输出的标签；超出的标签在解析层丢弃，回落到类别默认值。 */
export const DISTILL_TAGS = new Set<string>([
  "身份",
  "背景",
  "职业",
  "沟通方式",
  "偏好",
  "习惯",
  "约束",
  "决策",
  "生活",
  "项目",
  "流程",
  LESSON_TAG,
]);

/**
 * 一条记忆归到画像的哪一组：取第一个能识别的标签。
 * 都不认识就归「其他」——宁可分组难看，也不要让条目消失。
 */
export function profileGroupOf(tags: readonly string[]): ProfileGroupName {
  for (const tag of tags) {
    const group = TAG_GROUP[tag.trim().toLowerCase()];
    if (group) return group;
  }
  return "其他";
}

/** 是否属于「用户本人的稳定属性」——只有这些进全局画像聚合。 */
export function isProfileSourceFact(tags: readonly string[]): boolean {
  if (tags.includes(LESSON_TAG) || tags.includes(PROFILE_TAG)) return false;
  const group = profileGroupOf(tags);
  return group !== "项目与流程" && group !== "其他";
}

/** 按 `PROFILE_GROUPS` 顺序排；未知分组（模型自造的分组名）排在其后，保持稳定序。 */
export function sortByGroupOrder<T extends { title: string }>(groups: T[]): T[] {
  const rank = (title: string): number => {
    const index = (PROFILE_GROUPS as readonly string[]).indexOf(title);
    return index < 0 ? PROFILE_GROUPS.length : index;
  };
  return [...groups].sort((left, right) => rank(left.title) - rank(right.title)
    || left.title.localeCompare(right.title));
}
