import { createHmac, randomUUID } from 'node:crypto';
import { SnappliError } from './errors.js';
import { CONNECTOR_EVENT_HEADERS } from './generated/index.js';

export { CONNECTOR_EVENT_HEADERS };

/** Margen de reloj que acepta Snappli en `x-snappli-timestamp`. */
export const CONNECTOR_EVENT_MAX_SKEW_SECONDS = 300;
const EVENT_ID = /^[A-Za-z0-9_.:-]{6,100}$/;

export const DEFAULT_API_URL = 'https://api.snappli.io';

/** Respuesta de Snappli a un evento (siempre HTTP 200 si la firma vale). */
export type ConnectorEventResult =
  | { status: 'sent'; messageId: string; conversationId: string }
  | { status: 'ignored'; reason: 'no_mapping' | 'no_contact' | 'duplicate' }
  | { status: 'failed'; reason: string };

/**
 * Firma un evento de conector: `sha256=` + HMAC SHA-256 en hex de `timestamp.body`. Ojo: **con
 * prefijo**, a diferencia de la firma de los webhooks que manda Snappli.
 */
export function signConnectorEvent(
  secret: string,
  timestamp: number | string,
  body: string | Uint8Array,
): string {
  const hmac = createHmac('sha256', secret).update(`${timestamp}.`);
  hmac.update(body);
  return `sha256=${hmac.digest('hex')}`;
}

/** URL de eventos de un conector: `https://api.snappli.io/api/integrations/connectors/<id>/events`. */
export function connectorEventsUrl(connectorId: string, apiUrl: string = DEFAULT_API_URL): string {
  return `${apiUrl.replace(/\/+$/, '')}/api/integrations/connectors/${encodeURIComponent(connectorId)}/events`;
}

/** Id de evento válido para `x-snappli-event-id` (6–100 caracteres `[A-Za-z0-9_.:-]`). */
export function isValidConnectorEventId(eventId: string): boolean {
  return EVENT_ID.test(eventId);
}

export interface ConnectorEventRequest {
  /** URL de eventos del conector (o usa `connectorEventsUrl`). */
  url: string;
  /** Secreto de eventos del conector (`whsec_…`), el que mostró el panel al activarlos. */
  secret: string;
  /** Tipo de evento, el de la regla del panel (p. ej. `pedido.enviado`). */
  type: string;
  data: unknown;
  /**
   * Id único del evento: Snappli ignora los repetidos (`duplicate`). Usa uno estable de tu sistema
   * (p. ej. `pedido-123-enviado`) para que un reintento no mande dos mensajes. Si falta, se genera.
   */
  eventId?: string | undefined;
  timestamp?: number | undefined;
  fetch?: typeof fetch;
  /** Por defecto 15 s. */
  timeoutMs?: number | undefined;
}

/** Cuerpo y cabeceras firmadas de un evento, sin enviarlo. */
export function buildConnectorEvent(
  request: Pick<ConnectorEventRequest, 'secret' | 'type' | 'data' | 'eventId' | 'timestamp'>,
): { eventId: string; body: string; headers: Record<string, string> } {
  if (!request.secret) throw new TypeError('Falta el secreto de eventos del conector.');
  if (!request.type) throw new TypeError('Falta el tipo del evento.');
  const eventId = request.eventId ?? `evt_${randomUUID()}`;
  if (!isValidConnectorEventId(eventId)) {
    throw new SnappliError(
      'El id del evento debe tener de 6 a 100 caracteres: letras, números, _ . : o -.',
      'invalid_event_id',
    );
  }
  const timestamp = String(request.timestamp ?? Math.floor(Date.now() / 1000));
  const body = JSON.stringify({ type: request.type, data: request.data ?? {} });
  return {
    eventId,
    body,
    headers: {
      'Content-Type': 'application/json',
      [CONNECTOR_EVENT_HEADERS.timestamp]: timestamp,
      [CONNECTOR_EVENT_HEADERS.signature]: signConnectorEvent(request.secret, timestamp, body),
      [CONNECTOR_EVENT_HEADERS.eventId]: eventId,
    },
  };
}

/**
 * Envía un evento a Snappli para que mande la plantilla de WhatsApp de la regla. Devuelve el
 * resultado (`sent`, `ignored` o `failed`). Lanza `SnappliError` si Snappli lo rechaza (401: firma,
 * hora, id del evento o conector sin eventos activos).
 */
export async function sendConnectorEvent(
  request: ConnectorEventRequest,
): Promise<{ eventId: string; result: ConnectorEventResult }> {
  const { eventId, body, headers } = buildConnectorEvent(request);
  const fetcher = request.fetch ?? fetch;
  const response = await fetcher(request.url, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(request.timeoutMs ?? 15_000),
  });
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // Se devuelve el texto tal cual en el error.
  }
  if (!response.ok) {
    const message =
      parsed && typeof parsed === 'object' && 'message' in parsed
        ? String((parsed as { message: unknown }).message)
        : `HTTP ${response.status}`;
    throw new SnappliError(
      response.status === 401
        ? `Snappli rechazó el evento: ${message}. Revisa el secreto, la hora del servidor, el id del evento y que los eventos del conector estén activos.`
        : `Snappli respondió ${response.status}: ${message}`,
      response.status === 401 ? 'unauthorized' : 'http_error',
      { status: response.status, body: parsed },
    );
  }
  if (!parsed || typeof parsed !== 'object' || !('status' in parsed)) {
    throw new SnappliError('Respuesta inesperada de Snappli.', 'unexpected_response', {
      status: response.status,
      body: parsed,
    });
  }
  return { eventId, result: parsed as ConnectorEventResult };
}
