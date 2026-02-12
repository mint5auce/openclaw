export interface HaClientConfig {
  subdomain: string;
  token: string;
  /**
   * Timeout in milliseconds for outbound HA requests.
   * Defaults to 10_000.
   */
  timeoutMs?: number;
}

export type HaHttpMethod = "GET" | "POST";

export interface HaFetchOptions {
  method?: HaHttpMethod;
  body?: unknown;
}

export type HaErrorType = "AUTH_ERROR" | "TIMEOUT" | "CONNECTIVITY" | "HA_ERROR" | "UNKNOWN";

export class HaClientError extends Error {
  public readonly type: HaErrorType;
  public readonly status?: number;
  public readonly path?: string;

  constructor(type: HaErrorType, message: string, opts?: { status?: number; path?: string }) {
    super(message);
    this.name = "HaClientError";
    this.type = type;
    this.status = opts?.status;
    this.path = opts?.path;
  }
}

export function buildHaBaseUrl(subdomain: string): string {
  const trimmed = subdomain.trim();
  if (!trimmed) {
    throw new HaClientError("UNKNOWN", "HA_CLOUD_SUBDOMAIN is empty or whitespace");
  }
  return `https://${trimmed}.ui.nabu.casa`;
}

export interface HaEntityState {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  last_changed?: string;
  last_updated?: string;
  context?: Record<string, unknown>;
}

export interface HaPingResponse {
  message: string;
}

export class HaClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private statesCache?: {
    value: HaEntityState[];
    expiresAtMs: number;
  };

  constructor(config: HaClientConfig) {
    this.baseUrl = buildHaBaseUrl(config.subdomain);
    this.token = config.token.trim();
    if (!this.token) {
      throw new HaClientError("UNKNOWN", "HA_CLOUD_TOKEN is empty or whitespace");
    }
    this.timeoutMs = config.timeoutMs ?? 10_000;
  }

  private async haFetch<T>(path: string, options: HaFetchOptions = {}): Promise<T> {
    const url = new URL(path, this.baseUrl).toString();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      "Content-Type": "application/json",
    };

    try {
      const res = await fetch(url, {
        method: options.method ?? "GET",
        headers,
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
      });

      if (!res.ok) {
        const status = res.status;
        let bodyText: string | undefined;
        try {
          bodyText = await res.text();
        } catch {
          bodyText = undefined;
        }

        if (status === 401 || status === 403) {
          throw new HaClientError("AUTH_ERROR", "Home Assistant auth failed", {
            status,
            path,
          });
        }

        throw new HaClientError(
          "HA_ERROR",
          `Home Assistant error ${status}${bodyText ? `: ${bodyText}` : ""}`,
          { status, path },
        );
      }

      if (res.status === 204) {
        return undefined as T;
      }

      const bodyText = await res.text();
      if (!bodyText.trim()) {
        return undefined as T;
      }
      try {
        return JSON.parse(bodyText) as T;
      } catch {
        return bodyText as T;
      }
    } catch (err: unknown) {
      if (err instanceof Error && (err.name === "AbortError" || /aborted/i.test(err.message))) {
        throw new HaClientError("TIMEOUT", "Home Assistant request timed out", { path });
      }

      if (err instanceof HaClientError) {
        throw err;
      }

      throw new HaClientError(
        "CONNECTIVITY",
        (err as Error)?.message ?? "Connectivity error talking to Home Assistant",
        { path },
      );
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async ping(): Promise<HaPingResponse> {
    return await this.haFetch<HaPingResponse>("/api/");
  }

  async listStates(options?: { ttlSeconds?: number }): Promise<HaEntityState[]> {
    const ttlMs = Math.max(0, (options?.ttlSeconds ?? 0) * 1000);
    const now = Date.now();

    if (ttlMs > 0 && this.statesCache && this.statesCache.expiresAtMs > now) {
      return this.statesCache.value;
    }

    const states = await this.haFetch<HaEntityState[]>("/api/states");
    if (ttlMs > 0) {
      this.statesCache = {
        value: states,
        expiresAtMs: now + ttlMs,
      };
    }
    return states;
  }

  async getState(entityId: string): Promise<HaEntityState> {
    const trimmed = entityId.trim();
    if (!trimmed) {
      throw new HaClientError("UNKNOWN", "entityId is required");
    }
    return await this.haFetch<HaEntityState>(`/api/states/${encodeURIComponent(trimmed)}`);
  }

  async callService(
    domain: string,
    service: string,
    data: Record<string, unknown>,
  ): Promise<unknown> {
    const normalizedDomain = domain.trim();
    const normalizedService = service.trim();
    if (!normalizedDomain || !normalizedService) {
      throw new HaClientError("UNKNOWN", "domain and service are required");
    }
    return await this.haFetch(
      `/api/services/${encodeURIComponent(normalizedDomain)}/${encodeURIComponent(normalizedService)}`,
      {
        method: "POST",
        body: data,
      },
    );
  }
}
