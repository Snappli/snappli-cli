import { randomBytes } from 'node:crypto';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import {
  API_KEY_SCOPES,
  CONNECTOR_RESPONSE_MAX_BYTES,
  checkWebhookSignature,
  constructEvent,
  isWebhookEvent,
  type PublicApiMe,
  previewResponseMapping,
  readJsonPath,
  type Snappli,
  SnappliWebhookError,
  sendConnectorEvent,
  shapeConnectorResponse,
  signWebhookPayload,
  verifyWebhook,
  WEBHOOK_DELIVERY_STATUSES,
  WEBHOOK_EVENT_TYPES,
  WEBHOOK_TIMEOUT_MS,
  WEBHOOK_TOLERANCE_SECONDS,
  type WebhookDeliveryStatusValue,
  type WebhookEvent,
  type WebhookEventType,
  webhookDeliveryId,
  webhookHeaders,
  webhookResponseMappingSchema,
} from '@snappli/sdk';
import {
  type ApiKeySource,
  CliError,
  configFile,
  deleteConfig,
  type Env,
  saveConfig,
} from './config.js';
import { exampleWebhook, newDeliveryId, SAMPLE_FILES } from './fixtures.js';

export const DOCS_URL = 'https://docs.snappli.io/desarrolladores/herramientas/';
export { WEBHOOK_EVENT_TYPES };

const RESPONSE_PREVIEW_CHARS = 2000;

export function assertEventType(value: string | undefined): WebhookEventType {
  if (!value || !(WEBHOOK_EVENT_TYPES as readonly string[]).includes(value)) {
    throw new CliError(
      `Evento ${value ? `«${value}» ` : ''}no válido. Eventos: ${WEBHOOK_EVENT_TYPES.join(', ')}.`,
      'invalid_event_type',
    );
  }
  return value as WebhookEventType;
}

export function assertHttpUrl(value: string | undefined, flag = '--to'): URL {
  if (!value) throw new CliError(`Falta ${flag} <url>.`, 'missing_url');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CliError(`${flag} no es una URL válida: ${value}`, 'invalid_url');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new CliError(`${flag} debe ser http:// o https://.`, 'invalid_url');
  }
  return url;
}

/** localhost, 127.0.0.0/8, ::1 o *.localhost: un mock o tu servidor de desarrollo. */
export function isLocalUrl(url: URL): boolean {
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return (
    host === 'localhost' || host.endsWith('.localhost') || host === '::1' || /^127\./.test(host)
  );
}

// ---------------------------------------------------------------------------------------------
// Ejemplos y envío simulado de webhooks

export function webhookExample(event: string | undefined, withDocuments = false): WebhookEvent {
  return exampleWebhook(assertEventType(event), { withDocuments });
}

export interface HttpResult {
  status?: number;
  ok: boolean;
  durationMs: number;
  contentType?: string | null;
  /** JSON parseado, o el texto (recortado). */
  body?: unknown;
  json?: boolean;
  error?: { code: 'timeout' | 'network_error'; message: string };
}

async function postOnce(
  url: string,
  init: { headers: Record<string, string>; body: string; timeoutMs: number; fetch: typeof fetch },
): Promise<{ result: HttpResult; text: string }> {
  const started = performance.now();
  try {
    const response = await init.fetch(url, {
      method: 'POST',
      headers: init.headers,
      body: init.body,
      signal: AbortSignal.timeout(init.timeoutMs),
    });
    const text = await response.text().catch(() => '');
    const durationMs = Math.round(performance.now() - started);
    let parsed: unknown;
    let json = false;
    try {
      parsed = text ? JSON.parse(text) : undefined;
      json = text !== '';
    } catch {
      parsed = undefined;
    }
    return {
      text,
      result: {
        status: response.status,
        ok: response.ok,
        durationMs,
        contentType: response.headers.get('content-type'),
        body:
          json && text.length <= 20_000
            ? parsed
            : text.length > RESPONSE_PREVIEW_CHARS
              ? `${text.slice(0, RESPONSE_PREVIEW_CHARS)}…(recortado)`
              : text,
        json,
      },
    };
  } catch (error) {
    const durationMs = Math.round(performance.now() - started);
    const timeout =
      error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : '';
    return {
      text: '',
      result: {
        ok: false,
        durationMs,
        error: timeout
          ? {
              code: 'timeout',
              message: `Sin respuesta en ${init.timeoutMs / 1000} s. Snappli corta a los 15 s y reintenta.`,
            }
          : {
              code: 'network_error',
              message: `${error instanceof Error ? error.message : String(error)}${cause ? `: ${cause}` : ''}`,
            },
      },
    };
  }
}

interface FileServer {
  baseUrl: string;
  tokens: Record<string, string>;
  downloads: Record<string, number>;
  close: () => Promise<void>;
}

/** Sirve los archivos de ejemplo en `http://127.0.0.1:<puerto>/api/webhook-files/<token>`. */
async function startFileServer(): Promise<FileServer> {
  const tokens: Record<string, string> = {};
  const downloads: Record<string, number> = {};
  for (const key of Object.keys(SAMPLE_FILES)) {
    tokens[key] = randomBytes(16).toString('hex');
    downloads[key] = 0;
  }
  const server = createServer((req, res) => {
    const token = req.url?.match(/^\/api\/webhook-files\/([a-f0-9]+)$/)?.[1];
    const key = Object.keys(tokens).find((k) => tokens[k] === token);
    const file = key ? SAMPLE_FILES[key] : undefined;
    if (!key || !file || req.method !== 'GET') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ statusCode: 404, message: 'Enlace inválido o expirado' }));
      return;
    }
    downloads[key] = (downloads[key] ?? 0) + 1;
    res.writeHead(200, {
      'Content-Type': file.mimeType,
      'Content-Length': file.bytes.byteLength,
      'Cache-Control': 'private, no-store',
      'Content-Disposition': `inline; filename="${file.fileName}"`,
    });
    res.end(file.bytes);
  });
  const port = await listen(server, 0, '127.0.0.1');
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    tokens,
    downloads,
    close: () => closeServer(server),
  };
}

function listen(server: Server, port: number, host?: string): Promise<number> {
  return new Promise((resolvePort, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolvePort((server.address() as AddressInfo).port);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((done) => {
    server.closeAllConnections?.();
    server.close(() => done());
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface TriggerOptions {
  url: string;
  event?: string | undefined;
  /** Payload propio (de `--file`) en vez del de ejemplo. */
  payload?: unknown;
  secret?: string | undefined;
  /** Cabeceras extra, p. ej. la de autenticación configurada en la integración. */
  headers?: Record<string, string>;
  /** Mapeo de respuesta, como en el panel: `{ fields: { id_pedido: "$.data.id" }, note }`. */
  mapping?: unknown;
  /** Reenvía la misma entrega (misma Idempotency-Key) para probar que ignoras los repetidos. */
  repeat?: boolean;
  withDocuments?: boolean;
  /** Con documentos: cuánto se esperan las descargas después de la respuesta. */
  holdMs?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/**
 * Firma y envía un webhook a tu servidor con las mismas cabeceras que Snappli, y cuenta qué
 * respondió, si Snappli lo daría por bueno y qué rellenaría el mapeo de respuesta.
 */
export async function triggerWebhook(options: TriggerOptions) {
  const url = assertHttpUrl(options.url);
  if (options.payload === undefined) assertEventType(options.event);
  if (options.payload !== undefined && !isWebhookEvent(options.payload)) {
    throw new CliError(
      `El archivo no es un webhook de Snappli: necesita event (${WEBHOOK_EVENT_TYPES.join(', ')}), contact y trigger.`,
      'invalid_payload',
    );
  }
  const mapping = options.mapping === undefined ? undefined : parseMapping(options.mapping);
  const timeoutMs = options.timeoutMs ?? WEBHOOK_TIMEOUT_MS;
  const fetcher = options.fetch ?? fetch;
  const files = options.withDocuments ? await startFileServer() : undefined;

  try {
    let payload: WebhookEvent;
    if (options.payload !== undefined) {
      payload = structuredClone(options.payload as WebhookEvent);
      if (files) {
        const sample = exampleWebhook(payload.event, {
          withDocuments: true,
          documentBaseUrl: files.baseUrl,
          documentTokens: files.tokens,
        });
        payload.contact.documents = sample.contact.documents ?? {};
      }
    } else {
      payload = exampleWebhook(options.event as WebhookEventType, {
        withDocuments: Boolean(files),
        ...(files ? { documentBaseUrl: files.baseUrl, documentTokens: files.tokens } : {}),
      });
    }
    const deliveryId = payload.trigger?.deliveryId || newDeliveryId();
    payload.trigger.deliveryId = deliveryId;
    const body = JSON.stringify(payload);
    const extra = options.headers ?? {};
    const send = () =>
      postOnce(url.href, {
        headers: { ...webhookHeaders({ body, deliveryId, secret: options.secret }), ...extra },
        body,
        timeoutMs,
        fetch: fetcher,
      });

    const first = await send();
    const second = options.repeat ? await send() : undefined;

    let documents: Array<{ key: string; status: string; downloads: number }> | undefined;
    if (files) {
      const deadline = Date.now() + (options.holdMs ?? 10_000);
      const allDone = () => Object.values(files.downloads).every((n) => n > 0);
      while (!allDone() && Date.now() < deadline) await sleep(100);
      documents = Object.entries(payload.contact.documents ?? {}).map(([key, doc]) => ({
        key,
        status: doc.status,
        downloads: files.downloads[key] ?? 0,
      }));
    }

    const warnings = describeResponse(first.result, first.text, timeoutMs);
    if (!options.secret) {
      warnings.push(
        'Sin secreto: la entrega va sin X-Snappli-Signature. Configura un secreto en la integración y pásalo con --secret o SNAPPLI_WEBHOOK_SECRET.',
      );
    }
    if (second && first.result.ok && second.result.ok) {
      warnings.push(
        `Se envió dos veces la entrega ${deliveryId}: comprueba que tu sistema la procesó una sola vez.`,
      );
    }
    if (second && first.result.ok && !second.result.ok) {
      warnings.push(
        'El reenvío no respondió 2xx: ante un repetido responde 2xx (ya procesado), si no Snappli lo cuenta como fallo.',
      );
    }
    if (documents?.some((d) => d.downloads === 0)) {
      warnings.push(
        `No se descargaron: ${documents
          .filter((d) => d.downloads === 0)
          .map((d) => d.key)
          .join(', ')}. Los enlaces caducan: descarga los documentos al recibir el webhook.`,
      );
    }

    return {
      ok: first.result.ok && (!second || second.result.ok),
      request: {
        url: url.href,
        event: payload.event,
        deliveryId,
        signed: Boolean(options.secret),
        extraHeaders: Object.keys(extra),
      },
      response: first.result,
      ...(second ? { repeat: second.result } : {}),
      ...(mapping
        ? {
            mapping: first.result.ok
              ? previewResponseMapping(mapping, first.text)
              : { applied: false, reason: 'El mapeo solo se aplica a una respuesta 2xx.' },
          }
        : {}),
      ...(documents ? { documents } : {}),
      warnings,
    };
  } finally {
    await files?.close();
  }
}

function describeResponse(result: HttpResult, text: string, timeoutMs: number): string[] {
  const warnings: string[] = [];
  if (result.error) {
    warnings.push(
      result.error.code === 'timeout'
        ? 'Snappli daría el intento por fallido a los 15 s: responde 2xx enseguida y deja lo pesado en segundo plano.'
        : 'No se pudo conectar. ¿Está levantado el servidor y la URL es correcta?',
    );
    return warnings;
  }
  if (!result.ok) {
    warnings.push(
      `HTTP ${result.status}: Snappli reintentaría (3 intentos en total) y al final dejaría una nota en el contacto.`,
    );
  }
  if (result.durationMs > WEBHOOK_TIMEOUT_MS && timeoutMs > WEBHOOK_TIMEOUT_MS) {
    warnings.push(`Tardó ${result.durationMs} ms: Snappli corta a los 15 s.`);
  } else if (result.durationMs > 5_000) {
    warnings.push(`Tardó ${result.durationMs} ms. Snappli corta a los 15 s: responde antes.`);
  }
  if (result.ok && text && !result.json) {
    warnings.push('La respuesta no es JSON: el mapeo de respuesta no podrá leer nada.');
  }
  return warnings;
}

function parseMapping(raw: unknown) {
  const parsed = webhookResponseMappingSchema.safeParse(raw);
  if (!parsed.success) {
    throw new CliError(
      `Mapeo no válido: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'mapeo'}: ${i.message}`).join('; ')}. Forma: {"fields":{"id_pedido":"$.data.id"},"note":"Pedido {{id_pedido}}"}`,
      'invalid_mapping',
    );
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------------------------
// Verificar una firma

export interface VerifyOptions {
  secret: string;
  timestamp: string;
  signature: string;
  body: string;
  toleranceSeconds?: number;
  /** No comprobar la hora (para una entrega antigua copiada del historial). */
  ignoreTime?: boolean;
  now?: number;
}

/** Dice si una firma de webhook es válida y, si no, la causa más probable. */
export function verifySignature(options: VerifyOptions) {
  if (!options.secret) throw new CliError('Falta --secret.', 'missing_secret');
  if (!options.timestamp) throw new CliError('Falta --timestamp.', 'missing_timestamp');
  if (!options.signature) throw new CliError('Falta --signature.', 'missing_signature');
  const result = checkWebhookSignature(
    options.body,
    options.secret,
    options.timestamp,
    options.signature,
    {
      toleranceSeconds: options.ignoreTime
        ? Number.MAX_SAFE_INTEGER
        : (options.toleranceSeconds ?? WEBHOOK_TOLERANCE_SECONDS),
      ...(options.now !== undefined ? { now: options.now } : {}),
    },
  );
  const hints: string[] = [];
  if (/^\d{13}$/.test(options.timestamp)) {
    hints.push('X-Snappli-Timestamp va en segundos; ese valor parece estar en milisegundos.');
  }
  if (/^sha256=/i.test(options.signature)) {
    hints.push(
      'Los webhooks de Snappli firman en hex sin prefijo; el prefijo sha256= es de los eventos de conector.',
    );
  }
  if (!result.valid && result.reason === 'bad_signature') {
    const sameTime = (body: string) =>
      signWebhookPayload(body, options.secret, Number(options.timestamp)).signature ===
      options.signature.replace(/^sha256=/i, '').toLowerCase();
    const trimmed = options.body.replace(/\r?\n$/, '');
    let compact: string | undefined;
    try {
      compact = JSON.stringify(JSON.parse(options.body));
    } catch {
      compact = undefined;
    }
    if (trimmed !== options.body && sameTime(trimmed)) {
      hints.push(
        'La firma coincide sin el salto de línea final: el archivo tiene un \\n que no venía en la entrega.',
      );
    } else if (compact && compact !== options.body && sameTime(compact)) {
      hints.push(
        'La firma coincide con el JSON compactado: el cuerpo se reformateó (parseado y vuelto a serializar). Verifica con los bytes exactos que llegaron.',
      );
    } else {
      hints.push(
        'Revisa que el secreto sea el de esa integración y que verifiques el cuerpo crudo, sin parsear (express.raw, req.text()).',
      );
    }
  }
  if (!result.valid && result.reason === 'timestamp_out_of_range') {
    hints.push(
      'Si es una entrega antigua copiada del historial, usa --ignore-time para comprobar solo la firma.',
    );
  }
  return result.valid
    ? { valid: true as const, hints }
    : { valid: false as const, reason: result.reason, message: result.detail, hints };
}

// ---------------------------------------------------------------------------------------------
// Receptor local

export interface ReceivedDelivery {
  receivedAt: string;
  method: string;
  path: string;
  deliveryId: string | null;
  /** Veces que llegó esta entrega (reintentos o --repeat). */
  attempt: number;
  duplicate: boolean;
  verified: boolean | null;
  reason?: string;
  event?: string;
  responseStatus: number;
  headers: Record<string, string>;
  payload?: unknown;
  body?: string;
}

export interface ReceiverOptions {
  port: number;
  host?: string;
  secret?: string | undefined;
  /** Cuerpo de la respuesta (JSON). Por defecto `{"received":true}`. */
  respondBody?: string;
  status?: number;
  onDelivery: (delivery: ReceivedDelivery) => void;
}

const SHOWN_HEADERS = [
  'content-type',
  'user-agent',
  'idempotency-key',
  'x-snappli-delivery-id',
  'x-snappli-timestamp',
  'x-snappli-signature',
];

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((done, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => done(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Servidor que recibe webhooks, los verifica (si hay secreto) y los muestra. */
export async function startReceiver(options: ReceiverOptions) {
  const seen = new Map<string, number>();
  const status = options.status ?? 200;
  const respondBody = options.respondBody ?? '{"received":true}';
  const server = createServer(async (req, res) => {
    const raw = await readBody(req);
    const headers = Object.fromEntries(
      SHOWN_HEADERS.flatMap((name) => {
        const value = req.headers[name];
        return value === undefined ? [] : [[name, Array.isArray(value) ? value.join(', ') : value]];
      }),
    );
    const deliveryId = webhookDeliveryId(req.headers) ?? null;
    const attempt = deliveryId ? (seen.get(deliveryId) ?? 0) + 1 : 1;
    if (deliveryId) seen.set(deliveryId, attempt);

    let verified: boolean | null = null;
    let reason: string | undefined;
    let payload: unknown;
    try {
      payload = options.secret
        ? verifyWebhook(raw, req.headers, options.secret)
        : constructEvent(raw);
      verified = options.secret ? true : null;
    } catch (error) {
      if (!(error instanceof SnappliWebhookError)) throw error;
      reason = error.reason;
      if (options.secret) verified = false;
      try {
        payload = JSON.parse(raw.toString('utf8'));
      } catch {
        payload = undefined;
      }
    }
    const rejected = verified === false;
    const responseStatus = rejected ? 401 : status;
    res.writeHead(responseStatus, { 'Content-Type': 'application/json' });
    res.end(rejected ? JSON.stringify({ error: reason }) : respondBody);
    options.onDelivery({
      receivedAt: new Date().toISOString(),
      method: req.method ?? 'POST',
      path: req.url ?? '/',
      deliveryId,
      attempt,
      duplicate: attempt > 1,
      verified,
      ...(reason ? { reason } : {}),
      ...(payload && typeof payload === 'object' && 'event' in payload
        ? { event: String((payload as { event: unknown }).event) }
        : {}),
      responseStatus,
      headers,
      ...(payload !== undefined ? { payload } : { body: raw.toString('utf8').slice(0, 2000) }),
    });
  });
  const port = await listen(server, options.port, options.host);
  return {
    url: `http://${options.host && options.host !== '0.0.0.0' ? options.host : 'localhost'}:${port}`,
    port,
    close: () => closeServer(server),
  };
}

// ---------------------------------------------------------------------------------------------
// Eventos de conector

export interface SendEventOptions {
  url: string;
  secret: string | undefined;
  type: string | undefined;
  data: unknown;
  eventId?: string | undefined;
  timeoutMs?: number | undefined;
  /** Hace falta para una URL que no es local: Snappli manda un WhatsApp real al contacto. */
  allowWrite: boolean;
  fetch?: typeof fetch;
}

const EVENT_HINTS: Record<string, string> = {
  sent: 'Snappli envió la plantilla al contacto y dejó una nota en la conversación.',
  no_mapping:
    'No hay una regla activa para ese tipo en el conector (panel → Conectores → Eventos). El tipo debe coincidir exactamente.',
  no_contact:
    'No se encontró el contacto: revisa la ruta del contacto de la regla (p. ej. $.telefono) y que el teléfono o email exista en Snappli.',
  duplicate:
    'Ese id de evento ya se recibió: Snappli ignora los repetidos. Usa un id nuevo para otro evento.',
  failed:
    'La regla existe pero el envío falló (plantilla no aprobada, ventana, número…). El motivo está en reason.',
};

/** Envía un evento firmado a Snappli (o a un mock) y explica el resultado. */
export async function sendEvent(options: SendEventOptions) {
  const url = assertHttpUrl(options.url);
  if (!options.secret) {
    throw new CliError(
      'Falta el secreto de eventos del conector: --secret o SNAPPLI_CONNECTOR_EVENT_SECRET.',
      'missing_secret',
    );
  }
  if (!options.type) throw new CliError('Falta el tipo del evento.', 'missing_event_type');
  if (!isLocalUrl(url) && !options.allowWrite) {
    throw new CliError(
      'Este evento hará que Snappli mande un WhatsApp real al contacto. Repite con --yes (CLI) o con SNAPPLI_ALLOW_WRITE=1 (MCP) si es lo que quieres.',
      'write_not_allowed',
    );
  }
  const { eventId, result } = await sendConnectorEvent({
    url: url.href,
    secret: options.secret,
    type: options.type,
    data: options.data ?? {},
    eventId: options.eventId,
    timeoutMs: options.timeoutMs,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const key = result.status === 'ignored' ? result.reason : result.status;
  return { url: url.href, type: options.type, eventId, result, hint: EVENT_HINTS[key] ?? null };
}

// ---------------------------------------------------------------------------------------------
// Respuesta de un conector

/** Lo que leería la IA de la respuesta de tu API con ese `responseMap`. */
export function checkConnectorResponse(body: string, rawMap?: unknown) {
  const responseMap = normalizeResponseMap(rawMap);
  const warnings: string[] = [];
  const bytes = Buffer.byteLength(body);
  if (bytes > CONNECTOR_RESPONSE_MAX_BYTES) {
    warnings.push(
      `La respuesta pesa ${bytes} bytes: Snappli corta a 1 MB y la llamada falla. Pagina o filtra en tu API.`,
    );
  }
  let data: unknown;
  let json = true;
  try {
    data = body ? JSON.parse(body) : null;
  } catch {
    json = false;
    warnings.push(
      'La respuesta no es JSON: la IA recibirá el texto tal cual y el responseMap no se aplica.',
    );
  }
  const values: Record<string, unknown> = {};
  if (responseMap && json) {
    for (const [key, path] of Object.entries(responseMap)) {
      if (!/^[a-z][a-z0-9_]{0,39}$/.test(key)) {
        warnings.push(`«${key}»: el nombre debe ir en minúsculas, números y _ (hasta 40).`);
      }
      if (!path.startsWith('$')) warnings.push(`«${key}»: la ruta debe empezar con $ (${path}).`);
      const value = readJsonPath(data, path);
      values[key] = value ?? null;
      if (value === undefined)
        warnings.push(`«${key}» (${path}) no está en la respuesta: la IA recibirá null.`);
    }
  }
  const shaped = shapeConnectorResponse(body, responseMap);
  if (!responseMap) {
    warnings.push(
      'Sin responseMap la IA recibe el JSON entero (recortado a 2048 caracteres). Define los campos que necesita.',
    );
  }
  if (shaped.truncated) {
    warnings.push('Lo que lee la IA pasa de 2048 caracteres y se recorta: devuelve menos campos.');
  }
  return {
    bytes,
    overLimit: bytes > CONNECTOR_RESPONSE_MAX_BYTES,
    json,
    mapped: shaped.mapped,
    ...(responseMap && json ? { values } : {}),
    aiSees: shaped.text,
    truncated: shaped.truncated,
    warnings,
  };
}

/** Acepta el `responseMap` solo, una operación (`{responseMap}`) o nada. */
function normalizeResponseMap(raw: unknown): Record<string, string> | undefined {
  if (raw === undefined || raw === null) return undefined;
  const candidate =
    raw && typeof raw === 'object' && 'responseMap' in raw
      ? (raw as { responseMap: unknown }).responseMap
      : raw;
  if (
    !candidate ||
    typeof candidate !== 'object' ||
    Array.isArray(candidate) ||
    !Object.values(candidate).every((v) => typeof v === 'string')
  ) {
    throw new CliError(
      'El mapa debe ser {"campo":"$.ruta"} o una operación con responseMap.',
      'invalid_response_map',
    );
  }
  return candidate as Record<string, string>;
}

// ---------------------------------------------------------------------------------------------
// init

const ENV_VARS = ['SNAPPLI_API_KEY', 'SNAPPLI_WEBHOOK_SECRET', 'SNAPPLI_CONNECTOR_EVENT_SECRET'];

/** Añade al `.env` las variables que falten (vacías) y comprueba que `.env` no se sube a git. */
export async function initProject(cwd: string, envFile = '.env') {
  const path = resolve(cwd, envFile);
  const current = await readFile(path, 'utf8').catch(() => undefined);
  const has = (name: string) =>
    new RegExp(`^\\s*(export\\s+)?${name}\\s*=`, 'm').test(current ?? '');
  const missing = ENV_VARS.filter((name) => !has(name));
  if (missing.length) {
    const lines = missing.map((name) => `${name}=`).join('\n');
    if (current === undefined) await writeFile(path, `${lines}\n`, { mode: 0o600 });
    else await appendFile(path, `${current && !current.endsWith('\n') ? '\n' : ''}${lines}\n`);
  }
  const gitignore = await readFile(resolve(cwd, '.gitignore'), 'utf8').catch(() => undefined);
  const base = envFile.replace(/^\.\//, '');
  const ignored = gitignore !== undefined && isGitignored(gitignore, base);
  return {
    envFile: path,
    created: current === undefined,
    added: missing,
    gitignored: ignored,
    warnings: ignored
      ? []
      : [`${base} no está en .gitignore: añádelo antes de poner la key o los secretos.`],
    nextSteps: [
      'Instala el SDK: npm install @snappli/sdk',
      'Pon el secreto de tu integración de webhooks en SNAPPLI_WEBHOOK_SECRET.',
      'Prueba tu receptor: npx @snappli/cli webhooks trigger contact.stage.entered --to http://localhost:3000/webhooks/snappli --repeat',
    ],
    docs: DOCS_URL,
  };
}

/** Comprobación sencilla de `.gitignore` (patrones con `*`, `/` inicial y `!` de excepción). */
export function isGitignored(gitignore: string, file: string): boolean {
  let ignored = false;
  for (const rawLine of gitignore.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const negated = line.startsWith('!');
    const pattern = line.replace(/^!/, '').replace(/^\//, '').replace(/\/$/, '');
    const regex = new RegExp(
      `^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*\*?/g, '.*')}$`,
    );
    const name = file.split('/').pop() ?? file;
    if (regex.test(file) || (!pattern.includes('/') && regex.test(name))) ignored = !negated;
  }
  return ignored;
}

// ---------------------------------------------------------------------------------------------
// Con API key: cuenta, integraciones de webhook y entregas

/** Valida la key con `GET /v1/me` y la guarda en la config del usuario (0600). */
export async function login(
  client: Snappli,
  env: Env,
  options: { apiKey: string; apiUrl?: string | undefined },
) {
  const me = await client.me();
  const savedTo = await saveConfig(env, {
    apiKey: options.apiKey,
    ...(options.apiUrl ? { apiUrl: options.apiUrl } : {}),
  });
  return { ...describeAccount(me), savedTo };
}

export async function logout(env: Env) {
  return { loggedOut: await deleteConfig(env), file: configFile(env) };
}

export async function whoami(client: Snappli, source: ApiKeySource, apiUrl: string) {
  return { ...describeAccount(await client.me()), apiUrl, keySource: source };
}

function describeAccount(me: PublicApiMe) {
  const missing = API_KEY_SCOPES.filter((scope) => !me.apiKey.scopes.includes(scope));
  return {
    organization: me.organization,
    apiKey: { ...me.apiKey, key: `${me.apiKey.keyPrefix}…` },
    rateLimitPerMin: me.rateLimitPerMin,
    ...(missing.length ? { missingScopes: missing } : {}),
  };
}

export function listWebhookIntegrations(client: Snappli) {
  return client.webhookIntegrations.list();
}

export function getWebhookIntegration(client: Snappli, id: string | undefined) {
  return client.webhookIntegrations.get(requireId(id, 'el id de la integración'));
}

export interface DeliveryFilters {
  webhookIntegrationId?: string | undefined;
  status?: string | undefined;
  limit?: number | undefined;
  page?: number | undefined;
}

export function listDeliveries(client: Snappli, filters: DeliveryFilters = {}) {
  const status = filters.status?.toUpperCase();
  if (status && !(WEBHOOK_DELIVERY_STATUSES as readonly string[]).includes(status)) {
    throw new CliError(
      `Estado «${filters.status}» no válido. Estados: ${WEBHOOK_DELIVERY_STATUSES.join(', ')}.`,
      'invalid_status',
    );
  }
  for (const [name, value, max] of [
    ['--limit', filters.limit, 100],
    ['--page', filters.page, Number.MAX_SAFE_INTEGER],
  ] as const) {
    if (value !== undefined && (!Number.isInteger(value) || value < 1 || value > max)) {
      throw new CliError(`${name} debe ser un entero entre 1 y ${max}.`, 'invalid_number');
    }
  }
  return client.webhookDeliveries.list({
    ...(filters.webhookIntegrationId ? { webhookIntegrationId: filters.webhookIntegrationId } : {}),
    ...(status ? { status: status as WebhookDeliveryStatusValue } : {}),
    ...(filters.limit ? { limit: filters.limit } : {}),
    ...(filters.page ? { page: filters.page } : {}),
  });
}

export function getDelivery(client: Snappli, id: string | undefined) {
  return client.webhookDeliveries.get(requireId(id, 'el id de la entrega'));
}

const REAL_SEND =
  'llega de verdad a la URL configurada en Snappli. Repite con --yes (CLI) o con SNAPPLI_ALLOW_WRITE=1 (MCP) si es lo que quieres.';

/** El botón «Enviar prueba» del panel. */
export function testWebhook(client: Snappli, id: string | undefined, allowWrite: boolean) {
  const integrationId = requireId(id, 'el id de la integración');
  if (!allowWrite) throw new CliError(`La prueba ${REAL_SEND}`, 'write_not_allowed');
  return client.webhookIntegrations.test(integrationId);
}

export async function retryDelivery(client: Snappli, id: string | undefined, allowWrite: boolean) {
  const deliveryId = requireId(id, 'el id de la entrega');
  if (!allowWrite) throw new CliError(`El reintento ${REAL_SEND}`, 'write_not_allowed');
  return { deliveryId, ...(await client.webhookDeliveries.retry(deliveryId)) };
}

/** Qué rellenaría el mapeo guardado de la integración con esa respuesta. */
export function previewMapping(client: Snappli, id: string | undefined, responseBody: string) {
  return client.webhookIntegrations.previewMapping(
    requireId(id, 'el id de la integración'),
    responseBody,
  );
}

function requireId(value: string | undefined, what: string): string {
  if (!value) throw new CliError(`Falta ${what}.`, 'missing_id');
  return value;
}
