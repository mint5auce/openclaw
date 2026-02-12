import type { GatewayRequestHandlers } from "./types.js";
import { HaActions } from "../ha-actions.js";
import { HaClientError } from "../ha-client.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateHaCallServiceParams,
  validateHaGetStateParams,
  validateHaListStatesParams,
  validateHaPingParams,
  validateHaServiceActionParams,
} from "../protocol/index.js";

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

function createHaActions(): HaActions {
  const subdomain = (process.env.HA_CLOUD_SUBDOMAIN ?? "").trim();
  const token = (process.env.HA_CLOUD_TOKEN ?? "").trim();
  if (!subdomain || !token) {
    throw new HaClientError(
      "UNKNOWN",
      "Home Assistant is not configured (HA_CLOUD_SUBDOMAIN and HA_CLOUD_TOKEN are required)",
    );
  }
  return new HaActions({
    subdomain,
    token,
    timeoutMs: envInt("HA_HTTP_TIMEOUT_MS", 10_000),
    defaultStatesCacheTtlSeconds: envInt("HA_STATES_CACHE_TTL_SECONDS", 0),
  });
}

function mapHaError(err: unknown) {
  if (err instanceof HaClientError) {
    if (err.type === "AUTH_ERROR") {
      return errorShape(ErrorCodes.INVALID_REQUEST, err.message);
    }
    if (err.type === "TIMEOUT" || err.type === "CONNECTIVITY") {
      return errorShape(ErrorCodes.UNAVAILABLE, err.message, { retryable: true });
    }
    if (err.type === "HA_ERROR") {
      return errorShape(ErrorCodes.UNAVAILABLE, err.message);
    }
    return errorShape(ErrorCodes.INVALID_REQUEST, err.message);
  }
  return errorShape(ErrorCodes.UNAVAILABLE, String(err));
}

export const haHandlers: GatewayRequestHandlers = {
  "ha.ping": async ({ params, respond }) => {
    if (!validateHaPingParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid ha.ping params: ${formatValidationErrors(validateHaPingParams.errors)}`,
        ),
      );
      return;
    }
    try {
      const actions = createHaActions();
      const result = await actions.haPing();
      respond(true, result, undefined);
    } catch (err) {
      respond(false, undefined, mapHaError(err));
    }
  },
  "ha.listStates": async ({ params, respond }) => {
    if (!validateHaListStatesParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid ha.listStates params: ${formatValidationErrors(validateHaListStatesParams.errors)}`,
        ),
      );
      return;
    }

    const p = params as {
      domain?: string;
      search?: string;
      ttlCacheSeconds?: number;
    };
    try {
      const actions = createHaActions();
      const result = await actions.haListStates({
        domain: p.domain,
        search: p.search,
        ttlCacheSeconds: p.ttlCacheSeconds,
      });
      respond(true, result, undefined);
    } catch (err) {
      respond(false, undefined, mapHaError(err));
    }
  },
  "ha.getState": async ({ params, respond }) => {
    if (!validateHaGetStateParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid ha.getState params: ${formatValidationErrors(validateHaGetStateParams.errors)}`,
        ),
      );
      return;
    }

    const p = params as { entityId: string };
    try {
      const actions = createHaActions();
      const result = await actions.haGetState(p.entityId);
      respond(true, result, undefined);
    } catch (err) {
      respond(false, undefined, mapHaError(err));
    }
  },
  "ha.callService": async ({ params, respond }) => {
    if (!validateHaCallServiceParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid ha.callService params: ${formatValidationErrors(validateHaCallServiceParams.errors)}`,
        ),
      );
      return;
    }

    const p = params as {
      domain: string;
      service: string;
      data?: Record<string, unknown>;
    };
    try {
      const actions = createHaActions();
      const result = await actions.haCallService(p.domain, p.service, p.data ?? {});
      respond(true, result, undefined);
    } catch (err) {
      respond(false, undefined, mapHaError(err));
    }
  },
  "ha.turnOn": async ({ params, respond }) => {
    if (!validateHaServiceActionParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid ha.turnOn params: ${formatValidationErrors(validateHaServiceActionParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as { entityId: string };
    try {
      const actions = createHaActions();
      const result = await actions.haTurnOn(p.entityId);
      respond(true, result, undefined);
    } catch (err) {
      respond(false, undefined, mapHaError(err));
    }
  },
  "ha.turnOff": async ({ params, respond }) => {
    if (!validateHaServiceActionParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid ha.turnOff params: ${formatValidationErrors(validateHaServiceActionParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as { entityId: string };
    try {
      const actions = createHaActions();
      const result = await actions.haTurnOff(p.entityId);
      respond(true, result, undefined);
    } catch (err) {
      respond(false, undefined, mapHaError(err));
    }
  },
  "ha.toggle": async ({ params, respond }) => {
    if (!validateHaServiceActionParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid ha.toggle params: ${formatValidationErrors(validateHaServiceActionParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as { entityId: string };
    try {
      const actions = createHaActions();
      const result = await actions.haToggle(p.entityId);
      respond(true, result, undefined);
    } catch (err) {
      respond(false, undefined, mapHaError(err));
    }
  },
};
