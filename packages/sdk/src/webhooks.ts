import { createHmac, timingSafeEqual } from 'node:crypto';
import { SnappliWebhookError } from './errors.js';
import {
  WEBHOOK_EVENT_TYPES,
  type WebhookContactDocument,
  type WebhookContactPayload,
  type WebhookEventType,
  type WebhookOutboundPayload,
} from './generated/index.js';
import { getHeader, type HeadersLike } from './headers.js';

/** Cabeceras que manda Snappli en cada entrega de webhook (en minúsculas). */
export const WEBHOOK_HEADERS = {
  signature: 'x-snappli-signature',
  timestamp: 'x-snappli-timestamp',
  deliveryId: 'x-snappli-delivery-id',
  idempotencyKey: 'idempotency-key',
} as const;

export const WEBHOOK_USER_AGENT = 'Snappli-Webhook/1.0';
/** Tiempo límite de cada intento: responde 2xx antes y deja lo pesado en segundo plano. */
export const WEBHOOK_TIMEOUT_MS = 15_000;
/** Intentos por entrega (con backoff exponencial desde 2 s). */
export const WEBHOOK_MAX_ATTEMPTS = 3;
export const WEBHOOK_RETRY_BASE_DELAY_MS = 2_000;
/** Margen de reloj que acepta `verifyWebhook` por defecto. */
export const WEBHOOK_TOLERANCE_SECONDS = 300;

/** Un webhook de Snappli, discriminado por `event`. */
export type WebhookEvent = WebhookOutboundPayload;
export type { WebhookContactDocument, WebhookContactPayload, WebhookEventType };

type RawBody = string | Uint8Array;

const nowSeconds = () => Math.floor(Date.now() / 1000);

function hmacHex(secret: string, timestamp: number | string, body: RawBody): string {
  const hmac = createHmac('sha256', secret).update(`${timestamp}.`);
  hmac.update(body);
  return hmac.digest('hex');
}

/**
 * Firma un cuerpo igual que Snappli: HMAC SHA-256 en hex (sin prefijo) de `timestamp.body`. Sirve
 * para tus tests y para simular entregas.
 */
export function signWebhookPayload(
  body: RawBody,
  secret: string,
  timestamp: number = nowSeconds(),
): { signature: string; timestamp: number } {
  return { signature: hmacHex(secret, timestamp, body), timestamp };
}

/** Cabeceras completas de una entrega (las mismas que manda Snappli). */
export function webhookHeaders(options: {
  body: RawBody;
  deliveryId: string;
  secret?: string | undefined;
  timestamp?: number | undefined;
}): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': WEBHOOK_USER_AGENT,
    'Idempotency-Key': options.deliveryId,
    'X-Snappli-Delivery-Id': options.deliveryId,
  };
  if (options.secret) {
    const { signature, timestamp } = signWebhookPayload(
      options.body,
      options.secret,
      options.timestamp,
    );
    headers['X-Snappli-Timestamp'] = String(timestamp);
    headers['X-Snappli-Signature'] = signature;
  }
  return headers;
}

/** Id de la entrega: igual en todos los reintentos. Úsalo para no procesar dos veces. */
export function webhookDeliveryId(headers: HeadersLike): string | undefined {
  return (
    getHeader(headers, WEBHOOK_HEADERS.idempotencyKey) ??
    getHeader(headers, WEBHOOK_HEADERS.deliveryId) ??
    undefined
  );
}

export interface VerifyWebhookOptions {
  /** Diferencia máxima entre `X-Snappli-Timestamp` y tu reloj. Por defecto 300 s. */
  toleranceSeconds?: number;
  /** Hora actual en segundos (para tests). */
  now?: number;
}

/**
 * Comprueba la firma (en tiempo constante) y la marca de tiempo, y devuelve el evento. Pasa el
 * **cuerpo crudo** tal como llegó: si lo parseas y lo vuelves a serializar, la firma no coincide.
 *
 * Lanza `SnappliWebhookError` con `reason`: `missing_signature`, `missing_timestamp`,
 * `bad_signature`, `timestamp_out_of_range`, `invalid_json` o `invalid_payload`.
 */
export function verifyWebhook(
  rawBody: RawBody,
  headers: HeadersLike,
  secret: string,
  options: VerifyWebhookOptions = {},
): WebhookEvent {
  if (!secret) {
    throw new TypeError('verifyWebhook necesita el secreto de la integración.');
  }
  const signature = getHeader(headers, WEBHOOK_HEADERS.signature)?.trim();
  const timestamp = getHeader(headers, WEBHOOK_HEADERS.timestamp)?.trim();
  if (!signature) {
    throw new SnappliWebhookError(
      'Falta X-Snappli-Signature. ¿La integración tiene secreto en Snappli?',
      'missing_signature',
    );
  }
  if (!timestamp) {
    throw new SnappliWebhookError('Falta X-Snappli-Timestamp.', 'missing_timestamp');
  }
  checkSignature(rawBody, secret, timestamp, signature, options);
  return constructEvent(rawBody);
}

/** Solo la firma y la hora, sin parsear el cuerpo. Devuelve el motivo si no vale. */
export function checkWebhookSignature(
  rawBody: RawBody,
  secret: string,
  timestamp: string | number,
  signature: string,
  options: VerifyWebhookOptions = {},
):
  | { valid: true }
  | { valid: false; reason: 'bad_signature' | 'timestamp_out_of_range'; detail: string } {
  try {
    checkSignature(rawBody, secret, String(timestamp), signature, options);
    return { valid: true };
  } catch (error) {
    const reason = (error as SnappliWebhookError).reason as 'bad_signature';
    return { valid: false, reason, detail: (error as Error).message };
  }
}

function checkSignature(
  rawBody: RawBody,
  secret: string,
  timestamp: string,
  signature: string,
  options: VerifyWebhookOptions,
): void {
  const seconds = Number(timestamp);
  const tolerance = options.toleranceSeconds ?? WEBHOOK_TOLERANCE_SECONDS;
  const now = options.now ?? nowSeconds();
  if (!/^\d+$/.test(timestamp) || Math.abs(now - seconds) > tolerance) {
    throw new SnappliWebhookError(
      `X-Snappli-Timestamp (${timestamp}) está a más de ${tolerance} s de tu reloj (${now}). Revisa la hora del servidor o descarta la entrega repetida.`,
      'timestamp_out_of_range',
    );
  }
  const expected = Buffer.from(hmacHex(secret, timestamp, rawBody), 'hex');
  // Snappli manda hex sin prefijo; se tolera `sha256=` por si se copió de un evento de conector.
  const received = Buffer.from(signature.replace(/^sha256=/i, '').toLowerCase(), 'hex');
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    throw new SnappliWebhookError(
      'La firma no coincide. Verifica con el cuerpo crudo (sin parsear) y el secreto de esa integración.',
      'bad_signature',
    );
  }
}

/**
 * Parsea un webhook **sin verificar la firma**. Úsalo solo si la integración no tiene secreto (y
 * entonces protege la URL con la cabecera de autenticación propia de la integración).
 */
export function constructEvent(rawBody: RawBody): WebhookEvent {
  let payload: unknown;
  try {
    payload = JSON.parse(typeof rawBody === 'string' ? rawBody : Buffer.from(rawBody).toString());
  } catch {
    throw new SnappliWebhookError('El cuerpo no es JSON.', 'invalid_json');
  }
  if (!isWebhookEvent(payload)) {
    throw new SnappliWebhookError(
      `El cuerpo no es un evento de Snappli (event debe ser uno de: ${WEBHOOK_EVENT_TYPES.join(', ')}).`,
      'invalid_payload',
    );
  }
  return payload;
}

/** `true` si el valor tiene la forma básica de un webhook de Snappli. */
export function isWebhookEvent(value: unknown): value is WebhookEvent {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.event === 'string' &&
    (WEBHOOK_EVENT_TYPES as readonly string[]).includes(v.event) &&
    typeof v.contact === 'object' &&
    v.contact !== null &&
    typeof v.trigger === 'object' &&
    v.trigger !== null
  );
}

export { WEBHOOK_EVENT_TYPES };
