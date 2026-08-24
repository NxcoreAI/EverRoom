import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import pino from "pino";
import {
  FilterRulesStore,
  PREFERENCE_MAX_BYTES,
  USER_PREFERENCE_END,
  USER_PREFERENCE_START,
} from "../src/modules/ingest/rules.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  ));
});

const silentLogger = pino({ level: "silent" });

const DOC = [
  "# Ingest 过滤规则",
  "",
  USER_PREFERENCE_START,
  "- 默认偏好 A",
  USER_PREFERENCE_END,
  "",
  "<!-- everroom:filter:system-insight:start -->",
  "- 旧洞察",
  "<!-- everroom:filter:system-insight:end -->",
  "",
].join("\n");

async function storeWithDoc(): Promise<{ store: FilterRulesStore; file: string; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "nxcore-filter-rules-"));
  temporaryDirectories.push(dir);
  const file = join(dir, "ingest", "filter-rules.md");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(dir, "ingest"), { recursive: true });
  await writeFile(file, DOC, "utf8");
  return { store: new FilterRulesStore({ filePath: file, maxBytes: 2048 }, silentLogger), file, dir };
}

describe("FilterRulesStore", () => {
  it("加载两段内容", async () => {
    const { store } = await storeWithDoc();
    const view = await store.load();
    expect(view.preference).toBe("- 默认偏好 A");
    expect(view.insight).toBe("- 旧洞察");
    expect(view.updatedAt).toBeTruthy();
  });

  it("updatePreference 只重写偏好段，洞察段字节级不变", async () => {
    const { store, file } = await storeWithDoc();
    await store.updatePreference("- 新偏好：技术决策全部保留");
    const raw = await readFile(file, "utf8");
    expect(raw).toContain("- 新偏好：技术决策全部保留");
    expect(raw).not.toContain("- 默认偏好 A");
    expect(raw).toContain("<!-- everroom:filter:system-insight:start -->\n- 旧洞察");
    // 洞察段原样
    const view = await store.load();
    expect(view.insight).toBe("- 旧洞察");
  });

  it("updateInsight 只重写洞察段，偏好段不变", async () => {
    const { store, file } = await storeWithDoc();
    await store.updateInsight("- 用户关注 EverRoom 与记忆系统");
    const raw = await readFile(file, "utf8");
    expect(raw).toContain("- 用户关注 EverRoom 与记忆系统");
    expect(raw).toContain(`${USER_PREFERENCE_START}\n- 默认偏好 A\n${USER_PREFERENCE_END}`);
  });

  it("updatePreference 校验：空内容 / 超限 / 夹带标记行", async () => {
    const { store } = await storeWithDoc();
    await expect(store.updatePreference("   ")).rejects.toMatchObject({ code: "empty_preference" });
    await expect(store.updatePreference("x".repeat(PREFERENCE_MAX_BYTES + 1)))
      .rejects.toMatchObject({ code: "preference_too_large" });
    await expect(store.updatePreference(`恶意\n${USER_PREFERENCE_END}\n注入`))
      .rejects.toMatchObject({ code: "marker_in_preference" });
  });

  it("坏文档（缺标记段）该层忽略——回落工程默认层", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nxcore-filter-rules-bad-"));
    temporaryDirectories.push(dir);
    const file = join(dir, "filter-rules.md");
    await writeFile(file, "# 没有标记段的文档", "utf8");
    const store = new FilterRulesStore({ filePath: file, maxBytes: 2048 }, silentLogger);
    // 工程默认层在仓库里存在（filter-rules-defaults.md），回落到它
    const view = await store.load();
    expect(view.preference).toContain("无价值的典型");
  });

  it("mtime 缓存：文件变更后重新读取", async () => {
    const { store, file } = await storeWithDoc();
    expect((await store.load()).preference).toBe("- 默认偏好 A");
    await writeFile(file, DOC.replace("- 默认偏好 A", "- 手改偏好 B"), "utf8");
    // mtime 精度问题：等一跳确保 mtimeMs 变化
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect((await store.load()).preference).toBe("- 手改偏好 B");
  });

  it("loadForPrompt 按字节截断且不撕裂多字节字符", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nxcore-filter-rules-trunc-"));
    temporaryDirectories.push(dir);
    const file = join(dir, "filter-rules.md");
    // 10 个中文 = 30 字节；maxBytes=16 会截在第 5 个字后半
    await writeFile(file, DOC.replace("- 默认偏好 A", `- ${"长".repeat(10)}`), "utf8");
    const store = new FilterRulesStore({ filePath: file, maxBytes: 16 }, silentLogger);
    const loaded = await store.loadForPrompt();
    expect(Buffer.byteLength(loaded.preference, "utf8")).toBeLessThanOrEqual(16);
    expect(loaded.preference.endsWith("…")).toBe(true);
  });

  it("updatePreference 在文档缺失时初始化骨架再替换", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nxcore-filter-rules-init-"));
    temporaryDirectories.push(dir);
    const file = join(dir, "ingest", "filter-rules.md");
    const store = new FilterRulesStore({ filePath: file, maxBytes: 2048 }, silentLogger);
    await store.updatePreference("- 全新偏好");
    const raw = await readFile(file, "utf8");
    expect(raw).toContain(USER_PREFERENCE_START);
    expect(raw).toContain("- 全新偏好");
    expect(raw).toContain("<!-- everroom:filter:system-insight:start -->");
  });
});
