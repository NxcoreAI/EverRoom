import type { AxiosInstance } from "axios";
import { describe, expect, it, vi } from "vitest";

import { ensureIntegration } from "../src/modules/connectors/nango-bootstrap.js";

describe("Nango integration bootstrap", () => {
  it("creates and repairs OAuth scopes without redundant updates", async () => {
    const scopes = "openid,email,profile,https://www.googleapis.com/auth/gmail.readonly";
    const post = vi.fn();
    const patch = vi.fn();
    const dashboard = { get: vi.fn(), post, patch } as unknown as AxiosInstance;

    dashboard.get = vi.fn().mockResolvedValueOnce({ status: 404 });
    await ensureIntegration(dashboard, "gmail", "google-mail", "client", "secret", scopes);
    expect(post).toHaveBeenCalledWith("/api/v1/integrations", expect.objectContaining({
      provider: "google-mail",
      auth: expect.objectContaining({ scopes }),
    }), { params: { env: "dev" } });

    dashboard.get = vi.fn().mockResolvedValueOnce({ status: 200, data: { data: { integration: { oauth_scopes: null } } } });
    await ensureIntegration(dashboard, "gmail", "google-mail", "client", "secret", scopes);
    expect(patch).toHaveBeenCalledWith("/api/v1/integrations/gmail", { authType: "OAUTH2", scopes }, { params: { env: "dev" } });

    patch.mockClear();
    dashboard.get = vi.fn().mockResolvedValueOnce({ status: 200, data: { data: { integration: { oauth_scopes: scopes } } } });
    await ensureIntegration(dashboard, "gmail", "google-mail", "client", "secret", scopes);
    expect(patch).not.toHaveBeenCalled();
  });
});
