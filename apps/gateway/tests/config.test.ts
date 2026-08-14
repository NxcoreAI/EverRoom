import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("prefers command line arguments over environment variables", () => {
    const config = loadConfig(
      ["--host", "127.0.0.2", "--port", "4321", "--data-dir", ".data/test", "--token", "0123456789abcdef"],
      { NXCORE_GATEWAY_PORT: "9999" },
    );

    expect(config.host).toBe("127.0.0.2");
    expect(config.port).toBe(4321);
    expect(config.authToken).toBe("0123456789abcdef");
  });

  it("rejects an invalid port", () => {
    expect(() => loadConfig(["--port", "invalid"], {})).toThrow("Invalid gateway port");
  });

  it("accepts the package-manager argument delimiter", () => {
    const config = loadConfig(["--", "--port", "4321", "--token", "0123456789abcdef"], {});

    expect(config.port).toBe(4321);
  });
});
