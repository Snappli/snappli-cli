import { SnappliError } from './errors.js';
import type { WebhookContactDocument } from './generated/index.js';

export interface DownloadedDocument {
  bytes: Uint8Array;
  /** `Content-Type` de la respuesta, o el `mimeType` del documento. */
  contentType: string;
  /** `fileName` del documento, o uno derivado de la clave (`documento_identidad.jpg`). */
  fileName: string;
  size: number;
}

export interface DownloadDocumentOptions {
  fetch?: typeof fetch;
  /** Por defecto 30 s. */
  timeoutMs?: number;
  /** Hora actual (para tests). */
  now?: Date;
}

/**
 * Descarga un documento del payload (`contact.documents.<clave>`). El enlace caduca
 * (`urlExpiresAt`, 72 h por defecto): descárgalo al recibir el webhook y guárdalo en tu sistema.
 */
export async function downloadDocument(
  document: WebhookContactDocument,
  options: DownloadDocumentOptions = {},
): Promise<DownloadedDocument> {
  if (!document.url) {
    throw new SnappliError(
      `El documento «${document.label}» no trae url (¿payload guardado y no el recibido?).`,
      'document_url_missing',
    );
  }
  const now = options.now ?? new Date();
  if (document.urlExpiresAt && new Date(document.urlExpiresAt).getTime() <= now.getTime()) {
    throw new SnappliError(
      `El enlace de «${document.label}» caducó el ${document.urlExpiresAt}. Reintenta la entrega desde Snappli para obtener uno nuevo.`,
      'document_url_expired',
    );
  }
  const fetcher = options.fetch ?? fetch;
  const response = await fetcher(document.url, {
    signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
  });
  if (!response.ok) {
    throw new SnappliError(
      `No se pudo descargar «${document.label}»: HTTP ${response.status}.`,
      response.status === 404 || response.status === 410 ? 'document_url_expired' : 'http_error',
      { status: response.status, body: await response.text().catch(() => '') },
    );
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  return {
    bytes,
    contentType: response.headers.get('content-type') ?? document.mimeType,
    fileName: document.fileName ?? fallbackName(document),
    size: bytes.byteLength,
  };
}

function fallbackName(document: WebhookContactDocument): string {
  const last = document.storageKey.split('/').pop();
  return last || 'documento';
}
