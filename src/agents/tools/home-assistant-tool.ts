import { Type } from "@sinclair/typebox";
import { optionalStringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, jsonResult, readStringParam } from "./common.js";
import { callGatewayTool, type GatewayCallOptions } from "./gateway.js";

const HA_TOOL_ACTIONS = [
  "intent",
  "ping",
  "list_states",
  "get_state",
  "call_service",
  "turn_on",
  "turn_off",
  "toggle",
] as const;

const HomeAssistantToolSchema = Type.Object({
  action: optionalStringEnum(HA_TOOL_ACTIONS),
  intent: Type.Optional(
    Type.String({
      description:
        "Natural language HA request, e.g. 'turn on switch.office_plug' or 'what is the state of light.kitchen'",
    }),
  ),
  entityId: Type.Optional(Type.String()),
  domain: Type.Optional(Type.String()),
  service: Type.Optional(Type.String()),
  data: Type.Optional(Type.Object({}, { additionalProperties: true })),
  search: Type.Optional(Type.String()),
  ttlCacheSeconds: Type.Optional(Type.Number()),
  gatewayUrl: Type.Optional(Type.String()),
  gatewayToken: Type.Optional(Type.String()),
  timeoutMs: Type.Optional(Type.Number()),
});

type HaBridgeMethod =
  | "ha.ping"
  | "ha.listStates"
  | "ha.getState"
  | "ha.callService"
  | "ha.turnOn"
  | "ha.turnOff"
  | "ha.toggle";

type MappedIntent = {
  method: HaBridgeMethod;
  params: Record<string, unknown>;
  reason: string;
};

export function createHomeAssistantTool(): AnyAgentTool {
  return {
    label: "Home Assistant",
    name: "home_assistant",
    description: `Bridge natural-language Home Assistant requests to gateway ha.* methods.

Use action="intent" with plain English commands (recommended), or call explicit actions:
- ping
- list_states
- get_state
- call_service
- turn_on
- turn_off
- toggle`,
    parameters: HomeAssistantToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = (readStringParam(params, "action") ?? "intent").toLowerCase();
      const gatewayOpts: GatewayCallOptions = {
        gatewayUrl: readStringParam(params, "gatewayUrl", { trim: false }),
        gatewayToken: readStringParam(params, "gatewayToken", { trim: false }),
        timeoutMs: typeof params.timeoutMs === "number" ? params.timeoutMs : undefined,
      };

      const direct = resolveDirectAction(action, params);
      if (direct) {
        const result = await callGatewayTool(direct.method, gatewayOpts, direct.params);
        return jsonResult({
          ok: true,
          mapped: direct,
          result,
        });
      }

      if (action !== "intent") {
        throw new Error(`unknown action: ${action}`);
      }

      const intent = readStringParam(params, "intent", { required: true });
      const mapped = mapNaturalLanguageIntent(intent, params);
      const result = await callGatewayTool(mapped.method, gatewayOpts, mapped.params);
      return jsonResult({
        ok: true,
        mapped,
        result,
      });
    },
  };
}

function resolveDirectAction(action: string, params: Record<string, unknown>): MappedIntent | null {
  if (action === "ping") {
    return { method: "ha.ping", params: {}, reason: "explicit action=ping" };
  }
  if (action === "list_states") {
    return {
      method: "ha.listStates",
      params: {
        domain: readStringParam(params, "domain"),
        search: readStringParam(params, "search"),
        ttlCacheSeconds:
          typeof params.ttlCacheSeconds === "number" ? params.ttlCacheSeconds : undefined,
      },
      reason: "explicit action=list_states",
    };
  }
  if (action === "get_state") {
    const entityId = readStringParam(params, "entityId", { required: true });
    return {
      method: "ha.getState",
      params: { entityId },
      reason: "explicit action=get_state",
    };
  }
  if (action === "call_service") {
    const domain = readStringParam(params, "domain", { required: true });
    const service = readStringParam(params, "service", { required: true });
    const data = isRecord(params.data) ? params.data : {};
    return {
      method: "ha.callService",
      params: { domain, service, data },
      reason: "explicit action=call_service",
    };
  }
  if (action === "turn_on") {
    const entityId = readStringParam(params, "entityId", { required: true });
    return {
      method: "ha.turnOn",
      params: { entityId },
      reason: "explicit action=turn_on",
    };
  }
  if (action === "turn_off") {
    const entityId = readStringParam(params, "entityId", { required: true });
    return {
      method: "ha.turnOff",
      params: { entityId },
      reason: "explicit action=turn_off",
    };
  }
  if (action === "toggle") {
    const entityId = readStringParam(params, "entityId", { required: true });
    return {
      method: "ha.toggle",
      params: { entityId },
      reason: "explicit action=toggle",
    };
  }
  return null;
}

function mapNaturalLanguageIntent(intent: string, params: Record<string, unknown>): MappedIntent {
  const normalized = intent.trim();
  const lowered = normalized.toLowerCase();
  const entityId = readStringParam(params, "entityId") ?? extractEntityId(lowered);

  if (/\b(ping|alive|reach|reachable|connectivity)\b/.test(lowered)) {
    return { method: "ha.ping", params: {}, reason: "intent matched ping/health wording" };
  }

  if (/\b(turn on|switch on|enable)\b/.test(lowered)) {
    if (!entityId) {
      throw new Error("Could not infer entityId for turn_on intent");
    }
    return {
      method: "ha.turnOn",
      params: { entityId },
      reason: "intent matched turn on wording",
    };
  }

  if (/\b(turn off|switch off|disable)\b/.test(lowered)) {
    if (!entityId) {
      throw new Error("Could not infer entityId for turn_off intent");
    }
    return {
      method: "ha.turnOff",
      params: { entityId },
      reason: "intent matched turn off wording",
    };
  }

  if (/\btoggle\b/.test(lowered)) {
    if (!entityId) {
      throw new Error("Could not infer entityId for toggle intent");
    }
    return {
      method: "ha.toggle",
      params: { entityId },
      reason: "intent matched toggle wording",
    };
  }

  if (/\b(state|status)\b/.test(lowered) || /\b(what is|what's|is)\b/.test(lowered)) {
    if (entityId) {
      return {
        method: "ha.getState",
        params: { entityId },
        reason: "intent matched state/status wording with entityId",
      };
    }
  }

  if (
    /\b(list|show|find)\b/.test(lowered) &&
    /\b(states?|entities?|devices?|lights?|switches?|scenes?|scripts?)\b/.test(lowered)
  ) {
    const inferredDomain = readStringParam(params, "domain") ?? inferDomainFromIntent(lowered);
    return {
      method: "ha.listStates",
      params: {
        domain: inferredDomain,
        search: readStringParam(params, "search"),
        ttlCacheSeconds:
          typeof params.ttlCacheSeconds === "number" ? params.ttlCacheSeconds : undefined,
      },
      reason: "intent matched list/show entities wording",
    };
  }

  const explicitCall = extractServiceCallFromIntent(lowered);
  if (explicitCall) {
    const serviceToken = `${explicitCall.domain}.${explicitCall.service}`;
    const explicitEntityId =
      readStringParam(params, "entityId") ??
      extractEntityId(lowered, {
        exclude: [serviceToken],
      });
    const data = isRecord(params.data) ? { ...params.data } : {};
    if (explicitEntityId && typeof data.entity_id !== "string") {
      data.entity_id = explicitEntityId;
    }
    return {
      method: "ha.callService",
      params: {
        domain: readStringParam(params, "domain") ?? explicitCall.domain,
        service: readStringParam(params, "service") ?? explicitCall.service,
        data,
      },
      reason: "intent matched explicit service call wording",
    };
  }

  throw new Error(
    "Could not map Home Assistant intent. Use action=intent with entity_id wording, or use explicit action fields.",
  );
}

function extractEntityId(input: string, opts?: { exclude?: string[] }): string | undefined {
  const excluded = new Set((opts?.exclude ?? []).map((entry) => entry.toLowerCase()));
  const matches = Array.from(input.matchAll(/\b([a-z_][a-z0-9_]*\.[a-z0-9_]+)\b/g));
  for (const match of matches) {
    const candidate = match[1];
    if (!candidate) {
      continue;
    }
    if (excluded.has(candidate.toLowerCase())) {
      continue;
    }
    return candidate;
  }
  return undefined;
}

function inferDomainFromIntent(input: string): string | undefined {
  if (/\blights?\b/.test(input)) {
    return "light";
  }
  if (/\bswitch(es)?\b/.test(input)) {
    return "switch";
  }
  if (/\bscenes?\b/.test(input)) {
    return "scene";
  }
  if (/\bscripts?\b/.test(input)) {
    return "script";
  }
  return undefined;
}

function extractServiceCallFromIntent(input: string): { domain: string; service: string } | null {
  const match = input.match(
    /\b(?:call|run|invoke)\s+(?:service\s+)?([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\b/,
  );
  if (!match) {
    return null;
  }
  return {
    domain: match[1] ?? "",
    service: match[2] ?? "",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
