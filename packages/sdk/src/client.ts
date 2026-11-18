import { createRequire } from 'node:module';
import { DEFAULT_API_URL } from './connector-events.js';
import { SnappliError } from './errors.js';
import type { PaginatedResponse } from './generated/index.js';

/** Versión del paquete (va en el User-Agent). */
export const SDK_VERSION: string = (
  createRequire(import.meta.url)('../package.json') as { version: string }
).version;

const API_KEY = /^sk_[0-9a-f]{48}$/;

export interface SnappliOptions {
  /** Por defecto `https://api.snappli.io` (o `SNAPPLI_API_URL`). */
  baseUrl?: string | undefined;
  fetch?: typeof fetch;
  /** Por defecto 30 s. */
  timeoutMs?: number;
  /** Se añade al `User-Agent` (p. ej. `snappli-cli/0.1.0`). */
  userAgent?: string;
}

/** Contacto tal como lo devuelve la API pública. */
export interface Contact {
  id: string;
  [key: string]: unknown;
}

export interface ContactListParams {
  page?: number;
  limit?: number;
  search?: string;
  departmentId?: string;
  view?: 'all' | 'blocked' | 'active' | 'inactive' | 'window_open';
  tagId?: string;
  segmentId?: string;
  pipelineStageId?: string;
}

/** Muestra solo el principio de una key: `sk_1a2b…`. */
export function maskApiKey(apiKey: string): string {
  return apiKey.length > 8 ? `${apiKey.slice(0, 7)}…` : '…';
}

/**
 * Cliente de la API pública de Snappli (`/api/v1`). Usa una API key de **Configuración → API** del
 * panel (`sk_…`); la API pública requiere un plan con acceso a la API.
 */
export class Snappli {
  readonly baseUrl: string;
  readonly contacts: {
    list: (params?: ContactListParams) => Promise<PaginatedResponse<Contact>>;
    get: (id: string) => Promise<Contact>;
  };
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #userAgent: string;

  constructor(apiKey: string, options: SnappliOptions = {}) {
    if (!apiKey) throw new SnappliError('Falta la API key de Snappli.', 'missing_api_key');
    if (!API_KEY.test(apiKey.trim())) {
      throw new SnappliError(
        `La API key ${maskApiKey(apiKey)} no tiene el formato sk_ + 48 caracteres hex.`,
        'invalid_api_key',
      );
    }
    this.#apiKey = apiKey.trim();
    this.baseUrl = (options.baseUrl ?? DEFAULT_API_URL).replace(/\/+$/, '');
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#userAgent = [`snappli-sdk-js/${SDK_VERSION}`, options.userAgent]
      .filter(Boolean)
      .join(' ');
    this.contacts = {
      list: (params = {}) => this.request('GET', '/v1/contacts', { query: { ...params } }),
      get: (id) => this.request('GET', `/v1/contacts/${encodeURIComponent(id)}`),
    };
  }

  /** Petición a la API (`path` sin `/api`, p. ej. `/v1/contacts`). */
  async request<T>(
    method: string,
    path: string,
    options: { query?: Record<string, unknown>; body?: unknown } = {},
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}/api${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value));
      }
    }
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.#apiKey}`,
          Accept: 'application/json',
          'User-Agent': this.#userAgent,
          ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      throw new SnappliError(
        `No se pudo conectar con ${this.baseUrl}: ${error instanceof Error ? error.message : String(error)}`,
        'network_error',
      );
    }
    const text = await response.text();
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      // Cuerpo no JSON: se deja como texto.
    }
    if (!response.ok) throw errorFromResponse(response.status, body);
    return body as T;
  }
}

const CODES: Record<number, string> = {
  400: 'invalid_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  429: 'rate_limited',
};

function errorFromResponse(status: number, body: unknown): SnappliError {
  const raw =
    body && typeof body === 'object' && 'message' in body
      ? (body as { message: unknown }).message
      : undefined;
  const message = Array.isArray(raw)
    ? raw.join('; ')
    : typeof raw === 'string'
      ? raw
      : `HTTP ${status}`;
  return new SnappliError(
    message,
    CODES[status] ?? (status >= 500 ? 'server_error' : 'http_error'),
    {
      status,
      body,
    },
  );
}
