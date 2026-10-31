import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  larkCliSpawnEnvironment,
} from "../src/modules/documents/agent-export/lark-cli-environment.js";
import { larkCliVersion, runLarkCli } from "../src/modules/documents/agent-export/lark-cli.js";

/** 假 lark-cli：输出里带上收到的 HOME/USERPROFILE/可疑变量，用于断言环境隔离。 */
async function writeEnvironmentEchoCli(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "everroom-gateway-lark-"));
  const executable = join(directory, process.platform === "win32" ? "lark-cli.exe" : "lark-cli");
  const script = `#!/bin/bash
if [ "$1" = "--version" ]; then
  echo "lark-cli version 1.0.93"
  exit 0
fi
echo "{\\"ok\\":true,\\"data\\":{\\"home\\":\\"$HOME\\",\\"userprofile\\":\\"$USERPROFILE\\",\\"profile\\":\\"$LARKSUITE_CLI_PROFILE\\",\\"openclaw\\":\\"$OPENCLAW_HOME\\",\\"noColor\\":\\"$NO_COLOR\\"}}"
exit 0
`;
  await writeFile(executable, script, "utf8");
  if (process.platform !== "win32") await chmod(executable, 0o755);
  return executable;
}

describe("gateway lark-cli environment isolation", () => {
  it("pins HOME family to the private directory and drops external agent context", () => {
    const environment = larkCliSpawnEnvironment({
      HOME: "/Users/someone",
      USER: "someone",
      LANG: "zh_CN.UTF-8",
      PATH: "/usr/local/bin:/usr/bin",
      HTTPS_PROXY: "http://proxy.corp:8080",
      LARKSUITE_CLI_PROFILE: "personal",
      FEISHU_APP_ID: "cli_personal",
      OPENCLAW_HOME: "/Users/someone/.openclaw",
      HERMES_HOME: "/Users/someone/.hermes",
      NODE_OPTIONS: "--inspect",
      ELECTRON_RUN_AS_NODE: "1",
      XDG_CONFIG_HOME: "/Users/someone/.config",
    }, { homeDirectory: "/private/home" });

    expect(environment.HOME).toBe("/private/home");
    expect(environment.USERPROFILE).toBe("/private/home");
    expect(environment.APPDATA).toBe("/private/home/AppData/Roaming");
    expect(environment.LOCALAPPDATA).toBe("/private/home/AppData/Local");
    expect(environment.NO_COLOR).toBe("1");
    expect(environment.LANG).toBe("zh_CN.UTF-8");
    expect(environment.HTTPS_PROXY).toBe("http://proxy.corp:8080");
    expect(environment.LARKSUITE_CLI_PROFILE).toBeUndefined();
    expect(environment.FEISHU_APP_ID).toBeUndefined();
    expect(environment.OPENCLAW_HOME).toBeUndefined();
    expect(environment.HERMES_HOME).toBeUndefined();
    expect(environment.NODE_OPTIONS).toBeUndefined();
    expect(environment.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(environment.XDG_CONFIG_HOME).toBeUndefined();
  });

  it("keeps the historical full inheritance when no private home is configured", () => {
    const environment = larkCliSpawnEnvironment({
      HOME: "/Users/someone",
      LARKSUITE_CLI_PROFILE: "personal",
    }, {});
    expect(environment.HOME).toBe("/Users/someone");
    expect(environment.LARKSUITE_CLI_PROFILE).toBe("personal");
    expect(environment.NO_COLOR).toBe("1");
  });

  it("spawns lark-cli with the private home and without external profile variables", async () => {
    const executable = await writeEnvironmentEchoCli();
    const { data } = await runLarkCli(
      { executable, homeDirectory: "/private/gateway-home" },
      ["auth", "status"],
      { timeoutMs: 10_000 },
    ) as { data: Record<string, unknown> };
    expect(data.home).toBe("/private/gateway-home");
    expect(data.userprofile).toBe("/private/gateway-home");
    expect(data.profile).toBe("");
    expect(data.openclaw).toBe("");
    expect(data.noColor).toBe("1");
  });

  it("probes --version for the export preflight", async () => {
    const executable = await writeEnvironmentEchoCli();
    await expect(larkCliVersion({ executable })).resolves.toBe("ok");
  });
});