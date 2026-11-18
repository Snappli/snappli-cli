/** Error de la API de Snappli o de una llamada que hace el SDK. */
export class SnappliError extends Error {
  /** Código estable (`unauthorized`, `not_found`, `http_error`, `document_url_expired`…). */
  readonly code: string;
  /** Código HTTP, si hubo respuesta. */
  readonly status: number | undefined;
  /** Cuerpo de la respuesta de error, tal cual (JSON o texto). */
  readonly body: unknown;

  constructor(message: string, code: string, options: { status?: number; body?: unknown } = {}) {
    super(message);
    this.name = 'SnappliError';
    this.code = code;
    this.status = options.status;
    this.body = options.body;
  }
}

export type WebhookErrorReason =
  | 'missing_signature'
  | 'missing_timestamp'
  | 'bad_signature'
  | 'timestamp_out_of_range'
  | 'invalid_json'
  | 'invalid_payload';

/** El webhook no se puede aceptar. Responde 400 (o 401) y no lo proceses. */
export class SnappliWebhookError extends Error {
  readonly reason: WebhookErrorReason;

  constructor(message: string, reason: WebhookErrorReason) {
    super(message);
    this.name = 'SnappliWebhookError';
    this.reason = reason;
  }
}
