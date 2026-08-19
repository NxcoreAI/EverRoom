import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDatabase } from "../src/infrastructure/database/client.js";
import {
  bestMatch,
  bigramDiceSimilarity,
  normalizeEntityName,
} from "../src/modules/knowledge/entity-index.js";
import {
  blendCentroid,
  cosineSimilarity,
  decodeCentroid,
  encodeCentroid,
  nearestByCentroid,
} from "../src/modules/knowledge/embedding.js";
import {
  EntityRegistry,
  derivePrimaryRoles,
  meetsPromotionThreshold,
  type EntityRow,
} from "../src/modules/knowledge/entity-registry.js";
import {
  parseExtractionResponse,
  parseJudgeResponse,
  parseRegisterResponse,
} from "../src/modules/knowledge/llm.js";
import { dedupeExtraction, fallbackSummary, pickPromotedTargets } from "../src/modules/knowledge/router.js";
import {
  buildWikiGraph,
  ingestLedgerOf,
  mergeIngestLedger,
  parseWikiLinks,
  resolveWikiLinkTarget,
} from "../src/modules/knowledge/service.js";

// ───────────────────────── 纯函数 ─────────────────────────

describe("③″ 实体名匹配", () => {
  it("normalizes names: NFC + 空白折叠 + 小写", () => {
    expect(normalizeEntityName("  Q3   营销  ")).toBe("q3 营销");
    expect(normalizeEntityName("Satellite")).toBe(normalizeEntityName(" satellite "));
  });

  it("bigram Dice：近似名高分、无关名低分、空串 0", () => {
    expect(bigramDiceSimilarity("Q3 营销复盘", "q3营销复盘")).toBeGreaterThan(0.9);
    expect(bigramDiceSimilarity("营销复盘", "服务器扩容")).toBeLessThan(0.3);
    expect(bigramDiceSimilarity("", "任何")).toBe(0);
  });

  it("bestMatch：精确归一化命中得 1，并列取先出现者，空池返回 null", () => {
    expect(bestMatch("卫星项目", ["别的", "卫星项目"])).toMatchObject({ value: "卫星项目", score: 1 });
    expect(bestMatch("Satellite", ["satellite", "SATTELITE "])!.value).toBe("satellite");
    expect(bestMatch("anything", [])).toBeNull();
    expect(bestMatch("  ", ["x"])).toBeNull();
  });

  it("bestMatch 比对的是 name+aliases 的整体最优（alias 撞名不会串到别的实体）", () => {
    // "备忘录" 同时是两个实体的 alias 时，得分并列取先出现者——不误选
    const match = bestMatch("项目备忘录", ["备忘录", "别的名字"]);
    expect(match!.score).toBeGreaterThan(0);
    expect(match!.value).toBe("备忘录");
  });
});

describe("④ 质心代数", () => {
  it("base64 float32 往返", () => {
    const vector = [0.1, -0.2, 0.3];
    const decoded = decodeCentroid(encodeCentroid(vector));
    expect(decoded).toHaveLength(3);
    expect(decoded[0]).toBeCloseTo(0.1, 6);
  });

  it("余弦相似度与维度不匹配拒绝", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosineSimilarity([1, 0], [1, 0, 0])).toBe(0);
  });

  it("EMA 混合并归一化；旧质心为空时直接归一化新向量", () => {
    const blended = blendCentroid([1, 0], [0, 1], 0.25);
    const norm = Math.sqrt(blended.reduce((sum, value) => sum + value * value, 0));
    expect(norm).toBeCloseTo(1);
    expect(blended[0]).toBeCloseTo(0.75 / Math.hypot(0.75, 0.25), 6);
    expect(blendCentroid(null, [3, 4])[0]).toBeCloseTo(0.6, 6);
  });

  it("nearestByCentroid：跳过无质心/换模型的候选，无冷启动阈值", () => {
    const warm = { id: "warm", centroid: encodeCentroid([1, 0]), centroidDocs: 1, centroidModel: "m" };
    const bare = { id: "bare", centroid: null, centroidDocs: 0, centroidModel: "m" };
    const stale = { id: "stale", centroid: encodeCentroid([0, 1]), centroidDocs: 9, centroidModel: "other" };
    const nearest = nearestByCentroid([1, 0], [warm, bare, stale], "m");
    expect(nearest).toMatchObject({ id: "warm" });
    expect(nearest!.similarity).toBeCloseTo(1);
    expect(nearestByCentroid([1, 0], [bare, stale], "m")).toBeNull();
  });
});

describe("③′⑤ LLM 输出解析", () => {
  it("解析干净的抽取 JSON", () => {
    const result = parseExtractionResponse(
      '{"summary":"讨论卫星排期","entities":[{"name":"卫星项目","kind":"项目","salience":0.9,"evidence":"排期确认"}]}',
    );
    expect(result.summary).toBe("讨论卫星排期");
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0]).toMatchObject({ name: "卫星项目", kind: "项目", salience: 0.9 });
  });

  it("剥 markdown 围栏；空 entities 合法", () => {
    const result = parseExtractionResponse('```json\n{"summary":"无实体","entities":[]}\n```');
    expect(result.entities).toEqual([]);
  });

  it("字段越界修正：kind 非法落主题、salience 夹取、缺失回退 0.3", () => {
    const result = parseExtractionResponse(
      '{"entities":[{"name":"a","kind":"随便","salience":5},{"name":"b","kind":"人物","salience":"x"}]}',
    );
    expect(result.entities[0]).toMatchObject({ kind: "主题", salience: 1 });
    expect(result.entities[1]).toMatchObject({ salience: 0.3 });
  });

  it("同名实体去重保 salience 高者；数量封顶 10", () => {
    const many = Array.from({ length: 12 }, (_, index) => ({ name: `实体${index}`, kind: "主题" }));
    const overflow = parseExtractionResponse(
      JSON.stringify({ entities: [...many, { name: "实体0", kind: "主题", salience: 0.1 }] }),
    );
    expect(overflow.entities).toHaveLength(10);
    const dup = parseExtractionResponse(
      '{"entities":[{"name":"张三","salience":0.3},{"name":"张三","salience":0.8}]}',
    );
    expect(dup.entities).toHaveLength(1);
    expect(dup.entities[0]!.salience).toBe(0.8);
  });

  it("非 JSON 抛错", () => {
    expect(() => parseExtractionResponse("我觉得没有实体")).toThrow();
  });

  it("判定输出：same 必须是布尔", () => {
    expect(parseJudgeResponse('{"same":true,"reason":"同一项目"}')).toMatchObject({ same: true });
    expect(() => parseJudgeResponse('{"same":"yes"}')).toThrow();
    expect(() => parseJudgeResponse('{"reason":"没有same"}')).toThrow();
  });

  it("登记输出：name 必填，aliases 剔除自身并去重", () => {
    const registered = parseRegisterResponse(
      '{"name":"卫星项目","summary":"低轨星座排期","aliases":["卫星项目","卫星计划","卫星计划"]}',
    );
    expect(registered.name).toBe("卫星项目");
    expect(registered.aliases).toEqual(["卫星计划"]);
    expect(() => parseRegisterResponse('{"summary":"没有名字"}')).toThrow();
  });
});

describe("④ 证据与晋升判定", () => {
  it("derivePrimaryRoles：分量最高者为 primary，绝对并列 ≤2 个", () => {
    const roles = derivePrimaryRoles([
      { name: "甲", salience: 0.9 },
      { name: "乙", salience: 0.9 },
      { name: "丙", salience: 0.9 },
      { name: "丁", salience: 0.4 },
    ]);
    expect(roles.get("甲")).toBe("primary");
    expect(roles.get("乙")).toBe("primary");
    expect(roles.get("丙")).toBe("mention"); // 并列第三个降级
    expect(roles.get("丁")).toBe("mention");
    expect(derivePrimaryRoles([]).size).toBe(0);
  });

  it("浮点容差内的并列视为同分（1e-9）", () => {
    const roles = derivePrimaryRoles([
      { name: "甲", salience: 0.3 },
      { name: "乙", salience: 0.3 + 1e-12 },
    ]);
    expect(roles.get("甲")).toBe("primary");
    expect(roles.get("乙")).toBe("primary");
  });

  it("meetsPromotionThreshold：双条件同时满足，且仅 weak 态可晋升", () => {
    const thresholds = { promoteScore: 2, promoteSources: 2 };
    expect(meetsPromotionThreshold(
      { status: "weak", evidenceScore: 2.0, sourceCount: 2 },
      thresholds,
    )).toBe(true);
    expect(meetsPromotionThreshold(
      { status: "weak", evidenceScore: 2.0, sourceCount: 1 },
      thresholds,
    )).toBe(false);
    expect(meetsPromotionThreshold(
      { status: "weak", evidenceScore: 1.4, sourceCount: 2 },
      thresholds,
    )).toBe(false);
    expect(meetsPromotionThreshold(
      { status: "room", evidenceScore: 5, sourceCount: 5 },
      thresholds,
    )).toBe(false);
  });
});

describe("路由纯函数", () => {
  it("dedupeExtraction：同 kind 近名合并——保留首名、salience 取 max、依据句拼接", () => {
    const deduped = dedupeExtraction([
      { name: "卫星项目", kind: "项目", salience: 0.6, evidence: "排期确认" },
      { name: "卫星 项目", kind: "项目", salience: 0.9, evidence: "预算敲定" },
    ]);
    expect(deduped).toHaveLength(1);
    expect(deduped[0]).toMatchObject({ name: "卫星项目", salience: 0.9 });
    expect(deduped[0]!.evidence).toContain("排期确认");
    expect(deduped[0]!.evidence).toContain("预算敲定");
  });

  it("dedupeExtraction：kind 不同不合并（同名的人物与项目分立）", () => {
    const deduped = dedupeExtraction([
      { name: "北斗", kind: "人物", salience: 0.9, evidence: "" },
      { name: "北斗", kind: "项目", salience: 0.8, evidence: "" },
    ]);
    expect(deduped).toHaveLength(2);
  });

  it("pickPromotedTargets：全部已晋升链接实体入选（mention 角色同样沉淀），salience 优先、并列看证据分", () => {
    const base = {
      aliases: [], kind: "主题", summary: null, roomId: "room-a",
      evidenceScore: 0, sourceCount: 0,
      centroid: null, centroidDocs: 0, centroidModel: null, mergedFrom: [],
      lastLinkedAt: null, createdAt: new Date(), updatedAt: new Date(),
    };
    const promotedHigh = { ...base, id: "e-high", name: "高分实体", status: "room", evidenceScore: 3 } as EntityRow;
    const promotedTie = { ...base, id: "e-tie", name: "并列实体", status: "room", evidenceScore: 5 } as EntityRow;
    const weak = { ...base, id: "e-weak", name: "弱实体", status: "weak", roomId: null } as EntityRow;
    const promotedMention = { ...base, id: "e-mention", name: "提及实体", status: "room", roomId: "room-b" } as EntityRow;

    // 无已晋升链接 → 空（linked 出口）
    expect(pickPromotedTargets([
      { entity: weak, role: "primary", salience: 0.9 },
    ])).toEqual([]);
    // mention 角色的已晋升实体同样入选（多对多沉淀）
    expect(pickPromotedTargets([
      { entity: promotedMention, role: "mention", salience: 0.9 },
    ]).map((item) => item.entity.id)).toEqual(["e-mention"]);
    // 多目标排序：salience 优先、并列看证据分；弱实体不出线
    expect(pickPromotedTargets([
      { entity: promotedHigh, role: "primary", salience: 0.8 },
      { entity: promotedTie, role: "primary", salience: 0.8 },
      { entity: promotedMention, role: "mention", salience: 0.95 },
      { entity: weak, role: "mention", salience: 0.4 },
    ]).map((item) => item.entity.id)).toEqual(["e-mention", "e-tie", "e-high"]);
  });

  it("fallbackSummary 剥 frontmatter 与 markdown 标记", () => {
    const markdown = "---\ntitle: x\nversion: 3\n---\n\n## 结论\n\n- 卫星**轨道**确认";
    const summary = fallbackSummary(markdown);
    expect(summary).not.toContain("---");
    expect(summary).not.toContain("##");
    expect(summary).not.toContain("**");
    expect(summary).toContain("卫星");
    expect(summary).toContain("轨道");
  });

  it("落盘账本：二次落进另一 Room 追加条目，同 Room 重复落盘覆盖不重复", () => {
    let evidence = mergeIngestLedger({ summary: "讨论卫星排期" }, "room-a", "kb-a", "file-x.md");
    // 多对多沉淀：同一资料命中多个已晋升实体，落进 room-b 的 wiki
    evidence = mergeIngestLedger(evidence, "room-b", "kb-b", "file-x.md");
    evidence = mergeIngestLedger(evidence, "room-a", "kb-a2", "file-x.md"); // wiki 重建重落
    const ledger = ingestLedgerOf({ evidence, primaryRoomId: "room-b" });
    expect(ledger).toHaveLength(2);
    expect(ledger).toContainEqual({ roomId: "room-a", filename: "file-x.md" });
    expect(ledger).toContainEqual({ roomId: "room-b", filename: "file-x.md" });
    // 路由审计字段不被覆写
    expect(evidence.summary).toBe("讨论卫星排期");
  });

  it("补账跳过（账本制）：本房本文件已落才跳，他房确认不挡本房补账", () => {
    // room-a 已确认沉淀（primaryRoomId 指向 room-a），room-b 的实体后晋升
    const decision = {
      evidence: mergeIngestLedger({ summary: "s" }, "room-a", "kb-a", "file-x.md"),
      primaryRoomId: "room-a" as string | null,
    };
    const hasIngested = (roomId: string, filename: string) =>
      ingestLedgerOf(decision).some((entry) => entry.roomId === roomId && entry.filename === filename);
    // room-b 不在账本 → 不跳（旧口径 primaryRoomId===roomId 会误挡这里）
    expect(hasIngested("room-b", "file-x.md")).toBe(false);
    // room-a 同文件 → 跳（幂等收敛）
    expect(hasIngested("room-a", "file-x.md")).toBe(true);
    // room-a 换了文件名（重路由/改名）→ 不跳，重新沉淀
    expect(hasIngested("room-a", "file-y.md")).toBe(false);
  });

  it("落盘账本回退：旧决策（无 rooms）用单点 primaryRoomId + filename", () => {
    expect(ingestLedgerOf({
      evidence: { filename: "old.md" },
      primaryRoomId: "room-legacy",
    })).toEqual([{ roomId: "room-legacy", filename: "old.md" }]);
    // 坏条目（缺 filename 字符串）被剔除；全空 → 无落点
    expect(ingestLedgerOf({
      evidence: { rooms: [{ roomId: "room-a" }, "junk"] },
      primaryRoomId: null,
    })).toEqual([]);
  });

  it("parseWikiLinks：维基链与相对 md 链都收，外链/锚点剔除", () => {
    const markdown = [
      "参见 [[排期计划]] 与 [[排期计划|详细排期]]。",
      "细节在 [架构文档](./docs/architecture.md) 和 [外链](https://example.com/x)。",
      "[锚点](#section) 与 [邮箱](mailto:a@b.c) 不算。",
    ].join("\n");
    // 目标原样返回（./ 归一化在 resolveWikiLinkTarget）
    expect(parseWikiLinks(markdown)).toEqual(["排期计划", "./docs/architecture.md"]);
  });

  it("resolveWikiLinkTarget：path > 标题 > 末段，未命中返回 null", () => {
    const pages = [
      { id: "p1", title: "排期计划", type: "doc", path: "plan/排期.md" },
      { id: "p2", title: "架构", type: "doc", path: "docs/architecture.md" },
    ];
    expect(resolveWikiLinkTarget("docs/architecture.md", pages)).toBe("p2"); // 精确 path
    expect(resolveWikiLinkTarget("排期计划", pages)).toBe("p1"); // 标题命中
    expect(resolveWikiLinkTarget("./排期.md", pages)).toBe("p1"); // 末段（去 ./ 与扩展名）
    expect(resolveWikiLinkTarget("不存在", pages)).toBeNull();
  });

  it("buildWikiGraph：内链成边并计入 inLinks，自环/重复/读不到的页剔除", () => {
    const pages = [
      { id: "p1", title: "首页", type: "doc", path: "index.md" },
      { id: "p2", title: "排期", type: "doc", path: "plan.md" },
      { id: "p3", title: "自环", type: "doc", path: "loop.md" },
      { id: "p4", title: "缺内容", type: "doc", path: "missing.md" },
    ];
    const graph = buildWikiGraph(pages, new Map([
      ["p1", "[[排期]] 和 [[排期]] 重复只算一次，[[首页]] 自环剔除"],
      ["p2", "回看 [[首页]]"],
      ["p3", "[[自环]]"],
      // p4 无内容 → 不产生边，但节点保留
    ]));
    expect(graph.edges).toEqual([
      { source: "p1", target: "p2" },
      { source: "p2", target: "p1" },
    ]);
    expect(graph.nodes.find((node) => node.id === "p1")!.inLinks).toBe(1);
    expect(graph.nodes.find((node) => node.id === "p2")!.inLinks).toBe(1);
    expect(graph.nodes.find((node) => node.id === "p4")!.inLinks).toBe(0);
  });
});

// ───────────────────────── 注册表（真实 sqlite） ─────────────────────────

const temporaryDirectories: string[] = [];

afterEach(async () => {
  // Windows：sqlite -shm 释放有延迟，EBUSY 时让 fs.rm 自带的重试兜底
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  ));
});

async function registryForTest() {
  const dataDir = await mkdtemp(join(tmpdir(), "nxcore-entity-registry-"));
  temporaryDirectories.push(dataDir);
  const { db, sqlite } = createDatabase(join(dataDir, "gateway.sqlite"), resolve("drizzle"));
  return { registry: new EntityRegistry(db), sqlite };
}

describe("实体注册表：证据累积算术（plan §4.3）", () => {
  it("首链计权重、sourceCount 只在首次 +1、版本更新调差额", async () => {
    const { registry, sqlite } = await registryForTest();
    const entity = registry.createEntity({ name: "卫星项目", kind: "项目" });
    expect(entity.status).toBe("weak");
    expect(entity.summary).toBeNull(); // ED7：弱期不写合成概述

    // 源 1：primary（+1.0）
    let updated = registry.upsertLink({
      entityId: entity.id, sourceKind: "file", sourceId: "file-a", sourceVersion: 1,
      role: "primary", salience: 0.9, evidence: "排期确认", decidedBy: "resolution",
    });
    expect(updated.evidenceScore).toBeCloseTo(1.0, 6);
    expect(updated.sourceCount).toBe(1);

    // 源 2：mention（+0.4）
    updated = registry.upsertLink({
      entityId: entity.id, sourceKind: "file", sourceId: "file-b", sourceVersion: 1,
      role: "mention", salience: 0.3, evidence: "顺带提及", decidedBy: "resolution",
    });
    expect(updated.evidenceScore).toBeCloseTo(1.4, 6);
    expect(updated.sourceCount).toBe(2);
    expect(meetsPromotionThreshold(updated, { promoteScore: 2, promoteSources: 2 })).toBe(false);

    // 源 1 版本更新：primary → mention，调差额 -0.6，sourceCount 不变
    updated = registry.upsertLink({
      entityId: entity.id, sourceKind: "file", sourceId: "file-a", sourceVersion: 2,
      role: "mention", salience: 0.2, evidence: "改稿后降级", decidedBy: "resolution",
    });
    expect(updated.evidenceScore).toBeCloseTo(0.8, 6);
    expect(updated.sourceCount).toBe(2);

    // 手动挂载（+1.5）达到晋升线
    updated = registry.upsertLink({
      entityId: entity.id, sourceKind: "mail", sourceId: "mail-1", sourceVersion: 1,
      role: "manual", salience: 1, evidence: "用户手动挂载", decidedBy: "user",
    });
    expect(updated.evidenceScore).toBeCloseTo(2.3, 6);
    expect(updated.sourceCount).toBe(3);
    expect(meetsPromotionThreshold(updated, { promoteScore: 2, promoteSources: 2 })).toBe(true);
    sqlite.close();
  });

  it("claimForPromotion：weak 抢占成功，room 拒绝，promoting 可重入（重试续跑）", async () => {
    const { registry, sqlite } = await registryForTest();
    const entity = registry.createEntity({ name: "议题实体", kind: "议题" });
    expect(registry.claimForPromotion(entity.id)).toBe(true);
    expect(registry.getEntity(entity.id)!.status).toBe("promoting");
    // 重试重入：失败滞留 promoting 的实体能再次被 claim
    expect(registry.claimForPromotion(entity.id)).toBe(true);
    registry.promoteToRoom(entity.id, "room-x");
    expect(registry.getEntity(entity.id)).toMatchObject({ status: "room", roomId: "room-x" });
    expect(registry.claimForPromotion(entity.id)).toBe(false);
    sqlite.close();
  });

  it("markReady：weak → ready 幂等翻转；ready 可被 claim 晋升，参与解析池", async () => {
    const { registry, sqlite } = await registryForTest();
    const a = registry.createEntity({ name: "卫星项目", kind: "项目" });
    expect(registry.markReady(a.id)).toBe(true);
    expect(registry.getEntity(a.id)!.status).toBe("ready");
    expect(registry.markReady(a.id)).toBe(false); // 已 ready：幂等不翻
    // ready 参与解析池（新资料按名命中，不另立弱实体）
    expect(registry.loadResolutionPool().map((entity) => entity.id)).toContain(a.id);
    // ready 可被用户确认晋升抢占
    expect(registry.claimForPromotion(a.id)).toBe(true);
    expect(registry.getEntity(a.id)!.status).toBe("promoting");
    // 已晋升实体不回推荐池
    registry.promoteToRoom(a.id, "room-r");
    expect(registry.markReady(a.id)).toBe(false);
    sqlite.close();
  });

  it("releaseStuckPromotions：promoting 滞留全部复位 weak", async () => {
    const { registry, sqlite } = await registryForTest();
    const a = registry.createEntity({ name: "A", kind: "主题" });
    const b = registry.createEntity({ name: "B", kind: "主题" });
    registry.claimForPromotion(a.id);
    registry.claimForPromotion(b.id);
    registry.promoteToRoom(b.id, "room-b");
    expect(registry.releaseStuckPromotions()).toBe(1);
    expect(registry.getEntity(a.id)!.status).toBe("weak");
    expect(registry.getEntity(b.id)!.status).toBe("room");
    sqlite.close();
  });

  it("mergeEntities：链接迁移、分数相加、aliases 并集、from 转 archived", async () => {
    const { registry, sqlite } = await registryForTest();
    const into = registry.createEntity({ name: "卫星项目", kind: "项目" });
    const from = registry.createEntity({ name: "星座计划", kind: "项目" });
    registry.upsertLink({
      entityId: into.id, sourceKind: "file", sourceId: "file-1", sourceVersion: 1,
      role: "primary", salience: 0.9, evidence: "主项目", decidedBy: "resolution",
    });
    registry.upsertLink({
      entityId: from.id, sourceKind: "file", sourceId: "file-2", sourceVersion: 1,
      role: "mention", salience: 0.3, evidence: "别称提及", decidedBy: "resolution",
    });
    // 撞源：from 对 file-1 也有链接，角色证据分更低——保留 into 的
    registry.upsertLink({
      entityId: from.id, sourceKind: "file", sourceId: "file-1", sourceVersion: 2,
      role: "mention", salience: 0.2, evidence: "", decidedBy: "resolution",
    });

    const merged = registry.mergeEntities({ intoId: into.id, fromId: from.id });
    expect(merged.into!.evidenceScore).toBeCloseTo(1.4, 6); // 1.0 + (0.4 + 0)
    expect(merged.into!.aliases).toContain("星座计划");
    expect(merged.into!.mergedFrom).toEqual([from.id]);
    expect(merged.from!.status).toBe("archived");
    expect(merged.from!.roomId).toBeNull();
    // 迁移后链接全在 into 名下，from 名下清零
    expect(registry.linksOfEntity(into.id)).toHaveLength(2);
    expect(registry.linksOfEntity(from.id)).toHaveLength(0);
    sqlite.close();
  });

  it("updateEntityIdentity：改名推旧名进 aliases，addAliases 累积去重", async () => {
    const { registry, sqlite } = await registryForTest();
    const entity = registry.createEntity({ name: "旧名", kind: "人物", aliases: ["曾用"] });
    const updated = registry.updateEntityIdentity(entity.id, {
      name: "新名",
      addAliases: ["别名", "曾用"],
    })!;
    expect(updated.name).toBe("新名");
    expect(updated.aliases).toContain("旧名");
    expect(updated.aliases).toContain("别名");
    expect(updated.aliases.filter((alias) => alias === "曾用")).toHaveLength(1);
    expect(updated.aliases).not.toContain("新名");
    sqlite.close();
  });
});
