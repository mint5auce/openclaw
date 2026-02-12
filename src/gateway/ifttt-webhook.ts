import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { resolveMainSessionKeyFromConfig } from "../config/sessions/main-session.js";
import { createInternalHookEvent, triggerInternalHook } from "../hooks/internal-hooks.js";
import { requestHeartbeatNow } from "../infra/heartbeat-wake.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { parseForwardedForClientIp } from "./net.js";

const log = createSubsystemLogger("webhooks/ifttt");

const IFTTT_PATH_PREFIX = "/ifttt-webhook";
const EVENT_TYPE_RE = /^[a-z0-9][a-z0-9_.-]*$/;

const InboundIftttSchema = z
  .object({
    event_type: z
      .string()
      .min(1)
      .max(64)
      .refine((v) => EVENT_TYPE_RE.test(v), "invalid event_type"),
    occurred_at: z
      .string()
      .min(1)
      .max(128)
      .refine((v) => Number.isFinite(Date.parse(v)), "invalid occurred_at"),
    value1: z.string().max(4096).optional(),
    value2: z.string().max(4096).optional(),
    value3: z.string().max(4096).optional(),
  })
  .strict();

export type NormalizedWebhookEvent = {
  v: 1;
  source: "ifttt";
  event_type: string;
  occurred_at: string;
  idempotency_key: string;
  data: { value1?: string; value2?: string; value3?: string };
  meta: { remote_addr: string; user_agent: string };
};

function envInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) {
    return fallback;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    return fallback;
  }
  return Math.floor(n);
}

function envFloat(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) {
    return fallback;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    return fallback;
  }
  return n;
}

function sendVague404(res: ServerResponse) {
  res.statusCode = 404;
  res.end();
}

function drainRequest(req: IncomingMessage) {
  // If we reject early without reading the body, leave the connection in a good
  // state for keep-alive / pooling clients (e.g. undici).
  req.on("error", () => {});
  req.on("data", () => {});
  req.on("end", () => {});
  req.resume();
}

function isJsonContentType(req: IncomingMessage): boolean {
  const raw = typeof req.headers["content-type"] === "string" ? req.headers["content-type"] : "";
  const ct = raw.toLowerCase();
  return ct === "application/json" || ct.startsWith("application/json;");
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) {
    return false;
  }
  return timingSafeEqual(ba, bb);
}

function resolveClientIp(req: IncomingMessage): string {
  const fly = typeof req.headers["fly-client-ip"] === "string" ? req.headers["fly-client-ip"] : "";
  if (fly.trim()) {
    return fly.trim();
  }
  const xff =
    typeof req.headers["x-forwarded-for"] === "string" ? req.headers["x-forwarded-for"] : "";
  const parsed = parseForwardedForClientIp(xff);
  if (parsed) {
    return parsed;
  }
  return req.socket?.remoteAddress ?? "";
}

async function readJsonBodyBounded(
  req: IncomingMessage,
  maxBytes: number,
): Promise<
  { ok: true; value: unknown } | { ok: false; error: "payload too large" | "invalid json" }
> {
  return await new Promise((resolve) => {
    let done = false;
    let total = 0;
    const chunks: Buffer[] = [];

    const resolveOnce = (
      result:
        | { ok: true; value: unknown }
        | { ok: false; error: "payload too large" | "invalid json" },
    ) => {
      if (done) {
        return;
      }
      done = true;
      resolve(result);
    };

    const onData = (chunk: Buffer | Uint8Array | string) => {
      if (done) {
        return;
      }
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (total > maxBytes) {
        resolveOnce({ ok: false, error: "payload too large" });
        // Drain the rest without buffering to keep the connection usable.
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
        resolveOnce({ ok: false, error: "invalid json" });
      }
    };

    const onError = () => resolveOnce({ ok: false, error: "invalid json" });
    const onClose = () => resolveOnce({ ok: false, error: "invalid json" });

    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
    req.on("close", onClose);
  });
}

type TokenBucket = {
  tokens: number;
  updatedAtMs: number;
};

function allowTokenBucket(params: {
  bucket: TokenBucket;
  nowMs: number;
  ratePerSec: number;
  burst: number;
}): boolean {
  const { bucket, nowMs, ratePerSec, burst } = params;
  const elapsedMs = Math.max(0, nowMs - bucket.updatedAtMs);
  const refill = (elapsedMs / 1000) * ratePerSec;
  bucket.tokens = Math.min(burst, bucket.tokens + refill);
  bucket.updatedAtMs = nowMs;
  if (bucket.tokens < 1) {
    return false;
  }
  bucket.tokens -= 1;
  return true;
}

type DedupeEntry = { expiresAtMs: number };
const dedupe = new Map<string, DedupeEntry>();

const ipBuckets = new Map<string, TokenBucket>();
const globalBucket: TokenBucket = { tokens: 20, updatedAtMs: Date.now() };

type WorkItem = { event: NormalizedWebhookEvent; receivedAtMs: number };
const workQueue: WorkItem[] = [];
let workScheduled = false;
const MAX_QUEUE = 1000;

function scheduleDrain() {
  if (workScheduled) {
    return;
  }
  workScheduled = true;
  setImmediate(() => {
    workScheduled = false;
    while (workQueue.length > 0) {
      const item = workQueue.shift();
      if (!item) {
        continue;
      }
      void processWorkItem(item).catch((err) => {
        log.warn("ifttt_webhook.worker_error", { err: String(err) });
      });
    }
  });
}

async function processWorkItem(item: WorkItem) {
  const mainSessionKey = resolveMainSessionKeyFromConfig();

  const d = item.event.data;
  const parts = [
    `IFTTT: ${item.event.event_type}`,
    d.value1 ? `value1=${d.value1}` : null,
    d.value2 ? `value2=${d.value2}` : null,
    d.value3 ? `value3=${d.value3}` : null,
  ].filter(Boolean);
  enqueueSystemEvent(parts.join(" ").trim(), {
    sessionKey: mainSessionKey,
    contextKey: `ifttt:${item.event.idempotency_key}`,
  });
  requestHeartbeatNow({ reason: "ifttt:webhook" });

  const hookEvent = createInternalHookEvent("gateway", "webhook.ifttt", mainSessionKey, {
    event: item.event,
    receivedAtMs: item.receivedAtMs,
  });
  await triggerInternalHook(hookEvent);
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

function normalizeInbound(params: {
  payload: z.infer<typeof InboundIftttSchema>;
  remoteAddr: string;
  userAgent: string;
}): NormalizedWebhookEvent {
  const occurredAt = new Date(params.payload.occurred_at).toISOString();
  const eventType = `ifttt.${params.payload.event_type}`;
  const v1 = params.payload.value1 ?? "";
  const v2 = params.payload.value2 ?? "";
  const v3 = params.payload.value3 ?? "";
  const idemRaw = `v1|${eventType}|${occurredAt}|${v1}|${v2}|${v3}`;
  const idempotencyKey = createHash("sha256").update(idemRaw).digest("hex");
  const data: NormalizedWebhookEvent["data"] = {};
  if (params.payload.value1 !== undefined) {
    data.value1 = params.payload.value1;
  }
  if (params.payload.value2 !== undefined) {
    data.value2 = params.payload.value2;
  }
  if (params.payload.value3 !== undefined) {
    data.value3 = params.payload.value3;
  }
  return {
    v: 1,
    source: "ifttt",
    event_type: eventType,
    occurred_at: occurredAt,
    idempotency_key: idempotencyKey,
    data,
    meta: {
      remote_addr: params.remoteAddr.slice(0, 128),
      user_agent: params.userAgent.slice(0, 512),
    },
  };
}

function extractPathToken(pathname: string): string | null {
  if (!pathname.startsWith(`${IFTTT_PATH_PREFIX}/`)) {
    return null;
  }
  const rest = pathname.slice(`${IFTTT_PATH_PREFIX}/`.length);
  if (!rest || rest.includes("/")) {
    return null;
  }
  return rest;
}

export async function handleIftttWebhookRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const pathToken = extractPathToken(url.pathname);
  if (!pathToken) {
    return false;
  }

  const nowMs = Date.now();
  const clientIp = resolveClientIp(req);
  const ua = typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : "";

  const perMin = envInt("IFTTT_RATELIMIT_PER_MIN", 30);
  const burst = envInt("IFTTT_RATELIMIT_BURST", 10);
  const globalRps = envFloat("IFTTT_RATELIMIT_GLOBAL_RPS", 5);
  const globalBurst = envInt("IFTTT_RATELIMIT_GLOBAL_BURST", 20);

  const ipKey = clientIp || "unknown";
  const ipBucket =
    ipBuckets.get(ipKey) ??
    (() => {
      const created = { tokens: burst, updatedAtMs: nowMs };
      ipBuckets.set(ipKey, created);
      return created;
    })();
  const ipOk = allowTokenBucket({
    bucket: ipBucket,
    nowMs,
    ratePerSec: perMin / 60,
    burst,
  });
  const globalOk = allowTokenBucket({
    bucket: globalBucket,
    nowMs,
    ratePerSec: globalRps,
    burst: globalBurst,
  });
  if (!ipOk || !globalOk) {
    log.warn("ifttt_webhook.rate_limited", { ip: ipKey });
    drainRequest(req);
    sendVague404(res);
    return true;
  }

  if (req.method !== "POST") {
    log.warn("ifttt_webhook.rejected", { reason: "method", ip: ipKey });
    drainRequest(req);
    sendVague404(res);
    return true;
  }
  if (!isJsonContentType(req)) {
    log.warn("ifttt_webhook.rejected", { reason: "content_type", ip: ipKey });
    drainRequest(req);
    sendVague404(res);
    return true;
  }

  const expectedPathToken = (process.env.IFTTT_PATH_TOKEN ?? "").trim();
  const expectedHeaderToken = (process.env.IFTTT_HEADER_TOKEN ?? "").trim();
  const headerToken =
    typeof req.headers["x-ifttt-token"] === "string" ? req.headers["x-ifttt-token"] : "";

  if (!expectedPathToken || !expectedHeaderToken) {
    log.warn("ifttt_webhook.rejected", { reason: "missing_env", ip: ipKey });
    drainRequest(req);
    sendVague404(res);
    return true;
  }
  if (!safeEqual(pathToken, expectedPathToken)) {
    log.warn("ifttt_webhook.rejected", { reason: "bad_path_token", ip: ipKey });
    drainRequest(req);
    sendVague404(res);
    return true;
  }
  if (!headerToken || !safeEqual(headerToken, expectedHeaderToken)) {
    log.warn("ifttt_webhook.rejected", { reason: "bad_header_token", ip: ipKey });
    drainRequest(req);
    sendVague404(res);
    return true;
  }

  const maxBytes = envInt("IFTTT_MAX_BODY_BYTES", 64 * 1024);
  const body = await readJsonBodyBounded(req, maxBytes);
  if (!body.ok) {
    log.warn("ifttt_webhook.rejected", { reason: "body", ip: ipKey });
    sendVague404(res);
    return true;
  }

  const parsed = InboundIftttSchema.safeParse(body.value);
  if (!parsed.success) {
    log.warn("ifttt_webhook.rejected", { reason: "schema", ip: ipKey });
    sendVague404(res);
    return true;
  }

  gcDedupe(nowMs);
  const normalized = normalizeInbound({
    payload: parsed.data,
    remoteAddr: clientIp,
    userAgent: ua,
  });

  const ttlMs = envInt("IFTTT_DEDUPE_TTL_MS", 45 * 60 * 1000);
  const key = normalized.idempotency_key;
  const existing = dedupe.get(key);
  if (existing && existing.expiresAtMs > nowMs) {
    log.info("ifttt_webhook.dedupe_hit", { ip: ipKey, event_type: normalized.event_type });
    res.statusCode = 204;
    res.end();
    return true;
  }
  dedupe.set(key, { expiresAtMs: nowMs + ttlMs });

  if (workQueue.length >= MAX_QUEUE) {
    log.error("ifttt_webhook.enqueue_failure", { reason: "queue_full", ip: ipKey });
    res.statusCode = 204;
    res.end();
    return true;
  }
  workQueue.push({ event: normalized, receivedAtMs: nowMs });
  scheduleDrain();

  log.info("ifttt_webhook.accepted", {
    ip: ipKey,
    event_type: normalized.event_type,
    idempotency_prefix: normalized.idempotency_key.slice(0, 12),
  });

  res.statusCode = 204;
  res.end();
  return true;
}

export function __resetIftttWebhookStateForTest() {
  dedupe.clear();
  ipBuckets.clear();
  workQueue.length = 0;
  workScheduled = false;
  globalBucket.tokens = 20;
  globalBucket.updatedAtMs = Date.now();
}
