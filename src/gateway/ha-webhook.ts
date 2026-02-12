import type { IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { resolveMainSessionKeyFromConfig } from "../config/sessions/main-session.js";
import { createInternalHookEvent, triggerInternalHook } from "../hooks/internal-hooks.js";
import { requestHeartbeatNow } from "../infra/heartbeat-wake.js";
import { enqueueSystemEvent } from "../infra/system-events.js";

export const HA_WEBHOOK_PATH = "/ha-webhook";

export interface HaWebhookRawPayload {
  event_type?: unknown;
  occurred_at?: unknown;
  action?: unknown;
  entity_id?: unknown;
  state?: unknown;
  attributes?: unknown;
  context?: unknown;
}

export interface HaWebhookEvent {
  event_type: "ha_webhook";
  occurred_at: string;
  source: "home_assistant";
  action: string;
  entity_id?: string;
  state?: string;
  attributes: Record<string, unknown>;
  context: Record<string, unknown>;
}

const InboundHaWebhookSchema = z
  .object({
    event_type: z.string().min(1).max(128),
    occurred_at: z
      .string()
      .min(1)
      .max(128)
      .refine(
        (value) => Number.isFinite(Date.parse(value)),
        "occurred_at must be an ISO timestamp",
      ),
    action: z.string().min(1).max(128).optional(),
    entity_id: z.string().min(1).max(256).optional(),
    state: z.string().min(1).max(128).optional(),
    attributes: z.record(z.string(), z.unknown()).optional(),
    context: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

type DedupeEntry = {
  expiresAtMs: number;
};

const dedupe = new Map<string, DedupeEntry>();

function sendJson(res: ServerResponse, statusCode: number, payload: unknown) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    return fallback;
  }
  return Math.floor(n);
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) {
    return false;
  }
  return timingSafeEqual(ba, bb);
}

function isJsonContentType(req: IncomingMessage): boolean {
  const raw = typeof req.headers["content-type"] === "string" ? req.headers["content-type"] : "";
  const normalized = raw.toLowerCase();
  return normalized === "application/json" || normalized.startsWith("application/json;");
}

async function readJsonBodyBounded(
  req: IncomingMessage,
  maxBytes: number,
): Promise<
  { ok: true; value: unknown } | { ok: false; error: "payload_too_large" | "invalid_json" }
> {
  return await new Promise((resolve) => {
    let done = false;
    let total = 0;
    const chunks: Buffer[] = [];

    const resolveOnce = (
      value:
        | { ok: true; value: unknown }
        | { ok: false; error: "payload_too_large" | "invalid_json" },
    ) => {
      if (done) {
        return;
      }
      done = true;
      resolve(value);
    };

    const onData = (chunk: Buffer | Uint8Array | string) => {
      if (done) {
        return;
      }
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (total > maxBytes) {
        resolveOnce({ ok: false, error: "payload_too_large" });
        req.off("data", onData);
        req.off("end", onEnd);
        req.off("error", onError);
        req.off("close", onClose);
        req.on("error", () => {});
        req.on("data", () => {});
        req.on("end", () => {});
        req.resume();
        return;
      }
      chunks.push(buf);
    };

    const onEnd = () => {
      if (done) {
        return;
      }
      const raw = Buffer.concat(chunks).toString("utf-8").trim();
      if (!raw) {
        resolveOnce({ ok: true, value: {} });
        return;
      }
      try {
        resolveOnce({ ok: true, value: JSON.parse(raw) as unknown });
      } catch {
        resolveOnce({ ok: false, error: "invalid_json" });
      }
    };

    const onError = () => resolveOnce({ ok: false, error: "invalid_json" });
    const onClose = () => resolveOnce({ ok: false, error: "invalid_json" });

    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
    req.on("close", onClose);
  });
}

function toCanonicalEvent(payload: z.infer<typeof InboundHaWebhookSchema>): HaWebhookEvent {
  const normalizedOccurredAt = new Date(payload.occurred_at).toISOString();
  const action = payload.action?.trim()
    ? payload.action.trim()
    : payload.event_type === "state_changed"
      ? "state_changed"
      : payload.event_type === "automation_triggered"
        ? "automation_triggered"
        : "custom";

  return {
    event_type: "ha_webhook",
    occurred_at: normalizedOccurredAt,
    source: "home_assistant",
    action,
    entity_id: payload.entity_id,
    state: payload.state,
    attributes: payload.attributes ?? {},
    context: payload.context ?? {},
  };
}

function buildDedupeKey(event: HaWebhookEvent): string {
  return [event.occurred_at, event.action, event.entity_id ?? "", event.state ?? ""].join("|");
}

function gcDedupe(nowMs: number) {
  let scanned = 0;
  for (const [key, entry] of dedupe) {
    scanned += 1;
    if (entry.expiresAtMs <= nowMs) {
      dedupe.delete(key);
    }
    if (scanned >= 200) {
      break;
    }
  }
}

export async function handleHaWebhookRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname !== HA_WEBHOOK_PATH) {
    return false;
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    sendJson(res, 405, { ok: false, error: "method_not_allowed" });
    return true;
  }

  if (!isJsonContentType(req)) {
    sendJson(res, 415, { ok: false, error: "content_type_must_be_application_json" });
    return true;
  }

  const expectedSecret = (process.env.HA_WEBHOOK_SECRET ?? "").trim();
  if (!expectedSecret) {
    sendJson(res, 503, { ok: false, error: "ha_webhook_not_configured" });
    return true;
  }

  const providedSecretRaw = req.headers["x-ha-webhook-secret"];
  const providedSecret =
    typeof providedSecretRaw === "string"
      ? providedSecretRaw
      : Array.isArray(providedSecretRaw)
        ? providedSecretRaw[0]
        : "";
  if (!providedSecret) {
    sendJson(res, 401, { ok: false, error: "missing_webhook_secret" });
    return true;
  }
  if (!safeEqual(providedSecret, expectedSecret)) {
    sendJson(res, 403, { ok: false, error: "invalid_webhook_secret" });
    return true;
  }

  const body = await readJsonBodyBounded(req, envInt("HA_WEBHOOK_MAX_BODY_BYTES", 64 * 1024));
  if (!body.ok) {
    if (body.error === "payload_too_large") {
      sendJson(res, 413, { ok: false, error: body.error });
      return true;
    }
    sendJson(res, 400, { ok: false, error: body.error });
    return true;
  }

  const parsed = InboundHaWebhookSchema.safeParse(body.value);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((issue) => issue.message).join("; ");
    sendJson(res, 400, { ok: false, error: "invalid_payload", detail });
    return true;
  }

  const event = toCanonicalEvent(parsed.data);
  const nowMs = Date.now();
  gcDedupe(nowMs);

  const dedupeKey = buildDedupeKey(event);
  const existing = dedupe.get(dedupeKey);
  if (existing && existing.expiresAtMs > nowMs) {
    sendJson(res, 200, { ok: true, deduped: true });
    return true;
  }
  dedupe.set(dedupeKey, {
    expiresAtMs: nowMs + envInt("HA_WEBHOOK_DEDUPE_TTL_MS", 5 * 60 * 1000),
  });

  try {
    const mainSessionKey = resolveMainSessionKeyFromConfig();
    const parts = [
      "HA",
      event.action ? `action=${event.action}` : null,
      event.entity_id ? `entity=${event.entity_id}` : null,
      event.state ? `state=${event.state}` : null,
    ].filter(Boolean);
    enqueueSystemEvent(parts.join(" "), {
      sessionKey: mainSessionKey,
      contextKey: `ha:${dedupeKey}`,
    });
    requestHeartbeatNow({ reason: "ha:webhook" });

    const hookEvent = createInternalHookEvent("gateway", "webhook.ha", mainSessionKey, {
      event,
      receivedAtMs: nowMs,
    });
    await triggerInternalHook(hookEvent);
  } catch {
    sendJson(res, 500, { ok: false, error: "internal_error" });
    return true;
  }

  sendJson(res, 200, { ok: true, deduped: false });
  return true;
}

export function __resetHaWebhookStateForTest() {
  dedupe.clear();
}
