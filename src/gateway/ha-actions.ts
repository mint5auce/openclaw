import {
  HaClient,
  HaClientError,
  type HaClientConfig,
  type HaEntityState,
  type HaPingResponse,
} from "./ha-client.js";

const ALLOWED_DOMAINS = new Set(["switch", "light", "scene", "script"]);

export interface HaActionsConfig extends HaClientConfig {
  defaultStatesCacheTtlSeconds?: number;
}

export interface HaListStatesParams {
  domain?: string;
  search?: string;
  ttlCacheSeconds?: number;
}

export interface HaServiceCallResult {
  ok: boolean;
  errorCode?: string;
  errorMessage?: string;
  before?: HaEntityState | null;
  after?: HaEntityState | null;
}

export class HaActions {
  private readonly client: HaClient;
  private readonly defaultStatesCacheTtlSeconds: number;

  constructor(config: HaActionsConfig) {
    this.client = new HaClient(config);
    this.defaultStatesCacheTtlSeconds = Math.max(0, config.defaultStatesCacheTtlSeconds ?? 0);
  }

  async haPing(): Promise<HaPingResponse> {
    return await this.client.ping();
  }

  async haListStates(params: HaListStatesParams = {}): Promise<HaEntityState[]> {
    const ttlSeconds = params.ttlCacheSeconds ?? this.defaultStatesCacheTtlSeconds;
    const states = await this.client.listStates({ ttlSeconds });

    let filtered = states;

    const domain = typeof params.domain === "string" ? params.domain.trim() : "";
    if (domain) {
      const prefix = `${domain}.`;
      filtered = filtered.filter((state) => state.entity_id.startsWith(prefix));
    }

    const search = typeof params.search === "string" ? params.search.trim().toLowerCase() : "";
    if (search) {
      filtered = filtered.filter((state) => {
        const idMatch = state.entity_id.toLowerCase().includes(search);
        const friendly =
          typeof state.attributes?.friendly_name === "string"
            ? state.attributes.friendly_name.toLowerCase()
            : "";
        return idMatch || friendly.includes(search);
      });
    }

    return filtered;
  }

  async haGetState(entityId: string): Promise<HaEntityState> {
    return await this.client.getState(entityId);
  }

  async haCallService(
    domain: string,
    service: string,
    data: Record<string, unknown>,
  ): Promise<HaServiceCallResult> {
    if (!ALLOWED_DOMAINS.has(domain)) {
      return {
        ok: false,
        errorCode: "HA_DOMAIN_NOT_ALLOWED",
        errorMessage: `Domain ${domain} is not allowed`,
        before: null,
        after: null,
      };
    }

    const entityIdRaw =
      typeof data.entity_id === "string"
        ? data.entity_id
        : typeof data.entityId === "string"
          ? data.entityId
          : undefined;
    const entityId = entityIdRaw?.trim();

    let before: HaEntityState | null = null;
    if (entityId) {
      try {
        before = await this.client.getState(entityId);
      } catch (err) {
        if (!(err instanceof HaClientError)) {
          throw err;
        }
      }
    }

    await this.client.callService(domain, service, data);

    let after: HaEntityState | null = null;
    if (entityId) {
      try {
        after = await this.client.getState(entityId);
      } catch (err) {
        if (err instanceof HaClientError) {
          return {
            ok: false,
            errorCode: "HA_STATE_VERIFICATION_FAILED",
            errorMessage: "Service call completed but verification state fetch failed",
            before,
            after: null,
          };
        }
        throw err;
      }
    }

    if (entityId && before && after && before.state === after.state) {
      return {
        ok: false,
        errorCode: "HA_STATE_VERIFICATION_FAILED",
        errorMessage: "Service call completed but resulting state did not change as expected",
        before,
        after,
      };
    }

    return {
      ok: true,
      before,
      after,
    };
  }

  async haTurnOn(entityId: string): Promise<HaServiceCallResult> {
    const domain = inferDomain(entityId);
    return await this.haCallService(domain, "turn_on", { entity_id: entityId });
  }

  async haTurnOff(entityId: string): Promise<HaServiceCallResult> {
    const domain = inferDomain(entityId);
    return await this.haCallService(domain, "turn_off", { entity_id: entityId });
  }

  async haToggle(entityId: string): Promise<HaServiceCallResult> {
    const domain = inferDomain(entityId);
    return await this.haCallService(domain, "toggle", { entity_id: entityId });
  }
}

function inferDomain(entityId: string): string {
  const [domain] = entityId.split(".");
  if (!domain || !ALLOWED_DOMAINS.has(domain)) {
    throw new HaClientError("UNKNOWN", `Cannot infer allowed domain from entityId: ${entityId}`);
  }
  return domain;
}
