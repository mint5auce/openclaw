import { beforeEach, describe, expect, it, vi } from "vitest";
import { HaClient, HaClientError, buildHaBaseUrl } from "./ha-client.js";

describe("buildHaBaseUrl", () => {
  it("constructs base URL from subdomain", () => {
    expect(buildHaBaseUrl("example123")).toBe("https://example123.ui.nabu.casa");
  });

  it("trims whitespace and rejects empty input", () => {
    expect(() => buildHaBaseUrl("   ")).toThrow(HaClientError);
  });
});

describe("HaClient", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = originalFetch;
  });

  it("injects auth and content-type headers", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ message: "API running." }),
    });
    // @ts-expect-error test override
    global.fetch = mockFetch;

    const client = new HaClient({
      subdomain: "testsub",
      token: "secret-token",
    });
    await client.ping();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("https://testsub.ui.nabu.casa/api/");
    expect(init.headers).toMatchObject({
      Authorization: "Bearer secret-token",
      "Content-Type": "application/json",
    });
  });

  it("maps 401/403 to AUTH_ERROR", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => "Unauthorized",
    });
    // @ts-expect-error test override
    global.fetch = mockFetch;

    const client = new HaClient({
      subdomain: "testsub",
      token: "bad-token",
    });

    await expect(client.ping()).rejects.toMatchObject({
      type: "AUTH_ERROR",
    });
  });
});
