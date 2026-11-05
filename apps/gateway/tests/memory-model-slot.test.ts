import { describe, expect, it } from "vitest";
import type { GatewayConfig, PiRuntimeConfig } from "../src/config.js";
import { createMemoryInternalRuntime, createMemoryRuntimeResolver } from "../src/modules/agent/runtime-factory.js";

/** 最小可用的 pi 档位配置（测试只关心档位选择，不真正发请求）。 */
function slot(model: string): PiRuntimeConfig {
  return {
    provider: "openai",
    model,
    baseUrl: "http://127.0.0.1:1/ai-relay/v1",
    apiKey: "gateway-token",
    api: "openai-completions",
    maxTokens: 4096,
    contextWindow: 32768,
    temperature: 0.2,
    reasoning: "off",
    sessionsDir: "/tmp/nxcore-test/sessions",
    workingDirectory: "/tmp/nxcore-test/work",
    agentDirectory: "/tmp/nxcore-test/agent",
  };
}

function configWith(overrides: Partial<GatewayConfig>): GatewayConfig {
  return {
    agentRuntime: "pi",
    pi: null,
    litePi: null,
    backgroundPi: null,
    ...overrides,
  } as GatewayConfig;
}

describe("记忆用的模型档位选择", () => {
  it("lite 配置了就用 lite", () => {
    const runtime = createMemoryInternalRuntime(configWith({
      litePi: slot("lite-model"),
      backgroundPi: slot("bg-model"),
      pi: slot("primary-model"),
    }));
    expect(runtime).not.toBeNull();
  });

  it("没有 lite 时回退 background", () => {
    const runtime = createMemoryInternalRuntime(configWith({
      litePi: null,
      backgroundPi: slot("bg-model"),
      pi: slot("primary-model"),
    }));
    expect(runtime).not.toBeNull();
  });

  it("只有 primary 时也能用（只走已配置的 SaaS 槽位）", () => {
    const runtime = createMemoryInternalRuntime(configWith({
      litePi: null,
      backgroundPi: null,
      pi: slot("primary-model"),
    }));
    expect(runtime).not.toBeNull();
  });

  it("一个档位都没配时返回 null（调用方静默跳过）", () => {
    expect(createMemoryInternalRuntime(configWith({}))).toBeNull();
  });

  it("存在 SaaS 中转槽位时只用中转槽位", () => {
    const localSlot = { ...slot("local-model"), baseUrl: "https://api.openai.com/v1" };
    const runtime = createMemoryInternalRuntime(configWith({
      litePi: localSlot,
      backgroundPi: slot("relay-background"), // baseUrl 含 /ai-relay
      pi: localSlot,
    }));
    expect(runtime).not.toBeNull();
    // 选中的应是 relay 槽位的模型
    expect((runtime as unknown as { config: { model: string } }).config.model).toBe("relay-background");
  });

  it("fake runtime 下不建内部 runtime", () => {
    expect(createMemoryInternalRuntime(configWith({
      agentRuntime: "fake",
      litePi: slot("lite-model"),
    }))).toBeNull();
  });
});

describe("记忆运行时的惰性解析", () => {
  it("档位后到（runtime config 原地 patch）也能解析出来", () => {
    // 启动时档位是空的：applyRuntimeConfig 之后才把四要素写进同一个对象。
    const config = configWith({});
    const resolve = createMemoryRuntimeResolver(config);
    expect(resolve()).toBeNull();

    config.pi = slot("primary-model");

    expect(resolve()).not.toBeNull();
    // 解析成功后固定同一个实例，不反复重建
    expect(resolve()).toBe(resolve());
  });

  it("档位签名变化（换模型/换端点/令牌轮换）时重建实例", () => {
    const config = configWith({ pi: slot("primary-model") });
    const resolve = createMemoryRuntimeResolver(config);
    const first = resolve();
    expect(first).not.toBeNull();

    // 令牌轮换：同一槽位、新 apiKey → 必须换实例，否则会一直打旧凭据
    config.pi = { ...slot("primary-model"), apiKey: "rotated-token" };
    const second = resolve();
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);

    // 换模型同理
    config.pi = { ...slot("primary-model"), model: "another-model" };
    expect(resolve()).not.toBe(second);

    // 稳下来之后仍复用同一实例
    expect(resolve()).toBe(resolve());
  });

  it("档位被撤掉后回到 null（不再用旧连接硬打）", () => {
    const config = configWith({ pi: slot("primary-model") });
    const resolve = createMemoryRuntimeResolver(config);
    expect(resolve()).not.toBeNull();

    config.pi = null;
    expect(resolve()).toBeNull();
  });

  it("一直没配档位就一直返回 null（调用方静默跳过）", () => {
    const resolve = createMemoryRuntimeResolver(configWith({}));
    expect(resolve()).toBeNull();
    expect(resolve()).toBeNull();
  });
});
