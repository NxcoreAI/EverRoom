import { describe, expect, it } from "vitest";
import {
  DEFAULT_SCENE,
  SCENES,
  fontFloorsForDistance,
  isSceneId,
  proseBudgetBaseForDensity,
  inferSceneId,
  resolveScene,
  sceneLabel,
  typeScaleForDistance,
} from "../src/modules/slides-layout/scene.js";
import { resolveTheme } from "../src/modules/slides-layout/theme.js";
import { contractFromStyleParams } from "../src/modules/slides-layout/tree/layout-contract.js";

const TOKEN_ORDER = ["display", "hero", "h1", "h2", "h3", "lead", "body", "label", "kicker", "caption"] as const;

describe("场景档案", () => {
  it("五个场景各自落在距离 × 密度上", () => {
    expect(SCENES).toHaveLength(5);
    const axes = Object.fromEntries(
      SCENES.map((id) => {
        const p = resolveScene(id);
        return [id, `${p.distance}/${p.density}`];
      }),
    );
    expect(axes).toEqual({
      fundraising: "far/dense",
      "internal-review": "far/standard",
      keynote: "far/airy",
      training: "near/standard",
      reading: "near/dense",
    });
  });

  it("非法或缺失的场景一律落到最保守的缺省，不抛错", () => {
    expect(resolveScene().id).toBe(DEFAULT_SCENE);
    expect(resolveScene(null).id).toBe(DEFAULT_SCENE);
    expect(resolveScene("swiss").id).toBe(DEFAULT_SCENE);
    expect(isSceneId("keynote")).toBe(true);
    expect(isSceneId("poster")).toBe(false);
    expect(sceneLabel("nope")).toBe(resolveScene(DEFAULT_SCENE).label);
  });

  it("字阶严格递减，且两端落在设计区间内", () => {
    for (const distance of ["far", "near"] as const) {
      const scale = typeScaleForDistance(distance);
      for (let i = 1; i < TOKEN_ORDER.length; i += 1) {
        expect(scale[TOKEN_ORDER[i]!]).toBeLessThan(scale[TOKEN_ORDER[i - 1]!]);
      }
      expect(scale.display).toBeLessThanOrEqual(110);
      expect(scale.caption).toBeGreaterThanOrEqual(10);
    }
  });

  it("投影档正文落在 18–24pt 最佳实践区间，研读档与参考 deck 对齐", () => {
    const far = typeScaleForDistance("far");
    expect(far.body).toBeGreaterThanOrEqual(18);
    expect(far.body).toBeLessThanOrEqual(24);
    const near = typeScaleForDistance("near");
    // nexwing 参考 deck 实测：正文 16、caption 11
    expect(near.body).toBe(16);
    expect(near.caption).toBe(11);
  });

  it("字号下限不再是 9pt（这是「满屏无意义小字」的旧根因）", () => {
    for (const distance of ["far", "near"] as const) {
      const floors = fontFloorsForDistance(distance);
      expect(floors.caption).toBeGreaterThanOrEqual(10);
      expect(floors.body).toBeGreaterThanOrEqual(14);
      // 下限必须低于同变体的阶梯值，否则降档无空间
      const scale = typeScaleForDistance(distance);
      expect(floors.display).toBeLessThan(scale.display);
      expect(floors.body).toBeLessThan(scale.body);
      expect(floors.caption).toBeLessThan(scale.caption);
    }
  });

  it("密度基准：疏 35 / 标准 60 / 密 95", () => {
    expect(proseBudgetBaseForDensity("airy")).toBe(35);
    expect(proseBudgetBaseForDensity("standard")).toBe(60);
    expect(proseBudgetBaseForDensity("dense")).toBe(95);
  });
});

describe("场景接入主题与契约", () => {
  it("主题字号来自场景，风格卡的字号字段被忽略", () => {
    const wild = resolveTheme(
      { typography: { sizes: { body: 40, caption: 30, coverTitle: 10 }, typeScale: { body: 44 } } },
      "internal-review",
    );
    const plain = resolveTheme({}, "internal-review");
    expect(wild.typeScale).toEqual(plain.typeScale);
    expect(wild.sizes).toEqual(plain.sizes);
    // far 档：正文 20pt（中文满宽字，比拉丁阶梯低一档才排得下）
    expect(wild.typeScale.body).toBe(20);
  });

  it("同一份风格卡在不同场景下得到不同字号", () => {
    const far = resolveTheme({}, "keynote");
    const near = resolveTheme({}, "reading");
    expect(far.typeScale.body).toBeGreaterThan(near.typeScale.body);
    expect(far.scene).toBe("keynote");
    expect(near.scene).toBe("reading");
  });

  it("契约的字号下限随场景变化，且缺省场景可省略", () => {
    const far = contractFromStyleParams(null, "fundraising");
    const near = contractFromStyleParams(null, "training");
    expect(far.fontFloors.body).toBe(16);
    expect(near.fontFloors.body).toBe(14);
    expect(contractFromStyleParams(null).fontFloors).toEqual(far.fontFloors);
  });
});

describe("场景静默判断（只看指令里的场合词）", () => {
  it("场合词对得上的落对应场景", () => {
    expect(inferSceneId("给投资人做一轮路演，讲清估值逻辑")).toBe("fundraising");
    expect(inferSceneId("周一内部周会，过一遍上周复盘")).toBe("internal-review");
    expect(inferSceneId("产品发布会主论坛演讲，二十分钟")).toBe("keynote");
    expect(inferSceneId("给新人的入职培训讲义，讲三天")).toBe("training");
    expect(inferSceneId("打印出来做尽调研读的白皮书")).toBe("reading");
  });

  it("判不出来落最保守的一档，不猜", () => {
    expect(inferSceneId("")).toBe(DEFAULT_SCENE);
    expect(inferSceneId(undefined)).toBe(DEFAULT_SCENE);
    expect(inferSceneId("做一份十六页的演示文稿")).toBe(DEFAULT_SCENE);
  });

  it("同一句指令恒定判成同一个场景（确定性）", () => {
    const instruction = "给投资人路演，同时要能打印研读";
    expect(inferSceneId(instruction)).toBe(inferSceneId(instruction));
  });

  it("场景决定密度：研读场景一页能承载更多字", () => {
    expect(resolveScene(inferSceneId("尽调研读用")).density).toBe("dense");
    expect(resolveScene(inferSceneId("发布会演讲")).density).toBe("airy");
  });
});
