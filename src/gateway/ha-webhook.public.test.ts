import { beforeEach, describe, expect, it } from "vitest";
import { resolveMainSessionKeyFromConfig } from "../config/sessions/main-session.js";
import { drainSystemEvents, peekSystemEvents } from "../infra/system-events.js";
import { __resetHaWebhookStateForTest } from "./ha-webhook.js";
import {
  getFreePort,
  installGatewayTestHooks,
  startGatewayServer,
  waitForSystemEvent,
} from "./test-helpers.server.js";

installGatewayTestHooks({ scope: "suite" });

beforeEach(() => {
  delete process.env.OPENCLAW_PUBLIC_WEBHOOK_LOCKDOWN;
  delete process.env.HA_WEBHOOK_SECRET;
  delete process.env.HA_WEBHOOK_MAX_BODY_BYTES;
  delete process.env.HA_WEBHOOK_DEDUPE_TTL_MS;
  __resetHaWebhookStateForTest();
});

function haRequestInit(params: {
  secret?: string;
  body: unknown;
  contentType?: string;
}): RequestInit {
  const headers: Record<string, string> = {
    "content-type": params.contentType ?? "application/json",
  };
  if (params.secret) {
    headers["x-ha-webhook-secret"] = params.secret;
  }
  return {
    method: "POST",
    headers,
    body: typeof params.body === "string" ? params.body : JSON.stringify(params.body),
  };
}

describe("Public /ha-webhook", () => {
  it("enforces method/content-type and secret", async () => {
    process.env.HA_WEBHOOK_SECRET = "ha-secret";

    const port = await getFreePort();
    const server = await startGatewayServer(port, { bind: "loopback" });

    const methodRes = await fetch(`http://127.0.0.1:${port}/ha-webhook`);
    expect(methodRes.status).toBe(405);
    expect(await methodRes.json()).toMatchObject({ ok: false, error: "method_not_allowed" });

    const contentTypeRes = await fetch(
      `http://127.0.0.1:${port}/ha-webhook`,
      haRequestInit({
        secret: "ha-secret",
        contentType: "text/plain",
        body: { event_type: "state_changed", occurred_at: "2026-02-12T12:34:56Z" },
      }),
    );
    expect(contentTypeRes.status).toBe(415);

    const missingSecret = await fetch(
      `http://127.0.0.1:${port}/ha-webhook`,
      haRequestInit({
        body: { event_type: "state_changed", occurred_at: "2026-02-12T12:34:56Z" },
      }),
    );
    expect(missingSecret.status).toBe(401);

    const invalidSecret = await fetch(
      `http://127.0.0.1:${port}/ha-webhook`,
      haRequestInit({
        secret: "bad-secret",
        body: { event_type: "state_changed", occurred_at: "2026-02-12T12:34:56Z" },
      }),
    );
    expect(invalidSecret.status).toBe(403);

    await server.close();
  });

  it("rejects invalid payloads", async () => {
    process.env.HA_WEBHOOK_SECRET = "ha-secret";

    const port = await getFreePort();
    const server = await startGatewayServer(port, { bind: "loopback" });

    const badPayload = await fetch(
      `http://127.0.0.1:${port}/ha-webhook`,
      haRequestInit({
        secret: "ha-secret",
        body: { event_type: "state_changed" },
      }),
    );
    expect(badPayload.status).toBe(400);
    expect(await badPayload.json()).toMatchObject({ ok: false, error: "invalid_payload" });

    await server.close();
  });

  it("accepts valid payload and dedupes duplicates", async () => {
    process.env.HA_WEBHOOK_SECRET = "ha-secret";
    process.env.HA_WEBHOOK_DEDUPE_TTL_MS = String(60 * 60 * 1000);

    const port = await getFreePort();
    const server = await startGatewayServer(port, { bind: "loopback" });

    const sessionKey = resolveMainSessionKeyFromConfig();
    drainSystemEvents(sessionKey);

    const payload = {
      event_type: "state_changed",
      occurred_at: "2026-02-12T12:34:56Z",
      entity_id: "switch.office_plug",
      state: "on",
      attributes: { friendly_name: "Office Plug" },
      context: {},
    };

    const first = await fetch(
      `http://127.0.0.1:${port}/ha-webhook`,
      haRequestInit({ secret: "ha-secret", body: payload }),
    );
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ ok: true, deduped: false });

    const events = await waitForSystemEvent();
    expect(events.join("\n")).toContain(
      "HA action=state_changed entity=switch.office_plug state=on",
    );
    drainSystemEvents(sessionKey);

    const second = await fetch(
      `http://127.0.0.1:${port}/ha-webhook`,
      haRequestInit({ secret: "ha-secret", body: payload }),
    );
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ ok: true, deduped: true });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(peekSystemEvents(sessionKey).length).toBe(0);

    await server.close();
  });
});

describe("Public Webhook Lockdown", () => {
  it("allows /ha-webhook when lockdown is enabled", async () => {
    process.env.OPENCLAW_PUBLIC_WEBHOOK_LOCKDOWN = "1";
    process.env.HA_WEBHOOK_SECRET = "ha-secret";

    const port = await getFreePort();
    const server = await startGatewayServer(port, { bind: "loopback" });

    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(health.status).toBe(200);

    const other = await fetch(`http://127.0.0.1:${port}/v1/responses`, { method: "POST" });
    expect(other.status).toBe(404);

    const webhook = await fetch(
      `http://127.0.0.1:${port}/ha-webhook`,
      haRequestInit({
        secret: "ha-secret",
        body: {
          event_type: "state_changed",
          occurred_at: "2026-02-12T12:34:56Z",
        },
      }),
    );
    expect(webhook.status).toBe(200);

    await server.close();
  });
});
