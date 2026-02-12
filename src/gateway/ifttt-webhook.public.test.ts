import { beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { resolveMainSessionKeyFromConfig } from "../config/sessions/main-session.js";
import { drainSystemEvents, peekSystemEvents } from "../infra/system-events.js";
import { __resetIftttWebhookStateForTest } from "./ifttt-webhook.js";
import {
  getFreePort,
  installGatewayTestHooks,
  startGatewayServer,
  waitForSystemEvent,
} from "./test-helpers.server.js";

installGatewayTestHooks({ scope: "suite" });

beforeEach(() => {
  delete process.env.OPENCLAW_PUBLIC_WEBHOOK_LOCKDOWN;
  delete process.env.IFTTT_PATH_TOKEN;
  delete process.env.IFTTT_HEADER_TOKEN;
  delete process.env.IFTTT_MAX_BODY_BYTES;
  delete process.env.IFTTT_DEDUPE_TTL_MS;
  delete process.env.IFTTT_RATELIMIT_PER_MIN;
  delete process.env.IFTTT_RATELIMIT_BURST;
  delete process.env.IFTTT_RATELIMIT_GLOBAL_RPS;
  delete process.env.IFTTT_RATELIMIT_GLOBAL_BURST;
  delete process.env.HA_WEBHOOK_SECRET;
  __resetIftttWebhookStateForTest();
});

function iftttRequestInit(params: { headerToken: string; body: unknown; contentType?: string }) {
  return {
    method: "POST",
    headers: {
      "content-type": params.contentType ?? "application/json",
      "x-ifttt-token": params.headerToken,
    },
    body: typeof params.body === "string" ? params.body : JSON.stringify(params.body),
  } satisfies RequestInit;
}

describe("Public /ifttt-webhook/:pathToken", () => {
  it("enforces method and content-type (vague 404)", async () => {
    process.env.IFTTT_PATH_TOKEN = "ptok";
    process.env.IFTTT_HEADER_TOKEN = "htok";

    const port = await getFreePort();
    const server = await startGatewayServer(port, { bind: "loopback" });

    const r1 = await fetch(`http://127.0.0.1:${port}/ifttt-webhook/ptok`);
    expect(r1.status).toBe(404);

    const r2 = await fetch(`http://127.0.0.1:${port}/ifttt-webhook/ptok`, {
      ...iftttRequestInit({
        headerToken: "htok",
        body: { event_type: "x", occurred_at: "2026-02-10T00:00:00Z" },
        contentType: "text/plain",
      }),
    });
    expect(r2.status).toBe(404);

    const r3 = await fetch(`http://127.0.0.1:${port}/ifttt-webhook/ptok`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-ifttt-token": "htok" },
      body: "{",
    });
    expect(r3.status).toBe(404);

    await server.close();
  });

  it("enforces path token and header token (vague 404)", async () => {
    process.env.IFTTT_PATH_TOKEN = "ptok";
    process.env.IFTTT_HEADER_TOKEN = "htok";

    const port = await getFreePort();
    const server = await startGatewayServer(port, { bind: "loopback" });

    const badPath = await fetch(
      `http://127.0.0.1:${port}/ifttt-webhook/nope`,
      iftttRequestInit({
        headerToken: "htok",
        body: { event_type: "x", occurred_at: "2026-02-10T00:00:00Z" },
      }),
    );
    expect(badPath.status).toBe(404);

    const badHeader = await fetch(
      `http://127.0.0.1:${port}/ifttt-webhook/ptok`,
      iftttRequestInit({
        headerToken: "nope",
        body: { event_type: "x", occurred_at: "2026-02-10T00:00:00Z" },
      }),
    );
    expect(badHeader.status).toBe(404);

    const ok = await fetch(
      `http://127.0.0.1:${port}/ifttt-webhook/ptok`,
      iftttRequestInit({
        headerToken: "htok",
        body: { event_type: "x", occurred_at: "2026-02-10T00:00:00Z" },
      }),
    );
    expect(ok.status).toBe(204);

    await server.close();
  });

  it("fails closed on schema violations (extra keys rejected)", async () => {
    process.env.IFTTT_PATH_TOKEN = "ptok";
    process.env.IFTTT_HEADER_TOKEN = "htok";

    const port = await getFreePort();
    const server = await startGatewayServer(port, { bind: "loopback" });

    const res = await fetch(
      `http://127.0.0.1:${port}/ifttt-webhook/ptok`,
      iftttRequestInit({
        headerToken: "htok",
        body: { event_type: "x", occurred_at: "2026-02-10T00:00:00Z", extra: "nope" },
      }),
    );
    expect(res.status).toBe(404);

    await server.close();
  });

  it("enforces a strict body size limit", async () => {
    process.env.IFTTT_PATH_TOKEN = "ptok";
    process.env.IFTTT_HEADER_TOKEN = "htok";
    process.env.IFTTT_MAX_BODY_BYTES = "128";

    const port = await getFreePort();
    const server = await startGatewayServer(port, { bind: "loopback" });

    const big = {
      event_type: "x",
      occurred_at: "2026-02-10T00:00:00Z",
      value1: "a".repeat(400),
    };

    const res = await fetch(
      `http://127.0.0.1:${port}/ifttt-webhook/ptok`,
      iftttRequestInit({
        headerToken: "htok",
        body: big,
      }),
    );
    expect(res.status).toBe(404);

    await server.close();
  });

  it("dedupes by idempotency_key (duplicate is acked but not processed again)", async () => {
    process.env.IFTTT_PATH_TOKEN = "ptok";
    process.env.IFTTT_HEADER_TOKEN = "htok";
    process.env.IFTTT_DEDUPE_TTL_MS = String(60 * 60 * 1000);

    const port = await getFreePort();
    const server = await startGatewayServer(port, { bind: "loopback" });

    const sessionKey = resolveMainSessionKeyFromConfig();
    drainSystemEvents(sessionKey);

    const payload = {
      event_type: "alert_motion",
      occurred_at: "2026-02-10T12:34:56Z",
      value1: "frontdoor",
    };

    const r1 = await fetch(
      `http://127.0.0.1:${port}/ifttt-webhook/ptok`,
      iftttRequestInit({
        headerToken: "htok",
        body: payload,
      }),
    );
    expect(r1.status).toBe(204);

    const events1 = await waitForSystemEvent();
    expect(events1.join("\n")).toContain("IFTTT: ifttt.alert_motion");
    drainSystemEvents(sessionKey);

    const r2 = await fetch(
      `http://127.0.0.1:${port}/ifttt-webhook/ptok`,
      iftttRequestInit({
        headerToken: "htok",
        body: payload,
      }),
    );
    expect(r2.status).toBe(204);

    await new Promise((r) => setTimeout(r, 50));
    expect(peekSystemEvents(sessionKey).length).toBe(0);

    await server.close();
  });

  it("rate limits per IP", async () => {
    process.env.IFTTT_PATH_TOKEN = "ptok";
    process.env.IFTTT_HEADER_TOKEN = "htok";
    process.env.IFTTT_RATELIMIT_PER_MIN = "1";
    process.env.IFTTT_RATELIMIT_BURST = "1";

    const port = await getFreePort();
    const server = await startGatewayServer(port, { bind: "loopback" });

    const payload = { event_type: "x", occurred_at: "2026-02-10T00:00:00Z" };

    const r1 = await fetch(
      `http://127.0.0.1:${port}/ifttt-webhook/ptok`,
      iftttRequestInit({
        headerToken: "htok",
        body: payload,
      }),
    );
    expect(r1.status).toBe(204);

    const r2 = await fetch(
      `http://127.0.0.1:${port}/ifttt-webhook/ptok`,
      iftttRequestInit({
        headerToken: "htok",
        body: payload,
      }),
    );
    expect(r2.status).toBe(404);

    await server.close();
  });
});

describe("Public Webhook Lockdown", () => {
  it("serves only allowlisted public webhook routes when enabled", async () => {
    process.env.OPENCLAW_PUBLIC_WEBHOOK_LOCKDOWN = "1";
    process.env.IFTTT_PATH_TOKEN = "ptok";
    process.env.IFTTT_HEADER_TOKEN = "htok";
    process.env.HA_WEBHOOK_SECRET = "ha-secret";

    const port = await getFreePort();
    const server = await startGatewayServer(port, { bind: "loopback" });

    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.text()).toBe("ok");

    const other = await fetch(`http://127.0.0.1:${port}/v1/responses`, { method: "POST" });
    expect(other.status).toBe(404);

    const ifttt = await fetch(
      `http://127.0.0.1:${port}/ifttt-webhook/ptok`,
      iftttRequestInit({
        headerToken: "htok",
        body: { event_type: "x", occurred_at: "2026-02-10T00:00:00Z" },
      }),
    );
    expect(ifttt.status).toBe(204);

    const ha = await fetch(`http://127.0.0.1:${port}/ha-webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-ha-webhook-secret": "ha-secret",
      },
      body: JSON.stringify({
        event_type: "state_changed",
        occurred_at: "2026-02-10T00:00:00Z",
      }),
    });
    expect(ha.status).toBe(200);

    // WS upgrades should be blocked.
    const wsResult = await new Promise<"error" | "close" | "open">((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      ws.once("open", () => resolve("open"));
      ws.once("error", () => resolve("error"));
      ws.once("close", () => resolve("close"));
    });
    expect(wsResult).not.toBe("open");

    await server.close();
  });
});
