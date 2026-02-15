import type { TlsOptions } from "node:tls";
import type { WebSocketServer } from "ws";
import { webhookCallback } from "grammy";
import {
  createServer as createHttpServer,
  request as httpRequest,
  type Server as HttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createServer as createHttpsServer, request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
import type { CanvasHostHandler } from "../canvas-host/server.js";
import type { createSubsystemLogger } from "../logging/subsystem.js";
import type { GatewayWsClient } from "./server/ws-types.js";
import { resolveAgentAvatar } from "../agents/identity-avatar.js";
import {
  A2UI_PATH,
  CANVAS_HOST_PATH,
  CANVAS_WS_PATH,
  handleA2uiHttpRequest,
} from "../canvas-host/a2ui.js";
import { loadConfig } from "../config/config.js";
import { handleSlackHttpRequest } from "../slack/http/index.js";
import { resolveTelegramAccount } from "../telegram/accounts.js";
import { createTelegramBot } from "../telegram/bot.js";
import { authorizeGatewayConnect, isLocalDirectRequest, type ResolvedGatewayAuth } from "./auth.js";
import {
  handleControlUiAvatarRequest,
  handleControlUiHttpRequest,
  type ControlUiRootState,
} from "./control-ui.js";
import { handleHaWebhookRequest } from "./ha-webhook.js";
import { applyHookMappings } from "./hooks-mapping.js";
import {
  extractHookToken,
  getHookChannelError,
  type HookMessageChannel,
  type HooksConfigResolved,
  normalizeAgentPayload,
  normalizeHookHeaders,
  normalizeWakePayload,
  readJsonBody,
  resolveHookChannel,
  resolveHookDeliver,
} from "./hooks.js";
import { sendUnauthorized } from "./http-common.js";
import { getBearerToken, getHeader } from "./http-utils.js";
import { handleIftttWebhookRequest } from "./ifttt-webhook.js";
import { resolveGatewayClientIp } from "./net.js";
import { handleOpenAiHttpRequest } from "./openai-http.js";
import { handleOpenResponsesHttpRequest } from "./openresponses-http.js";
import {
  isAllowedPublicWebhookRequest,
  isPublicWebhookLockdownEnabled,
  PUBLIC_HEALTHZ_PATH,
  PUBLIC_TELEGRAM_WEBHOOK_PATH,
  sendHealthz,
  sendVague404,
} from "./public-webhook-lockdown.js";
import { handleToolsInvokeHttpRequest } from "./tools-invoke-http.js";

type SubsystemLogger = ReturnType<typeof createSubsystemLogger>;

type HookDispatchers = {
  dispatchWakeHook: (value: { text: string; mode: "now" | "next-heartbeat" }) => void;
  dispatchAgentHook: (value: {
    message: string;
    name: string;
    wakeMode: "now" | "next-heartbeat";
    sessionKey: string;
    deliver: boolean;
    channel: HookMessageChannel;
    to?: string;
    model?: string;
    thinking?: string;
    timeoutSeconds?: number;
    allowUnsafeExternalContent?: boolean;
  }) => string;
};

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function isCanvasPath(pathname: string): boolean {
  return (
    pathname === A2UI_PATH ||
    pathname.startsWith(`${A2UI_PATH}/`) ||
    pathname === CANVAS_HOST_PATH ||
    pathname.startsWith(`${CANVAS_HOST_PATH}/`) ||
    pathname === CANVAS_WS_PATH
  );
}

const CHAT_BACKEND_BASE_URL_ENV = "CHAT_BACKEND_BASE_URL";

function resolveChatBackendBaseUrl(): URL | null {
  const raw = process.env[CHAT_BACKEND_BASE_URL_ENV]?.trim();
  if (!raw) {
    return null;
  }
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function isChatBackendWsPath(pathname: string): boolean {
  return pathname === "/v1/ws" || pathname === "/v1/ws/";
}

function isChatBackendHttpPath(pathname: string): boolean {
  return (
    pathname === "/v1/sessions" ||
    pathname === "/v1/conversations" ||
    pathname.startsWith("/v1/conversations/") ||
    pathname === "/v1/uploads" ||
    pathname.startsWith("/v1/uploads/") ||
    pathname === "/v1/devices/apns" ||
    isChatBackendWsPath(pathname)
  );
}

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function shouldStripResponseHeader(name: string): boolean {
  return HOP_BY_HOP_HEADERS.has(name.toLowerCase());
}

function appendForwardedFor(req: IncomingMessage, upstreamHeaders: Headers) {
  const clientIp = req.socket.remoteAddress;
  if (!clientIp) {
    return;
  }
  const existing = getHeader(req, "x-forwarded-for");
  const next = existing ? `${existing}, ${clientIp}` : clientIp;
  upstreamHeaders.set("x-forwarded-for", next);
}

function resolvePublicGatewayBases(req: IncomingMessage): {
  apiBaseUrl: string;
  wsUrl: string;
} | null {
  const host = getHeader(req, "x-forwarded-host") ?? req.headers.host;
  if (!host) {
    return null;
  }
  const protoHeader = getHeader(req, "x-forwarded-proto") ?? "https";
  const proto = protoHeader.split(",")[0]?.trim().toLowerCase() === "http" ? "http" : "https";
  const wsProto = proto === "http" ? "ws" : "wss";
  return {
    apiBaseUrl: `${proto}://${host}`,
    wsUrl: `${wsProto}://${host}/v1/ws`,
  };
}

async function readRawBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    if (typeof chunk === "string") {
      chunks.push(Buffer.from(chunk));
    } else {
      chunks.push(chunk);
    }
  }
  return Buffer.concat(chunks);
}

async function handleChatBackendProxyHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  const baseUrl = resolveChatBackendBaseUrl();
  if (!baseUrl || !isChatBackendHttpPath(url.pathname)) {
    return false;
  }

  try {
    const targetUrl = new URL(req.url ?? "/", baseUrl);
    const method = (req.method ?? "GET").toUpperCase();
    const upstreamHeaders = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      const lower = name.toLowerCase();
      if (value === undefined || lower === "host" || HOP_BY_HOP_HEADERS.has(lower)) {
        continue;
      }
      if (Array.isArray(value)) {
        for (const item of value) {
          upstreamHeaders.append(name, item);
        }
      } else {
        upstreamHeaders.set(name, value);
      }
    }
    appendForwardedFor(req, upstreamHeaders);
    upstreamHeaders.set("x-forwarded-host", req.headers.host ?? "");
    upstreamHeaders.set("accept-encoding", "identity");

    const requestInit: RequestInit = {
      method,
      headers: upstreamHeaders,
      redirect: "manual",
    };
    if (method !== "GET" && method !== "HEAD") {
      requestInit.body = await readRawBody(req);
    }

    const upstream = await fetch(targetUrl, requestInit);
    res.statusCode = upstream.status;
    const rewriteSessionUrls = url.pathname === "/v1/sessions";

    for (const [name, value] of upstream.headers.entries()) {
      if (shouldStripResponseHeader(name)) {
        continue;
      }
      if (name.toLowerCase() === "content-encoding") {
        continue;
      }
      if (rewriteSessionUrls && name.toLowerCase() === "content-length") {
        continue;
      }
      res.setHeader(name, value);
    }

    if (rewriteSessionUrls) {
      const raw = await upstream.text();
      let body = raw;
      const publicBases = resolvePublicGatewayBases(req);
      if (publicBases) {
        try {
          const parsed = JSON.parse(raw) as Record<string, unknown>;
          if (parsed && typeof parsed === "object") {
            parsed.api_base_url = publicBases.apiBaseUrl;
            parsed.ws_url = publicBases.wsUrl;
            body = JSON.stringify(parsed);
          }
        } catch {
          // ignore parse failures; forward original body
        }
      }
      res.setHeader("content-length", Buffer.byteLength(body));
      res.end(body);
      return true;
    }

    if (!upstream.body) {
      res.end();
      return true;
    }

    Readable.fromWeb(upstream.body as never).pipe(res);
    return true;
  } catch {
    res.statusCode = 502;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: false, error: "chat_backend_proxy_failed" }));
    return true;
  }
}

function writeRawHttpResponseHead(socket: NodeJS.WritableStream, statusLine: string, rawHeaders: string[]) {
  socket.write(`${statusLine}\r\n`);
  for (let i = 0; i < rawHeaders.length; i += 2) {
    socket.write(`${rawHeaders[i]}: ${rawHeaders[i + 1]}\r\n`);
  }
  socket.write("\r\n");
}

function handleChatBackendProxyUpgrade(req: IncomingMessage, socket: NodeJS.WritableStream, head: Buffer): boolean {
  const baseUrl = resolveChatBackendBaseUrl();
  if (!baseUrl) {
    return false;
  }
  const url = new URL(req.url ?? "/", "http://localhost");
  if (!isChatBackendWsPath(url.pathname)) {
    return false;
  }

  const isHttpsTarget = baseUrl.protocol === "https:";
  const requestUpstream = isHttpsTarget ? httpsRequest : httpRequest;
  const upstreamReq = requestUpstream({
    protocol: baseUrl.protocol,
    hostname: baseUrl.hostname,
    port: baseUrl.port || (isHttpsTarget ? 443 : 80),
    method: req.method ?? "GET",
    path: req.url ?? "/v1/ws",
    headers: {
      ...req.headers,
      host: baseUrl.host,
      "x-forwarded-host": req.headers.host ?? "",
    },
  });

  upstreamReq.once("response", (upstreamRes) => {
    const statusLine = `HTTP/1.1 ${upstreamRes.statusCode ?? 502} ${upstreamRes.statusMessage ?? "Bad Gateway"}`;
    writeRawHttpResponseHead(socket, statusLine, upstreamRes.rawHeaders);
    upstreamRes.pipe(socket as never);
  });

  upstreamReq.once("upgrade", (upstreamRes, upstreamSocket, upstreamHead) => {
    const statusLine = `HTTP/1.1 ${upstreamRes.statusCode ?? 101} ${upstreamRes.statusMessage ?? "Switching Protocols"}`;
    writeRawHttpResponseHead(socket, statusLine, upstreamRes.rawHeaders);

    if (head.length > 0) {
      upstreamSocket.write(head);
    }
    if (upstreamHead.length > 0) {
      socket.write(upstreamHead);
    }

    socket.pipe(upstreamSocket);
    upstreamSocket.pipe(socket as never);

    socket.on("error", () => upstreamSocket.destroy());
    upstreamSocket.on("error", () => {
      try {
        socket.destroy();
      } catch {
        // ignore
      }
    });
    socket.on("close", () => upstreamSocket.destroy());
    upstreamSocket.on("close", () => {
      try {
        socket.destroy();
      } catch {
        // ignore
      }
    });
  });

  upstreamReq.once("error", () => {
    try {
      socket.write("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
      socket.destroy();
    } catch {
      // ignore
    }
  });

  upstreamReq.end();
  return true;
}

function hasAuthorizedWsClientForIp(clients: Set<GatewayWsClient>, clientIp: string): boolean {
  for (const client of clients) {
    if (client.clientIp && client.clientIp === clientIp) {
      return true;
    }
  }
  return false;
}

async function authorizeCanvasRequest(params: {
  req: IncomingMessage;
  auth: ResolvedGatewayAuth;
  trustedProxies: string[];
  clients: Set<GatewayWsClient>;
}): Promise<boolean> {
  const { req, auth, trustedProxies, clients } = params;
  if (isLocalDirectRequest(req, trustedProxies)) {
    return true;
  }

  const token = getBearerToken(req);
  if (token) {
    const authResult = await authorizeGatewayConnect({
      auth: { ...auth, allowTailscale: false },
      connectAuth: { token, password: token },
      req,
      trustedProxies,
    });
    if (authResult.ok) {
      return true;
    }
  }

  const clientIp = resolveGatewayClientIp({
    remoteAddr: req.socket?.remoteAddress ?? "",
    forwardedFor: getHeader(req, "x-forwarded-for"),
    realIp: getHeader(req, "x-real-ip"),
    trustedProxies,
  });
  if (!clientIp) {
    return false;
  }
  return hasAuthorizedWsClientForIp(clients, clientIp);
}

export type HooksRequestHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

export function createHooksRequestHandler(
  opts: {
    getHooksConfig: () => HooksConfigResolved | null;
    bindHost: string;
    port: number;
    logHooks: SubsystemLogger;
  } & HookDispatchers,
): HooksRequestHandler {
  const { getHooksConfig, bindHost, port, logHooks, dispatchAgentHook, dispatchWakeHook } = opts;
  return async (req, res) => {
    const hooksConfig = getHooksConfig();
    if (!hooksConfig) {
      return false;
    }
    const url = new URL(req.url ?? "/", `http://${bindHost}:${port}`);
    const basePath = hooksConfig.basePath;
    if (url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`)) {
      return false;
    }

    if (url.searchParams.has("token")) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end(
        "Hook token must be provided via Authorization: Bearer <token> or X-OpenClaw-Token header (query parameters are not allowed).",
      );
      return true;
    }

    const token = extractHookToken(req);
    if (!token || token !== hooksConfig.token) {
      res.statusCode = 401;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Unauthorized");
      return true;
    }

    if (req.method !== "POST") {
      res.statusCode = 405;
      res.setHeader("Allow", "POST");
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Method Not Allowed");
      return true;
    }

    const subPath = url.pathname.slice(basePath.length).replace(/^\/+/, "");
    if (!subPath) {
      res.statusCode = 404;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Not Found");
      return true;
    }

    const body = await readJsonBody(req, hooksConfig.maxBodyBytes);
    if (!body.ok) {
      const status = body.error === "payload too large" ? 413 : 400;
      sendJson(res, status, { ok: false, error: body.error });
      return true;
    }

    const payload = typeof body.value === "object" && body.value !== null ? body.value : {};
    const headers = normalizeHookHeaders(req);

    if (subPath === "wake") {
      const normalized = normalizeWakePayload(payload as Record<string, unknown>);
      if (!normalized.ok) {
        sendJson(res, 400, { ok: false, error: normalized.error });
        return true;
      }
      dispatchWakeHook(normalized.value);
      sendJson(res, 200, { ok: true, mode: normalized.value.mode });
      return true;
    }

    if (subPath === "agent") {
      const normalized = normalizeAgentPayload(payload as Record<string, unknown>);
      if (!normalized.ok) {
        sendJson(res, 400, { ok: false, error: normalized.error });
        return true;
      }
      const runId = dispatchAgentHook(normalized.value);
      sendJson(res, 202, { ok: true, runId });
      return true;
    }

    if (hooksConfig.mappings.length > 0) {
      try {
        const mapped = await applyHookMappings(hooksConfig.mappings, {
          payload: payload as Record<string, unknown>,
          headers,
          url,
          path: subPath,
        });
        if (mapped) {
          if (!mapped.ok) {
            sendJson(res, 400, { ok: false, error: mapped.error });
            return true;
          }
          if (mapped.action === null) {
            res.statusCode = 204;
            res.end();
            return true;
          }
          if (mapped.action.kind === "wake") {
            dispatchWakeHook({
              text: mapped.action.text,
              mode: mapped.action.mode,
            });
            sendJson(res, 200, { ok: true, mode: mapped.action.mode });
            return true;
          }
          const channel = resolveHookChannel(mapped.action.channel);
          if (!channel) {
            sendJson(res, 400, { ok: false, error: getHookChannelError() });
            return true;
          }
          const runId = dispatchAgentHook({
            message: mapped.action.message,
            name: mapped.action.name ?? "Hook",
            wakeMode: mapped.action.wakeMode,
            sessionKey: mapped.action.sessionKey ?? "",
            deliver: resolveHookDeliver(mapped.action.deliver),
            channel,
            to: mapped.action.to,
            model: mapped.action.model,
            thinking: mapped.action.thinking,
            timeoutSeconds: mapped.action.timeoutSeconds,
            allowUnsafeExternalContent: mapped.action.allowUnsafeExternalContent,
          });
          sendJson(res, 202, { ok: true, runId });
          return true;
        }
      } catch (err) {
        logHooks.warn(`hook mapping failed: ${String(err)}`);
        sendJson(res, 500, { ok: false, error: "hook mapping failed" });
        return true;
      }
    }

    res.statusCode = 404;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Not Found");
    return true;
  };
}

export function createGatewayHttpServer(opts: {
  canvasHost: CanvasHostHandler | null;
  clients: Set<GatewayWsClient>;
  controlUiEnabled: boolean;
  controlUiBasePath: string;
  controlUiRoot?: ControlUiRootState;
  openAiChatCompletionsEnabled: boolean;
  openResponsesEnabled: boolean;
  openResponsesConfig?: import("../config/types.gateway.js").GatewayHttpResponsesConfig;
  handleHooksRequest: HooksRequestHandler;
  handlePluginRequest?: HooksRequestHandler;
  resolvedAuth: ResolvedGatewayAuth;
  tlsOptions?: TlsOptions;
}): HttpServer {
  const {
    canvasHost,
    clients,
    controlUiEnabled,
    controlUiBasePath,
    controlUiRoot,
    openAiChatCompletionsEnabled,
    openResponsesEnabled,
    openResponsesConfig,
    handleHooksRequest,
    handlePluginRequest,
    resolvedAuth,
  } = opts;
  const httpServer: HttpServer = opts.tlsOptions
    ? createHttpsServer(opts.tlsOptions, (req, res) => {
        void handleRequest(req, res);
      })
    : createHttpServer((req, res) => {
        void handleRequest(req, res);
      });

  const cachedTelegram = {
    token: "" as string,
    secret: "" as string,
    handler: null as null | ((req: IncomingMessage, res: ServerResponse) => unknown),
  };

  async function handleRequest(req: IncomingMessage, res: ServerResponse) {
    // Don't interfere with WebSocket upgrades; ws handles the 'upgrade' event.
    if (String(req.headers.upgrade ?? "").toLowerCase() === "websocket") {
      return;
    }

    try {
      const configSnapshot = loadConfig();
      const trustedProxies = configSnapshot.gateway?.trustedProxies ?? [];

      const url = new URL(req.url ?? "/", "http://localhost");

      // Public health check endpoint for hardened deployments.
      if (url.pathname === PUBLIC_HEALTHZ_PATH) {
        if (req.method === "GET" || req.method === "HEAD") {
          sendHealthz(res);
          return;
        }
        if (isPublicWebhookLockdownEnabled()) {
          sendVague404(res);
          return;
        }
      }

      // Optional hardening: only allow explicitly public webhook routes on this listener.
      if (isPublicWebhookLockdownEnabled()) {
        if (!isAllowedPublicWebhookRequest(req, url.pathname)) {
          sendVague404(res);
          return;
        }
      }

      // IFTTT inbound webhook (public; protected by path+header secrets).
      if (await handleIftttWebhookRequest(req, res)) {
        return;
      }

      // Home Assistant inbound webhook (header-secret authenticated).
      if (await handleHaWebhookRequest(req, res)) {
        return;
      }

      // Telegram webhook (public; authenticated by Telegram secret header token).
      if (url.pathname === PUBLIC_TELEGRAM_WEBHOOK_PATH) {
        if (req.method !== "POST") {
          sendVague404(res);
          return;
        }
        const account = resolveTelegramAccount({ cfg: configSnapshot, accountId: null });
        const token = account.token.trim();
        const secret =
          typeof account.config.webhookSecret === "string"
            ? account.config.webhookSecret.trim()
            : "";
        if (!token || !secret) {
          sendVague404(res);
          return;
        }
        if (
          !cachedTelegram.handler ||
          cachedTelegram.token !== token ||
          cachedTelegram.secret !== secret
        ) {
          const bot = createTelegramBot({
            token,
            accountId: account.accountId,
            config: configSnapshot,
          });
          cachedTelegram.token = token;
          cachedTelegram.secret = secret;
          cachedTelegram.handler = webhookCallback(bot, "http", {
            secretToken: secret,
          }) as (req: IncomingMessage, res: ServerResponse) => unknown;
        }
        const telegramHandler = cachedTelegram.handler;
        if (!telegramHandler) {
          sendVague404(res);
          return;
        }
        const handled = telegramHandler(req, res);
        if (handled && typeof (handled as Promise<unknown>).catch === "function") {
          void (handled as Promise<unknown>).catch(() => {
            if (!res.headersSent) {
              res.statusCode = 500;
            }
            res.end();
          });
        }
        return;
      }

      // Optional reverse-proxy bridge to the dedicated OpenClaw chat backend.
      if (await handleChatBackendProxyHttpRequest(req, res, url)) {
        return;
      }

      if (await handleHooksRequest(req, res)) {
        return;
      }
      if (
        await handleToolsInvokeHttpRequest(req, res, {
          auth: resolvedAuth,
          trustedProxies,
        })
      ) {
        return;
      }
      if (await handleSlackHttpRequest(req, res)) {
        return;
      }
      if (handlePluginRequest && (await handlePluginRequest(req, res))) {
        return;
      }
      if (openResponsesEnabled) {
        if (
          await handleOpenResponsesHttpRequest(req, res, {
            auth: resolvedAuth,
            config: openResponsesConfig,
            trustedProxies,
          })
        ) {
          return;
        }
      }
      if (openAiChatCompletionsEnabled) {
        if (
          await handleOpenAiHttpRequest(req, res, {
            auth: resolvedAuth,
            trustedProxies,
          })
        ) {
          return;
        }
      }
      if (canvasHost) {
        if (isCanvasPath(url.pathname)) {
          const ok = await authorizeCanvasRequest({
            req,
            auth: resolvedAuth,
            trustedProxies,
            clients,
          });
          if (!ok) {
            sendUnauthorized(res);
            return;
          }
        }
        if (await handleA2uiHttpRequest(req, res)) {
          return;
        }
        if (await canvasHost.handleHttpRequest(req, res)) {
          return;
        }
      }
      if (controlUiEnabled) {
        if (
          handleControlUiAvatarRequest(req, res, {
            basePath: controlUiBasePath,
            resolveAvatar: (agentId) => resolveAgentAvatar(configSnapshot, agentId),
          })
        ) {
          return;
        }
        if (
          handleControlUiHttpRequest(req, res, {
            basePath: controlUiBasePath,
            config: configSnapshot,
            root: controlUiRoot,
          })
        ) {
          return;
        }
      }

      if (isPublicWebhookLockdownEnabled()) {
        sendVague404(res);
        return;
      }
      res.statusCode = 404;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Not Found");
    } catch {
      if (isPublicWebhookLockdownEnabled()) {
        sendVague404(res);
        return;
      }
      res.statusCode = 500;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Internal Server Error");
    }
  }

  return httpServer;
}

export function attachGatewayUpgradeHandler(opts: {
  httpServer: HttpServer;
  wss: WebSocketServer;
  canvasHost: CanvasHostHandler | null;
  clients: Set<GatewayWsClient>;
  resolvedAuth: ResolvedGatewayAuth;
}) {
  const { httpServer, wss, canvasHost, clients, resolvedAuth } = opts;
  httpServer.on("upgrade", (req, socket, head) => {
    if (handleChatBackendProxyUpgrade(req, socket, head)) {
      return;
    }

    if (isPublicWebhookLockdownEnabled()) {
      socket.destroy();
      return;
    }
    void (async () => {
      if (canvasHost) {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (url.pathname === CANVAS_WS_PATH) {
          const configSnapshot = loadConfig();
          const trustedProxies = configSnapshot.gateway?.trustedProxies ?? [];
          const ok = await authorizeCanvasRequest({
            req,
            auth: resolvedAuth,
            trustedProxies,
            clients,
          });
          if (!ok) {
            socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
            socket.destroy();
            return;
          }
        }
        if (canvasHost.handleUpgrade(req, socket, head)) {
          return;
        }
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    })().catch(() => {
      socket.destroy();
    });
  });
}
