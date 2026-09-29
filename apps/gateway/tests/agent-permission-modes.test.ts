import { describe, expect, it } from "vitest";
import type { AgentPermissionMode } from "@nxcore/agent-contract";
import {
  defaultPermissionModeForProvider,
  isAgentPermissionMode,
  permissionModeIdForProvider,
  permissionModesForProvider,
  semanticForProviderModeId,
} from "../src/modules/agent/permission-modes.js";

describe("agent permission modes", () => {
  it("maps semantics to provider mode ids and back", () => {
    expect(permissionModeIdForProvider("claude", "ask_before_write")).toBe("default");
    expect(permissionModeIdForProvider("claude", "full_access")).toBe("bypassPermissions");
    expect(permissionModeIdForProvider("codex", "auto")).toBe("auto");
    // claude 无 auto、codex 无 accept_edits（语义面交集不同）
    expect(permissionModeIdForProvider("claude", "auto")).toBeNull();
    expect(permissionModeIdForProvider("codex", "accept_edits")).toBeNull();

    expect(semanticForProviderModeId("claude", "acceptEdits")).toBe("accept_edits");
    expect(semanticForProviderModeId("codex", "full-access")).toBe("full_access");
    // 同名 modeId 按 provider 区分：codex:auto 是语义档，claude 侧不存在
    expect(semanticForProviderModeId("codex", "auto")).toBe("auto");
    expect(semanticForProviderModeId("claude", "auto")).toBeNull();
    expect(semanticForProviderModeId("claude", "dontAsk")).toBeNull();
  });

  it("exposes per-provider availability and defaults", () => {
    expect(permissionModesForProvider("claude")).toEqual<readonly AgentPermissionMode[]>([
      "ask_before_write",
      "accept_edits",
      "full_access",
    ]);
    expect(permissionModesForProvider("codex")).toEqual<readonly AgentPermissionMode[]>([
      "ask_before_write",
      "auto",
      "full_access",
    ]);
    // 无 mode 映射的 ACP provider → 空表（UI 不显示切换钮）
    expect(permissionModesForProvider("openclaw")).toEqual([]);
    // pi 档（provider null）→ 全量四档
    expect(permissionModesForProvider(null)).toHaveLength(4);

    expect(defaultPermissionModeForProvider("claude")).toBe("ask_before_write");
    expect(defaultPermissionModeForProvider("codex")).toBe("auto");
    expect(defaultPermissionModeForProvider(null)).toBe("accept_edits");
  });

  it("validates semantic ids", () => {
    expect(isAgentPermissionMode("accept_edits")).toBe(true);
    expect(isAgentPermissionMode("dontAsk")).toBe(false);
    expect(isAgentPermissionMode(null)).toBe(false);
  });
});
