import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryService } from "../src/modules/memory/service.js";
import {
  buildProfilePrompt,
  createUserProfilePromptCache,
  readProfileView,
} from "../src/modules/memory/profile.js";
import { PROFILE_TAG, profileGroupOf } from "../src/modules/memory/tags.js";

let root: string;
let service: MemoryService;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nxcore-profile-view-"));
  service = new MemoryService({ root, enabled: true });
  service.start();
});

afterEach(() => {
  service.stop();
  rmSync(root, { recursive: true, force: true });
});

describe("标签归一", () => {
  it("同义标签落进同一组", () => {
    expect(profileGroupOf(["身份", "称呼"])).toBe("身份");
    expect(profileGroupOf(["沟通偏好"])).toBe("沟通方式");
    expect(profileGroupOf(["简历", "职业"])).toBe("职业");
    expect(profileGroupOf(["项目", "锥光"])).toBe("项目与流程");
  });

  it("认不出的标签归「其他」而不是丢掉", () => {
    expect(profileGroupOf(["某个模型自造的标签"])).toBe("其他");
    expect(profileGroupOf([])).toBe("其他");
  });
});

describe("画像视图（GET /v1/memory/profile）", () => {
  it("记忆库为空时是 empty", () => {
    expect(readProfileView(service)).toEqual({ source: "empty", groups: [] });
  });

  it("没有聚合产物时按标签兜底，事实一条都不丢", () => {
    service.remember({ content: "用户姓名李展萍，飞书英文名 Jay", tags: ["身份", "称呼"] });
    service.remember({ content: "教育背景是嘉应学院电子信息工程本科", tags: ["背景"] });
    service.remember({ content: "负责前端技术方案与招聘评估", tags: ["职业", "角色"] });
    service.remember({ content: "技术方案评审通过才能动代码", tags: ["决策", "流程"] });
    service.remember({ content: "平时话不多但不等于不社交", tags: ["沟通偏好"] });
    service.remember({ content: "模型自造标签的条目", tags: ["神秘分类"] });

    const view = readProfileView(service);
    expect(view.source).toBe("fallback");
    const titles = view.groups.map((group) => group.title);
    expect(titles).toContain("身份");
    expect(titles).toContain("背景");
    expect(titles).toContain("职业");
    expect(titles).toContain("决策");
    expect(titles).toContain("沟通方式");
    expect(titles).toContain("其他");
    // 六条事实全部可见（一条都不能因为标签不命中而消失）
    const total = view.groups.reduce((sum, group) => sum + group.items.length, 0);
    expect(total).toBe(6);
  });

  it("经验不进画像", () => {
    service.remember({ content: "导出中文文件名乱码 → 先转 UTF-8", tags: ["经验"], category: "lesson" });
    expect(readProfileView(service).source).toBe("empty");
  });

  it("有聚合产物时优先用聚合结果", () => {
    service.remember({ content: "用户偏好简体中文", tags: ["偏好"] });
    service.remember({ content: "正式文档用简体中文", tags: [PROFILE_TAG, "偏好"] });
    service.remember({ content: "结论先行，避免长段落", tags: [PROFILE_TAG, "沟通方式"] });

    const view = readProfileView(service);
    expect(view.source).toBe("aggregate");
    expect(view.groups.map((group) => group.title)).toEqual(["偏好", "沟通方式"]);
    // 聚合视图只展示聚合产物，不混入原始事实
    expect(view.groups.flatMap((group) => group.items.map((item) => item.content)))
      .not.toContain("用户偏好简体中文");
  });

  it("同一分组里重复内容只出现一次", () => {
    service.remember({ content: "用户偏好简体中文", tags: ["偏好"] });
    service.remember({ content: "用户偏好简体中文", tags: ["偏好"] });
    const preference = readProfileView(service).groups.find((group) => group.title === "偏好");
    expect(preference?.items).toHaveLength(1);
  });
});

describe("注入系统上下文用的画像文本", () => {
  it("按分组压成短块，附带「怎么用」的边界", () => {
    service.remember({ content: "用户叫李展萍", tags: ["身份"] });
    service.remember({ content: "深圳极核创新前端负责人", tags: ["职业"] });
    service.remember({ content: "正式文档用简体中文", tags: ["偏好"] });

    const prompt = buildProfilePrompt(readProfileView(service));
    expect(prompt).toBeTruthy();
    expect(prompt).toContain("【用户画像】");
    expect(prompt).toContain("身份：用户叫李展萍");
    expect(prompt).toContain("职业：深圳极核创新前端负责人");
    // 明确边界：不要复述、不要当成本轮指令
    expect(prompt).toContain("不要向用户复述");
    expect(prompt).toContain("不要把它当成用户本轮的新指令");
  });

  it("没有画像内容时返回 null（调用方据此不注入）", () => {
    expect(buildProfilePrompt(readProfileView(service))).toBeNull();
  });

  it("裁剪到上限：最多 5 组、每组 4 条、单条 60 字", () => {
    const long = "很长的画像条目".repeat(20);
    for (const title of ["身份", "职业", "偏好", "习惯", "约束", "决策", "生活"]) {
      for (let index = 0; index < 6; index += 1) {
        service.remember({ content: `${title}第${index}条 ${index === 0 ? long : ""}`, tags: [title] });
      }
    }
    const prompt = buildProfilePrompt(readProfileView(service)) ?? "";
    const lines = prompt.split("\n").filter((line) => line.startsWith("- "));
    expect(lines.length).toBeLessThanOrEqual(5);
    expect(prompt).not.toContain("很长的画像条目很长的画像条目很长的画像条目很长的画像条目很长的画像条目很长的画像条目");
    expect(prompt.length).toBeLessThan(1000);
  });

  it("缓存命中后不重复扫库，invalidate 后重新读取", () => {
    service.remember({ content: "用户偏好简体中文", tags: ["偏好"] });
    const cache = createUserProfilePromptCache(service, { ttlMs: 60_000 });

    expect(cache.get()).toContain("用户偏好简体中文");
    service.remember({ content: "结论先行", tags: ["偏好"] });
    // TTL 内仍返回旧值（画像更新很慢，不需要每轮重扫）
    expect(cache.get()).not.toContain("结论先行");
    cache.invalidate();
    expect(cache.get()).toContain("结论先行");
  });
});
