import type { IncomingMessage, ServerResponse } from "node:http";

export const PUBLIC_HEALTHZ_PATH = "/healthz";
export const PUBLIC_TELEGRAM_WEBHOOK_PATH = "/telegram-webhook";
export const PUBLIC_IFTTT_PREFIX = "/ifttt-webhook";
export const PUBLIC_HA_WEBHOOK_PATH = "/ha-webhook";

export function isPublicWebhookLockdownEnabled(): boolean {
  return process.env.OPENCLAW_PUBLIC_WEBHOOK_LOCKDOWN === "1";
}

export function sendVague404(res: ServerResponse) {
  res.statusCode = 404;
  res.end();
}

export function sendHealthz(res: ServerResponse) {
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end("ok");
}

export function isAllowedPublicWebhookRequest(req: IncomingMessage, pathname: string): boolean {
  const method = (req.method ?? "").toUpperCase();
  if (pathname === PUBLIC_HEALTHZ_PATH) {
    return method === "GET" || method === "HEAD";
  }
  if (pathname === PUBLIC_TELEGRAM_WEBHOOK_PATH) {
    return method === "POST";
  }
  if (pathname.startsWith(`${PUBLIC_IFTTT_PREFIX}/`)) {
    const rest = pathname.slice(`${PUBLIC_IFTTT_PREFIX}/`.length);
    return method === "POST" && rest.length > 0 && !rest.includes("/");
  }
  if (pathname === PUBLIC_HA_WEBHOOK_PATH) {
    return method === "POST";
  }
  return false;
}
